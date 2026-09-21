/**
 * Gajae Code adapter: discovers and refreshes the token-free account
 * inventory exposed by `gjc accounts`. GJC keeps credentials in its own
 * store; Fuel Gauge persists only identity and normalized quota snapshots.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { asRecord } from "../core/discovery.js";
import { gjcAccountId, md5Hex } from "../core/ids.js";
import { SubprocessError } from "../core/subprocess.js";
import type {
  AccountSummary,
  GjcCredentialKind,
  GjcCredentialSource,
  ImportCandidate,
  OmpUsageLimit,
  StoredGjcAccount,
} from "../core/types.js";
import type { RuntimeDependencies } from "../runtime.js";
import type { AuthFlow, ProviderAdapter } from "./provider.js";

const ACCOUNTS_TIMEOUT_MS = 90_000;

/**
 * Variables stripped from the `gjc` child environment.
 *
 * omp exports `PI_CODING_AGENT_DIR` (its own agent directory, per profile),
 * and GJC's path resolver reads that same name as the legacy alias of
 * `GJC_CODING_AGENT_DIR`. Inheriting it therefore points every `gjc accounts`
 * call at omp's `agent.db` — whose auth schema can be newer than the one GJC
 * understands, failing the command outright ("no such column: revision").
 * Stripping the alias leaves GJC resolving its own agent directory
 * (`GJC_CODING_AGENT_DIR`, else `~/.gjc/agent`), which is the store the user
 * actually logged into.
 */
const GJC_SANITIZED_ENV: readonly string[] = ["PI_CODING_AGENT_DIR"];

/** Resolves GJC's credential database the way the `gjc` CLI itself does. */
export function gjcAgentDbPath(env: NodeJS.ProcessEnv): string {
  const override = env.GJC_CODING_AGENT_DIR?.trim();
  // PI_CODING_AGENT_DIR is deliberately NOT honored: GJC treats it as a
  // legacy alias of its own variable, so following it here would read
  // omp's agent.db instead of the store the user logged into (the same
  // trap GJC_SANITIZED_ENV defends the subprocess against).
  const agentDir =
    override != null && override !== ""
      ? override
      : join(homedir(), ".gjc", "agent");
  return join(agentDir, "agent.db");
}

/**
 * md5 fingerprints of GJC's stored api keys, keyed by credential row id.
 *
 * GJC's CLI inventory is payload-free by design, so identity-less api-key
 * accounts (identityLabel null) carry nothing the dashboard could merge
 * on. GJC does keep the raw key in `auth_credentials.data` of its own
 * `agent.db`, though; reading it here — transiently, readonly, keeping
 * only the non-secret md5 — yields the same fingerprint format omp and
 * opencode already use, letting the same key merge across agents.
 *
 * Mirrors GJC's resolution semantics (auth-storage.ts): a `!`-prefixed
 * key is a config reference GJC resolves itself (skipped — the value is
 * not on disk), any other value resolves through the environment first
 * and falls back to the stored literal. Every failure mode (missing
 * database, migrated schema, locked file) yields an empty map: the
 * fingerprint is best-effort and never blocks the CLI inventory.
 */
export function gjcKeyFingerprints(
  dbPath: string,
  env: NodeJS.ProcessEnv,
): Map<number, string> {
  const fingerprints = new Map<number, string>();
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
    const statement = database.prepare(
      "SELECT id, credential_type, data FROM auth_credentials WHERE disabled_cause IS NULL",
    );
    for (const row of statement.all()) {
      const record = asRecord(row);
      const id = record?.id;
      if (record == null || typeof id !== "number" || !Number.isFinite(id)) {
        continue;
      }
      if (record.credential_type !== "api_key") {
        continue;
      }
      let key: unknown;
      try {
        key = asRecord(JSON.parse(String(record.data)))?.key;
      } catch {
        continue;
      }
      if (typeof key !== "string" || key === "" || key.startsWith("!")) {
        continue;
      }
      fingerprints.set(id, md5Hex(env[key] ?? key));
    }
  } catch {
    return new Map<number, string>();
  } finally {
    database?.close();
  }
  return fingerprints;
}

const IMPORT_ONLY_MESSAGE =
  "Accounts are managed by the gjc CLI. Log in with `/login` inside gjc, " +
  "then restart Fuel Gauge to discover the account.";

const GJC_PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic Claude",
  "openai-codex": "ChatGPT Codex",
  "openai-codex-device": "ChatGPT Codex (device)",
  cursor: "Cursor",
  "github-copilot": "GitHub Copilot",
  "google-antigravity": "Antigravity",
  "google-gemini-cli": "Gemini CLI",
  "opencode-zen": "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  "kimi-code": "Kimi Code",
  moonshot: "Moonshot",
  zai: "Z.AI (GLM)",
  "minimax-code": "MiniMax",
  "grok-build": "Grok Build",
  "minimax-code-cn": "MiniMax (CN)",
  xai: "xAI Grok",
  "alibaba-token-plan": "Alibaba Token Plan",
  "qwen-portal": "Qwen Portal",
  "gitlab-duo": "GitLab Duo",
  firepass: "Fire Pass",
  perplexity: "Perplexity",
  "xiaomi-token-plan": "Xiaomi Token Plan",
};

interface GjcReport {
  sourceId: string;
  /** Numeric `auth_credentials` row id; links the inventory row to agent.db. */
  credentialId: number | null;
  gjcProviderId: string;
  credentialKind: GjcCredentialKind;
  credentialSource: GjcCredentialSource;
  displayLabel: string;
  email: string | null;
  identityLabel: string | null;
  /** md5 of the stored api key when agent.db yields one; else `null`. */
  keyFingerprint: string | null;
  limits: OmpUsageLimit[];
  usageFetchedAt: number | null;
  freshness: "fresh" | "stale-last-good" | null;
  disabled: boolean;
  healthFailed: boolean;
}

interface GjcInventorySnapshot {
  reports: GjcReport[];
  checkCommandFailed: boolean;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Attaches agent.db key fingerprints to inventory rows by credential id. */
function attachKeyFingerprints(reports: GjcReport[]): void {
  const fingerprints = gjcKeyFingerprints(
    gjcAgentDbPath(process.env),
    process.env,
  );
  if (fingerprints.size === 0) {
    return;
  }
  for (const report of reports) {
    if (report.credentialKind !== "api_key" || report.credentialId === null) {
      continue;
    }
    const fingerprint = fingerprints.get(report.credentialId);
    if (fingerprint !== undefined) {
      report.keyFingerprint = fingerprint;
    }
  }
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const clean = value.trim();
  return clean === "" ? null : clean.slice(0, 160);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function remainingPercent(amount: Record<string, unknown>): number | null {
  const remainingFraction = finiteOrNull(amount.remainingFraction);
  if (remainingFraction !== null) {
    return clampPercent(remainingFraction * 100);
  }
  const usedFraction = finiteOrNull(amount.usedFraction);
  if (usedFraction !== null) {
    return clampPercent((1 - usedFraction) * 100);
  }
  const remaining = finiteOrNull(amount.remaining);
  const used = finiteOrNull(amount.used);
  const total = finiteOrNull(amount.limit);
  if (total !== null && total > 0) {
    if (remaining !== null) {
      return clampPercent((remaining / total) * 100);
    }
    if (used !== null) {
      return clampPercent((1 - used / total) * 100);
    }
  }
  if (amount.unit === "percent") {
    if (remaining !== null) {
      return clampPercent(remaining);
    }
    if (used !== null) {
      return clampPercent(100 - used);
    }
  }
  return null;
}

function parseLimits(value: unknown, gjcProviderId: string): OmpUsageLimit[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const limit = asRecord(entry);
    const id = textOrNull(limit?.id);
    const label = textOrNull(limit?.label);
    const amount = asRecord(limit?.amount);
    if (limit === undefined || id === null || label === null || amount === undefined) {
      return [];
    }
    const window = asRecord(limit.window);
    return [
      {
        id: `gjc.${gjcProviderId}.${id}`,
        label,
        windowLabel: textOrNull(window?.label) ?? "",
        remainingPercent: remainingPercent(amount),
        used: finiteOrNull(amount.used),
        total: finiteOrNull(amount.limit),
        resetAt: finiteOrNull(window?.resetsAt),
      } satisfies OmpUsageLimit,
    ];
  });
}

function parseCredentialKind(value: unknown): GjcCredentialKind | null {
  return value === "oauth" || value === "api_key" ? value : null;
}

function parseCredentialSource(value: unknown): GjcCredentialSource | null {
  return value === "stored" ||
    value === "env" ||
    value === "config" ||
    value === "runtime"
    ? value
    : null;
}

function baseDisplayLabel(report: Omit<GjcReport, "displayLabel">): string {
  const providerName = GJC_PROVIDER_NAMES[report.gjcProviderId] ?? report.gjcProviderId;
  const identity =
    report.identityLabel ??
    (report.credentialKind === "api_key" ? "API key" : "OAuth account");
  return `${providerName} · ${identity}`;
}

const CANDIDATE_ID_MARKER = " · gjc ID ";

function importCandidateLabel(report: GjcReport): string {
  return `${report.displayLabel}${CANDIDATE_ID_MARKER}${gjcAccountId(
    report.gjcProviderId,
    report.sourceId,
  )}`;
}

function importCandidateId(label: string): string | null {
  const marker = label.lastIndexOf(CANDIDATE_ID_MARKER);
  if (marker === -1) {
    return null;
  }
  const id = label.slice(marker + CANDIDATE_ID_MARKER.length);
  return /^gjc_[0-9a-f]{32}$/.test(id) ? id : null;
}

function parseInventory(stdout: string): GjcReport[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown parse error";
    throw new Error(`gjc accounts output is not valid JSON: ${message}`);
  }
  const root = asRecord(parsed);
  if (!Array.isArray(root?.accounts)) {
    throw new Error("gjc accounts output has no accounts array");
  }

  const reportsWithoutLabels = root.accounts.flatMap(
    (entry): Array<Omit<GjcReport, "displayLabel">> => {
      const account = asRecord(entry);
      const sourceId = textOrNull(account?.id);
      const gjcProviderId = textOrNull(account?.provider);
      const credentialKind = parseCredentialKind(account?.credentialKind);
      const credentialSource = parseCredentialSource(account?.source);
      if (
        account === undefined ||
        sourceId === null ||
        gjcProviderId === null ||
        credentialKind === null ||
        credentialSource === null
      ) {
        return [];
      }
      const identityLabel = textOrNull(account.identityLabel);
      const usage = asRecord(account.usage);
      const usageReport = asRecord(usage?.report);
      const health = asRecord(account.health);
      return [
        {
          sourceId,
          credentialId: finiteOrNull(account?.credentialId),
          gjcProviderId,
          credentialKind,
          credentialSource,
          identityLabel,
          email: identityLabel?.includes("@") === true
            ? identityLabel.toLowerCase()
            : null,
          keyFingerprint: null,
          limits: parseLimits(usageReport?.limits, gjcProviderId),
          usageFetchedAt:
            finiteOrNull(usage?.fetchedAt) ?? finiteOrNull(usageReport?.fetchedAt),
          freshness:
            usage?.freshness === "fresh"
              ? "fresh"
              : usage?.freshness === "stale-last-good"
                ? "stale-last-good"
                : null,
          disabled: account.disabled === true,
          healthFailed: health?.status === "failed",
        },
      ];
    },
  );

  return reportsWithoutLabels.map((report) => ({
    ...report,
    displayLabel: baseDisplayLabel(report),
  }));
}

export function createGjcProvider(deps: RuntimeDependencies): ProviderAdapter {
  const { store, clock, subprocess } = deps;

  async function gjcBinary(): Promise<string> {
    const settings = await store.loadSettings();
    const override = settings.importPathOverrides.gjc?.trim();
    return override != null && override !== "" ? override : "gjc";
  }

  async function runList(
    binary: string,
    signal: AbortSignal,
  ): Promise<GjcReport[]> {
    const result = await subprocess.run(binary, ["accounts", "list", "--json"], {
      timeoutMs: ACCOUNTS_TIMEOUT_MS,
      signal,
      envRemove: GJC_SANITIZED_ENV,
    });
    const reports = parseInventory(result.stdout);
    attachKeyFingerprints(reports);
    return reports;
  }

  async function runInventory(
    signal: AbortSignal,
    providerId?: string,
  ): Promise<GjcInventorySnapshot> {
    const binary = await gjcBinary();
    let checkCommandFailed = false;
    let checkExitedOne = false;
    try {
      await subprocess.run(
        binary,
        ["accounts", "check", ...(providerId == null ? [] : [providerId]), "--json"],
        { timeoutMs: ACCOUNTS_TIMEOUT_MS, signal, envRemove: GJC_SANITIZED_ENV },
      );
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      // Exit 1 is GJC's documented aggregate result when any account row
      // fails; list carries the per-row health. Spawn/timeout/output failures
      // are command-level and apply to every returned cached row.
      checkExitedOne =
        error instanceof SubprocessError &&
        error.code === "failed" &&
        error.exitCode === 1;
      checkCommandFailed = !checkExitedOne;
    }
    const reports = await runList(binary, signal);
    if (checkExitedOne && !reports.some((report) => report.healthFailed)) {
      // Exit 1 without a failed inventory row is an internal command error,
      // not GJC's documented aggregate account-check result.
      checkCommandFailed = true;
    }
    return { reports, checkCommandFailed };
  }

  async function storedAccounts(): Promise<StoredGjcAccount[]> {
    const accounts = await store.listStored("gjc");
    return accounts.filter(
      (account): account is StoredGjcAccount => account.provider === "gjc",
    );
  }

  function accountFromReport(
    report: GjcReport,
    existing: StoredGjcAccount | undefined,
    checkCommandFailed: boolean,
  ): StoredGjcAccount {
    const now = clock.now();
    const unavailable = report.disabled;
    const noUsage = report.limits.length === 0;
    const statusReason = report.disabled
      ? "gjc reports this credential is disabled"
      : report.healthFailed
        ? "gjc account check failed"
        : noUsage
          ? "gjc reports no usage endpoint for this account"
          : report.freshness === "stale-last-good"
            ? "gjc usage cache is stale"
            : null;
    return {
      provider: "gjc",
      id: gjcAccountId(report.gjcProviderId, report.sourceId),
      status: unavailable ? "requiresReauthentication" : "active",
      statusReason,
      quotaQueryLastError:
        report.healthFailed || checkCommandFailed
          ? "gjc account check failed"
          : null,
      quotaQueryLastErrorAt:
        report.healthFailed || checkCommandFailed ? now : null,
      usageUpdatedAt: noUsage
        ? (existing?.usageUpdatedAt ?? null)
        : (report.usageFetchedAt ?? now),
      createdAt: existing?.createdAt ?? now,
      lastUsed: now,
      gjcProviderId: report.gjcProviderId,
      sourceId: report.sourceId,
      credentialKind: report.credentialKind,
      credentialSource: report.credentialSource,
      displayLabel: report.displayLabel,
      email: report.email,
      identityLabel: report.identityLabel,
      keyFingerprint: report.keyFingerprint,
      limits: report.limits,
    };
  }

  function matchReport(
    reports: readonly GjcReport[],
    account: StoredGjcAccount,
  ): GjcReport | undefined {
    return reports.find(
      (report) =>
        report.gjcProviderId === account.gjcProviderId &&
        report.sourceId === account.sourceId,
    );
  }

  async function summaryOf(accountId: string): Promise<AccountSummary> {
    const summary = (await store.list("gjc")).find((entry) => entry.id === accountId);
    if (summary === undefined) {
      throw new Error("gjc account is missing from the private store");
    }
    return summary;
  }

  async function list(): Promise<AccountSummary[]> {
    return store.list("gjc");
  }

  async function discoverImports(signal: AbortSignal): Promise<ImportCandidate[]> {
    try {
      // Discovery is cache-only: do not make GJC read credentials or call
      // provider APIs until the user confirms an import.
      const reports = await runList(await gjcBinary(), signal);
      return reports
        .filter((report) => !report.disabled)
        .map((report) => ({
          provider: "gjc" as const,
          source: "subprocess" as const,
          label: importCandidateLabel(report),
          path: null,
        }));
    } catch {
      return [];
    }
  }

  async function importAccount(
    candidate: ImportCandidate,
    signal: AbortSignal,
  ): Promise<AccountSummary[]> {
    const requestedId = importCandidateId(candidate.label);
    const snapshot = await runInventory(signal);
    const report = snapshot.reports.find(
      (entry) =>
        !entry.disabled &&
        requestedId === gjcAccountId(entry.gjcProviderId, entry.sourceId),
    );
    if (report === undefined) {
      throw new Error(
        "That account is no longer listed by `gjc accounts` — refresh discovery and try again",
      );
    }
    const existing = (await storedAccounts()).find(
      (account) =>
        account.gjcProviderId === report.gjcProviderId &&
        account.sourceId === report.sourceId,
    );
    const account = accountFromReport(
      report,
      existing,
      snapshot.checkCommandFailed,
    );
    await store.upsert("gjc", account);
    return [await summaryOf(account.id)];
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
    if (current === undefined) {
      throw new Error("gjc account is missing from the private store");
    }
    let snapshot: GjcInventorySnapshot;
    try {
      snapshot = await runInventory(signal, current.gjcProviderId);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const now = clock.now();
      await store.upsert("gjc", {
        ...current,
        quotaQueryLastError: "gjc accounts failed",
        quotaQueryLastErrorAt: now,
        lastUsed: now,
      });
      return summaryOf(accountId);
    }
    const report = matchReport(snapshot.reports, current);
    if (report === undefined) {
      const now = clock.now();
      await store.upsert("gjc", {
        ...current,
        status: "requiresReauthentication",
        statusReason: "no longer listed by `gjc accounts`",
        quotaQueryLastError: null,
        quotaQueryLastErrorAt: null,
        lastUsed: now,
      });
      return summaryOf(accountId);
    }
    await store.upsert(
      "gjc",
      accountFromReport(report, current, snapshot.checkCommandFailed),
    );
    return summaryOf(accountId);
  }

  async function refreshAll(signal: AbortSignal): Promise<AccountSummary[]> {
    const accounts = await storedAccounts();
    let snapshot: GjcInventorySnapshot | undefined;
    try {
      snapshot = await runInventory(signal);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      snapshot = undefined;
    }
    for (const account of accounts) {
      if (signal.aborted) {
        break;
      }
      try {
        const report = snapshot && matchReport(snapshot.reports, account);
        if (snapshot === undefined) {
          const now = clock.now();
          await store.upsert("gjc", {
            ...account,
            quotaQueryLastError: "gjc accounts failed",
            quotaQueryLastErrorAt: now,
            lastUsed: now,
          });
        } else if (report === undefined) {
          const now = clock.now();
          await store.upsert("gjc", {
            ...account,
            status: "requiresReauthentication",
            statusReason: "no longer listed by `gjc accounts`",
            quotaQueryLastError: null,
            quotaQueryLastErrorAt: null,
            lastUsed: now,
          });
        } else {
          await store.upsert(
            "gjc",
            accountFromReport(report, account, snapshot.checkCommandFailed),
          );
        }
      } catch {
        // Per-account failures retain the prior token-free quota snapshot.
      }
    }
    return store.list("gjc");
  }

  async function remove(accountId: string): Promise<void> {
    await store.remove("gjc", accountId);
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
