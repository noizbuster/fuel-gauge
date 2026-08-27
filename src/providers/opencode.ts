/**
 * OpenCode adapter: discovers every credential in opencode's own
 * `auth.json` and refreshes quota straight from the underlying vendors
 * (Z.AI coding plan, OpenAI ChatGPT, xAI Grok). Like the omp adapter,
 * nothing is ever copied into the Fuel Gauge store: tokens are read from
 * the agent's file transiently during refresh only. There is no
 * Fuel-Gauge-side login — accounts are created with `opencode auth login`
 * and then imported here.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { asRecord, recordString } from "../core/discovery.js";
import { fetchWithTimeout } from "../core/http.js";
import { md5Hex, opencodeAccountId } from "../core/ids.js";
import { quotaWindowLabel } from "../core/store.js";
import type {
  AccountSummary,
  ImportCandidate,
  OmpUsageLimit,
  StoredOpenCodeAccount,
} from "../core/types.js";
import type { RuntimeDependencies } from "../runtime.js";
import type { AuthFlow, ProviderAdapter } from "./provider.js";
import { fetchZaiQuotaLimits } from "./zai-quota.js";

/** Vendor usage calls are quick, but the file read plus API stays bounded. */
const REFRESH_TIMEOUT_MS = 30_000;

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const XAI_BILLING_URL =
  "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

/** opencode provider ids with a known vendor usage endpoint. */
const USAGE_ENDPOINTS = new Set([
  "zai-coding-plan",
  "openai",
  "xai",
  "opencode-go",
]);

const EXPIRED_REASON = "credentials expired — run opencode to refresh";
const NO_USAGE_ENDPOINT_REASON = "no usage endpoint for this provider";
const NO_GO_DASHBOARD_REASON =
  "no usage endpoint: set OPENCODE_GO_WORKSPACE_ID and " +
  "OPENCODE_GO_AUTH_COOKIE (or install the opencode-quota plugin) to " +
  "read the OpenCode Go dashboard";

/** Display names for opencode provider ids (auth.json keys). */
const OPENCODE_PROVIDER_NAMES: Record<string, string> = {
  "zai-coding-plan": "Z.AI Coding Plan",
  zai: "Z.AI",
  openai: "OpenAI (ChatGPT)",
  google: "Google",
  xai: "xAI Grok",
  "opencode-go": "OpenCode Go",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  "github-copilot": "GitHub Copilot",
};

/** Message-only error flattening; never includes error values. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createOpenCodeProvider(
  deps: RuntimeDependencies,
): ProviderAdapter {
  const { store, fetch, clock } = deps;

  // -------------------------------------------------------------------------
  // The agent's credential file (read transiently; never persisted)
  // -------------------------------------------------------------------------

  function authFilePath(
    env: Readonly<Record<string, string | undefined>>,
  ): string {
    const dataHome =
      env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share");
    return path.join(dataHome, "opencode", "auth.json");
  }

  async function readAuthFile(): Promise<Map<string, Record<string, unknown>>> {
    let text: string;
    try {
      text = await readFile(authFilePath(process.env), "utf8");
    } catch {
      throw new Error(
        "opencode auth store not found — run `opencode auth login` first",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `opencode auth store is not valid JSON: ${errorText(error)}`,
      );
    }
    const root = asRecord(parsed);
    const entries = new Map<string, Record<string, unknown>>();
    for (const [id, value] of Object.entries(root ?? {})) {
      const record = asRecord(value);
      if (record != null) {
        entries.set(id, record);
      }
    }
    return entries;
  }

  function credentialType(record: Record<string, unknown>): "api" | "oauth" {
    return record.type === "oauth" ? "oauth" : "api";
  }

  /** Deterministic candidate/import label built from the raw record. */
  function labelForRecord(id: string, record: Record<string, unknown>): string {
    const authType = credentialType(record);
    return displayLabelFor(
      id,
      authType,
      recordString(record, "key") ?? null,
      authType === "oauth"
        ? identityFromAccessToken(recordString(record, "access") ?? null)
        : undefined,
    );
  }

  function displayLabelFor(
    openCodeProviderId: string,
    authType: string,
    apiKey?: string | null,
    identity?: OpenCodeIdentity,
  ): string {
    const name =
      OPENCODE_PROVIDER_NAMES[openCodeProviderId] ?? openCodeProviderId;
    if (authType === "oauth") {
      const label =
        identity?.email != null
          ? identity.email
          : identity?.accountId != null
            ? `id ${identity.accountId.slice(0, 8)}`
            : "OAuth";
      return `${name} · ${label}`;
    }
    // Six masked characters identify the key without exposing it.
    const suffix =
      apiKey != null && apiKey.length >= 8
        ? `API: ${apiKey.slice(0, 3)}..${apiKey.slice(-3)}`
        : "API key";
    return `${name} · ${suffix}`;
  }

  // -------------------------------------------------------------------------
  // Vendor usage APIs (tokens used transiently, never stored)
  // -------------------------------------------------------------------------

  /** ChatGPT subscription windows (`rate_limit.primary/secondary`). */
  async function fetchOpenAiLimits(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<OmpUsageLimit[]> {
    const response = await fetchWithTimeout(
      OPENAI_USAGE_URL,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal,
        timeoutMs: REFRESH_TIMEOUT_MS,
      },
      fetch,
    );
    if (response.status === 401 || response.status === 403) {
      throw new ReauthenticationRequired(EXPIRED_REASON);
    }
    if (!response.ok) {
      throw new Error(
        `OpenAI usage request returned status ${response.status}`,
      );
    }
    const root = asRecord(await response.json());
    const rateLimit = asRecord(root?.rate_limit);
    const windows: [string, string, unknown][] = [
      ["primary_window", "Primary usage", rateLimit?.primary_window],
      ["secondary_window", "Weekly usage", rateLimit?.secondary_window],
    ];
    const now = clock.now();
    return windows.flatMap(([id, label, value]) => {
      const window = asRecord(value);
      if (window === undefined) {
        return [];
      }
      const usedPercent = finiteOrNull(window.used_percent);
      const resetAt = finiteOrNull(window.reset_at);
      const resetAfterSeconds = finiteOrNull(window.reset_after_seconds);
      const windowSeconds = finiteOrNull(window.limit_window_seconds);
      // Same ceil-to-minutes rule as the codex adapter, so both adapters
      // derive identical labels for the same vendor window.
      const windowMinutes =
        windowSeconds != null && windowSeconds > 0
          ? Math.trunc((windowSeconds + 59) / 60)
          : null;
      const windowResetAt =
        resetAt != null && resetAt > 0 && resetAt < 1e12
          ? resetAt * 1000
          : (resetAt ?? null);
      const relativeResetAt =
        resetAfterSeconds != null && resetAfterSeconds >= 0
          ? now + resetAfterSeconds * 1000
          : null;
      return [
        {
          id: `opencode.openai.${id}`,
          label: quotaWindowLabel(windowMinutes, label),
          windowLabel: "",
          remainingPercent:
            usedPercent != null ? 100 - Math.min(100, usedPercent) : null,
          used: null,
          total: null,
          resetAt: windowResetAt ?? relativeResetAt,
        } satisfies OmpUsageLimit,
      ];
    });
  }

  /** xAI Grok subscription credits; shape is mapped defensively. */
  async function fetchXaiLimits(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<OmpUsageLimit[]> {
    const response = await fetchWithTimeout(
      XAI_BILLING_URL,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal,
        timeoutMs: REFRESH_TIMEOUT_MS,
      },
      fetch,
    );
    if (response.status === 401 || response.status === 403) {
      throw new ReauthenticationRequired(EXPIRED_REASON);
    }
    if (!response.ok) {
      throw new Error(`xAI billing request returned status ${response.status}`);
    }
    return parseXaiCredits(await response.json());
  }

  function parseXaiCredits(raw: unknown): OmpUsageLimit[] {
    const root = asRecord(raw);
    if (root === undefined) {
      return [];
    }
    const remaining = finiteOrNull(root.remaining_credits);
    const total = finiteOrNull(root.total_credits);
    const resetsAt = finiteOrNull(root.reset_at);
    if (remaining == null && total == null && resetsAt == null) {
      return [];
    }
    const remainingPercent =
      remaining != null && total != null && total > 0
        ? Math.min(100, Math.max(0, (remaining / total) * 100))
        : null;
    return [
      {
        id: "opencode.xai.credits",
        label: "Grok credits",
        windowLabel: "",
        remainingPercent,
        used:
          total != null && remaining != null
            ? Math.max(0, total - remaining)
            : null,
        total,
        resetAt:
          resetsAt != null && resetsAt > 0 && resetsAt < 1e12
            ? resetsAt * 1000
            : resetsAt,
      } satisfies OmpUsageLimit,
    ];
  }

  /**
   * Dashboard credentials for the OpenCode Go plan: env vars first, then
   * the session cached by the `opencode-quota` plugin (read-only reuse).
   */
  async function openCodeGoDashboardConfig(
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<{ workspaceId: string; authCookie: string } | null> {
    const workspaceId = env.OPENCODE_GO_WORKSPACE_ID?.trim();
    const authCookie = env.OPENCODE_GO_AUTH_COOKIE?.trim();
    if (
      workspaceId != null &&
      authCookie != null &&
      workspaceId !== "" &&
      authCookie !== ""
    ) {
      return { workspaceId, authCookie };
    }
    const configHome = env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
    try {
      const text = await readFile(
        path.join(configHome, "opencode", "opencode-quota", "opencode-go.json"),
        "utf8",
      );
      const root = asRecord(JSON.parse(text));
      const cachedWorkspaceId =
        root != null ? recordString(root, "workspaceId") : undefined;
      const cachedCookie =
        root != null ? recordString(root, "authCookie") : undefined;
      if (cachedWorkspaceId != null && cachedCookie != null) {
        return { workspaceId: cachedWorkspaceId, authCookie: cachedCookie };
      }
    } catch {
      // Missing or unreadable plugin cache; env vars are the manual path.
    }
    return null;
  }

  /**
   * OpenCode Go usage windows (rolling/weekly/monthly) scraped from the
   * workspace dashboard's SolidJS SSR hydration output — the same surface
   * the opencode-quota plugin reads.
   */
  async function fetchOpenCodeGoLimits(
    dashboard: { workspaceId: string; authCookie: string },
    signal: AbortSignal,
  ): Promise<OmpUsageLimit[]> {
    const url = `https://opencode.ai/workspace/${encodeURIComponent(
      dashboard.workspaceId,
    )}/go`;
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0",
          Accept: "text/html",
          Cookie: `auth=${dashboard.authCookie}`,
        },
        signal,
        timeoutMs: REFRESH_TIMEOUT_MS,
      },
      fetch,
    );
    if (response.status === 401 || response.status === 403) {
      throw new ReauthenticationRequired(
        "OpenCode Go dashboard auth expired — refresh OPENCODE_GO_AUTH_COOKIE",
      );
    }
    if (!response.ok) {
      throw new Error(
        `OpenCode Go dashboard returned status ${response.status}`,
      );
    }
    return parseOpenCodeGoDashboard(await response.text(), clock.now());
  }

  function parseOpenCodeGoDashboard(
    html: string,
    nowMs: number,
  ): OmpUsageLimit[] {
    const number = "(-?\\d+(?:\\.\\d+)?)";
    const windows: [string, string][] = [
      ["rollingUsage", "Rolling usage"],
      ["weeklyUsage", "Weekly usage"],
      ["monthlyUsage", "Monthly usage"],
    ];
    const rows: OmpUsageLimit[] = [];
    for (const [field, label] of windows) {
      const pctFirst = new RegExp(
        `${field}:\\$R\\[\\d+\\]=\\{[^}]*?usagePercent:${number}[^}]*?resetInSec:${number}`,
      );
      const resetFirst = new RegExp(
        `${field}:\\$R\\[\\d+\\]=\\{[^}]*?resetInSec:${number}[^}]*?usagePercent:${number}`,
      );
      const pctMatch = pctFirst.exec(html);
      const match = pctMatch ?? resetFirst.exec(html);
      if (match === null) {
        continue;
      }
      const usagePercent = Number(pctMatch !== null ? match[1] : match[2]);
      const resetInSec = Number(pctMatch !== null ? match[2] : match[1]);
      if (!Number.isFinite(usagePercent) || !Number.isFinite(resetInSec)) {
        continue;
      }
      rows.push({
        id: `opencode.go.${field}`,
        label,
        windowLabel: "",
        remainingPercent: Math.min(100, Math.max(0, 100 - usagePercent)),
        used: null,
        total: null,
        resetAt: nowMs + Math.max(0, resetInSec) * 1000,
      });
    }
    return rows;
  }

  // -------------------------------------------------------------------------
  // Account lifecycle
  // -------------------------------------------------------------------------

  async function storedAccounts(): Promise<StoredOpenCodeAccount[]> {
    const accounts = await store.listStored("opencode");
    return accounts.filter(
      (account): account is StoredOpenCodeAccount =>
        account.provider === "opencode",
    );
  }

  function accountFor(
    openCodeProviderId: string,
    authType: "api" | "oauth",
    expiresAt: number | null,
    apiKey: string | null,
    identity: OpenCodeIdentity,
    limits: OmpUsageLimit[],
    status: {
      status: "active" | "requiresReauthentication";
      reason: string | null;
    },
    existing: StoredOpenCodeAccount | undefined,
  ): StoredOpenCodeAccount {
    const now = clock.now();
    return {
      provider: "opencode",
      id: opencodeAccountId(openCodeProviderId),
      status: status.status,
      statusReason: status.reason,
      quotaQueryLastError: null,
      quotaQueryLastErrorAt: null,
      usageUpdatedAt:
        limits.length > 0 ? now : (existing?.usageUpdatedAt ?? null),
      createdAt: existing?.createdAt ?? now,
      lastUsed: now,
      openCodeProviderId,
      authType,
      keyFingerprint:
        authType === "api" && apiKey !== null && apiKey !== ""
          ? md5Hex(apiKey)
          : null,
      email: identity.email,
      expiresAt,
      displayLabel: displayLabelFor(
        openCodeProviderId,
        authType,
        apiKey,
        identity,
      ),
      limits,
    };
  }

  /** Identity decoded from an oauth access token's JWT claims. */
  interface OpenCodeIdentity {
    readonly email: string | null;
    readonly accountId: string | null;
  }

  /**
   * JWT claims survive token expiry, so the identity is readable even
   * when the usage call cannot run. Opaque tokens yield nothing.
   */
  function identityFromAccessToken(
    accessToken: string | null,
  ): OpenCodeIdentity {
    if (accessToken == null) {
      return { email: null, accountId: null };
    }
    const parts = accessToken.split(".");
    if (parts.length !== 3) {
      return { email: null, accountId: null };
    }
    try {
      const payload = asRecord(
        JSON.parse(
          Buffer.from(parts[1] as string, "base64url").toString("utf8"),
        ),
      );
      if (payload == null) {
        return { email: null, accountId: null };
      }
      const profile = asRecord(payload["https://api.openai.com/profile"]);
      const openaiAuth = asRecord(payload["https://api.openai.com/auth"]);
      const email =
        recordString(payload, "email") ??
        (profile != null ? recordString(profile, "email") : undefined) ??
        null;
      const accountId =
        (openaiAuth != null
          ? recordString(openaiAuth, "chatgpt_account_id")
          : undefined) ??
        recordString(payload, "sub") ??
        null;
      return { email, accountId };
    } catch {
      return { email: null, accountId: null };
    }
  }

  async function refreshOne(
    existing: StoredOpenCodeAccount,
    signal: AbortSignal,
  ): Promise<StoredOpenCodeAccount> {
    const entries = await readAuthFile();
    const record = entries.get(existing.openCodeProviderId);
    if (record === undefined) {
      return {
        ...existing,
        status: "requiresReauthentication",
        statusReason: "removed from opencode's credential store",
        lastUsed: clock.now(),
      };
    }
    const authType = credentialType(record);
    const expiresAt = finiteOrNull(record.expires);
    const identity =
      authType === "oauth"
        ? identityFromAccessToken(recordString(record, "access") ?? null)
        : { email: null, accountId: null };
    if (existing.openCodeProviderId === "opencode-go") {
      // The Go plan's usage lives on the web dashboard, not behind the
      // api key; see openCodeGoDashboardConfig for the credential sources.
      const dashboard = await openCodeGoDashboardConfig(process.env);
      if (dashboard === null) {
        return accountFor(
          existing.openCodeProviderId,
          authType,
          expiresAt,
          recordString(record, "key") ?? null,
          identity,
          existing.limits,
          { status: "active", reason: NO_GO_DASHBOARD_REASON },
          existing,
        );
      }
      try {
        const limits = await fetchOpenCodeGoLimits(dashboard, signal);
        return accountFor(
          existing.openCodeProviderId,
          authType,
          expiresAt,
          recordString(record, "key") ?? null,
          identity,
          limits,
          { status: "active", reason: null },
          existing,
        );
      } catch (error) {
        if (error instanceof ReauthenticationRequired) {
          return {
            ...existing,
            status: "requiresReauthentication",
            statusReason: error.message,
            lastUsed: clock.now(),
          };
        }
        const now = clock.now();
        return {
          ...existing,
          quotaQueryLastError: `opencode refresh failed: ${errorText(error)}`,
          quotaQueryLastErrorAt: now,
          lastUsed: now,
        };
      }
    }
    if (!USAGE_ENDPOINTS.has(existing.openCodeProviderId)) {
      // Expiry is irrelevant without a usage call: the account stays
      // listed as active so the dashboard shows it with its reason.
      return accountFor(
        existing.openCodeProviderId,
        authType,
        expiresAt,
        recordString(record, "key") ?? null,
        identity,
        existing.limits,
        {
          status: "active",
          reason:
            existing.openCodeProviderId === "opencode-go"
              ? NO_GO_DASHBOARD_REASON
              : NO_USAGE_ENDPOINT_REASON,
        },
        existing,
      );
    }
    if (authType === "oauth" && expiresAt != null && expiresAt <= clock.now()) {
      return {
        ...existing,
        status: "requiresReauthentication",
        statusReason: EXPIRED_REASON,
        lastUsed: clock.now(),
      };
    }
    const token =
      authType === "api"
        ? recordString(record, "key")
        : recordString(record, "access");
    if (token == null) {
      return {
        ...existing,
        status: "requiresReauthentication",
        statusReason: EXPIRED_REASON,
        lastUsed: clock.now(),
      };
    }
    try {
      let limits: OmpUsageLimit[] = [];
      if (existing.openCodeProviderId === "zai-coding-plan") {
        limits = await fetchZaiQuotaLimits({
          fetch,
          apiKey: token,
          signal,
          timeoutMs: REFRESH_TIMEOUT_MS,
          metricIdPrefix: "opencode",
        });
      } else if (existing.openCodeProviderId === "openai") {
        limits = await fetchOpenAiLimits(token, signal);
      } else {
        limits = await fetchXaiLimits(token, signal);
      }
      return accountFor(
        existing.openCodeProviderId,
        authType,
        expiresAt,
        authType === "api" ? token : null,
        identity,
        limits,
        { status: "active", reason: null },
        existing,
      );
    } catch (error) {
      if (error instanceof ReauthenticationRequired) {
        return {
          ...existing,
          status: "requiresReauthentication",
          statusReason: error.message,
          lastUsed: clock.now(),
        };
      }
      const now = clock.now();
      return {
        ...existing,
        quotaQueryLastError: `opencode refresh failed: ${errorText(error)}`,
        quotaQueryLastErrorAt: now,
        lastUsed: now,
      };
    }
  }

  class ReauthenticationRequired extends Error {}

  async function summaryOf(accountId: string): Promise<AccountSummary> {
    const summaries = await store.list("opencode");
    const match = summaries.find((summary) => summary.id === accountId);
    if (match == null) {
      throw new Error("OpenCode account is missing from the private store");
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // ProviderAdapter
  // -------------------------------------------------------------------------

  async function list(): Promise<AccountSummary[]> {
    return store.list("opencode");
  }

  async function discoverImports(
    signal: AbortSignal,
  ): Promise<ImportCandidate[]> {
    void signal;
    let entries: Map<string, Record<string, unknown>>;
    try {
      entries = await readAuthFile();
    } catch {
      return [];
    }
    return [...entries.keys()].map((id) => ({
      provider: "opencode" as const,
      source: "file" as const,
      label: labelForRecord(id, entries.get(id) ?? {}),
      path: authFilePath(process.env),
    }));
  }

  async function importAccount(
    candidate: ImportCandidate,
    signal: AbortSignal,
  ): Promise<AccountSummary[]> {
    void signal;
    const entries = await readAuthFile();
    const match = [...entries.entries()].find(
      ([id, record]) => labelForRecord(id, record) === candidate.label,
    );
    if (match === undefined) {
      throw new Error(
        "That account is no longer in opencode's credential store — refresh discovery and try again",
      );
    }
    const [id, record] = match;
    const authType = credentialType(record);
    const account = accountFor(
      id,
      authType,
      finiteOrNull(record.expires),
      recordString(record, "key") ?? null,
      authType === "oauth"
        ? identityFromAccessToken(recordString(record, "access") ?? null)
        : { email: null, accountId: null },
      [],
      { status: "active", reason: null },
      (await storedAccounts()).find(
        (stored) => stored.openCodeProviderId === id,
      ),
    );
    await store.upsert("opencode", account);
    return [await summaryOf(account.id)];
  }

  async function beginAuth(): Promise<AuthFlow> {
    throw new Error(
      "OpenCode accounts are managed by the opencode CLI. Log in with " +
        "`opencode auth login <provider>`, then import the account here (a).",
    );
  }

  async function refresh(
    accountId: string,
    signal: AbortSignal,
  ): Promise<AccountSummary> {
    const current = (await storedAccounts()).find(
      (account) => account.id === accountId,
    );
    if (current == null) {
      throw new Error("OpenCode account is missing from the private store");
    }
    await store.upsert("opencode", await refreshOne(current, signal));
    return summaryOf(accountId);
  }

  async function refreshAll(signal: AbortSignal): Promise<AccountSummary[]> {
    const accounts = await storedAccounts();
    for (const account of accounts) {
      if (signal.aborted) {
        break;
      }
      try {
        await store.upsert("opencode", await refreshOne(account, signal));
      } catch {
        // Per-account failures keep their prior safe quota (store merge).
      }
    }
    return store.list("opencode");
  }

  async function remove(accountId: string): Promise<void> {
    await store.remove("opencode", accountId);
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
