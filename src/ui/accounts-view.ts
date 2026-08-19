/**
 * Account-centric dashboard model: flattens every provider's accounts
 * into one list where the same real-world identity appears exactly once.
 *
 * Two accounts merge when they share a normalized email or the same
 * api-key fingerprint; everything else stays its own entry. Entries keep
 * the canonical provider order of their first member, ordered most
 * sources first.
 */

import type { AccountSummary, ProviderId } from "../core/types.js";
import { PROVIDER_LABELS, PROVIDER_ORDER } from "../core/types.js";

/** One merged dashboard entry: a real-world identity across providers. */
export interface MergedAccountEntry {
  /** Grouping key (`email:…` / `key:…` / `account:…`). */
  readonly key: string;
  /** Vendor-ish name leading the title, e.g. `"Codex"`. */
  readonly vendorLabel: string;
  /** Lowercase source ids in parens, e.g. `"omp, codex"`. */
  readonly sourcesLabel: string;
  /** Identity: email, masked api key, or fallback. */
  readonly identityLabel: string;
  /** `Vendor (sources) identity` — the rendered title. */
  readonly title: string;
  /** Unique provider ids holding this identity, in canonical order. */
  readonly providers: readonly ProviderId[];
  /** Every member account, canonical provider order. */
  readonly accounts: readonly AccountSummary[];
  /** Entry metric rows: per-label worst remaining, first-seen order. */
  readonly metricRows: readonly {
    readonly label: string;
    readonly remainingPercent: number | null;
    readonly resetAt: number | null;
  }[];
  /** Worst remaining percent across members; null when none report. */
  readonly worstRemainingPercent: number | null;
  /** True when any member is not active or reports a quota error. */
  readonly needsAttention: boolean;
  /** True when any member is pinned. */
  readonly pinned: boolean;
}

/** Email with `@`, lowercased and trimmed; `null` for anything else. */
function normalizedEmail(account: AccountSummary): string | null {
  const raw =
    account.provider === "githubCopilot"
      ? account.githubEmail
      : account.provider === "fuelGauge"
        ? null
        : account.email;
  if (raw == null) {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  return trimmed.includes("@") && trimmed !== "" ? trimmed : null;
}

/** `Vendor · tail` display labels split into their two halves. */
function displayLabelParts(displayLabel: string): {
  vendor: string;
  tail: string;
} {
  const separator = displayLabel.indexOf(" · ");
  if (separator === -1) {
    return { vendor: displayLabel, tail: displayLabel };
  }
  return {
    vendor: displayLabel.slice(0, separator),
    tail: displayLabel.slice(separator + 3),
  };
}

/** Vendor-ish name leading the title (`Codex`, `Z.AI Coding Plan`). */
function vendorLabelOf(account: AccountSummary): string {
  if (
    account.provider === "omp" ||
    account.provider === "opencode" ||
    account.provider === "fuelGauge"
  ) {
    return displayLabelParts(account.displayLabel).vendor;
  }
  return PROVIDER_LABELS[account.provider];
}
/**
 * omp provider ids folded onto the native vendor they bill against.
 * Unknown ids keep their own namespace so new agents never collide.
 */
const OMP_VENDOR_KEYS: Record<string, string> = {
  "openai-codex": "codex",
  "openai-codex-device": "codex",
  zai: "zai",
  "zai-coding-plan": "zai",
  "zhipu-coding-plan": "zai",
  "xai-oauth": "xai",
  xai: "xai",
  "google-antigravity": "antigravity",
  "google-gemini-cli": "gemini",
  "github-copilot": "githubCopilot",
  anthropic: "claude",
  "opencode-go": "opencode-go",
};

/** opencode provider ids folded onto the native vendor, same policy. */
const OPENCODE_VENDOR_KEYS: Record<string, string> = {
  openai: "codex",
  zai: "zai",
  "zai-coding-plan": "zai",
  xai: "xai",
  google: "gemini",
  "github-copilot": "githubCopilot",
  anthropic: "claude",
  "opencode-go": "opencode-go",
  openrouter: "openrouter",
};

/** FuelGauge-source vendor registry keys onto the same vendor namespace. */
const FUEL_GAUGE_VENDOR_KEYS: Record<string, string> = {
  "zai-coding-plan": "zai",
};

/**
 * The underlying vendor an account bills against. Identity merging is
 * vendor-scoped: one real-world identity merges only within the same
 * vendor, so an xAI login never folds into an OpenAI login (or any other
 * vendor) just because the email matches.
 */
function vendorKeyOf(account: AccountSummary): string {
  switch (account.provider) {
    case "omp":
      return (
        OMP_VENDOR_KEYS[account.ompProviderId] ?? `omp.${account.ompProviderId}`
      );
    case "opencode":
      return (
        OPENCODE_VENDOR_KEYS[account.openCodeProviderId] ??
        `oc.${account.openCodeProviderId}`
      );
    case "fuelGauge":
      return FUEL_GAUGE_VENDOR_KEYS[account.vendor] ?? `fg.${account.vendor}`;
    default:
      return account.provider;
  }
}

/** Identity for the title: email, masked key, or per-provider fallback. */
function identityLabelOf(account: AccountSummary): string {
  const email = normalizedEmail(account);
  if (email != null) {
    return email;
  }
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
    case "opencode":
    case "fuelGauge":
      return displayLabelParts(account.displayLabel).tail;
    default:
      return account.email ?? account.id;
  }
}

function providerRank(provider: ProviderId): number {
  const index = PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? PROVIDER_ORDER.length : index;
}

function worstRemaining(accounts: readonly AccountSummary[]): number | null {
  let worst: number | null = null;
  for (const account of accounts) {
    for (const metric of account.metrics) {
      if (metric.remainingPercent == null) {
        continue;
      }
      if (worst === null || metric.remainingPercent < worst) {
        worst = metric.remainingPercent;
      }
    }
  }
  return worst;
}

function mergeKeyOf(account: AccountSummary, index: number): string {
  // Merging is vendor-scoped: the same email or api key merges accounts
  // only when they bill against the same vendor (see vendorKeyOf), so an
  // xAI login never folds into an OpenAI login by email alone.
  const vendor = vendorKeyOf(account);
  const email = normalizedEmail(account);
  if (email != null) {
    return `email:${vendor}:${email}`;
  }
  if (
    (account.provider === "opencode" ||
      account.provider === "omp" ||
      account.provider === "fuelGauge") &&
    account.keyFingerprint !== null
  ) {
    return `key:${vendor}:${account.keyFingerprint}`;
  }
  // Same email under different casings still merges above; everything
  // else (distinct accounts, anonymous agent accounts) stays unique.
  return `account:${account.provider}:${account.id}:${index}`;
}

/**
 * Groups every account by vendor-scoped identity: the same email or api
 * key merges only within one underlying vendor (see vendorKeyOf), so one
 * person's xAI and OpenAI logins stay separate entries. Input order does
 * not matter: members are re-sorted into canonical provider order, and
 * the entries by distinct source count (most first), provider rank
 * breaking ties.
 */
export function mergeAccountsByIdentity(
  accounts: readonly AccountSummary[],
): MergedAccountEntry[] {
  // Callers flatten every provider's records into one list, and ids are
  // only unique PER PROVIDER — the same (provider, id) can appear twice
  // when sources overlap. A merged entry showing the same account twice
  // is pure duplication (and duplicate React keys downstream), so the
  // first occurrence wins.
  const seen = new Set<string>();
  const unique = accounts.filter((account) => {
    const key = `${account.provider}:${account.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  const groups = new Map<string, AccountSummary[]>();
  unique.forEach((account, index) => {
    const key = mergeKeyOf(account, index);
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [account]);
    } else {
      bucket.push(account);
    }
  });
  const entries = [...groups.values()].map((members) => {
    const ordered = [...members].sort(
      (a, b) => providerRank(a.provider) - providerRank(b.provider),
    );
    const first = ordered[0] as AccountSummary;
    const providers = [...new Set(ordered.map((account) => account.provider))];
    const vendorLabel = vendorLabelOf(first);
    const sourcesLabel = providers.join(", ");
    const identity = identityLabelOf(first);
    return {
      key: mergeKeyOf(first, 0),
      vendorLabel,
      sourcesLabel,
      identityLabel: identity,
      title: `${vendorLabel} (${sourcesLabel}) ${identity}`,
      providers,
      accounts: ordered,
      metricRows: mergedMetricRows(ordered),
      worstRemainingPercent: worstRemaining(ordered),
      needsAttention: ordered.some(
        (account) =>
          account.status !== "active" || account.quotaQueryLastError !== null,
      ),
      pinned: false,
    } satisfies MergedAccountEntry;
  });
  // Identities signed into more sources surface first — an account
  // live in several places is the one worth watching — with canonical
  // provider order breaking ties so the layout stays deterministic.
  entries.sort(
    (a, b) =>
      b.providers.length - a.providers.length ||
      providerRank(a.providers[0] as ProviderId) -
        providerRank(b.providers[0] as ProviderId),
  );
  return entries;
}

/**
 * Per-label metric rows across members: the same label from several
 * accounts collapses to its worst remaining percent (conservative).
 */
function mergedMetricRows(accounts: readonly AccountSummary[]): {
  label: string;
  remainingPercent: number | null;
  resetAt: number | null;
}[] {
  const rows: {
    label: string;
    remainingPercent: number | null;
    resetAt: number | null;
  }[] = [];
  const byLabel = new Map<
    string,
    { label: string; remainingPercent: number | null; resetAt: number | null }
  >();
  for (const account of accounts) {
    for (const metric of account.metrics) {
      // Null-percent rows would render as a bare "--" and carry no
      // information (e.g. a dead credential's stale windows); the
      // per-account modal keeps the full picture.
      if (metric.remainingPercent == null) {
        continue;
      }
      const existing = byLabel.get(metric.label);
      if (existing === undefined) {
        const row = {
          label: metric.label,
          remainingPercent: metric.remainingPercent,
          resetAt: metric.resetAt,
        };
        byLabel.set(metric.label, row);
        rows.push(row);
      } else if (
        metric.remainingPercent != null &&
        (existing.remainingPercent == null ||
          metric.remainingPercent < existing.remainingPercent)
      ) {
        existing.remainingPercent = metric.remainingPercent;
        existing.resetAt = metric.resetAt;
      }
    }
  }
  return rows;
}

/** Marks entries whose members are pinned (mutates the returned shape). */
export function markPinnedEntries(
  entries: readonly MergedAccountEntry[],
  pinnedIds: readonly string[],
): MergedAccountEntry[] {
  const pinned = new Set(pinnedIds);
  return entries.map((entry) => ({
    ...entry,
    pinned: entry.accounts.some((account) => pinned.has(account.id)),
  }));
}
