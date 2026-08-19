/**
 * Codex (OpenAI) adapter: local auth.json discovery/import, browser OAuth
 * on the fixed 1455 loopback port, and the wham usage API with one
 * refresh-and-retry on 401/403. Behavior is ported from the canonical
 * Rust reference `ref/quota/src-tauri/src/codex.rs`; timestamps are
 * normalized to epoch milliseconds for the shared store.
 */

import { homedir } from "node:os";
import path from "node:path";
import {
  asRecord,
  confirmFirstSource,
  DiscoveryError,
  type DiscoverySource,
  envOverride,
  pathReadable,
  readJsonCredentialFile,
  recordString,
  recordStringAny,
  requireRecord,
} from "../core/discovery.js";
import {
  encodeQueryComponent,
  fetchWithTimeout,
  postForm,
  redactSecrets,
  snippet,
} from "../core/http.js";
import { codexApiKeyIdentity, codexOAuthAccountId } from "../core/ids.js";
import { claimString, decodeJwtPayload } from "../core/jwt.js";
import { newPkcePair, pkceChallenge, randomToken } from "../core/oauth.js";
import { addSeconds, epochSecondsToMs } from "../core/time.js";
import type {
  AccountSummary,
  CodexQuotaSummary,
  ImportCandidate,
  StoredCodexAccount,
  StoredCodexTokens,
} from "../core/types.js";
import type { RuntimeDependencies } from "../runtime.js";
import type {
  AuthFlow,
  BrowserCallbackAuthFlow,
  ProviderAdapter,
} from "./provider.js";

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const OAUTH_AUTHORIZE_ENDPOINT = "https://auth.openai.com/oauth/authorize";
const OAUTH_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
const OAUTH_TIMEOUT_MS = 300_000;
const REAUTHENTICATION_MESSAGE =
  "Codex authorization expired. Reauthenticate to continue.";
const API_KEY_QUOTA_ERROR =
  "API key accounts do not expose Codex web quota in this slice.";
const HTTP_TIMEOUT_MS = 20_000;
const BASE_URL_KEYS: readonly string[] = [
  "base_url",
  "api_base_url",
  "apiBaseUrl",
];
const REFRESH_REJECTION_SIGNALS: readonly string[] = [
  "invalid_grant",
  "refresh token expired",
  "refresh_token_expired",
  "refresh token revoked",
  "refresh_token_revoked",
];

const EMPTY_QUOTA: CodexQuotaSummary = {
  hourlyRemainingPercent: null,
  hourlyResetAt: null,
  hourlyWindowMinutes: null,
  weeklyRemainingPercent: null,
  weeklyResetAt: null,
  weeklyWindowMinutes: null,
};

interface ParsedQuota {
  plan: string | null;
  quota: CodexQuotaSummary;
}

interface QuotaFetchOutcome {
  ok: boolean;
  value?: ParsedQuota;
  errorKind?: "unauthorized" | "other";
  message?: string;
}

interface TokenRefreshOutcome {
  account?: StoredCodexAccount;
  message?: string;
  reauthentication?: boolean;
}

interface OAuthTokensInput {
  idToken: string;
  accessToken: string;
  refreshToken: string | null;
  accountId: string | null;
}

/** Typed, secret-free text for a caught error. */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(snippet(message, 300));
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** `100 - clamp(used_percent ?? 0, 0, 100)`, exactly as the reference. */
function remainingPercent(window: Record<string, unknown>): number {
  const used = numberField(window, "used_percent") ?? 0;
  return 100 - Math.min(100, Math.max(0, used));
}

function windowMinutes(window: Record<string, unknown>): number | null {
  const seconds = numberField(window, "limit_window_seconds");
  if (seconds == null || seconds <= 0) return null;
  return Math.trunc((seconds + 59) / 60);
}

function windowResetAt(
  window: Record<string, unknown>,
  nowMs: number,
): number | null {
  const resetAt = numberField(window, "reset_at");
  if (resetAt != null) return epochSecondsToMs(resetAt);
  const resetAfter = numberField(window, "reset_after_seconds");
  if (resetAfter == null || resetAfter < 0) return null;
  return addSeconds(nowMs, resetAfter);
}

export function createCodexProvider(
  deps: RuntimeDependencies,
): ProviderAdapter {
  const { store, fetch, clock, callbackServer } = deps;

  // -------------------------------------------------------------------------
  // Local discovery and import
  // -------------------------------------------------------------------------

  /** Codex source order: non-empty `$CODEX_HOME/auth.json`, then `~/.codex/auth.json`. */
  function authFilePaths(
    env: Readonly<Record<string, string | undefined>>,
  ): string[] {
    const paths: string[] = [];
    const codexHome = envOverride(env, "CODEX_HOME");
    if (codexHome != null) paths.push(path.join(codexHome, "auth.json"));
    paths.push(path.join(homedir(), ".codex", "auth.json"));
    return paths;
  }

  async function discoverImports(
    signal: AbortSignal,
  ): Promise<ImportCandidate[]> {
    const settings = await store.loadSettings();
    const override = settings.importPathOverrides.codex?.trim();
    const paths = authFilePaths(process.env);
    if (override != null && override !== "") paths.push(override);
    const candidates: ImportCandidate[] = [];
    for (const filePath of paths) {
      if (signal.aborted) break;
      if (await pathReadable(filePath)) {
        candidates.push({
          provider: "codex",
          source: "file",
          label: `Codex auth file (${filePath})`,
          path: filePath,
        });
      }
    }
    return candidates;
  }

  async function importCandidate(
    candidate: ImportCandidate,
    signal: AbortSignal,
  ): Promise<AccountSummary[]> {
    if (candidate.path == null) {
      throw new DiscoveryError(
        "NoCredentialFound",
        "Codex import requires a credential file path",
      );
    }
    // Confirmed-first walk: the explicitly confirmed candidate leads; the
    // remaining discovered sources follow in deterministic precedence. A
    // typed failure (missing/unreadable/corrupt/incomplete) skips to the
    // next source; the first parseable credential wins and is the only one
    // persisted. Source files are only ever read.
    const ordered = await orderedSources(candidate, signal);
    const confirmed = await confirmFirstSource(ordered, signal);
    await store.upsert("codex", confirmed.value);
    return [await summaryOf(confirmed.value.id)];
  }

  async function orderedSources(
    confirmed: ImportCandidate,
    signal: AbortSignal,
  ): Promise<DiscoverySource<StoredCodexAccount>[]> {
    const listed = await discoverImports(signal);
    const chosen = listed.find(
      (entry) =>
        entry.source === confirmed.source &&
        entry.label === confirmed.label &&
        entry.path === confirmed.path,
    );
    const rest =
      chosen != null ? listed.filter((entry) => entry !== chosen) : listed;
    const orderedCandidates = [
      ...(chosen != null ? [chosen] : []),
      ...rest,
      // A confirmed candidate that vanished since discovery still leads.
      ...(chosen == null ? [confirmed] : []),
    ];
    return orderedCandidates.map(
      (entry): DiscoverySource<StoredCodexAccount> => ({
        candidate: entry,
        load: async (loadSignal) => {
          const filePath = entry.path;
          if (filePath == null) {
            throw new DiscoveryError(
              "NoCredentialFound",
              "Codex import requires a credential file path",
            );
          }
          const root = requireRecord(
            await readJsonCredentialFile(filePath, loadSignal),
            "Codex auth file",
            filePath,
          );
          return parseAuthFile(root, filePath);
        },
      }),
    );
  }

  function parseAuthFile(
    root: Record<string, unknown>,
    filePath: string,
  ): StoredCodexAccount {
    const authMode = recordString(root, "auth_mode");
    const tokensRecord = asRecord(root.tokens);
    const mode = authMode?.toLowerCase();
    const apiKey = apiKeyFromAuthFile(root);

    if (mode === "apikey" || tokensRecord == null) {
      if (apiKey == null) {
        if (mode === "keyring" || mode === "auto") {
          throw new DiscoveryError(
            "NoCredentialFound",
            `Codex credentials live in the OS keyring (auth mode "${mode}"), not in ${filePath}`,
            [filePath],
          );
        }
        throw new DiscoveryError(
          "EmptyCredential",
          "Codex auth file has no importable credentials",
          [filePath],
        );
      }
      return buildApiKeyAccount(
        apiKey,
        recordStringAny(root, BASE_URL_KEYS) ?? null,
      );
    }

    const idToken = recordString(tokensRecord, "id_token");
    const accessToken = recordString(tokensRecord, "access_token");
    if (idToken == null || accessToken == null) {
      throw new DiscoveryError(
        "EmptyCredential",
        "Codex auth file tokens are incomplete",
        [filePath],
      );
    }
    return buildOAuthAccount({
      idToken,
      accessToken,
      refreshToken: recordString(tokensRecord, "refresh_token") ?? null,
      accountId: recordString(tokensRecord, "account_id") ?? null,
    });
  }

  function apiKeyFromAuthFile(
    root: Record<string, unknown>,
  ): string | undefined {
    const raw = root.OPENAI_API_KEY;
    return typeof raw === "string" && raw.trim() !== ""
      ? raw.trim()
      : undefined;
  }

  function buildApiKeyAccount(
    apiKey: string,
    apiBaseUrl: string | null,
  ): StoredCodexAccount {
    const identity = codexApiKeyIdentity(apiKey);
    const now = clock.now();
    return {
      provider: "codex",
      id: identity.id,
      email: identity.email,
      authMode: "apikey",
      openAIApiKey: apiKey,
      apiBaseUrl,
      userId: null,
      plan: "API Key",
      accountId: null,
      organizationId: null,
      tokens: null,
      quota: { ...EMPTY_QUOTA },
      status: "active",
      statusReason: null,
      quotaQueryLastError: null,
      quotaQueryLastErrorAt: null,
      usageUpdatedAt: null,
      createdAt: now,
      lastUsed: now,
    };
  }

  function buildOAuthAccount(tokens: OAuthTokensInput): StoredCodexAccount {
    const claims = decodeJwtPayload(tokens.idToken);
    if (claims === undefined) {
      throw new DiscoveryError(
        "CorruptCredential",
        "Invalid Codex JWT token format",
      );
    }
    const authData = asRecord(claims["https://api.openai.com/auth"]);
    const profileData = asRecord(claims["https://api.openai.com/profile"]);
    const email =
      claimString(claims, ["email"]) ??
      (profileData != null ? claimString(profileData, ["email"]) : undefined);
    if (email == null) {
      throw new DiscoveryError(
        "CorruptCredential",
        "Codex id_token does not include an email",
      );
    }
    const userId =
      (authData != null
        ? recordStringAny(authData, ["chatgpt_user_id", "user_id"])
        : undefined) ??
      claimString(claims, ["sub"]) ??
      null;
    const plan =
      authData != null
        ? (recordString(authData, "chatgpt_plan_type") ?? null)
        : null;
    const accountId =
      (authData != null
        ? recordStringAny(authData, ["account_id", "chatgpt_account_id"])
        : undefined) ?? tokens.accountId;
    const organizationId =
      authData != null
        ? (recordStringAny(authData, [
            "organization_id",
            "chatgpt_organization_id",
          ]) ?? null)
        : null;
    const oauthTokens: StoredCodexTokens = {
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
    const now = clock.now();
    return {
      provider: "codex",
      id: codexOAuthAccountId(
        email,
        accountId ?? undefined,
        organizationId ?? undefined,
      ),
      email,
      authMode: "oauth",
      openAIApiKey: null,
      apiBaseUrl: null,
      userId,
      plan,
      accountId,
      organizationId,
      tokens: oauthTokens,
      quota: { ...EMPTY_QUOTA },
      status: "active",
      statusReason: null,
      quotaQueryLastError: null,
      quotaQueryLastErrorAt: null,
      usageUpdatedAt: null,
      createdAt: now,
      lastUsed: now,
    };
  }

  // -------------------------------------------------------------------------
  // Browser OAuth on the fixed 1455 loopback port
  // -------------------------------------------------------------------------

  async function beginAuth(signal: AbortSignal): Promise<AuthFlow> {
    const loginId = randomToken(32);
    const state = randomToken(32);
    const { codeVerifier } = newPkcePair(32);
    const start = buildCodexOAuthStart(loginId, state, codeVerifier);
    const redirectUri = start.callbackUrl;
    const authUrl = start.authUrl;
    const expiresAt = clock.now() + OAUTH_TIMEOUT_MS;

    const server = await callbackServer.start({
      kind: "codex",
      expectedState: state,
      timeoutMs: OAUTH_TIMEOUT_MS,
      signal,
    });

    const result = (async () => {
      try {
        const callback = await server.result;
        const response = await exchangeOAuthCode(
          codeVerifier,
          redirectUri,
          callback.code,
          signal,
        );
        const account = await applyTokenResponse(null, response);
        return [await summaryOf(account.id)];
      } finally {
        await server.close();
      }
    })();

    const flow: BrowserCallbackAuthFlow = {
      mode: "browserCallback",
      provider: "codex",
      authUrl,
      callbackUrl: redirectUri,
      expiresAt,
      result,
      cancel: async () => {
        await server.cancel();
      },
    };
    return flow;
  }

  async function exchangeOAuthCode(
    codeVerifier: string,
    redirectUri: string,
    code: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await postForm(
        OAUTH_TOKEN_ENDPOINT,
        [
          ["grant_type", "authorization_code"],
          ["client_id", OAUTH_CLIENT_ID],
          ["code", code],
          ["redirect_uri", redirectUri],
          ["code_verifier", codeVerifier],
        ],
        { signal, timeoutMs: HTTP_TIMEOUT_MS, fetchImpl: fetch },
      );
    } catch (error) {
      throw new Error(`Codex OAuth token request failed: ${errorText(error)}`);
    }
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Codex OAuth token exchange returned ${response.status} with body length ${body.length}`,
      );
    }
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(
        `Could not parse Codex OAuth token response: ${errorText(error)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Token-response application (login and refresh share this)
  // -------------------------------------------------------------------------

  async function applyTokenResponse(
    existingAccountId: string | null,
    response: unknown,
  ): Promise<StoredCodexAccount> {
    const root = requireRecord(
      response,
      "Codex token response",
      "<token endpoint>",
    );
    if (root.error != null) {
      const description =
        recordString(root, "error_description") ??
        snippet(JSON.stringify(root.error), 200);
      throw new Error(`Codex token response error: ${description}`);
    }
    const idToken = recordString(root, "id_token");
    const accessToken = recordString(root, "access_token");
    if (idToken == null) {
      throw new Error("Codex token response did not include an id_token");
    }
    if (accessToken == null) {
      throw new Error("Codex token response did not include an access_token");
    }
    let refreshToken = recordString(root, "refresh_token") ?? null;
    if (refreshToken == null && existingAccountId != null) {
      refreshToken =
        (await loadAccount(existingAccountId))?.tokens?.refreshToken ?? null;
    }
    const account = buildOAuthAccount({
      idToken,
      accessToken,
      refreshToken,
      accountId: null,
    });
    await store.upsert("codex", account);
    return (await loadAccount(account.id)) ?? account;
  }

  // -------------------------------------------------------------------------
  // Refresh: wham usage with one refresh-and-retry on 401/403
  // -------------------------------------------------------------------------

  async function refresh(
    accountId: string,
    signal: AbortSignal,
  ): Promise<AccountSummary> {
    const account = await requireStoredAccount(accountId);
    if (account.authMode === "apikey") {
      await store.upsert("codex", {
        ...account,
        quotaQueryLastError: API_KEY_QUOTA_ERROR,
        quotaQueryLastErrorAt: clock.now(),
        lastUsed: clock.now(),
      });
      return summaryOf(account.id);
    }

    const first = await fetchQuota(account, signal);
    if (first.ok && first.value != null) {
      return persistQuotaSuccess(account, first.value);
    }
    if (
      !first.ok &&
      first.errorKind !== "unauthorized" &&
      first.message != null
    ) {
      return persistQuotaFailure(account, first.message, false);
    }

    const refreshed = await refreshAccountTokens(account);
    if (refreshed.account == null) {
      return persistQuotaFailure(
        account,
        refreshed.message ?? REAUTHENTICATION_MESSAGE,
        refreshed.reauthentication === true,
      );
    }
    const second = await fetchQuota(refreshed.account, signal);
    if (second.ok && second.value != null) {
      return persistQuotaSuccess(refreshed.account, second.value);
    }
    if (second.errorKind === "unauthorized") {
      return persistQuotaFailure(
        refreshed.account,
        REAUTHENTICATION_MESSAGE,
        true,
      );
    }
    return persistQuotaFailure(
      refreshed.account,
      second.message ?? "Codex quota failed",
      false,
    );
  }

  async function fetchQuota(
    account: StoredCodexAccount,
    signal: AbortSignal,
  ): Promise<QuotaFetchOutcome> {
    const token = account.tokens?.accessToken.trim();
    if (token == null || token === "") {
      return {
        ok: false,
        errorKind: "other",
        message: "Codex account does not have an OAuth access token",
      };
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
    if (account.accountId != null && account.accountId.trim() !== "") {
      headers["ChatGPT-Account-Id"] = account.accountId;
    }
    let response: Response;
    try {
      response = await fetchWithTimeout(
        USAGE_ENDPOINT,
        { headers, signal, timeoutMs: HTTP_TIMEOUT_MS },
        fetch,
      );
    } catch (error) {
      return {
        ok: false,
        errorKind: "other",
        message: `Codex quota request failed: ${errorText(error)}`,
      };
    }
    const body = await response.text();
    if (!response.ok) {
      const message = `Codex quota API returned ${response.status} with body length ${body.length}`;
      if (response.status === 401 || response.status === 403) {
        return { ok: false, errorKind: "unauthorized", message };
      }
      return { ok: false, errorKind: "other", message };
    }
    try {
      return { ok: true, value: parseQuota(JSON.parse(body)) };
    } catch (error) {
      return {
        ok: false,
        errorKind: "other",
        message: `Could not parse Codex quota JSON: ${errorText(error)}`,
      };
    }
  }

  async function refreshAccountTokens(
    account: StoredCodexAccount,
  ): Promise<TokenRefreshOutcome> {
    const refreshToken = account.tokens?.refreshToken?.trim();
    if (refreshToken == null || refreshToken === "") {
      return { message: REAUTHENTICATION_MESSAGE, reauthentication: true };
    }
    let response: Response;
    try {
      response = await postForm(
        OAUTH_TOKEN_ENDPOINT,
        [
          ["grant_type", "refresh_token"],
          ["client_id", OAUTH_CLIENT_ID],
          ["refresh_token", refreshToken],
        ],
        { timeoutMs: HTTP_TIMEOUT_MS, fetchImpl: fetch },
      );
    } catch (error) {
      return {
        message: `Codex token refresh request failed: ${errorText(error)}`,
        reauthentication: false,
      };
    }
    const body = await response.text();
    if (!response.ok) {
      const classified = classifyCodexRefreshFailure(response.status, body);
      return {
        message: classified.message,
        reauthentication: classified.requiresReauthentication,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      return {
        message: `Could not parse Codex token response: ${errorText(error)}`,
        reauthentication: false,
      };
    }
    try {
      return { account: await applyTokenResponse(account.id, parsed) };
    } catch (error) {
      return { message: errorText(error), reauthentication: false };
    }
  }

  async function persistQuotaSuccess(
    account: StoredCodexAccount,
    parsed: ParsedQuota,
  ): Promise<AccountSummary> {
    const now = clock.now();
    const updated: StoredCodexAccount = {
      ...account,
      plan: parsed.plan ?? account.plan,
      quota: parsed.quota,
      quotaQueryLastError: null,
      quotaQueryLastErrorAt: null,
      status: "active",
      statusReason: null,
      usageUpdatedAt: now,
      lastUsed: now,
    };
    await store.upsert("codex", updated);
    return summaryOf(updated.id);
  }

  async function persistQuotaFailure(
    account: StoredCodexAccount,
    message: string,
    reauthentication: boolean,
  ): Promise<AccountSummary> {
    const now = clock.now();
    await store.upsert("codex", {
      ...account,
      quotaQueryLastError: message,
      quotaQueryLastErrorAt: now,
      status: reauthentication ? "requiresReauthentication" : account.status,
      statusReason: reauthentication ? message : account.statusReason,
      lastUsed: now,
    });
    return summaryOf(account.id);
  }

  function parseQuota(raw: unknown): ParsedQuota {
    return parseCodexQuota(raw, clock.now());
  }

  // -------------------------------------------------------------------------
  // Shared adapter operations
  // -------------------------------------------------------------------------

  async function refreshAll(signal: AbortSignal): Promise<AccountSummary[]> {
    const accounts = await store.listStored("codex");
    for (const account of accounts) {
      if (signal.aborted) break;
      try {
        await refresh(account.id, signal);
      } catch {
        // Per-account failures persist their own error state; keep the order.
      }
    }
    return store.list("codex");
  }

  async function summaryOf(accountId: string): Promise<AccountSummary> {
    const summaries = await store.list("codex");
    const match = summaries.find((summary) => summary.id === accountId);
    if (match == null) {
      throw new Error("Codex account is missing from the private store");
    }
    return match;
  }

  async function loadAccount(
    accountId: string,
  ): Promise<StoredCodexAccount | undefined> {
    const accounts = await store.listStored("codex");
    return accounts.find(
      (account): account is StoredCodexAccount =>
        account.provider === "codex" && account.id === accountId,
    );
  }

  async function requireStoredAccount(
    accountId: string,
  ): Promise<StoredCodexAccount> {
    const account = await loadAccount(accountId);
    if (account == null) {
      throw new Error(`Could not read Codex account: ${accountId}`);
    }
    return account;
  }

  return {
    list: () => store.list("codex"),
    discoverImports,
    import: importCandidate,
    beginAuth,
    refresh,
    refreshAll,
    remove: (accountId: string) => store.remove("codex", accountId),
  };
}

/**
 * Reference `parse_quota_from_value`: primary/secondary windows with the
 * exact clamped-remaining, ceil-minutes, and reset normalization rules.
 * Exported for the canonical integration port (Rust `parse_codex_quota_for_test`).
 */
export function parseCodexQuota(raw: unknown, nowMs: number): ParsedQuota {
  const root = asRecord(raw);
  if (root === undefined) {
    throw new Error("Codex usage payload is not an object");
  }
  const rateLimit = asRecord(root.rate_limit);
  const primary =
    rateLimit != null ? asRecord(rateLimit.primary_window) : undefined;
  const secondary =
    rateLimit != null ? asRecord(rateLimit.secondary_window) : undefined;
  return {
    plan: recordString(root, "plan_type") ?? null,
    quota: {
      hourlyRemainingPercent:
        primary != null ? remainingPercent(primary) : null,
      hourlyResetAt: primary != null ? windowResetAt(primary, nowMs) : null,
      hourlyWindowMinutes: primary != null ? windowMinutes(primary) : null,
      weeklyRemainingPercent:
        secondary != null ? remainingPercent(secondary) : null,
      weeklyResetAt: secondary != null ? windowResetAt(secondary, nowMs) : null,
      weeklyWindowMinutes: secondary != null ? windowMinutes(secondary) : null,
    },
  };
}

/**
 * Reference `build_oauth_start`: fixed 1455 loopback callback and the exact
 * authorize-URL parameter order. Exported for the canonical integration
 * port (Rust `build_codex_oauth_start_for_test`).
 */
export function buildCodexOAuthStart(
  loginId: string,
  state: string,
  codeVerifier: string,
): { loginId: string; authUrl: string; callbackUrl: string } {
  const callbackUrl = "http://localhost:1455/auth/callback";
  const authUrl = [
    `${OAUTH_AUTHORIZE_ENDPOINT}?client_id=${encodeQueryComponent(OAUTH_CLIENT_ID)}`,
    "response_type=code",
    `redirect_uri=${encodeQueryComponent(callbackUrl)}`,
    `scope=${encodeQueryComponent(OAUTH_SCOPES)}`,
    `state=${encodeQueryComponent(state)}`,
    `code_challenge=${encodeQueryComponent(pkceChallenge(codeVerifier))}`,
    "code_challenge_method=S256",
    "originator=codex_vscode",
  ].join("&");
  return { loginId, authUrl, callbackUrl };
}

export interface CodexRefreshClassification {
  readonly message: string;
  readonly requiresReauthentication: boolean;
}

/**
 * Reference `classify_token_refresh_failure`: 401/403 and 400-with-known
 * rejection signals are reauthentication; everything else is a temporary
 * failure whose message carries only the status and body length.
 * Exported for the canonical integration port (Rust
 * `classify_codex_refresh_failure_for_test`).
 */
export function classifyCodexRefreshFailure(
  status: number,
  body: string,
): CodexRefreshClassification {
  const normalized = body.toLowerCase();
  const rejected =
    status === 401 ||
    status === 403 ||
    (status === 400 &&
      REFRESH_REJECTION_SIGNALS.some((signalText) =>
        normalized.includes(signalText),
      ));
  if (rejected) {
    return {
      message: REAUTHENTICATION_MESSAGE,
      requiresReauthentication: true,
    };
  }
  return {
    message: `Codex token refresh returned ${status} with body length ${body.length}`,
    requiresReauthentication: false,
  };
}
