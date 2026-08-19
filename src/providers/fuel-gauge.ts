/**
 * The FuelGauge source: first-party accounts the user adds directly by
 * pasting a vendor API key. Unlike every other adapter there is no
 * upstream agent credential file — the key IS the credential, so it is
 * persisted in the private store under the same plaintext disclosure as
 * imports, and quota refresh calls the vendor usage API directly.
 *
 * v1 vendor registry: Z.AI coding plan (real quota windows, endpoint
 * verified against a live install — see zai-quota.ts). OpenAI/Anthropic
 * pay-as-you-go keys are deliberately absent: they expose spend, not
 * quota windows, and would not fit the fuel-gauge model.
 */

import { HttpError } from "../core/http.js";
import { fuelGaugeAccountId, md5Hex } from "../core/ids.js";
import type {
  AccountSummary,
  FuelGaugeVendorId,
  ImportCandidate,
  StoredFuelGaugeAccount,
} from "../core/types.js";
import type { RuntimeDependencies } from "../runtime.js";
import type {
  ApiKeyAuthFlow,
  AuthFlow,
  AuthSubmission,
  ProviderAdapter,
} from "./provider.js";
import { fetchZaiQuotaLimits } from "./zai-quota.js";

/** Vendor usage calls match the opencode adapter's bounded budget. */
const REQUEST_TIMEOUT_MS = 30_000;
/** How long an add-key flow stays retryable before it must be restarted. */
const ADD_FLOW_TIMEOUT_MS = 600_000;
/** Shortest accepted key; also the floor for the masked display form. */
const MIN_API_KEY_LENGTH = 8;

/** What the add flow and refresh need to know per vendor. */
interface FuelGaugeVendor {
  /** Display label leading the account title, e.g. `"Z.AI Coding Plan"`. */
  readonly label: string;
  /** AuthRoute paste hint naming the expected key. */
  readonly hint: string;
}

/**
 * The vendor registry: every {@link FuelGaugeVendorId} with a first-class
 * usage API. Adding a vendor = one entry here plus refresh wiring in this
 * adapter; nothing else in the codebase enumerates vendors.
 */
export const FUEL_GAUGE_VENDORS: Record<FuelGaugeVendorId, FuelGaugeVendor> = {
  "zai-coding-plan": {
    label: "Z.AI Coding Plan",
    hint: "Z.AI coding plan API key",
  },
};

const DEFAULT_VENDOR: FuelGaugeVendorId = "zai-coding-plan";

/** Message-only error flattening; never includes error values. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Six masked characters identify the key without exposing it. */
function displayLabelFor(vendor: FuelGaugeVendorId, apiKey: string): string {
  return `${FUEL_GAUGE_VENDORS[vendor].label} · API: ${apiKey.slice(0, 3)}..${apiKey.slice(-3)}`;
}

export function createFuelGaugeProvider(
  deps: RuntimeDependencies,
): ProviderAdapter {
  const { store, fetch, clock } = deps;

  async function storedAccounts(): Promise<StoredFuelGaugeAccount[]> {
    const accounts = await store.listStored("fuelGauge");
    return accounts.filter(
      (account): account is StoredFuelGaugeAccount =>
        account.provider === "fuelGauge",
    );
  }

  async function requireStoredAccount(
    accountId: string,
  ): Promise<StoredFuelGaugeAccount> {
    const account = (await storedAccounts()).find(
      (entry) => entry.id === accountId,
    );
    if (account === undefined) {
      throw new Error(
        "That FuelGauge account is no longer stored — refresh the list and try again",
      );
    }
    return account;
  }

  async function summaryOf(accountId: string): Promise<AccountSummary> {
    const summary = (await store.list("fuelGauge")).find(
      (entry) => entry.id === accountId,
    );
    if (summary === undefined) {
      throw new Error(`FuelGauge account ${accountId} vanished from the store`);
    }
    return summary;
  }

  // -------------------------------------------------------------------------
  // Add flow: paste an API key, verified against the vendor usage API
  // -------------------------------------------------------------------------

  async function beginAuth(signal: AbortSignal): Promise<AuthFlow> {
    const vendor = DEFAULT_VENDOR;
    const expiresAt = clock.now() + ADD_FLOW_TIMEOUT_MS;

    let resolveResult!: (summaries: AccountSummary[]) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<AccountSummary[]>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const settleGuard = { settled: false };
    const settle = (outcome: () => void) => {
      if (settleGuard.settled) return;
      settleGuard.settled = true;
      outcome();
    };

    async function completeWith(submission: AuthSubmission): Promise<void> {
      if (submission.kind !== "fuelGauge") {
        throw new Error(
          "FuelGauge API-key entry accepts only fuelGauge submissions",
        );
      }
      const apiKey = submission.apiKey.trim();
      if (apiKey.length < MIN_API_KEY_LENGTH) {
        throw new Error(
          "API key is too short — paste the full key the vendor issued",
        );
      }
      if (expiresAt <= clock.now()) {
        settle(() =>
          rejectResult(new Error("API-key entry expired. Start again.")),
        );
        return;
      }
      // A rejected key throws WITHOUT settling: the flow stays mounted so
      // the user can paste a corrected key into the same prompt.
      const limits = await fetchZaiQuotaLimits({
        fetch,
        apiKey,
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        metricIdPrefix: "fuelgauge",
      });
      const now = clock.now();
      await store.upsert("fuelGauge", {
        id: fuelGaugeAccountId(vendor, apiKey),
        provider: "fuelGauge",
        status: "active",
        statusReason: null,
        quotaQueryLastError: null,
        quotaQueryLastErrorAt: null,
        usageUpdatedAt: limits.length > 0 ? now : null,
        createdAt: now,
        lastUsed: now,
        vendor,
        apiKey,
        keyFingerprint: md5Hex(apiKey),
        displayLabel: displayLabelFor(vendor, apiKey),
        limits,
      });
      const summary = await summaryOf(fuelGaugeAccountId(vendor, apiKey));
      settle(() => resolveResult([summary]));
    }

    const flow: ApiKeyAuthFlow = {
      mode: "apiKey",
      provider: "fuelGauge",
      hint: FUEL_GAUGE_VENDORS[vendor].hint,
      expiresAt,
      result,
      submit: completeWith,
      cancel: async () => {
        settle(() =>
          rejectResult(
            new Error("FuelGauge API-key entry was cancelled. Start again."),
          ),
        );
      },
    };
    return flow;
  }

  // -------------------------------------------------------------------------
  // Refresh: vendor usage API with the stored key
  // -------------------------------------------------------------------------

  async function refresh(
    accountId: string,
    signal: AbortSignal,
  ): Promise<AccountSummary> {
    const account = await requireStoredAccount(accountId);
    try {
      const limits = await fetchZaiQuotaLimits({
        fetch,
        apiKey: account.apiKey,
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        metricIdPrefix: "fuelgauge",
      });
      const now = clock.now();
      await store.upsert("fuelGauge", {
        ...account,
        limits,
        status: "active",
        statusReason: null,
        quotaQueryLastError: null,
        quotaQueryLastErrorAt: null,
        usageUpdatedAt: limits.length > 0 ? now : account.usageUpdatedAt,
        lastUsed: now,
      });
    } catch (error) {
      // Retain the last safe quota (the spread keeps the prior limits) and
      // classify a rejected key so the dashboard asks for re-adding it.
      const rejected =
        error instanceof HttpError &&
        (error.status === 401 || error.status === 403);
      const now = clock.now();
      await store.upsert("fuelGauge", {
        ...account,
        status: rejected ? "requiresReauthentication" : account.status,
        statusReason: rejected
          ? "the vendor usage API rejected this API key — remove and re-add it"
          : account.statusReason,
        quotaQueryLastError: `fuel-gauge refresh failed: ${errorText(error)}`,
        quotaQueryLastErrorAt: now,
        lastUsed: now,
      });
    }
    return summaryOf(accountId);
  }

  return {
    async list(): Promise<AccountSummary[]> {
      return store.list("fuelGauge");
    },
    async discoverImports(): Promise<ImportCandidate[]> {
      // First-party source: nothing on disk to discover. The only way in
      // is the add-key flow surfaced as this provider's login option.
      return [];
    },
    async import(): Promise<AccountSummary[]> {
      throw new Error(
        "The FuelGauge source holds keys you add directly — nothing to import",
      );
    },
    beginAuth,
    refresh,
    async refreshAll(signal: AbortSignal): Promise<AccountSummary[]> {
      const accounts = await storedAccounts();
      const summaries: AccountSummary[] = [];
      for (const account of accounts) {
        try {
          summaries.push(await refresh(account.id, signal));
        } catch {
          // Per-account failures keep their prior safe quota (store merge);
          // the error itself was already persisted by refresh.
        }
      }
      return summaries;
    },
    async remove(accountId: string): Promise<void> {
      await store.remove("fuelGauge", accountId);
    },
  };
}
