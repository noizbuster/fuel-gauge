/**
 * Low-quota alerting over rendered normalized metrics.
 *
 * Two independent predicates drive the two outputs:
 *
 * - The rendered alert list is the set of metrics that are visually low at a
 *   FIXED threshold of {@link VISUAL_LOW_PERCENT} (20%), regardless of the
 *   configured notification threshold. It is ordered by canonical provider
 *   order, then account id, then metric order, and capped at
 *   {@link MAX_ACTIVE_ALERTS}.
 * - The bell rings on crossings of the CONFIGURED threshold
 *   (`AlertSettings.thresholdPercent`), clamped to 1–99. A key rings at most
 *   once per crossing episode: it fires when a metric is observed at or
 *   below the clamped threshold and only re-arms when that metric is
 *   subsequently OBSERVED strictly above the threshold. Disappearance of a
 *   metric or account never re-arms a key; stale keys stay suppressed until
 *   a real recovery is rendered. A present-but-null (unreported) metric also
 *   holds the suppression so flapping refreshes cannot re-bell.
 *
 * Alerts are derived exclusively from the {@link AccountSummary} metrics the
 * dashboard renders — the store is the only metrics producer — and only for
 * accounts with `status === "active"`. This module is pure: callers pass
 * `now`, and no timers, listeners, or IO live here. The bell is opt-in and
 * off by default; {@link bellOutput} gates it on `AlertSettings.enabled`.
 */

import type { AccountSummary, AlertSettings, ProviderId } from "./types.js";
import { PROVIDER_LABELS, PROVIDER_ORDER } from "./types.js";

/** Fixed rendered-low threshold in remaining percent. */
export const VISUAL_LOW_PERCENT = 20;

/** Inclusive bounds for the configured bell threshold. */
export const MIN_BELL_THRESHOLD = 1;
export const MAX_BELL_THRESHOLD = 99;

/** Bell threshold used when the configured value is not a finite number. */
export const DEFAULT_BELL_THRESHOLD = 20;

/** Maximum simultaneous low alerts kept in the rendered list. */
export const MAX_ACTIVE_ALERTS = 20;

/** Terminal bell character; emitted at most once per refresh batch. */
export const BEL = "\u0007";

/** An alert rendered for one metric of one account that is visually low. */
export interface LowQuotaAlert {
  /** Stable key: `${providerId}:${accountId}:${metricId}`. */
  readonly key: string;
  readonly providerId: ProviderId;
  readonly providerLabel: string;
  readonly accountId: string;
  readonly accountLabel: string;
  readonly metricId: string;
  readonly metricLabel: string;
  readonly remainingPercent: number;
  /**
   * Start of the current low episode: the earlier of the configured-
   * threshold crossing and the first render below the visual threshold.
   */
  readonly firedAt: number;
}

/** Edge-trigger state carried between refreshes. */
export interface AlertsState {
  /** Current visually-low alerts, deterministic order, at most 20. */
  readonly active: readonly LowQuotaAlert[];
  /**
   * Bell keys mapped to their last configured-threshold crossing time.
   * Keys stay suppressed across refresh gaps and account removal; only an
   * observed recovery strictly above the clamped threshold removes one.
   */
  readonly fired: ReadonlyMap<string, number>;
  /** Visual episode starts: key -> first render at or below 20% remaining. */
  readonly lowSince: ReadonlyMap<string, number>;
}

/** Result of one alert evaluation over a freshly rendered account list. */
export interface AlertUpdate {
  readonly state: AlertsState;
  /** Bell crossings raised by THIS evaluation (the only bell candidates). */
  readonly newlyFired: readonly LowQuotaAlert[];
}

export const EMPTY_ALERTS: AlertsState = Object.freeze({
  active: [],
  fired: new Map<string, number>(),
  lowSince: new Map<string, number>(),
});

/** Clamps a configured threshold into the usable 1–99 range. */
export function clampBellThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_BELL_THRESHOLD;
  }
  return Math.min(MAX_BELL_THRESHOLD, Math.max(MIN_BELL_THRESHOLD, value));
}

function alertKey(
  providerId: ProviderId,
  accountId: string,
  metricId: string,
): string {
  return `${providerId}:${accountId}:${metricId}`;
}

/** Deterministic display label for any account summary variant. */
export function accountDisplayLabel(account: AccountSummary): string {
  switch (account.provider) {
    case "githubCopilot":
      return account.githubName ?? account.githubLogin;
    case "antigravity":
      return account.name ?? account.email;
    case "claude":
      return account.displayName ?? account.email;
    case "cursor":
      return account.email ?? account.authId ?? account.id;
    case "omp":
      // Agent-managed accounts carry their underlying provider inside
      // displayLabel; the prefix names the managing agent.
      return `Oh My Pi · ${account.displayLabel}`;
    case "opencode":
      return `OpenCode · ${account.displayLabel}`;
    case "fuelGauge":
      return `FuelGauge · ${account.displayLabel}`;
    default:
      return account.email;
  }
}

function providerRank(providerId: ProviderId): number {
  const index = PROVIDER_ORDER.indexOf(providerId);
  return index === -1 ? PROVIDER_ORDER.length : index;
}

function byProviderThenAccount(
  a: { provider: ProviderId; id: string },
  b: { provider: ProviderId; id: string },
): number {
  const byProvider = providerRank(a.provider) - providerRank(b.provider);
  return byProvider !== 0 ? byProvider : a.id.localeCompare(b.id);
}

/**
 * Evaluates one rendered account list against the alert settings.
 *
 * - Only accounts with `status === "active"` contribute; banned, forbidden,
 *   and reauthentication-required accounts render stale or denied data.
 * - `active` lists metrics at or below {@link VISUAL_LOW_PERCENT} remaining.
 * - `newlyFired` lists first observations at or below the clamped configured
 *   threshold; repeat renders of the same low episode never re-ring.
 * - Recovery — and only recovery — is an observation strictly above the
 *   clamped threshold. Missing metrics/accounts and `null` values keep a
 *   fired key suppressed.
 */
export function updateAlerts(
  previous: AlertsState,
  accounts: readonly AccountSummary[],
  settings: AlertSettings,
  now: number,
): AlertUpdate {
  const bellThreshold = clampBellThreshold(settings.thresholdPercent);
  const ordered = [...accounts].sort(byProviderThenAccount);

  const active: LowQuotaAlert[] = [];
  const newlyFired: LowQuotaAlert[] = [];
  const fired = new Map(previous.fired);
  const lowSince = new Map<string, number>();

  for (const account of ordered) {
    for (const metric of account.metrics) {
      const key = alertKey(account.provider, account.id, metric.id);
      const isActive = account.status === "active";
      const remaining = metric.remainingPercent;
      const reported =
        isActive &&
        remaining != null &&
        Number.isFinite(remaining) &&
        remaining >= 0
          ? remaining
          : null;

      if (reported == null) {
        // Unreported or non-active: hold bell suppression, end visual episode.
        continue;
      }

      let crossing: number | undefined;
      if (reported > bellThreshold) {
        // Observed recovery: re-arm the bell for the next drop. The metric
        // may still be visually low, so do not skip the visual check below.
        fired.delete(key);
      } else {
        // At or below the configured threshold: keep/start suppression.
        crossing = fired.get(key);
        fired.set(key, crossing ?? now);
        if (crossing === undefined) {
          newlyFired.push({
            key,
            providerId: account.provider,
            providerLabel: PROVIDER_LABELS[account.provider],
            accountId: account.id,
            accountLabel: accountDisplayLabel(account),
            metricId: metric.id,
            metricLabel: metric.label,
            remainingPercent: reported,
            firedAt: now,
          });
        }
      }

      if (reported <= VISUAL_LOW_PERCENT) {
        const episodeStart = previous.lowSince.get(key) ?? crossing ?? now;
        lowSince.set(key, episodeStart);
        active.push({
          key,
          providerId: account.provider,
          providerLabel: PROVIDER_LABELS[account.provider],
          accountId: account.id,
          accountLabel: accountDisplayLabel(account),
          metricId: metric.id,
          metricLabel: metric.label,
          remainingPercent: reported,
          firedAt: episodeStart,
        });
      }
    }
  }

  return {
    state: { active: active.slice(0, MAX_ACTIVE_ALERTS), fired, lowSince },
    newlyFired,
  };
}

/**
 * Bell output for one refresh batch: a single {@link BEL} when alerting is
 * enabled (off by default) and at least one new crossing happened, otherwise
 * an empty string. One BEL per batch keeps terminals quiet on floods; the
 * count lives in the rendered alert list, not in bell spam.
 */
export function bellOutput(
  newlyFired: readonly LowQuotaAlert[],
  enabled: boolean,
): string {
  return enabled && newlyFired.length > 0 ? BEL : "";
}
