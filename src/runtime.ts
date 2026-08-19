/**
 * Runtime composition root for Fuel Gauge.
 *
 * `createRuntime` is the single place where production defaults (private
 * credential store, global fetch, system clock, native ports, provider
 * adapters) are wired together. Every external port is injectable so tests
 * replace the entire world; the override keys follow the shared contract
 * exactly and composition itself performs no provider I/O.
 */

import { type BrowserPort, createBrowserPort } from "./core/browser.js";
import {
  type CallbackServerFactory,
  createCallbackServerFactory,
} from "./core/callback-server.js";
import {
  type ConfigRootResolution,
  defaultPathContext,
  resolveConfigRoot,
} from "./core/paths.js";
import { type CredentialStore, createCredentialStore } from "./core/store.js";
import {
  createSubprocessPort,
  type SubprocessPort,
} from "./core/subprocess.js";
import { type Clock, systemClock } from "./core/time.js";
import {
  type AccountSummary,
  PROVIDER_ORDER,
  type ProviderId,
} from "./core/types.js";
import { createProviderRegistry } from "./providers/index.js";
import type { ProviderRegistry } from "./providers/provider.js";

/** Injectable overrides; tests replace every external port through these. */
export interface RuntimeOverrides {
  /** Wins over `FUEL_GAUGE_CONFIG_DIR` and platform defaults. */
  readonly configRoot?: string;
  /** Complete adapter registration; defaults build the production one lazily. */
  readonly adapters?: ProviderRegistry;
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
  readonly browser?: BrowserPort;
  readonly subprocess?: SubprocessPort;
  readonly callbackServer?: CallbackServerFactory;
}

/**
 * Everything provider adapters need from the runtime. This is the exact
 * dependency object passed to `createProviderRegistry`.
 */
export interface RuntimeDependencies {
  readonly configRoot: string;
  readonly store: CredentialStore;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly browser: BrowserPort;
  readonly subprocess: SubprocessPort;
  readonly callbackServer: CallbackServerFactory;
}

/** Token-free cached summaries for every provider, keyed and ordered by `PROVIDER_ORDER`. */
export type CachedProviderSummaries = ReadonlyMap<
  ProviderId,
  readonly AccountSummary[]
>;

export interface Runtime extends RuntimeDependencies {
  /** Lazily composed adapter registry; non-interactive use never touches it. */
  readonly adapters: ProviderRegistry;
  /**
   * Reads only the private store — never network, auth, or refresh — and
   * returns public summaries for all six providers in canonical order.
   */
  loadCachedSummaries(): Promise<CachedProviderSummaries>;
}

/** Thrown when the private config root cannot be resolved at all. */
export class HomeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeUnavailableError";
  }
}

/**
 * Resolves the private root: explicit override first, then a non-empty
 * `FUEL_GAUGE_CONFIG_DIR`, then platform defaults.
 */
function resolveRuntimeRoot(override: string | undefined): string {
  const trimmed = override?.trim();
  if (trimmed !== undefined && trimmed !== "") {
    return trimmed;
  }
  const resolution: ConfigRootResolution = resolveConfigRoot(
    defaultPathContext(),
  );
  if (!resolution.ok) {
    throw new HomeUnavailableError(resolution.message);
  }
  return resolution.root;
}

export function createRuntime(overrides: RuntimeOverrides = {}): Runtime {
  const configRoot = resolveRuntimeRoot(overrides.configRoot);
  const store = createCredentialStore(configRoot);
  const dependencies: RuntimeDependencies = {
    configRoot,
    store,
    fetch: overrides.fetch ?? globalThis.fetch,
    clock: overrides.clock ?? systemClock,
    browser: overrides.browser ?? createBrowserPort(),
    subprocess: overrides.subprocess ?? createSubprocessPort(),
    callbackServer: overrides.callbackServer ?? createCallbackServerFactory(),
  };

  let composedAdapters: ProviderRegistry | undefined;
  const runtime: Runtime = {
    ...dependencies,
    get adapters(): ProviderRegistry {
      composedAdapters ??=
        overrides.adapters ?? createProviderRegistry(dependencies);
      return composedAdapters;
    },
    async loadCachedSummaries(): Promise<CachedProviderSummaries> {
      const accounts = await Promise.all(
        PROVIDER_ORDER.map((provider) => store.list(provider)),
      );
      const summaries = new Map<ProviderId, readonly AccountSummary[]>();
      PROVIDER_ORDER.forEach((provider, index) => {
        summaries.set(provider, accounts[index] ?? []);
      });
      return summaries;
    },
  };
  return runtime;
}
