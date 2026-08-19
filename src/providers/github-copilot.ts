/**
 * GitHub Copilot adapter: typed local-token discovery (env → gh CLI →
 * config files) with network probing, plus the GitHub device OAuth flow.
 * Behavior is ported from `ref/quota/src-tauri/src/github_copilot.rs`; the
 * local-source precedence and probing rules come from the approved plan.
 * The GitHub OAuth token is never rotated: refreshes only re-exchange the
 * Copilot session token.
 */

import { homedir } from "node:os";
import path from "node:path";
import {
  asRecord,
  confirmFirstSource,
  DiscoveryError,
  type DiscoverySource,
  envTokenPresent,
  pathReadable,
  readJsonCredentialFile,
  recordString,
} from "../core/discovery.js";
import {
  fetchWithTimeout,
  postForm,
  redactSecrets,
  responseDetail,
  snippet,
} from "../core/http.js";
import { githubCopilotAccountId } from "../core/ids.js";
import { randomToken } from "../core/oauth.js";
import { parseEpochMs } from "../core/time.js";
import type {
  AccountSummary,
  ImportCandidate,
  StoredGitHubCopilotAccount,
} from "../core/types.js";
import type { RuntimeDependencies } from "../runtime.js";
import type {
  AuthFlow,
  DeviceCodeAuthFlow,
  ProviderAdapter,
} from "./provider.js";

const DEVICE_CODE_ENDPOINT = "https://github.com/login/device/code";
const DEVICE_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const USER_ENDPOINT = "https://api.github.com/user";
const USER_EMAILS_ENDPOINT = "https://api.github.com/user/emails";
const COPILOT_TOKEN_ENDPOINT =
  "https://api.github.com/copilot_internal/v2/token";
const COPILOT_USER_INFO_ENDPOINT =
  "https://api.github.com/copilot_internal/user";
const OAUTH_CLIENT_ID = "01ab8ac9400c4e429b23";
const OAUTH_SCOPE = "read:user user:email repo workflow";
const APP_USER_AGENT = "quota";
const API_VERSION = "2025-04-01";
const HTTP_TIMEOUT_MS = 20_000;
const CANCEL_TICK_MS = 200;
/** Token variables stripped from the `gh` child environment (the plan's sanitized-env rule). */
const GH_SANITIZED_ENV: readonly string[] = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
];
const ENV_TOKEN_VARS: readonly string[] = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
];
/** Keys accepted for the GitHub token inside `~/.copilot/config.json`. */
const COPILOT_CONFIG_TOKEN_KEYS: readonly string[] = [
  "githubAccessToken",
  "githubOauthToken",
  "oauth_token",
];

interface CopilotTokenBundle {
  token: string;
  plan: string | null;
  chatEnabled: boolean | null;
  expiresAt: number | null;
  refreshIn: number | null;
  quotaSnapshots: unknown;
  quotaResetDate: string | null;
  limitedUserQuotas: unknown;
  limitedUserResetAt: number | null;
}

interface GitHubIdentity {
  login: string;
  id: number;
  name: string | null;
  email: string | null;
}

interface CopilotPayload {
  identity: GitHubIdentity;
  githubAccessToken: string;
  githubTokenType: string | null;
  githubScope: string | null;
  copilot: CopilotTokenBundle;
}

interface DeviceLoginState {
  loginId: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresAt: number;
  cancelled: boolean;
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

export function createGitHubCopilotProvider(
  deps: RuntimeDependencies,
): ProviderAdapter {
  const { store, fetch, clock, subprocess } = deps;

  // -------------------------------------------------------------------------
  // Discovery: env tokens, sanitized gh CLI, config files
  // -------------------------------------------------------------------------

  async function discoverImports(
    signal: AbortSignal,
  ): Promise<ImportCandidate[]> {
    const settings = await store.loadSettings();
    const override = settings.importPathOverrides.githubCopilot?.trim();
    const candidates: ImportCandidate[] = [];
    for (const name of ENV_TOKEN_VARS) {
      if (envTokenPresent(process.env, name)) {
        candidates.push({
          provider: "githubCopilot",
          source: "env",
          label: `${name} environment variable`,
          path: null,
        });
      }
    }
    if (await ghAvailable(signal)) {
      candidates.push({
        provider: "githubCopilot",
        source: "subprocess",
        label: "GitHub CLI (`gh auth token --hostname github.com`)",
        path: null,
      });
    }
    const configPaths = [
      path.join(homedir(), ".copilot", "config.json"),
      path.join(homedir(), ".config", "github-copilot", "hosts.json"),
    ];
    if (override != null && override !== "") configPaths.push(override);
    for (const filePath of configPaths) {
      if (await pathReadable(filePath)) {
        candidates.push({
          provider: "githubCopilot",
          source: "file",
          label: `Copilot credentials (${filePath})`,
          path: filePath,
        });
      }
    }
    return candidates;
  }

  /** Runs `gh --version` (no credential access) to decide whether to list the CLI candidate. */
  async function ghAvailable(signal: AbortSignal): Promise<boolean> {
    try {
      await subprocess.run("gh", ["--version"], {
        timeoutMs: 5_000,
        signal,
        envRemove: GH_SANITIZED_ENV,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reads the GitHub token out of one confirmed candidate. Typed
   * rejections throw `NoCredentialFound` so the walk can continue; genuine
   * infrastructure failures throw plain errors and abort.
   */
  async function loadCandidateToken(
    candidate: ImportCandidate,
    signal: AbortSignal,
  ): Promise<string> {
    if (candidate.source === "env") {
      const name = envNameFromLabel(candidate.label);
      const value = name != null ? process.env[name] : undefined;
      const token = value?.trim();
      if (token == null || token === "") {
        throw new DiscoveryError(
          "EmptyCredential",
          `${candidate.label} is empty`,
        );
      }
      return token;
    }
    if (candidate.source === "subprocess") {
      const result = await subprocess.run(
        "gh",
        ["auth", "token", "--hostname", "github.com"],
        { timeoutMs: 10_000, signal, envRemove: GH_SANITIZED_ENV },
      );
      const token = result.stdout.trim();
      if (token === "") {
        throw new DiscoveryError(
          "EmptyCredential",
          "gh auth token returned no token",
        );
      }
      return token;
    }
    const filePath = candidate.path;
    if (filePath == null) {
      throw new DiscoveryError(
        "NoCredentialFound",
        "Copilot import requires a file path",
      );
    }
    return tokenFromCredentialFile(filePath, signal);
  }

  function envNameFromLabel(label: string): string | undefined {
    return ENV_TOKEN_VARS.find((name) => label.startsWith(`${name} `));
  }

  async function tokenFromCredentialFile(
    filePath: string,
    signal: AbortSignal,
  ): Promise<string> {
    const root = asRecord(await readJsonCredentialFile(filePath, signal));
    if (root === undefined) {
      throw new DiscoveryError(
        "CorruptCredential",
        `Credential file is not an object: ${filePath}`,
        [filePath],
      );
    }
    let token: string | undefined;
    if (filePath.endsWith("hosts.json")) {
      const host = asRecord(root["github.com"]);
      token = host != null ? recordString(host, "oauth_token") : undefined;
    } else {
      token = COPILOT_CONFIG_TOKEN_KEYS.map((key) =>
        recordString(root, key),
      ).find((value) => value !== undefined);
    }
    if (token == null) {
      throw new DiscoveryError(
        "EmptyCredential",
        `No GitHub token in ${filePath}`,
        [filePath],
      );
    }
    return token;
  }

  // -------------------------------------------------------------------------
  // Probing: /user and /copilot_internal/v2/token for every candidate
  // -------------------------------------------------------------------------

  async function probeToken(
    githubAccessToken: string,
    signal: AbortSignal,
  ): Promise<CopilotPayload> {
    const identity = await fetchGitHubIdentity(githubAccessToken, signal);
    const copilot = await fetchCopilotToken(githubAccessToken, signal);
    const email =
      (await fetchGitHubEmail(githubAccessToken, signal)) ?? identity.email;
    return {
      identity: { ...identity, email },
      githubAccessToken,
      githubTokenType: null,
      githubScope: null,
      copilot,
    };
  }

  async function fetchGitHubIdentity(
    token: string,
    signal: AbortSignal,
  ): Promise<GitHubIdentity> {
    const response = await fetchWithTimeout(
      USER_ENDPOINT,
      {
        headers: {
          "User-Agent": APP_USER_AGENT,
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
        },
        signal,
        timeoutMs: HTTP_TIMEOUT_MS,
      },
      fetch,
    );
    const body = await response.text();
    if (!response.ok) {
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404
      ) {
        throw new DiscoveryError(
          "NoCredentialFound",
          `GitHub token was rejected by github.com (status ${response.status})`,
        );
      }
      throw new Error(`GitHub user request failed: status ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(
        `Could not parse GitHub user response: ${errorText(error)}`,
      );
    }
    const root = asRecord(parsed);
    const login = root != null ? recordString(root, "login") : undefined;
    const id = root != null ? numberOrNull(root.id) : null;
    if (root == null || login == null || id == null) {
      throw new Error("GitHub user response was missing login or id");
    }
    return {
      login,
      id,
      name: root != null ? textOrNull(root.name) : null,
      email: root != null ? textOrNull(root.email) : null,
    };
  }

  async function fetchGitHubEmail(
    token: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        USER_EMAILS_ENDPOINT,
        {
          headers: {
            "User-Agent": APP_USER_AGENT,
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
          },
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
        },
        fetch,
      );
    } catch {
      return null;
    }
    if (!response.ok) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const emails = parsed
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry != null)
      .map((entry) => ({
        email: textOrNull(entry.email),
        primary: entry.primary === true,
        verified: entry.verified === true,
      }))
      .filter((entry) => entry.email != null);
    const primaryVerified = emails.find(
      (entry) => entry.primary && entry.verified,
    );
    const verified = emails.find((entry) => entry.verified);
    return (primaryVerified ?? verified)?.email ?? null;
  }

  async function fetchCopilotToken(
    githubAccessToken: string,
    signal: AbortSignal,
  ): Promise<CopilotTokenBundle> {
    const response = await fetchWithTimeout(
      COPILOT_TOKEN_ENDPOINT,
      {
        headers: {
          "User-Agent": APP_USER_AGENT,
          Accept: "application/json",
          "X-GitHub-Api-Version": API_VERSION,
          Authorization: `token ${githubAccessToken}`,
        },
        signal,
        timeoutMs: HTTP_TIMEOUT_MS,
      },
      fetch,
    );
    const body = await response.text();
    if (!response.ok) {
      const detail = responseDetail(body);
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404
      ) {
        throw new DiscoveryError(
          "NoCredentialFound",
          `Token is not usable for Copilot (status ${response.status}${
            detail != null ? `: ${snippet(detail, 120)}` : ""
          })`,
        );
      }
      throw new Error(
        `Copilot token request failed: status ${response.status}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(
        `Could not parse Copilot token response: ${errorText(error)}`,
      );
    }
    const root = asRecord(parsed);
    const token = root != null ? textOrNull(root.token) : null;
    if (token == null) {
      throw new DiscoveryError(
        "NoCredentialFound",
        root != null && textOrNull(root.message) != null
          ? `Copilot token unavailable: ${snippet(textOrNull(root.message) ?? "", 120)}`
          : "Copilot token missing",
      );
    }
    // Best-effort plan/quota enrichment; failures are ignored (reference: `.ok()`).
    const userInfo = await fetchCopilotUserInfo(githubAccessToken, signal);
    return {
      token,
      plan:
        (userInfo != null
          ? recordString(userInfo, "copilot_plan")
          : undefined) ??
        textOrNull(root?.sku) ??
        null,
      chatEnabled:
        root != null && "chat_enabled" in root
          ? root.chat_enabled === true
          : null,
      expiresAt: parseEpochMs(root?.expires_at),
      refreshIn: numberOrNull(root?.refresh_in),
      quotaSnapshots:
        userInfo != null ? (userInfo.quota_snapshots ?? null) : null,
      quotaResetDate:
        userInfo != null ? textOrNull(userInfo.quota_reset_date) : null,
      limitedUserQuotas: root?.limited_user_quotas ?? null,
      limitedUserResetAt: parseEpochMs(root?.limited_user_reset_date),
    };
  }

  async function fetchCopilotUserInfo(
    githubAccessToken: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await fetchWithTimeout(
        COPILOT_USER_INFO_ENDPOINT,
        {
          headers: {
            "User-Agent": APP_USER_AGENT,
            Accept: "application/json",
            "X-GitHub-Api-Version": API_VERSION,
            Authorization: `token ${githubAccessToken}`,
          },
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
        },
        fetch,
      );
      if (!response.ok) return undefined;
      return asRecord(JSON.parse(await response.text()));
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Account assembly and persistence
  // -------------------------------------------------------------------------

  async function upsertPayload(
    payload: CopilotPayload,
  ): Promise<StoredGitHubCopilotAccount> {
    const accounts = await store.listStored("githubCopilot");
    const existing = accounts.find(
      (account) =>
        account.provider === "githubCopilot" &&
        account.githubId === payload.identity.id,
    );
    const id =
      existing?.id ??
      githubCopilotAccountId(
        payload.identity.login,
        String(payload.identity.id),
      );
    const now = clock.now();
    const account: StoredGitHubCopilotAccount = {
      provider: "githubCopilot",
      id,
      githubLogin: payload.identity.login,
      githubId: payload.identity.id,
      githubName: payload.identity.name,
      githubEmail: payload.identity.email,
      githubAccessToken: payload.githubAccessToken,
      githubTokenType: payload.githubTokenType,
      githubScope: payload.githubScope,
      copilotToken: payload.copilot.token,
      copilotPlan: payload.copilot.plan,
      copilotChatEnabled: payload.copilot.chatEnabled,
      copilotExpiresAt: payload.copilot.expiresAt,
      copilotRefreshIn: payload.copilot.refreshIn,
      copilotQuotaSnapshots: payload.copilot.quotaSnapshots,
      copilotQuotaResetDate: payload.copilot.quotaResetDate,
      copilotLimitedUserQuotas: payload.copilot.limitedUserQuotas,
      copilotLimitedUserResetAt: payload.copilot.limitedUserResetAt,
      status: "active",
      statusReason: null,
      quotaQueryLastError: null,
      quotaQueryLastErrorAt: null,
      usageUpdatedAt: now,
      createdAt: existing?.createdAt ?? now,
      lastUsed: now,
    };
    await store.upsert("githubCopilot", account);
    return account;
  }

  async function summaryOf(accountId: string): Promise<AccountSummary> {
    const summaries = await store.list("githubCopilot");
    const match = summaries.find((summary) => summary.id === accountId);
    if (match == null) {
      throw new Error(
        "GitHub Copilot account is missing from the private store",
      );
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  /**
   * Walks the full deterministic precedence, starting from the confirmed
   * candidate: reading the token AND probing `/user` +
   * `/copilot_internal/v2/token` are part of each candidate's load, so a
   * rejected env token falls through to the sanitized `gh` CLI and the
   * config files, exactly as the approved plan requires.
   */
  async function importCandidate(
    candidate: ImportCandidate,
    signal: AbortSignal,
  ): Promise<AccountSummary[]> {
    const ordered = await orderedSources(candidate, signal);
    const confirmed = await confirmFirstSource(ordered, signal);
    const payload = confirmed.value;
    const account = await upsertPayload(payload);
    return [await summaryOf(account.id)];
  }

  async function orderedSources(
    confirmed: ImportCandidate,
    signal: AbortSignal,
  ): Promise<DiscoverySource<CopilotPayload>[]> {
    const listed = await discoverImports(signal);
    const chosen = listed.find(
      (entry) =>
        entry.source === confirmed.source &&
        entry.label === confirmed.label &&
        entry.path === confirmed.path,
    );
    const rest =
      chosen != null ? listed.filter((entry) => entry !== chosen) : listed;
    const orderedCandidates = chosen != null ? [chosen, ...rest] : listed;
    return orderedCandidates.map(
      (entry): DiscoverySource<CopilotPayload> => ({
        candidate: entry,
        load: async (loadSignal) => {
          const token = await loadCandidateToken(entry, loadSignal);
          return probeToken(token, loadSignal);
        },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Device OAuth flow
  // -------------------------------------------------------------------------

  async function beginAuth(signal: AbortSignal): Promise<AuthFlow> {
    const code = await requestDeviceCode(signal);
    const login: DeviceLoginState = {
      loginId: randomToken(24),
      deviceCode: code.deviceCode,
      intervalSeconds: Math.max(1, code.interval ?? 5),
      expiresAt: clock.now() + code.expiresInSeconds * 1000,
      cancelled: false,
    };
    const flow: DeviceCodeAuthFlow = {
      mode: "deviceCode",
      provider: "githubCopilot",
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      verificationUriComplete: code.verificationUriComplete,
      expiresAt: login.expiresAt,
      intervalSeconds: login.intervalSeconds,
      result: completeDeviceLogin(login, signal),
      cancel: async () => {
        login.cancelled = true;
      },
    };
    return flow;
  }

  async function requestDeviceCode(signal: AbortSignal): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string | null;
    expiresInSeconds: number;
    interval: number | null;
  }> {
    let response: Response;
    try {
      response = await postForm(
        DEVICE_CODE_ENDPOINT,
        [
          ["client_id", OAUTH_CLIENT_ID],
          ["scope", OAUTH_SCOPE],
        ],
        {
          headers: { "User-Agent": APP_USER_AGENT, Accept: "application/json" },
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
          fetchImpl: fetch,
        },
      );
    } catch (error) {
      throw new Error(
        `Could not request GitHub device code: ${errorText(error)}`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `GitHub device code request failed: status ${response.status}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch (error) {
      throw new Error(
        `Could not parse GitHub device code response: ${errorText(error)}`,
      );
    }
    const root = asRecord(parsed);
    const deviceCode =
      root != null ? recordString(root, "device_code") : undefined;
    const userCode = root != null ? recordString(root, "user_code") : undefined;
    const verificationUri =
      root != null ? recordString(root, "verification_uri") : undefined;
    const expiresIn = numberOrNull(root?.expires_in);
    if (
      root == null ||
      deviceCode == null ||
      userCode == null ||
      verificationUri == null ||
      expiresIn == null
    ) {
      throw new Error("GitHub device code response was incomplete");
    }
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: textOrNull(root.verification_uri_complete),
      expiresInSeconds: expiresIn,
      interval: numberOrNull(root.interval),
    };
  }

  async function completeDeviceLogin(
    login: DeviceLoginState,
    signal: AbortSignal,
  ): Promise<AccountSummary[]> {
    for (;;) {
      if (login.cancelled || signal.aborted) {
        throw new Error("Login flow was cancelled. Start again.");
      }
      if (clock.now() > login.expiresAt) {
        throw new Error("GitHub authorization expired. Start again.");
      }
      const outcome = await exchangeDeviceToken(login.deviceCode, signal);
      if (outcome.kind === "token") {
        const payload = await buildPayloadFromAccessToken(
          outcome.accessToken,
          outcome.tokenType,
          outcome.scope,
          signal,
        );
        const account = await upsertPayload(payload);
        return [await summaryOf(account.id)];
      }
      if (outcome.kind === "fatal") {
        throw new Error(outcome.message);
      }
      const waitSeconds =
        outcome.kind === "slowDown"
          ? login.intervalSeconds + 5
          : login.intervalSeconds;
      await sleepWithCancelCheck(login, waitSeconds, signal);
    }
  }

  async function sleepWithCancelCheck(
    login: DeviceLoginState,
    totalSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    const ticks = Math.max(1, totalSeconds) * 5;
    for (let tick = 0; tick < ticks; tick += 1) {
      await clock.sleep(CANCEL_TICK_MS, signal);
      if (login.cancelled) {
        throw new Error("Login flow was cancelled. Start again.");
      }
    }
  }

  async function exchangeDeviceToken(
    deviceCode: string,
    signal: AbortSignal,
  ): Promise<
    | {
        kind: "token";
        accessToken: string;
        tokenType: string | null;
        scope: string | null;
      }
    | { kind: "pending" }
    | { kind: "slowDown" }
    | { kind: "fatal"; message: string }
  > {
    let response: Response;
    try {
      response = await postForm(
        DEVICE_TOKEN_ENDPOINT,
        [
          ["client_id", OAUTH_CLIENT_ID],
          ["device_code", deviceCode],
          ["grant_type", "urn:ietf:params:oauth:grant-type:device_code"],
        ],
        {
          headers: { "User-Agent": APP_USER_AGENT, Accept: "application/json" },
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
          fetchImpl: fetch,
        },
      );
    } catch (error) {
      throw new Error(
        `Could not request GitHub access token: ${errorText(error)}`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `GitHub access token request failed: status ${response.status}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch (error) {
      throw new Error(
        `Could not parse GitHub access token response: ${errorText(error)}`,
      );
    }
    const root = asRecord(parsed);
    const error = root != null ? recordString(root, "error") : undefined;
    if (error != null) {
      if (error === "authorization_pending") return { kind: "pending" };
      if (error === "slow_down") return { kind: "slowDown" };
      if (error === "expired_token") {
        return {
          kind: "fatal",
          message: "GitHub authorization expired. Start again.",
        };
      }
      if (error === "access_denied") {
        return { kind: "fatal", message: "GitHub authorization was denied." };
      }
      const description =
        root != null ? recordString(root, "error_description") : undefined;
      return {
        kind: "fatal",
        message: description ?? `GitHub authorization failed: ${error}`,
      };
    }
    const accessToken =
      root != null ? recordString(root, "access_token") : undefined;
    if (root == null || accessToken == null) {
      return { kind: "fatal", message: "GitHub access token missing" };
    }
    return {
      kind: "token",
      accessToken,
      tokenType: textOrNull(root.token_type),
      scope: textOrNull(root.scope),
    };
  }

  async function buildPayloadFromAccessToken(
    accessToken: string,
    tokenType: string | null,
    scope: string | null,
    signal: AbortSignal,
  ): Promise<CopilotPayload> {
    const identity = await fetchGitHubIdentity(accessToken, signal);
    const email =
      (await fetchGitHubEmail(accessToken, signal)) ?? identity.email;
    const copilot = await fetchCopilotToken(accessToken, signal);
    return {
      identity: { ...identity, email },
      githubAccessToken: accessToken,
      githubTokenType: tokenType,
      githubScope: scope,
      copilot,
    };
  }

  // -------------------------------------------------------------------------
  // Refresh: re-exchange the Copilot token, never rotating the GitHub token
  // -------------------------------------------------------------------------

  const COPILOT_REAUTH_MESSAGE =
    "GitHub token was rejected. Reconnect the GitHub Copilot account.";

  /**
   * A rejected stored GitHub token (401/403/404 from the probes, surfaced
   * as `NoCredentialFound`) is a reauthentication condition; every other
   * failure is temporary and keeps the account's current status.
   */
  function classifyRefreshFailure(error: unknown): {
    message: string;
    reauthentication: boolean;
  } {
    if (error instanceof DiscoveryError && error.code === "NoCredentialFound") {
      return { message: COPILOT_REAUTH_MESSAGE, reauthentication: true };
    }
    return { message: errorText(error), reauthentication: false };
  }

  /** Persists the redacted failure; the last safe quota is untouched. */
  async function recordRefreshError(
    account: StoredGitHubCopilotAccount,
    message: string,
    reauthentication: boolean,
  ): Promise<AccountSummary> {
    const now = clock.now();
    await store.upsert("githubCopilot", {
      ...account,
      lastUsed: now,
      quotaQueryLastError: message,
      quotaQueryLastErrorAt: now,
      status: reauthentication ? "requiresReauthentication" : account.status,
      statusReason: reauthentication ? message : account.statusReason,
    });
    return summaryOf(account.id);
  }

  async function refresh(
    accountId: string,
    signal: AbortSignal,
  ): Promise<AccountSummary> {
    const accounts = await store.listStored("githubCopilot");
    const account = accounts.find(
      (entry): entry is StoredGitHubCopilotAccount =>
        entry.provider === "githubCopilot" && entry.id === accountId,
    );
    if (account == null) {
      throw new Error(`Could not read GitHub Copilot account: ${accountId}`);
    }
    try {
      const bundle = await fetchCopilotToken(account.githubAccessToken, signal);
      const now = clock.now();
      await store.upsert("githubCopilot", {
        ...account,
        copilotToken: bundle.token,
        copilotPlan: bundle.plan,
        copilotChatEnabled: bundle.chatEnabled,
        copilotExpiresAt: bundle.expiresAt,
        copilotRefreshIn: bundle.refreshIn,
        copilotQuotaSnapshots: bundle.quotaSnapshots,
        copilotQuotaResetDate: bundle.quotaResetDate,
        copilotLimitedUserQuotas: bundle.limitedUserQuotas,
        copilotLimitedUserResetAt: bundle.limitedUserResetAt,
        quotaQueryLastError: null,
        quotaQueryLastErrorAt: null,
        status: "active",
        statusReason: null,
        usageUpdatedAt: now,
        lastUsed: now,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const classified = classifyRefreshFailure(error);
      return recordRefreshError(
        account,
        classified.message,
        classified.reauthentication,
      );
    }
    return summaryOf(accountId);
  }

  async function refreshAll(signal: AbortSignal): Promise<AccountSummary[]> {
    const accounts = await store.listStored("githubCopilot");
    for (const account of accounts) {
      if (signal.aborted) break;
      try {
        await refresh(account.id, signal);
      } catch {
        // Per-account failures already persisted their typed error state.
      }
    }
    return store.list("githubCopilot");
  }
  return {
    list: () => store.list("githubCopilot"),
    discoverImports,
    import: importCandidate,
    beginAuth,
    refresh,
    refreshAll,
    remove: (accountId: string) => store.remove("githubCopilot", accountId),
  };
}
