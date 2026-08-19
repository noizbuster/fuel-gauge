/**
 * Oh My Pi (omp) adapter: discovers and refreshes every account logged
 * into the locally installed `omp` CLI through `omp usage --json`.
 *
 * omp keeps all credentials inside its own vault (SQLite + auth-broker),
 * so this is the one adapter that never reads or stores tokens: imports
 * persist identity snapshots only, and every refresh re-asks the CLI.
 * There is no Fuel-Gauge-side login flow — new accounts are created with
 * `omp auth-broker login <provider>` and then imported here.
 */

import { asRecord, recordString } from "../core/discovery.js";
import { md5Hex, ompAccountId } from "../core/ids.js";
import type {
  AccountSummary,
  ImportCandidate,
  OmpUsageLimit,
  StoredOmpAccount,
} from "../core/types.js";
import type { RuntimeDependencies } from "../runtime.js";
import type { AuthFlow, ProviderAdapter } from "./provider.js";

/** Message-only error flattening; never includes error values. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** omp usage can fan out to several provider APIs; generous but bounded. */
const USAGE_TIMEOUT_MS = 90_000;
const TOKEN_TIMEOUT_MS = 15_000;

const IMPORT_ONLY_MESSAGE =
  "Oh My Pi accounts are managed by the omp CLI. Log in with " +
  "`omp auth-broker login <provider>`, then import the account here (a).";

/** Display names for omp provider ids seen in usage reports. */
const OMP_PROVIDER_NAMES: Record<string, string> = {
  "openai-codex": "ChatGPT Codex",
  "openai-codex-device": "ChatGPT Codex (device)",
  anthropic: "Anthropic Claude",
  zai: "Z.AI (GLM)",
  "zai-coding-plan": "Z.AI (GLM)",
  "zhipu-coding-plan": "Zhipu Coding Plan",
  "google-antigravity": "Antigravity",
  "google-gemini-cli": "Gemini CLI",
  "github-copilot": "GitHub Copilot",
  cursor: "Cursor",
  "xai-oauth": "xAI Grok",
  xai: "xAI API",
  openrouter: "OpenRouter",
  "kimi-code": "Kimi Code",
  firepass: "Fire Pass",
  "alibaba-coding-plan": "Alibaba Coding Plan",
  "qwen-portal": "Qwen Portal",
  deepseek: "DeepSeek",
  moonshot: "Moonshot (Kimi API)",
  minimax: "MiniMax",
  "minimax-code": "MiniMax",
  "minimax-code-cn": "MiniMax (CN)",
  gitlab: "GitLab Duo",
  "gitlab-duo": "GitLab Duo",
  "gitlab-duo-agent": "GitLab Duo Agent",
  devin: "Devin",
  umans: "Umans AI",
  sakana: "Sakana AI",
  "opencode-go": "OpenCode Go",
  aiand: "ai&",
  meta: "Meta Model API",
};

/** One `omp usage --json` account, normalized for identity matching. */
interface OmpReport {
  ompProviderId: string;
  accountKey: string;
  email: string | null;
  displayLabel: string;
  limits: OmpUsageLimit[];
  /** True for `accountsWithoutUsage` entries (no quota numbers exist). */
  noUsage: boolean;
  /** md5 of the api key for identity-less api-key accounts; else null. */
  keyFingerprint: string | null;
}

/** Everything `omp usage --json` knows about the vault's accounts. */
interface OmpUsageSnapshot {
  reports: OmpReport[];
}

export function createOmpProvider(deps: RuntimeDependencies): ProviderAdapter {
  const { store, clock, subprocess } = deps;

  // -------------------------------------------------------------------------
  // CLI boundary: `omp usage --json`
  // -------------------------------------------------------------------------

  async function ompBinary(): Promise<string> {
    const settings = await store.loadSettings();
    const override = settings.importPathOverrides.omp?.trim();
    return override != null && override !== "" ? override : "omp";
  }

  async function runUsage(signal: AbortSignal): Promise<OmpUsageSnapshot> {
    const binary = await ompBinary();
    const result = await subprocess.run(binary, ["usage", "--json"], {
      timeoutMs: USAGE_TIMEOUT_MS,
      signal,
    });
    return parseUsageReports(result.stdout, signal, binary);
  }

  async function parseUsageReports(
    stdout: string,
    signal: AbortSignal,
    binary: string,
  ): Promise<OmpUsageSnapshot> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new Error(
        `omp usage output is not valid JSON: ${errorText(error)}`,
      );
    }
    const root = asRecord(parsed);
    const reports = root?.reports;
    if (!Array.isArray(reports)) {
      throw new Error("omp usage output has no reports array");
    }
    const withoutUsage = Array.isArray(root?.accountsWithoutUsage)
      ? root?.accountsWithoutUsage
      : [];
    const anonymousSeen = new Map<string, number>();
    const withUsage = await Promise.all(
      reports.map(async (entry): Promise<OmpReport[]> => {
        const report = asRecord(entry);
        const ompProviderId = recordString(report ?? {}, "provider");
        if (report === undefined || ompProviderId === undefined) {
          return [];
        }
        const metadata = asRecord(report.metadata);
        const email = recordString(metadata ?? {}, "email") ?? null;
        const projectId = recordString(metadata ?? {}, "projectId") ?? null;
        const identity = email ?? projectId;
        if (identity != null) {
          return [
            {
              ompProviderId,
              accountKey: identity,
              email,
              displayLabel: reportLabel(ompProviderId, identity),
              limits: parseLimits(report.limits),
              noUsage: false,
              keyFingerprint: null,
            },
          ];
        }
        // No identity in the usage report (e.g. zai): the only stable
        // handle is the credential itself. When the provider has no
        // OAuth accounts, `omp token <p> --raw` yields the api key,
        // which is fingerprinted (md5) and masked — never stored raw.
        const apiKey = await probeApiKey(binary, ompProviderId, signal);
        const accountKey =
          apiKey !== null
            ? apiKeyMask(apiKey)
            : anonymousKey(anonymousSeen, ompProviderId);
        return [
          {
            ompProviderId,
            accountKey,
            email: null,
            displayLabel: reportLabel(ompProviderId, accountKey),
            limits: parseLimits(report.limits),
            noUsage: false,
            keyFingerprint: apiKey !== null ? md5Hex(apiKey) : null,
          },
        ];
      }),
    );
    const withoutUsageAccounts = await Promise.all(
      withoutUsage.map(async (entry): Promise<OmpReport[]> => {
        const record = asRecord(entry);
        const ompProviderId = recordString(record ?? {}, "provider");
        if (record === undefined || ompProviderId === undefined) {
          return [];
        }
        const apiKey =
          record.type === "api_key"
            ? await probeApiKey(binary, ompProviderId, signal)
            : null;
        const accountKey =
          apiKey !== null
            ? apiKeyMask(apiKey)
            : anonymousKey(anonymousSeen, ompProviderId);
        return [
          {
            ompProviderId,
            accountKey,
            email: null,
            displayLabel: reportLabel(ompProviderId, accountKey),
            limits: [],
            noUsage: true,
            keyFingerprint: apiKey !== null ? md5Hex(apiKey) : null,
          },
        ];
      }),
    );
    return {
      reports: [...withUsage.flat(), ...withoutUsageAccounts.flat()],
    };
  }

  /**
   * Returns the provider's api key when its vault entry is an api key
   * (no OAuth accounts stored); `null` for OAuth providers (their raw
   * token is a rotating JWT, useless as identity) and on any CLI failure.
   */
  async function probeApiKey(
    binary: string,
    ompProviderId: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    try {
      const raw = await subprocess.run(
        binary,
        ["token", ompProviderId, "--raw"],
        { timeoutMs: TOKEN_TIMEOUT_MS, signal },
      );
      const key = raw.stdout.trim();
      // OAuth access tokens are rotating JWTs — unstable as identity.
      // Only long, non-JWT values are treated as stable api keys.
      if (key.length < 8 || key.startsWith("eyJ") || key.includes(" ")) {
        return null;
      }
      return key;
    } catch {
      return null;
    }
  }

  function anonymousKey(
    seen: Map<string, number>,
    ompProviderId: string,
  ): string {
    const next = (seen.get(ompProviderId) ?? 0) + 1;
    seen.set(ompProviderId, next);
    return `account ${next}`;
  }

  function reportLabel(ompProviderId: string, accountKey: string): string {
    const name = OMP_PROVIDER_NAMES[ompProviderId] ?? ompProviderId;
    return `${name} · ${accountKey}`;
  }

  /** Six masked characters identify a key without exposing it. */
  function apiKeyMask(apiKey: string): string {
    return `API: ${apiKey.slice(0, 3)}..${apiKey.slice(-3)}`;
  }

  function parseLimits(value: unknown): OmpUsageLimit[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.flatMap((entry) => {
      const limit = asRecord(entry);
      const id = limit !== undefined ? recordString(limit, "id") : undefined;
      if (limit === undefined || id === undefined) {
        return [];
      }
      const amount = asRecord(limit.amount);
      const window = asRecord(limit.window);
      const remaining =
        amount !== undefined ? finiteOrNull(amount.remaining) : null;
      const remainingFraction =
        amount !== undefined ? finiteOrNull(amount.remainingFraction) : null;
      return [
        {
          id,
          label: recordString(limit, "label") ?? id,
          windowLabel:
            window !== undefined ? (recordString(window, "label") ?? "") : "",
          // percent-unit reports carry 0-100 in `remaining`; token-unit
          // reports carry only fractions, so the fraction is the percent.
          remainingPercent:
            remaining !== null && remaining >= 0 && remaining <= 100
              ? remaining
              : remainingFraction !== null
                ? remainingFraction * 100
                : null,
          used: amount !== undefined ? finiteOrNull(amount.used) : null,
          total:
            amount !== null && amount !== undefined
              ? finiteOrNull(amount.limit)
              : null,
          resetAt: window !== undefined ? finiteOrNull(window.resetsAt) : null,
        } satisfies OmpUsageLimit,
      ];
    });
  }

  function finiteOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  // -------------------------------------------------------------------------
  // Store plumbing
  // -------------------------------------------------------------------------

  async function storedAccounts(): Promise<StoredOmpAccount[]> {
    const accounts = await store.listStored("omp");
    return accounts.filter(
      (account): account is StoredOmpAccount => account.provider === "omp",
    );
  }

  function accountFromReport(
    report: OmpReport,
    existing: StoredOmpAccount | undefined,
  ): StoredOmpAccount {
    const now = clock.now();
    return {
      provider: "omp",
      id: ompAccountId(report.ompProviderId, report.accountKey),
      status: "active",
      statusReason: report.noUsage
        ? "agent reports no usage endpoint for this account"
        : null,
      quotaQueryLastError: null,
      quotaQueryLastErrorAt: null,
      usageUpdatedAt: report.noUsage ? (existing?.usageUpdatedAt ?? null) : now,
      createdAt: existing?.createdAt ?? now,
      lastUsed: now,
      ompProviderId: report.ompProviderId,
      accountKey: report.accountKey,
      displayLabel: report.displayLabel,
      email: report.email,
      keyFingerprint: report.keyFingerprint,
      limits: report.limits,
    };
  }

  function matchReport(
    reports: readonly OmpReport[],
    account: StoredOmpAccount,
  ): OmpReport | undefined {
    return reports.find(
      (report) =>
        report.ompProviderId === account.ompProviderId &&
        report.accountKey === account.accountKey,
    );
  }

  async function summaryOf(accountId: string): Promise<AccountSummary> {
    const summaries = await store.list("omp");
    const match = summaries.find((summary) => summary.id === accountId);
    if (match == null) {
      throw new Error("Oh My Pi account is missing from the private store");
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // ProviderAdapter
  // -------------------------------------------------------------------------

  async function list(): Promise<AccountSummary[]> {
    return store.list("omp");
  }

  async function discoverImports(
    signal: AbortSignal,
  ): Promise<ImportCandidate[]> {
    let snapshot: OmpUsageSnapshot;
    try {
      snapshot = await runUsage(signal);
    } catch {
      // A missing or failing omp CLI simply offers no candidates; the
      // login notice below explains how accounts are created instead.
      return [];
    }
    return snapshot.reports.map((report) => ({
      provider: "omp" as const,
      source: "subprocess" as const,
      label: report.displayLabel,
      path: null,
    }));
  }

  async function importAccount(
    candidate: ImportCandidate,
    signal: AbortSignal,
  ): Promise<AccountSummary[]> {
    const { reports } = await runUsage(signal);
    const report = reports.find(
      (entry) => entry.displayLabel === candidate.label,
    );
    if (report === undefined) {
      throw new Error(
        "That account is no longer listed by `omp usage` — refresh discovery and try again",
      );
    }
    const existing = (await storedAccounts()).find(
      (account) =>
        account.ompProviderId === report.ompProviderId &&
        account.accountKey === report.accountKey,
    );
    await store.upsert("omp", accountFromReport(report, existing));
    return [
      await summaryOf(ompAccountId(report.ompProviderId, report.accountKey)),
    ];
  }

  async function beginAuth(): Promise<AuthFlow> {
    throw new Error(IMPORT_ONLY_MESSAGE);
  }

  async function refresh(
    accountId: string,
    signal: AbortSignal,
  ): Promise<AccountSummary> {
    const current = (await storedAccounts()).find(
      (account) => account.id === accountId,
    );
    if (current == null) {
      throw new Error("Oh My Pi account is missing from the private store");
    }
    let snapshot: OmpUsageSnapshot;
    try {
      snapshot = await runUsage(signal);
    } catch (error) {
      const now = clock.now();
      await store.upsert("omp", {
        ...current,
        quotaQueryLastError: `omp usage failed: ${errorText(error)}`,
        quotaQueryLastErrorAt: now,
        lastUsed: now,
      });
      return summaryOf(accountId);
    }
    const report = matchReport(snapshot.reports, current);
    if (report === undefined) {
      const now = clock.now();
      await store.upsert("omp", {
        ...current,
        status: "requiresReauthentication",
        statusReason: "no longer listed by `omp usage`",
        quotaQueryLastError: null,
        quotaQueryLastErrorAt: null,
        lastUsed: now,
      });
      return summaryOf(accountId);
    }
    await store.upsert("omp", accountFromReport(report, current));
    return summaryOf(accountId);
  }

  async function refreshAll(signal: AbortSignal): Promise<AccountSummary[]> {
    const accounts = await storedAccounts();
    let snapshot: OmpUsageSnapshot | undefined;
    let cliError: unknown;
    try {
      snapshot = await runUsage(signal);
    } catch (error) {
      cliError = error;
    }
    for (const account of accounts) {
      if (signal.aborted) {
        break;
      }
      try {
        if (snapshot === undefined) {
          const now = clock.now();
          await store.upsert("omp", {
            ...account,
            quotaQueryLastError: `omp usage failed: ${errorText(cliError)}`,
            quotaQueryLastErrorAt: now,
            lastUsed: now,
          });
          continue;
        }
        const report = matchReport(snapshot.reports, account);
        if (report === undefined) {
          const now = clock.now();
          await store.upsert("omp", {
            ...account,
            status: "requiresReauthentication",
            statusReason: "no longer listed by `omp usage`",
            quotaQueryLastError: null,
            quotaQueryLastErrorAt: null,
            lastUsed: now,
          });
        } else {
          await store.upsert("omp", accountFromReport(report, account));
        }
      } catch {
        // Per-account failures keep their prior safe quota (store merge).
      }
    }
    return store.list("omp");
  }

  async function remove(accountId: string): Promise<void> {
    await store.remove("omp", accountId);
  }

  return {
    list,
    discoverImports,
    import: importAccount,
    beginAuth,
    refresh,
    refreshAll,
    remove,
  };
}
