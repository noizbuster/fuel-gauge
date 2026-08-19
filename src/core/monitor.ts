/**
 * The dashboard monitor: one state machine over cached summaries, refreshes,
 * imports, and auth flows, exposed as an observable snapshot for the Ink app.
 *
 * Contract:
 * - Cached summaries load FIRST and publish immediately; afterwards one
 *   silent sequential startup refresh walks the providers in canonical
 *   order under a single global lock.
 * - ONE global lock spans each entire refresh sequence (startup, `R`, auto
 *   tick). Duplicate requests while the lock is held publish the exact
 *   notice `refresh already running` instead of silently returning.
 * - `r` (selected) and `R` (all, sequential) both respect the Claude 180 s
 *   minimum gap; the adapter cooldown remains defense-in-depth.
 * - Auto refresh is off by default; its interval is clamped to 30–3600 s
 *   (default 120) and every tick skips busy, empty, and disabled providers.
 * - Claude is disabled until the policy is accepted through
 *   {@link MonitorController.updateSettings}.
 * - Import candidates are discovered WITHOUT reading secret contents; the
 *   UI confirms with the user before `importCandidate` reads/copies.
 * - Cached summaries and silent startup observations populate alert
 *   suppression but never ring: `startupComplete` gates the bell.
 * - All timers, abort controllers, auth flows, and the in-flight sequence
 *   are cleaned up deterministically by {@link MonitorController.dispose}.
 */

import type { AuthFlow, ProviderAdapter } from "../providers/provider.js";
import type { Runtime } from "../runtime.js";
import { redactSecrets } from "./http.js";
import type { Clock, ClockTimer } from "./time.js";
import type {
  AccountSummary,
  ImportCandidate,
  ProviderId,
  Settings,
} from "./types.js";
import { PROVIDER_ORDER } from "./types.js";

/** What a provider is doing right now. */
export type ProviderPhase =
  | "idle"
  | "importing"
  | "authenticating"
  | "refreshing"
  | "error";

/** Per-provider monitor state rendered by the dashboard. */
export interface ProviderMonitorState {
  readonly provider: ProviderId;
  readonly phase: ProviderPhase;
  /** Sanitized, token-free reason for the last failed/skipped operation. */
  readonly error: string | null;
  /** Epoch ms of the last completed refresh; null when never. */
  readonly refreshedAt: number | null;
  /** Current token-free summaries (cached values until a refresh lands). */
  readonly accounts: readonly AccountSummary[];
  /** Discovered local import candidates; token-free by construction. */
  readonly importCandidates: readonly ImportCandidate[];
}

/** Auth flow state rendered by the auth route. */
export interface MonitorAuthState {
  readonly provider: ProviderId;
  readonly flow: AuthFlow;
  /** Epoch ms when the flow started. */
  readonly startedAt: number;
  /** True while a manual submission is in flight. */
  readonly submitting: boolean;
  /** Sanitized failure text; null while healthy. */
  readonly error: string | null;
}

/** Immutable snapshot published on every transition. */
export interface MonitorSnapshot {
  readonly providers: ReadonlyMap<ProviderId, ProviderMonitorState>;
  /**
   * Account ids the USER added through Fuel Gauge itself (picker logins,
   * pasted API keys) — the auth tab manages exactly these; auto-imported
   * and agent-imported credentials never appear in it.
   */
  readonly userAddedAccountIds: ReadonlySet<string>;
  /** True while a refresh sequence holds the global lock. */
  readonly busy: boolean;
  readonly auth: MonitorAuthState | null;
  /**
   * True once the silent startup sequence settled. Cached summaries and
   * silent startup observations populate alert suppression but the bell
   * stays silent until the baseline is established.
   */
  readonly startupComplete: boolean;
  readonly disposed: boolean;
}

export interface MonitorOptions {
  readonly runtime: Runtime;
  readonly settings: Settings;
  /** Injectable clock; production uses the runtime's. */
  readonly clock?: Clock;
}

/** Auto-refresh interval bounds and the Claude minimum gap. */
export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 3600;
export const DEFAULT_INTERVAL_SECONDS = 600;
export const CLAUDE_MIN_INTERVAL_MS = 180_000;

/** Exact notice published when a duplicate refresh is rejected. */
export const REFRESH_ALREADY_RUNNING = "refresh already running";

/** Inline reason when Claude is refused before policy acceptance. */
export const CLAUDE_DISABLED_REASON =
  "claude is disabled until its policy is accepted (Settings, then c)";

/** Inline reason published when a second login start is rejected. */
export const AUTH_ALREADY_IN_PROGRESS = "login already in progress";

/** Inline reason published when manual `R` skips a cooled-down Claude. */
export const CLAUDE_COOLDOWN_NOTICE =
  "claude refresh cooldown (180 s) in effect";

/** Result of {@link MonitorController.beginAuth}. */
export type AuthBeginResult = { ok: true } | { ok: false; reason: string };

const MAX_ERROR_LENGTH = 300;

/** Clamps a configured auto-refresh interval into the usable range. */
export function clampIntervalSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return DEFAULT_INTERVAL_SECONDS;
  }
  return Math.min(
    MAX_INTERVAL_SECONDS,
    Math.max(MIN_INTERVAL_SECONDS, Math.round(seconds)),
  );
}

/** Flattens, redacts, and bounds any provider/adapter failure text. */
export function sanitizeErrorText(error: unknown): string {
  const raw =
    error instanceof Error && error.message !== ""
      ? error.message
      : "operation failed";
  const flattened = redactSecrets(raw.replaceAll(/\s+/g, " ").trim());
  const bounded = flattened.slice(0, MAX_ERROR_LENGTH);
  return bounded === "" ? "operation failed" : bounded;
}

interface ProviderRecord {
  phase: ProviderPhase;
  error: string | null;
  refreshedAt: number | null;
  accounts: readonly AccountSummary[];
  importCandidates: readonly ImportCandidate[];
}

type Listener = () => void;

/**
 * Observable monitor. Publishes immutable, referentially-stable snapshots;
 * never mutates state in place, so `useSyncExternalStore` can cache them.
 */
export class MonitorController {
  readonly #runtime: Runtime;
  readonly #clock: Clock;
  #settings: Settings;
  #records = new Map<ProviderId, ProviderRecord>();
  #busy = false;
  /** Promise of the in-flight refresh sequence; dispose awaits it. */
  #sequence: Promise<void> = Promise.resolve();
  /** Abort controller of the in-flight refresh sequence. */
  #sequenceAbort: AbortController | null = null;
  #auth: MonitorAuthState | null = null;
  #authAbort: AbortController | null = null;
  /** In-flight beginAuth setup (flow not yet assigned); blocks duplicates. */
  #authSetup: Promise<unknown> | null = null;
  /** Every tracked async operation dispose must await. */
  #ops = new Set<Promise<unknown>>();
  /** Abort controllers governing tracked operations. */
  #opControllers = new Set<AbortController>();
  /** Ownership token for auth result callbacks. */
  #authEpoch = 0;
  #timer: ClockTimer | null = null;
  #disposed = false;
  #startupStarted = false;
  /** Shared in-flight disposal; every caller awaits the same promise. */
  #disposePromise: Promise<void> | null = null;
  #startupComplete = false;
  #cachedSnapshot: MonitorSnapshot | null = null;
  #userAddedAccountIds: ReadonlySet<string> = new Set<string>();
  readonly #listeners = new Set<Listener>();

  constructor(options: MonitorOptions) {
    this.#runtime = options.runtime;
    this.#clock = options.clock ?? options.runtime.clock;
    this.#settings = options.settings;
    for (const provider of PROVIDER_ORDER) {
      this.#records.set(provider, {
        phase: "idle",
        error: null,
        refreshedAt: null,
        accounts: [],
        importCandidates: [],
      });
    }
  }

  /**
   * Current immutable snapshot. Referentially stable between mutations so
   * `useSyncExternalStore` can cache it.
   */
  getSnapshot(): MonitorSnapshot {
    this.#cachedSnapshot ??= this.#buildSnapshot();
    return this.#cachedSnapshot;
  }

  #buildSnapshot(): MonitorSnapshot {
    const providers = new Map<ProviderId, ProviderMonitorState>();
    for (const [provider, record] of this.#records) {
      providers.set(provider, { provider, ...record });
    }
    return {
      providers,
      userAddedAccountIds: this.#userAddedAccountIds,
      busy: this.#busy,
      auth: this.#auth,
      startupComplete: this.#startupComplete,
      disposed: this.#disposed,
    };
  }

  /** Subscribes to snapshot changes; returns the unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #publish(): void {
    this.#cachedSnapshot = null;
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }

  #setRecord(provider: ProviderId, patch: Partial<ProviderRecord>): void {
    const current = this.#records.get(provider);
    if (current === undefined) {
      return;
    }
    this.#records.set(provider, { ...current, ...patch });
    this.#publish();
  }

  /**
   * Runs `operation` as a tracked, abortable unit: dispose aborts
   * `controller` and awaits the returned promise before settling.
   */
  async #track<T>(
    controller: AbortController,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.#opControllers.add(controller);
    const run = operation();
    const tracked = run.finally(() => {
      this.#ops.delete(tracked);
      this.#opControllers.delete(controller);
    });
    this.#ops.add(tracked);
    // The caller observes `run`; this bookkeeping chain must never surface
    // a duplicate rejection.
    tracked.catch(() => undefined);
    return run;
  }

  /** True when the provider must stay network-silent. */
  isDisabled(provider: ProviderId): boolean {
    return provider === "claude" && !this.#settings.claudePolicyAccepted;
  }

  /**
   * Applies new settings: Claude gating, alert thresholds, and the
   * auto-refresh timer follow the persisted settings from now on.
   */
  updateSettings(settings: Settings): void {
    this.#settings = settings;
    this.configureAutoRefresh(
      settings.autoRefresh.enabled,
      settings.autoRefresh.intervalSeconds,
    );
    this.#publish();
  }

  #claudeCooldownElapsed(provider: ProviderId): boolean {
    if (provider !== "claude") {
      return true;
    }
    const record = this.#records.get("claude");
    if (record?.refreshedAt == null) {
      return true;
    }
    return this.#clock.now() - record.refreshedAt >= CLAUDE_MIN_INTERVAL_MS;
  }

  /**
   * Loads cached summaries and publishes them, auto-imports every local
   * account found on this machine (all providers, Claude included when
   * its policy is accepted), then runs the one silent sequential startup
   * refresh under the global lock.
   */
  async start(): Promise<void> {
    const cached = await this.#runtime.loadCachedSummaries();
    if (this.#disposed) {
      return;
    }
    this.#userAddedAccountIds =
      await this.#runtime.store.loadUserAddedAccountIds();
    for (const provider of PROVIDER_ORDER) {
      this.#setRecord(provider, { accounts: cached.get(provider) ?? [] });
    }
    if (!this.#startupStarted) {
      this.#startupStarted = true;
      await this.#autoAddAccounts();
      if (!this.#disposed) {
        // Imported accounts must appear in the records before the
        // sequence's empty-provider skip evaluates them.
        const seeded = await this.#runtime.loadCachedSummaries();
        for (const provider of PROVIDER_ORDER) {
          this.#setRecord(provider, { accounts: seeded.get(provider) ?? [] });
        }
      }
      await this.#runSequence(PROVIDER_ORDER, { silent: true });
      if (!this.#disposed) {
        this.#startupComplete = true;
        this.#publish();
      }
    }
  }

  /**
   * Default-on account adoption: every discovered local credential is
   * imported once per startup (imports upsert, so repeats are no-ops).
   * Discovery or import failures never block startup; the Add/Import
   * route remains for manual control.
   */
  async #autoAddAccounts(): Promise<void> {
    const controller = new AbortController();
    await this.#track(controller, async () => {
      for (const provider of PROVIDER_ORDER) {
        if (this.#disposed || controller.signal.aborted) {
          return;
        }
        if (this.isDisabled(provider)) {
          continue;
        }
        let candidates: Awaited<ReturnType<ProviderAdapter["discoverImports"]>>;
        try {
          candidates = await this.#runtime.adapters[provider].discoverImports(
            controller.signal,
          );
        } catch {
          continue;
        }
        for (const candidate of candidates) {
          if (this.#disposed || controller.signal.aborted) {
            return;
          }
          try {
            await this.#runtime.adapters[provider].import(
              candidate,
              controller.signal,
            );
          } catch {
            // Candidate vanished between discovery and import; skip it.
          }
        }
      }
    });
  }

  /** Reconfigures auto refresh after a settings change. */
  configureAutoRefresh(enabled: boolean, intervalSeconds: number): void {
    if (this.#disposed || !enabled) {
      this.#clearTimer();
      return;
    }
    this.#clearTimer();
    const intervalMs = clampIntervalSeconds(intervalSeconds) * 1000;
    this.#timer = this.#clock.setInterval(() => {
      void this.#autoTick();
    }, intervalMs);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      this.#clock.clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #autoTick(): Promise<void> {
    if (this.#busy || this.#disposed) {
      return;
    }
    const due = this.#refreshableProviders();
    if (due.length === 0) {
      return;
    }
    await this.#runSequence(due, { silent: true });
  }

  #refreshableProviders(): ProviderId[] {
    return PROVIDER_ORDER.filter(
      (provider) =>
        !this.isDisabled(provider) &&
        (this.#records.get(provider)?.accounts.length ?? 0) > 0 &&
        this.#claudeCooldownElapsed(provider),
    );
  }

  /**
   * `r`: refresh the selected provider. While the global lock is held the
   * exact notice {@link REFRESH_ALREADY_RUNNING} is published. Empty,
   * disabled, and Claude-cooled providers are skipped with a notice.
   */
  async refreshSelected(provider: ProviderId): Promise<void> {
    if (this.#disposed) {
      return;
    }
    if (this.#busy) {
      this.#setRecord(provider, { error: REFRESH_ALREADY_RUNNING });
      return;
    }
    if (this.isDisabled(provider)) {
      this.#setRecord(provider, {
        error: "claude is disabled until its policy is accepted",
      });
      return;
    }
    if ((this.#records.get(provider)?.accounts.length ?? 0) === 0) {
      this.#setRecord(provider, { error: "no accounts to refresh" });
      return;
    }
    if (!this.#claudeCooldownElapsed(provider)) {
      this.#setRecord(provider, {
        error: "claude refresh cooldown (180 s) in effect",
      });
      return;
    }
    await this.#runSequence([provider], { silent: false });
  }

  /** `R`: refresh every refreshable provider sequentially under one lock. */
  async refreshAll(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    if (this.#busy) {
      this.#setRecord(PROVIDER_ORDER[0], { error: REFRESH_ALREADY_RUNNING });
      return;
    }
    const due = PROVIDER_ORDER.filter(
      (provider) =>
        !this.isDisabled(provider) &&
        (this.#records.get(provider)?.accounts.length ?? 0) > 0,
    );
    // Manual `R` explains a cooled-down Claude instead of silently
    // dropping it; every other due provider still refreshes.
    for (const provider of due) {
      if (!this.#claudeCooldownElapsed(provider)) {
        this.#setRecord(provider, {
          phase: "idle",
          error: CLAUDE_COOLDOWN_NOTICE,
        });
      }
    }
    await this.#runSequence(
      due.filter((provider) => this.#claudeCooldownElapsed(provider)),
      { silent: false },
    );
  }

  /**
   * Runs one whole sequence under a SINGLE global lock: `#busy` stays true
   * from the first provider to the last, and one AbortController governs
   * the entire pass.
   */
  async #runSequence(
    providers: readonly ProviderId[],
    options: { silent: boolean },
  ): Promise<void> {
    if (this.#busy || this.#disposed || providers.length === 0) {
      return;
    }
    const controller = new AbortController();
    this.#sequenceAbort = controller;
    this.#busy = true;
    this.#publish();
    const run = (async () => {
      for (const provider of providers) {
        if (this.#disposed || controller.signal.aborted) {
          return;
        }
        if (
          this.isDisabled(provider) ||
          (this.#records.get(provider)?.accounts.length ?? 0) === 0
        ) {
          continue;
        }
        await this.#refreshOne(provider, controller.signal, options);
      }
    })();
    this.#sequence = run.then(
      () => undefined,
      () => undefined,
    );
    await this.#sequence;
    if (this.#sequenceAbort === controller) {
      this.#sequenceAbort = null;
    }
    this.#busy = false;
    this.#publish();
  }

  async #refreshOne(
    provider: ProviderId,
    signal: AbortSignal,
    options: { silent: boolean },
  ): Promise<void> {
    this.#setRecord(provider, { phase: "refreshing", error: null });
    try {
      const refreshed =
        await this.#runtime.adapters[provider].refreshAll(signal);
      if (this.#disposed || signal.aborted) {
        return;
      }
      this.#setRecord(provider, {
        phase: "idle",
        error: null,
        refreshedAt: this.#clock.now(),
        accounts: refreshed,
      });
    } catch (error) {
      if (this.#disposed || signal.aborted) {
        return;
      }
      // Failed refreshes keep the last safe cached summaries.
      this.#setRecord(provider, {
        phase: options.silent ? "idle" : "error",
        error: sanitizeErrorText(error),
      });
    }
  }

  /**
   * Discovers local import candidates WITHOUT reading secret contents and
   * stores them as token-free state for the Add/Import route.
   */
  async discoverImports(provider: ProviderId): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#setRecord(provider, { phase: "importing", error: null });
    this.#publish();
    const controller = new AbortController();
    try {
      const candidates = await this.#track(controller, () =>
        this.#runtime.adapters[provider].discoverImports(controller.signal),
      );
      if (this.#disposed) {
        return;
      }
      this.#setRecord(provider, {
        phase: "idle",
        importCandidates: candidates,
      });
    } catch (error) {
      if (this.#disposed) {
        return;
      }
      this.#setRecord(provider, {
        phase: "idle",
        error: sanitizeErrorText(error),
      });
    }
  }

  /**
   * Runs the confirmed import: reads and copies the candidate into the
   * private store. The Add route's ConfirmInput runs BEFORE this.
   */
  async importCandidate(
    provider: ProviderId,
    candidate: ImportCandidate,
  ): Promise<boolean> {
    if (this.#disposed) {
      return false;
    }
    this.#setRecord(provider, { phase: "importing", error: null });
    this.#publish();
    const controller = new AbortController();
    try {
      const accounts = await this.#track(controller, () =>
        this.#runtime.adapters[provider].import(candidate, controller.signal),
      );
      if (this.#disposed) {
        return false;
      }
      this.#setRecord(provider, {
        phase: "idle",
        error: null,
        accounts,
      });
      // A confirmed import is a user add exactly like a login: remember
      // the ids so the auth tab manages the imported accounts too.
      this.#userAddedAccountIds = new Set([
        ...this.#userAddedAccountIds,
        ...accounts.map((account) => account.id),
      ]);
      this.#publish();
      try {
        // Awaited so callers (and test teardown) never race the write.
        await this.#runtime.store.markUserAddedAccountIds(
          accounts.map((account) => account.id),
        );
      } catch {
        // Persistence is best-effort: the in-memory set already covers
        // this session; the next add retries the write.
      }
      return true;
    } catch (error) {
      if (this.#disposed) {
        return false;
      }
      this.#setRecord(provider, {
        phase: "idle",
        error: sanitizeErrorText(error),
      });
      return false;
    }
  }

  /**
   * Starts an interactive login. Fails fast when a flow is already active
   * or the provider is disabled. Result callbacks are guarded by an
   * ownership epoch: cancellation or dispose publishes nothing afterwards.
   */
  /**
   * Starts an interactive login. Returns whether a flow actually started:
   * a disabled provider publishes {@link CLAUDE_DISABLED_REASON}, a busy
   * monitor (active flow OR in-flight setup) publishes
   * {@link AUTH_ALREADY_IN_PROGRESS}, and dispose rejects late starts.
   * Result callbacks stay guarded by the ownership epoch.
   */
  async beginAuth(provider: ProviderId): Promise<AuthBeginResult> {
    if (this.#disposed) {
      return { ok: false, reason: "monitor is shutting down" };
    }
    if (this.isDisabled(provider)) {
      this.#setRecord(provider, {
        phase: "idle",
        error: CLAUDE_DISABLED_REASON,
      });
      return { ok: false, reason: CLAUDE_DISABLED_REASON };
    }
    if (this.#auth !== null || this.#authSetup !== null) {
      this.#setRecord(provider, {
        phase: "idle",
        error: AUTH_ALREADY_IN_PROGRESS,
      });
      return { ok: false, reason: AUTH_ALREADY_IN_PROGRESS };
    }
    const controller = new AbortController();
    const epoch = ++this.#authEpoch;
    this.#authAbort = controller;
    this.#setRecord(provider, { phase: "authenticating", error: null });
    this.#publish();
    let started = false;
    const setup = this.#track(controller, async () => {
      try {
        const flow = await this.#runtime.adapters[provider].beginAuth(
          controller.signal,
        );
        if (
          this.#disposed ||
          this.#authAbort !== controller ||
          epoch !== this.#authEpoch
        ) {
          await flow.cancel();
          return;
        }
        this.#auth = {
          provider,
          flow,
          startedAt: this.#clock.now(),
          submitting: false,
          error: null,
        };
        started = true;
        this.#publish();
        flow.result.then(
          (accounts) => {
            // Ownership guard: a cancel, dispose, or newer flow wins.
            if (
              this.#disposed ||
              epoch !== this.#authEpoch ||
              this.#auth?.flow !== flow
            ) {
              return;
            }
            this.#auth = null;
            this.#authAbort = null;
            // Merge by id: providers support multiple accounts, so a
            // fresh login must ADD to (or refresh) the record, never
            // replace the accounts an earlier login left behind.
            const current = this.#records.get(provider)?.accounts ?? [];
            const replaced = new Set(accounts.map((a) => a.id));
            const merged = [
              ...current.filter((a) => !replaced.has(a.id)),
              ...accounts,
            ];
            this.#setRecord(provider, {
              phase: "idle",
              error: null,
              refreshedAt: this.#clock.now(),
              accounts: merged,
            });
            // Auth-flow completions are exactly the user's own adds:
            // remember the ids so the auth tab keeps managing them.
            this.#userAddedAccountIds = new Set([
              ...this.#userAddedAccountIds,
              ...accounts.map((account) => account.id),
            ]);
            this.#publish();
            void this.#runtime.store
              .markUserAddedAccountIds(accounts.map((account) => account.id))
              .catch(() => {
                // Persistence is best-effort: the in-memory set already
                // covers this session; the next add retries the write.
              });
          },
          (error: unknown) => {
            if (
              this.#disposed ||
              epoch !== this.#authEpoch ||
              this.#auth?.flow !== flow
            ) {
              return;
            }
            this.#auth = null;
            this.#authAbort = null;
            this.#setRecord(provider, {
              phase: "idle",
              error: sanitizeErrorText(error),
            });
          },
        );
      } catch (error) {
        if (this.#authAbort === controller && epoch === this.#authEpoch) {
          this.#authAbort = null;
        }
        if (!this.#disposed && epoch === this.#authEpoch) {
          this.#setRecord(provider, {
            phase: "idle",
            error: sanitizeErrorText(error),
          });
        }
      }
    });
    this.#authSetup = setup;
    try {
      await setup;
    } finally {
      if (this.#authSetup === setup) {
        this.#authSetup = null;
      }
    }
    return started
      ? { ok: true }
      : { ok: false, reason: "login was cancelled before it started" };
  }

  /** Marks the manual submission in flight (auth route input state). */
  setAuthSubmitting(submitting: boolean): void {
    if (this.#auth !== null) {
      this.#auth = { ...this.#auth, submitting };
      this.#publish();
    }
  }

  /** Records a sanitized manual-submission failure; keeps the flow alive. */
  setAuthError(error: string | null): void {
    if (this.#auth !== null) {
      this.#auth = { ...this.#auth, error: sanitizeErrorText(error) };
      this.#publish();
    }
  }

  /** Cancels the active auth flow (Esc); idempotent. */
  async cancelAuth(): Promise<void> {
    const auth = this.#auth;
    this.#authEpoch += 1;
    this.#auth = null;
    const abort = this.#authAbort;
    this.#authAbort = null;
    abort?.abort();
    if (auth !== null) {
      this.#setRecord(auth.provider, { phase: "idle" });
      await auth.flow.cancel();
    }
  }

  /** Deletes the Fuel Gauge copy of one account (never the source). */
  async removeAccount(provider: ProviderId, accountId: string): Promise<void> {
    if (this.#disposed) {
      return;
    }
    try {
      await this.#track(new AbortController(), () =>
        this.#runtime.adapters[provider].remove(accountId),
      );
      if (this.#disposed) {
        return; // no late publication after dispose
      }
      const record = this.#records.get(provider);
      if (record !== undefined) {
        this.#setRecord(provider, {
          accounts: record.accounts.filter(
            (account) => account.id !== accountId,
          ),
        });
      }
    } catch (error) {
      this.#setRecord(provider, {
        phase: "error",
        error: sanitizeErrorText(error),
      });
    }
  }

  /**
   * Deterministic cleanup: clears the timer, aborts and awaits the active
   * sequence, cancels the auth flow, and drops listeners.
   */
  async dispose(): Promise<void> {
    if (this.#disposePromise !== null) {
      // Every caller awaits the SAME in-flight disposal, so a late await
      // can never observe a half-finished cleanup.
      return this.#disposePromise;
    }
    this.#disposePromise = this.#runDispose();
    return this.#disposePromise;
  }

  async #runDispose(): Promise<void> {
    this.#disposed = true;
    this.#clearTimer();
    const abort = this.#sequenceAbort;
    abort?.abort();
    for (const controller of this.#opControllers) {
      controller.abort();
    }
    const sequence = this.#sequence;
    const ops = [...this.#ops];
    const auth = this.#auth;
    this.#authEpoch += 1;
    this.#auth = null;
    this.#authAbort?.abort();
    this.#authAbort = null;
    this.#authSetup = null;
    this.#busy = false;
    this.#publish();
    this.#listeners.clear();
    await Promise.allSettled([sequence, ...ops]);
    if (auth !== null) {
      await auth.flow.cancel();
    }
  }
}
