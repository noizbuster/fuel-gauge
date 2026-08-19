/**
 * Claude Code adapter: policy-gated discovery (credentials file, macOS
 * Keychain, and the non-refreshable `CLAUDE_CODE_OAUTH_TOKEN` variant),
 * manual-paste OAuth, and the usage API with a hard 180 s quota cooldown.
 *
 * Rules from the approved plan layered over
 * `ref/quota/src-tauri/src/claude.rs`:
 * - Claude is network-silent until `settings.claudePolicyAccepted`.
 * - Every request carries exactly `User-Agent: claude-code/2.1.233`.
 * - The environment-token variant never calls the refresh endpoint; 401/403
 *   marks it reauthentication-required instead.
 * - `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are ignored (different
 *   billing identity).
 */

import { homedir } from "node:os";
import path from "node:path";
import {
  asRecord,
  confirmFirstSource,
  DiscoveryError,
  type DiscoverySource,
  envOverride,
  envTokenPresent,
  pathReadable,
  readJsonCredentialFile,
  recordString,
} from "../core/discovery.js";
import {
  encodeQueryComponent,
  fetchWithTimeout,
  redactSecrets,
  responseFailureMessage,
  snippet,
} from "../core/http.js";
import { claudeAccountId } from "../core/ids.js";
import { newPkcePair, pkceChallenge, randomToken } from "../core/oauth.js";
import { addSeconds } from "../core/time.js";
import type {
  AccountSummary,
  ClaudeQuotaSummary,
  ImportCandidate,
  StoredClaudeAccount,
} from "../core/types.js";
import type { RuntimeDependencies } from "../runtime.js";
import type {
  AuthFlow,
  AuthSubmission,
  ManualCodeAuthFlow,
  ProviderAdapter,
} from "./provider.js";

const OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const OAUTH_CALLBACK_URL = "https://platform.claude.com/oauth/code/callback";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const OAUTH_TIMEOUT_MS = 600_000;
const REAUTHENTICATION_MESSAGE =
  "Claude Code authorization expired. Reauthenticate to continue.";
const OAUTH_SCOPES: readonly string[] = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
const USER_AGENT = "claude-code/2.1.233";
const HTTP_TIMEOUT_MS = 20_000;
const TOKEN_EXPIRY_SKEW_MS = 300_000;
const USAGE_COOLDOWN_MS = 180_000;
const KEYCHAIN_TIMEOUT_MS = 5_000;
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const ENV_TOKEN_NAME = "CLAUDE_CODE_OAUTH_TOKEN";
const REFRESH_REJECTION_SIGNALS: readonly string[] = [
  "invalid_grant",
  "refresh token expired",
  "refresh_token_expired",
  "refresh token revoked",
  "refresh_token_revoked",
];

const EMPTY_QUOTA: ClaudeQuotaSummary = {
  fiveHourRemainingPercent: null,
  fiveHourResetAt: null,
  weeklyRemainingPercent: null,
  weeklyResetAt: null,
  weeklySonnetRemainingPercent: null,
  weeklySonnetResetAt: null,
  extraUsageRemainingPercent: null,
  extraUsageResetAt: null,
  extraUsageUsedCents: null,
  extraUsageLimitCents: null,
};

interface CredentialTokens {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string | null;
  expiresAt: number | null;
  scopes: string[];
}

interface PendingClaudeLogin {
  state: string;
  codeVerifier: string;
  expiresAt: number;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(snippet(message, 300));
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Reference `parse_callback_input`: URL query, `?query`, or a bare code. */
export function parseClaudeCallbackInput(input: string): {
  code: string;
  state: string | null;
} {
  const trimmed = input.trim();
  const queryIndex = trimmed.indexOf("?");
  const query =
    queryIndex >= 0
      ? trimmed.slice(queryIndex + 1)
      : trimmed.startsWith("?")
        ? trimmed.slice(1)
        : null;
  if (query != null && query !== "") {
    const params = parseQueryParams(query);
    const code = params.code;
    if (code != null && code !== "") return cleanCodeAndState(code);
  }
  return cleanCodeAndState(trimmed.replace(/^code=/, ""));
}

function cleanCodeAndState(raw: string): {
  code: string;
  state: string | null;
} {
  let code = raw.trim();
  let state: string | null = null;
  const hashIndex = code.indexOf("#");
  if (hashIndex >= 0) {
    state = textOrNull(code.slice(hashIndex + 1));
    code = code.slice(0, hashIndex);
  }
  const ampersandIndex = code.indexOf("&");
  if (ampersandIndex >= 0) {
    code = code.slice(0, ampersandIndex);
  }
  return { code: code.trim(), state };
}

function parseQueryParams(query: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of query.split("&")) {
    const equalsIndex = pair.indexOf("=");
    const rawKey = equalsIndex >= 0 ? pair.slice(0, equalsIndex) : pair;
    const rawValue = equalsIndex >= 0 ? pair.slice(equalsIndex + 1) : "";
    try {
      params[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    } catch {
      params[rawKey] = rawValue;
    }
  }
  return params;
}

/** Reference `parse_quota_from_value`; reset values normalize to ms. */
export function parseClaudeQuota(raw: unknown): ClaudeQuotaSummary {
  const root = asRecord(raw) ?? {};
  const fiveHour = asRecord(root.five_hour);
  const weekly = asRecord(root.seven_day);
  const weeklySonnet =
    asRecord(root.seven_day_sonnet) ??
    asRecord(root.seven_day_sonnet_4) ??
    asRecord(root.seven_day_model);
  const extraUsage = asRecord(root.extra_usage);
  const extraEnabled = extraUsage?.is_enabled === true;
  return {
    fiveHourRemainingPercent: remainingPercent(fiveHour?.utilization),
    fiveHourResetAt: parseResetSeconds(fiveHour?.resets_at),
    weeklyRemainingPercent: remainingPercent(weekly?.utilization),
    weeklyResetAt: parseResetSeconds(weekly?.resets_at),
    weeklySonnetRemainingPercent:
      weeklySonnet != null ? remainingPercent(weeklySonnet.utilization) : null,
    weeklySonnetResetAt: parseResetSeconds(weeklySonnet?.resets_at),
    extraUsageRemainingPercent: extraEnabled
      ? remainingPercent(extraUsage?.utilization)
      : null,
    extraUsageResetAt: parseResetSeconds(extraUsage?.resets_at),
    extraUsageUsedCents: intOrNull(extraUsage?.used_credits),
    extraUsageLimitCents: intOrNull(extraUsage?.monthly_limit),
  };
}

function remainingPercent(value: unknown): number | null {
  const used = numberOrNull(value);
  if (used == null || !Number.isFinite(used)) return null;
  return Math.min(100, Math.max(0, Math.trunc(100 - Math.round(used))));
}

function parseResetSeconds(value: unknown): number | null {
  const raw = numberOrNull(value);
  if (raw != null) {
    if (raw <= 0) return null;
    // Above the shared threshold the value is already epoch milliseconds.
    return Math.trunc(raw > 10_000_000_000 ? raw : raw * 1000);
  }
  const text = textOrNull(value);
  if (text == null) return null;
  const asNumber = Number(text);
  if (/^\d+$/.test(text) && Number.isFinite(asNumber)) {
    return Math.trunc(asNumber > 10_000_000_000 ? asNumber : asNumber * 1000);
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function intOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed == null ? null : Math.trunc(parsed);
}

/**
 * Reference `build_oauth_start`: manual-callback authorize URL with the
 * exact parameter order (`code=true` first) and S256 challenge.
 * Exported for the canonical integration port (Rust
 * `build_claude_oauth_start_for_test`).
 */
export function buildClaudeOAuthStart(
  loginId: string,
  state: string,
  codeVerifier: string,
): { loginId: string; authUrl: string; callbackUrl: string } {
  const authUrl = [
    `${OAUTH_AUTHORIZE_URL}?code=true`,
    `client_id=${encodeQueryComponent(OAUTH_CLIENT_ID)}`,
    "response_type=code",
    `redirect_uri=${encodeQueryComponent(OAUTH_CALLBACK_URL)}`,
    `scope=${encodeQueryComponent(OAUTH_SCOPES.join(" "))}`,
    `code_challenge=${encodeQueryComponent(pkceChallenge(codeVerifier))}`,
    "code_challenge_method=S256",
    `state=${encodeQueryComponent(state)}`,
  ].join("&");
  return { loginId, authUrl, callbackUrl: OAUTH_CALLBACK_URL };
}

export interface ClaudeRefreshClassification {
  readonly message: string;
  readonly requiresReauthentication: boolean;
}

/**
 * Reference `classify_token_refresh_failure`. Exported for the canonical
 * integration port (Rust `classify_claude_refresh_failure_for_test`).
 */
export function classifyClaudeRefreshFailure(
  status: number,
  body: string,
): ClaudeRefreshClassification {
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
    message: `Claude token refresh returned ${status} with body length ${body.length}`,
    requiresReauthentication: false,
  };
}

export function createClaudeProvider(
  deps: RuntimeDependencies,
): ProviderAdapter {
  const { store, fetch, clock, subprocess } = deps;

  /** Claude stays network-silent (and invisible) until the policy is accepted. */
  async function policyAccepted(): Promise<boolean> {
    const settings = await store.loadSettings();
    return settings.claudePolicyAccepted;
  }

  // -------------------------------------------------------------------------
  // Discovery (policy-gated)
  // -------------------------------------------------------------------------

  async function discoverImports(
    signal: AbortSignal,
  ): Promise<ImportCandidate[]> {
    if (!(await policyAccepted())) return [];
    const settings = await store.loadSettings();
    const override = settings.importPathOverrides.claude?.trim();
    const candidates: ImportCandidate[] = [];
    if (process.platform === "darwin") {
      const account =
        envOverride(process.env, "USER") ?? envOverride(process.env, "LOGNAME");
      if (account != null) {
        candidates.push({
          provider: "claude",
          source: "keychain",
          label: `macOS Keychain (${KEYCHAIN_SERVICE})`,
          path: null,
        });
      }
    }
    const filePaths: string[] = [];
    const configDir = envOverride(process.env, "CLAUDE_CONFIG_DIR");
    if (process.platform !== "darwin" && configDir != null) {
      filePaths.push(path.join(configDir, ".credentials.json"));
    }
    filePaths.push(path.join(homedir(), ".claude", ".credentials.json"));
    if (override != null && override !== "") filePaths.push(override);
    for (const filePath of filePaths) {
      if (signal.aborted) break;
      if (await pathReadable(filePath)) {
        candidates.push({
          provider: "claude",
          source: "file",
          label: `Claude credentials (${filePath})`,
          path: filePath,
        });
      }
    }
    if (envTokenPresent(process.env, ENV_TOKEN_NAME)) {
      candidates.push({
        provider: "claude",
        source: "env",
        label: `${ENV_TOKEN_NAME} environment variable (non-refreshable)`,
        path: null,
      });
    }
    return candidates;
  }

  async function importCandidate(
    candidate: ImportCandidate,
    signal: AbortSignal,
  ): Promise<AccountSummary[]> {
    if (!(await policyAccepted())) {
      throw new Error(
        "Claude integration is disabled until the policy is acknowledged.",
      );
    }
    // Confirmed-first walk (see the Codex adapter): the confirmed source
    // leads — Keychain first on macOS, then CLAUDE_CONFIG_DIR (non-darwin),
    // ~/.claude/.credentials.json, the override, and finally the
    // non-refreshable env token. Typed failures skip forward; only the
    // winning account is persisted, once, after the walk.
    const listed = await discoverImports(signal);
    const chosen = listed.find(
      (entry) =>
        entry.source === candidate.source &&
        entry.label === candidate.label &&
        entry.path === candidate.path,
    );
    const rest =
      chosen != null ? listed.filter((entry) => entry !== chosen) : listed;
    const ordered = [...(chosen != null ? [chosen] : [candidate]), ...rest].map(
      (entry): DiscoverySource<StoredClaudeAccount> => ({
        candidate: entry,
        load: (loadSignal) => loadConfirmedSource(entry, loadSignal),
      }),
    );
    const confirmed = await confirmFirstSource(ordered, signal);
    await store.upsert("claude", confirmed.value);
    return [await summaryOf(confirmed.value.id)];
  }

  /** Reads and builds (never persists) one Claude source. */
  async function loadConfirmedSource(
    entry: ImportCandidate,
    signal: AbortSignal,
  ): Promise<StoredClaudeAccount> {
    if (entry.source === "env") {
      const token = process.env[ENV_TOKEN_NAME]?.trim();
      if (token == null || token === "") {
        throw new DiscoveryError(
          "EmptyCredential",
          `${ENV_TOKEN_NAME} is empty`,
        );
      }
      return buildEnvironmentAccount(token, signal);
    }
    if (entry.source === "keychain") {
      const json = await readKeychainCredentials(signal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (error) {
        throw new DiscoveryError(
          "CorruptCredential",
          `Claude Keychain credentials are not valid JSON: ${errorText(error)}`,
        );
      }
      return buildCredentialAccount(parsed, "Keychain", signal);
    }
    const filePath = entry.path;
    if (filePath == null) {
      throw new DiscoveryError(
        "NoCredentialFound",
        "Claude import requires a credential file path",
      );
    }
    return buildCredentialAccount(
      await readJsonCredentialFile(filePath, signal),
      filePath,
      signal,
    );
  }

  async function readKeychainCredentials(signal: AbortSignal): Promise<string> {
    const account =
      envOverride(process.env, "USER") ?? envOverride(process.env, "LOGNAME");
    if (account == null) {
      throw new DiscoveryError(
        "SourceProtected",
        "Could not determine the current macOS user for the Keychain lookup",
      );
    }
    const result = await subprocess.run(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { timeoutMs: KEYCHAIN_TIMEOUT_MS, signal },
    );
    return result.stdout;
  }

  /**
   * Builds a `.credentials.json`/Keychain account without persisting. The
   * profile probe is required (it supplies the account identity); a failed
   * probe skips the source with a typed error.
   */
  async function buildCredentialAccount(
    parsedCredential: unknown,
    originLabel: string,
    signal: AbortSignal,
  ): Promise<StoredClaudeAccount> {
    const root = asRecord(parsedCredential);
    const oauth = root != null ? asRecord(root.claudeAiOauth) : undefined;
    if (oauth == null) {
      throw new DiscoveryError(
        "EmptyCredential",
        `Claude credentials have no claudeAiOauth block (${originLabel})`,
      );
    }
    const accessToken =
      recordString(oauth, "accessToken") ?? recordString(oauth, "access_token");
    if (accessToken == null) {
      throw new DiscoveryError(
        "EmptyCredential",
        "Claude credentials have no access token",
      );
    }
    const tokens: CredentialTokens = {
      accessToken,
      refreshToken:
        recordString(oauth, "refreshToken") ??
        recordString(oauth, "refresh_token") ??
        null,
      tokenType:
        recordString(oauth, "tokenType") ??
        recordString(oauth, "token_type") ??
        null,
      expiresAt:
        numberOrNull(oauth.expiresAt) ?? numberOrNull(oauth.expires_at),
      scopes: readScopes(oauth.scopes),
    };
    // The profile probe is required (it supplies the account identity); a
    // failed probe is a typed skip so the walk can continue.
    let profile: Record<string, unknown> | undefined;
    try {
      profile = await requestProfile(tokens.accessToken, signal);
    } catch (error) {
      throw new DiscoveryError(
        "NoCredentialFound",
        `Claude profile probe failed (${originLabel}): ${errorText(error)}`,
      );
    }
    return upsertFromTokens({
      tokens,
      profile,
      tokenResponse: undefined,
      emailHint: null,
      authMode: "oauth",
      persist: false,
    });
  }

  /**
   * Builds the `CLAUDE_CODE_OAUTH_TOKEN` variant: profile AND usage must
   * both succeed before anything is persisted.
   */
  async function buildEnvironmentAccount(
    token: string,
    signal: AbortSignal,
  ): Promise<StoredClaudeAccount> {
    let profile: Record<string, unknown> | undefined;
    let usage: unknown;
    try {
      profile = await requestProfile(token, signal);
      usage = await requestUsage(token, signal);
    } catch (error) {
      throw new DiscoveryError(
        "NoCredentialFound",
        `Claude environment-token probe failed: ${errorText(error)}`,
      );
    }
    const account = await upsertFromTokens({
      tokens: {
        accessToken: token,
        refreshToken: null,
        tokenType: null,
        expiresAt: null,
        scopes: [...OAUTH_SCOPES],
      },
      profile,
      tokenResponse: undefined,
      emailHint: null,
      authMode: "environmentToken",
      persist: false,
    });
    return {
      ...account,
      quota: parseClaudeQuota(usage),
      usageUpdatedAt: clock.now(),
    };
  }

  function readScopes(value: unknown): string[] {
    if (Array.isArray(value)) {
      const scopes = value.filter(
        (entry): entry is string => typeof entry === "string",
      );
      if (scopes.length > 0) return scopes;
    }
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim().split(/\s+/);
    }
    return [...OAUTH_SCOPES];
  }

  // -------------------------------------------------------------------------
  // HTTP: token exchange, profile, usage — all UA claude-code/2.1.233
  // -------------------------------------------------------------------------

  async function exchangeOAuthCode(
    pending: PendingClaudeLogin,
    code: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        OAUTH_TOKEN_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/plain, */*",
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: OAUTH_CLIENT_ID,
            code,
            redirect_uri: OAUTH_CALLBACK_URL,
            code_verifier: pending.codeVerifier,
            state: pending.state,
          }),
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
        },
        fetch,
      );
    } catch (error) {
      throw new Error(`Claude OAuth token request failed: ${errorText(error)}`);
    }
    return parseLabeledJson(response, "Claude OAuth token exchange");
  }

  async function requestProfile(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        OAUTH_PROFILE_URL,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
        },
        fetch,
      );
    } catch (error) {
      throw new Error(`Claude profile request failed: ${errorText(error)}`);
    }
    return parseLabeledJson(response, "Claude OAuth profile");
  }

  async function requestUsage(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        OAUTH_USAGE_URL,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "anthropic-beta": OAUTH_BETA_HEADER,
            "User-Agent": USER_AGENT,
          },
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
        },
        fetch,
      );
    } catch (error) {
      throw new Error(`Claude usage request failed: ${errorText(error)}`);
    }
    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new UnauthorizedError();
    }
    if (!response.ok) {
      throw new Error(
        responseFailureMessage("Claude usage", response.status, body),
      );
    }
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(
        `Could not parse Claude usage response: ${errorText(error)} status=${response.status} body_length=${body.length}`,
      );
    }
  }

  async function parseLabeledJson(
    response: Response,
    label: string,
  ): Promise<Record<string, unknown>> {
    const body = await response.text();
    if (!response.ok) {
      throw new Error(responseFailureMessage(label, response.status, body));
    }
    try {
      const parsed: unknown = JSON.parse(body);
      const root = asRecord(parsed);
      if (root == null) {
        throw new Error(`${label} response is not an object`);
      }
      return root;
    } catch (error) {
      if (
        error instanceof Error &&
        !error.message.startsWith("Could not parse")
      ) {
        if (error.message.includes("response is not an object")) throw error;
      }
      throw new Error(
        `Could not parse ${label} response: ${errorText(error)} status=${response.status} body_length=${body.length}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Account assembly
  // -------------------------------------------------------------------------

  async function upsertFromTokens(input: {
    tokens: CredentialTokens;
    profile: Record<string, unknown> | undefined;
    tokenResponse: Record<string, unknown> | undefined;
    emailHint: string | null;
    authMode: "oauth" | "environmentToken";
    persist?: boolean;
  }): Promise<StoredClaudeAccount> {
    const { tokens, profile, tokenResponse, emailHint, authMode } = input;
    const accountUuid =
      pathString(profile, ["account", "uuid"]) ??
      pathString(tokenResponse, ["account", "uuid"]) ??
      null;
    const email =
      pathString(profile, ["account", "email"]) ??
      pathString(profile, ["account", "email_address"]) ??
      pathString(tokenResponse, ["account", "email_address"]) ??
      emailHint;
    if (email == null) {
      throw new Error("Claude OAuth response did not include an email.");
    }
    const organizationUuid =
      pathString(profile, ["organization", "uuid"]) ??
      pathString(tokenResponse, ["organization", "uuid"]) ??
      null;
    const organizationName =
      pathString(profile, ["organization", "name"]) ??
      pathString(profile, ["organization", "display_name"]) ??
      pathString(tokenResponse, ["organization", "name"]) ??
      null;
    const displayName = pathString(profile, ["account", "display_name"]);
    const avatarUrl =
      pathString(profile, ["account", "avatar_url"]) ??
      pathString(profile, ["account", "avatarUrl"]);
    const planType = subscriptionTypeFromProfile(profile);
    const now = clock.now();
    const account: StoredClaudeAccount = {
      provider: "claude",
      id: claudeAccountId(
        email,
        accountUuid ?? undefined,
        organizationUuid ?? undefined,
      ),
      email,
      authMode,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType,
      scopes: tokens.scopes,
      expiresAt: tokens.expiresAt,
      accountUuid,
      organizationUuid,
      organizationName,
      displayName: displayName ?? null,
      avatarUrl: avatarUrl ?? null,
      planType,
      quota: { ...EMPTY_QUOTA },
      status: "active",
      statusReason: null,
      quotaQueryLastError: null,
      quotaQueryLastErrorAt: null,
      usageUpdatedAt: null,
      createdAt: now,
      lastUsed: now,
    };
    if (input.persist !== false) {
      await store.upsert("claude", account);
    }
    return account;
  }

  function subscriptionTypeFromProfile(
    profile: Record<string, unknown> | undefined,
  ): string | null {
    const type =
      profile != null
        ? pathString(profile, ["organization", "organization_type"])
        : null;
    if (type === "claude_max") return "Max";
    if (type === "claude_pro") return "Pro";
    if (type === "claude_enterprise") return "Enterprise";
    if (type === "claude_team") return "Team";
    return null;
  }

  function pathString(
    root: Record<string, unknown> | undefined,
    parts: readonly string[],
  ): string | undefined {
    let current: unknown = root;
    for (const part of parts) {
      const record = asRecord(current);
      if (record == null) return undefined;
      current = record[part];
    }
    return textOrNull(current) ?? undefined;
  }

  // -------------------------------------------------------------------------
  // Manual-paste OAuth
  // -------------------------------------------------------------------------

  async function beginAuth(signal: AbortSignal): Promise<AuthFlow> {
    if (!(await policyAccepted())) {
      throw new Error(
        "Claude integration is disabled until the policy is acknowledged.",
      );
    }
    const state = randomToken(32);
    const { codeVerifier } = newPkcePair(32);
    const start = buildClaudeOAuthStart("login", state, codeVerifier);
    const authUrl = start.authUrl;
    const expiresAt = clock.now() + OAUTH_TIMEOUT_MS;
    const pending: PendingClaudeLogin = { state, codeVerifier, expiresAt };

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
      if (submission.kind !== "claude") {
        throw new Error("Claude login accepts only claude submissions.");
      }
      const { code, state: callbackState } = parseClaudeCallbackInput(
        submission.callbackOrCode,
      );
      if (code === "") {
        throw new Error("Claude OAuth callback URL or code is required.");
      }
      if (pending.expiresAt <= clock.now()) {
        settle(() =>
          rejectResult(new Error("Claude OAuth login expired. Start again.")),
        );
        return;
      }
      if (callbackState != null && callbackState !== pending.state) {
        throw new Error(
          "Claude OAuth callback state did not match. Start again.",
        );
      }
      try {
        const tokenResponse = await exchangeOAuthCode(pending, code, signal);
        const accessToken = recordString(tokenResponse, "access_token");
        if (accessToken == null) {
          throw new Error(
            "Claude OAuth token response did not include an access token.",
          );
        }
        const profile = await requestProfile(accessToken, signal).catch(
          () => undefined,
        );
        const account = await upsertFromTokens({
          tokens: {
            accessToken,
            refreshToken: recordString(tokenResponse, "refresh_token") ?? null,
            tokenType: recordString(tokenResponse, "token_type") ?? null,
            expiresAt:
              numberOrNull(tokenResponse.expires_in) != null
                ? addSeconds(
                    clock.now(),
                    numberOrNull(tokenResponse.expires_in) as number,
                  )
                : null,
            scopes: readScopes(tokenResponse.scope ?? tokenResponse.scopes),
          },
          profile,
          tokenResponse,
          emailHint: submission.emailHint?.trim() || null,
          authMode: "oauth",
        });
        const summary = await summaryOf(account.id);
        settle(() => resolveResult([summary]));
      } catch (error) {
        settle(() =>
          rejectResult(
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
        throw error;
      }
    }

    const flow: ManualCodeAuthFlow = {
      mode: "manualCode",
      provider: "claude",
      authUrl,
      callbackUrl: OAUTH_CALLBACK_URL,
      expiresAt,
      result,
      submit: completeWith,
      cancel: async () => {
        settle(() =>
          rejectResult(
            new Error("Claude OAuth login was cancelled. Start again."),
          ),
        );
      },
    };
    return flow;
  }

  // -------------------------------------------------------------------------
  // Refresh: 180 s cooldown, retry/reauth only for refreshable accounts
  // -------------------------------------------------------------------------

  async function refresh(
    accountId: string,
    signal: AbortSignal,
  ): Promise<AccountSummary> {
    const account = await requireStoredAccount(accountId);
    if (
      account.usageUpdatedAt != null &&
      clock.now() - account.usageUpdatedAt < USAGE_COOLDOWN_MS
    ) {
      return summaryOf(accountId);
    }

    let current = account;
    const tokenState = await ensureAccessTokenValid(current, signal);
    if ("error" in tokenState) {
      return recordRefreshError(
        tokenState.account,
        tokenState.error.message,
        tokenState.error.reauthentication,
      );
    }
    current = tokenState.account;

    let usage: unknown;
    try {
      usage = await requestUsage(current.accessToken, signal);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) {
        return recordRefreshError(current, errorMessage(error), false);
      }
      if (current.authMode === "environmentToken") {
        return recordRefreshError(current, REAUTHENTICATION_MESSAGE, true);
      }
      const refreshed = await refreshAccessToken(current, signal);
      if ("error" in refreshed) {
        return recordRefreshError(
          refreshed.account,
          refreshed.error.message,
          refreshed.error.reauthentication,
        );
      }
      current = refreshed.account;
      try {
        usage = await requestUsage(current.accessToken, signal);
      } catch (retryError) {
        if (retryError instanceof UnauthorizedError) {
          return recordRefreshError(current, REAUTHENTICATION_MESSAGE, true);
        }
        return recordRefreshError(current, errorMessage(retryError), false);
      }
    }

    const now = clock.now();
    await store.upsert("claude", {
      ...current,
      quota: parseClaudeQuota(usage),
      quotaQueryLastError: null,
      quotaQueryLastErrorAt: null,
      status: "active",
      statusReason: null,
      usageUpdatedAt: now,
      lastUsed: now,
    });
    return summaryOf(accountId);
  }

  async function ensureAccessTokenValid(
    account: StoredClaudeAccount,
    signal: AbortSignal,
  ): Promise<
    | { account: StoredClaudeAccount }
    | {
        account: StoredClaudeAccount;
        error: { message: string; reauthentication: boolean };
      }
  > {
    const stale =
      account.authMode === "oauth" &&
      account.expiresAt != null &&
      account.expiresAt <= clock.now() + TOKEN_EXPIRY_SKEW_MS;
    if (!stale) return { account };
    if (account.authMode === "environmentToken") return { account };
    return refreshAccessToken(account, signal);
  }

  async function refreshAccessToken(
    account: StoredClaudeAccount,
    signal: AbortSignal,
  ): Promise<
    | { account: StoredClaudeAccount }
    | {
        account: StoredClaudeAccount;
        error: { message: string; reauthentication: boolean };
      }
  > {
    if (account.refreshToken == null) {
      return {
        account,
        error: { message: REAUTHENTICATION_MESSAGE, reauthentication: true },
      };
    }
    let response: Response;
    try {
      response = await fetchWithTimeout(
        OAUTH_TOKEN_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: account.refreshToken,
            client_id: OAUTH_CLIENT_ID,
          }),
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
        },
        fetch,
      );
    } catch (error) {
      return {
        account,
        error: {
          message: `Claude token refresh failed: ${errorText(error)}`,
          reauthentication: false,
        },
      };
    }
    const body = await response.text();
    if (!response.ok) {
      const classified = classifyClaudeRefreshFailure(response.status, body);
      return {
        account,
        error: {
          message: classified.message,
          reauthentication: classified.requiresReauthentication,
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      return {
        account,
        error: {
          message: `Could not parse Claude token refresh response: ${errorText(error)}`,
          reauthentication: false,
        },
      };
    }
    const root = asRecord(parsed);
    const accessToken =
      root != null ? recordString(root, "access_token") : undefined;
    if (root == null || accessToken == null) {
      return {
        account,
        error: {
          message: "Claude token refresh had no access token",
          reauthentication: false,
        },
      };
    }
    const refreshToken = recordString(root, "refresh_token");
    const expiresInSeconds = numberOrNull(root.expires_in);
    return {
      account: {
        ...account,
        accessToken,
        refreshToken: refreshToken ?? account.refreshToken,
        expiresAt:
          expiresInSeconds != null
            ? addSeconds(clock.now(), expiresInSeconds)
            : account.expiresAt,
      },
    };
  }

  async function recordRefreshError(
    account: StoredClaudeAccount,
    message: string,
    reauthentication: boolean,
  ): Promise<AccountSummary> {
    const now = clock.now();
    await store.upsert("claude", {
      ...account,
      lastUsed: now,
      quotaQueryLastError: message,
      quotaQueryLastErrorAt: now,
      status: reauthentication ? "requiresReauthentication" : account.status,
      statusReason: reauthentication ? message : account.statusReason,
    });
    return summaryOf(account.id);
  }

  async function refreshAll(signal: AbortSignal): Promise<AccountSummary[]> {
    const accounts = await store.listStored("claude");
    for (const account of accounts) {
      if (signal.aborted) break;
      try {
        await refresh(account.id, signal);
      } catch {
        // Per-account failures already persisted their typed error state.
      }
    }
    return store.list("claude");
  }

  async function summaryOf(accountId: string): Promise<AccountSummary> {
    const summaries = await store.list("claude");
    const match = summaries.find((summary) => summary.id === accountId);
    if (match == null) {
      throw new Error("Claude account is missing from the private store");
    }
    return match;
  }

  async function requireStoredAccount(
    accountId: string,
  ): Promise<StoredClaudeAccount> {
    const accounts = await store.listStored("claude");
    const account = accounts.find(
      (entry): entry is StoredClaudeAccount =>
        entry.provider === "claude" && entry.id === accountId,
    );
    if (account == null) {
      throw new Error(`Could not read Claude account: ${accountId}`);
    }
    return account;
  }

  return {
    list: () => store.list("claude"),
    discoverImports,
    import: importCandidate,
    beginAuth,
    refresh,
    refreshAll,
    remove: (accountId: string) => store.remove("claude", accountId),
  };
}

class UnauthorizedError extends Error {
  constructor() {
    super("Claude usage request was unauthorized");
    this.name = "UnauthorizedError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? redactSecrets(snippet(error.message, 300))
    : String(error);
}
