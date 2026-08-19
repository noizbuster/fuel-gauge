/**
 * Kiro adapter: local `kiro-auth-token.json` import with optional IDE
 * profile enrichment, Cognito browser OAuth on a candidate loopback port
 * (plus manual callback submission), and the Kiro runtime usage API with
 * one token-refresh retry. Ported from
 * `ref/quota/src-tauri/src/kiro.rs`; timestamps are epoch milliseconds.
 */

import { homedir } from "node:os";
import path from "node:path";
import type { CallbackSuccess } from "../core/callback-server.js";
import {
  asRecord,
  confirmFirstSource,
  DiscoveryError,
  type DiscoverySource,
  pathReadable,
  readJsonCredentialFile,
} from "../core/discovery.js";
import {
  encodeQueryComponent,
  fetchWithTimeout,
  redactSecrets,
  snippet,
} from "../core/http.js";
import { kiroAccountId, tokenSeed } from "../core/ids.js";
import { decodeJwtPayload, jwtEmailHint } from "../core/jwt.js";
import { newPkcePair, randomToken } from "../core/oauth.js";
import { heuristicEpochMs } from "../core/time.js";
import type {
  AccountSummary,
  ImportCandidate,
  StoredKiroAccount,
} from "../core/types.js";
import type { RuntimeDependencies } from "../runtime.js";
import type {
  AuthFlow,
  AuthSubmission,
  BrowserCallbackAuthFlow,
  ProviderAdapter,
} from "./provider.js";

const AUTH_PORTAL_URL = "https://app.kiro.dev/signin";
const TOKEN_ENDPOINT =
  "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token";
const REFRESH_ENDPOINT =
  "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
const RUNTIME_DEFAULT_ENDPOINT = "https://q.us-east-1.amazonaws.com";
const OAUTH_TIMEOUT_MS = 600_000;
const HTTP_TIMEOUT_MS = 20_000;
const ACCESS_TOKEN_KEYS: readonly (readonly string[])[] = [
  ["accessToken"],
  ["access_token"],
  ["token"],
  ["idToken"],
  ["id_token"],
];
const REFRESH_TOKEN_KEYS: readonly (readonly string[])[] = [
  ["refreshToken"],
  ["refresh_token"],
];
const EXPIRES_AT_KEYS: readonly (readonly string[])[] = [
  ["expiresAt"],
  ["expires_at"],
  ["expiry"],
  ["expiration"],
];
const IDC_REGION_KEYS: readonly (readonly string[])[] = [
  ["idc_region"],
  ["idcRegion"],
  ["region"],
];
const CLIENT_ID_KEYS: readonly (readonly string[])[] = [
  ["client_id"],
  ["clientId"],
];
const LOGIN_PROVIDER_KEYS: readonly (readonly string[])[] = [
  ["login_option"],
  ["provider"],
  ["loginProvider"],
];
const PROFILE_ARN_KEYS: readonly (readonly string[])[] = [
  ["profileArn"],
  ["profile_arn"],
  ["arn"],
];

interface CallbackData {
  code: string;
  path: string;
  loginOption: string;
  issuerUrl: string | null;
  idcRegion: string | null;
}

interface ParsedUsage {
  planName: string | null;
  creditsTotal: number | null;
  creditsUsed: number | null;
  bonusTotal: number | null;
  bonusUsed: number | null;
  usageResetAt: number | null;
  bonusExpireDays: number | null;
  email: string | null;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(snippet(message, 300));
}

function pickString(
  root: Record<string, unknown> | undefined,
  paths: readonly (readonly string[])[],
): string | undefined {
  if (root == null) return undefined;
  for (const parts of paths) {
    let current: unknown = root;
    for (const part of parts) {
      const record = asRecord(current);
      if (record == null) {
        current = undefined;
        break;
      }
      current = record[part];
    }
    if (typeof current === "string" && current.trim() !== "")
      return current.trim();
  }
  return undefined;
}

function pickNumber(
  root: Record<string, unknown> | undefined,
  paths: readonly (readonly string[])[],
): number | undefined {
  if (root == null) return undefined;
  for (const parts of paths) {
    let current: unknown = root;
    for (const part of parts) {
      const record = asRecord(current);
      if (record == null) {
        current = undefined;
        break;
      }
      current = record[part];
    }
    if (typeof current === "number" && Number.isFinite(current)) return current;
    if (typeof current === "string") {
      const parsed = Number(current.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function pickTimestamp(
  root: Record<string, unknown> | undefined,
  paths: readonly (readonly string[])[],
): number | null {
  if (root == null) return null;
  for (const parts of paths) {
    let current: unknown = root;
    for (const part of parts) {
      const record = asRecord(current);
      if (record == null) {
        current = undefined;
        break;
      }
      current = record[part];
    }
    if (typeof current === "number" && Number.isFinite(current)) {
      const normalized = heuristicEpochMs(current);
      if (normalized != null) return normalized;
    } else if (typeof current === "string" && current.trim() !== "") {
      const trimmed = current.trim();
      if (/^\d+$/.test(trimmed)) {
        const normalized = heuristicEpochMs(Number(trimmed));
        if (normalized != null) return normalized;
      } else {
        const parsed = Date.parse(trimmed);
        if (!Number.isNaN(parsed)) return parsed;
      }
    }
  }
  return null;
}

function providerFromLoginOption(loginOption: string): string {
  const lowered = loginOption.trim().toLowerCase();
  if (lowered === "google") return "Google";
  if (lowered === "github") return "GitHub";
  return loginOption;
}

function resolvePlanDisplay(raw: string): string {
  const upper = raw.trim().toUpperCase();
  if (upper.includes("FREE") || upper.includes("STANDALONE")) return "FREE";
  if (upper.includes("PRO")) return "PRO";
  if (upper.includes("INDIVIDUAL")) return "INDIVIDUAL";
  if (upper.includes("BUSINESS") || upper.includes("TEAM")) return "BUSINESS";
  if (upper.includes("ENTERPRISE")) return "ENTERPRISE";
  return upper;
}

/** `arn:partition:service:region:...` → region segment (empty → null). */
export function parseProfileArnRegion(arn: string): string | null {
  const parts = arn.split(":");
  if (parts[0]?.trim().toLowerCase() !== "arn") return null;
  const region = parts[3]?.trim();
  return region != null && region !== "" ? region : null;
}

function runtimeEndpointForRegion(region: string | null): string {
  const lowered = (region ?? "us-east-1").trim().toLowerCase();
  if (lowered === "us-east-1") return "https://q.us-east-1.amazonaws.com";
  if (lowered === "eu-central-1") return "https://q.eu-central-1.amazonaws.com";
  return RUNTIME_DEFAULT_ENDPOINT;
}

function extractProfileArn(
  authToken: Record<string, unknown>,
  profile: Record<string, unknown> | undefined,
): string | null {
  return (
    pickString(profile, [["arn"], ["profileArn"]]) ??
    pickString(authToken, PROFILE_ARN_KEYS) ??
    null
  );
}

/** Reference `parse_callback_url`: accepts full URL, `?query`, or bare query. */
export function parseKiroCallbackUrl(raw: string): {
  code: string;
  loginOption: string | null;
  state: string | null;
} {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("Callback URL is empty.");
  }
  let query: string;
  const queryIndex = trimmed.indexOf("?");
  if (queryIndex >= 0) {
    query = trimmed.slice(queryIndex + 1);
  } else if (trimmed.startsWith("/") || trimmed.startsWith("http")) {
    throw new Error("Callback URL has no query parameters.");
  } else {
    query = trimmed.replace(/^\?/, "");
  }
  const params = parseQueryParams(query);
  const code = params.code;
  if (code == null || code === "") {
    throw new Error("No code parameter in callback URL.");
  }
  return {
    code,
    loginOption: params.login_option ?? params.loginOption ?? null,
    state: params.state ?? null,
  };
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

export function createKiroProvider(deps: RuntimeDependencies): ProviderAdapter {
  const { store, fetch, clock, callbackServer } = deps;

  // -------------------------------------------------------------------------
  // Local discovery: token file required, profile enrichment optional
  // -------------------------------------------------------------------------

  function tokenPaths(): string[] {
    const paths = [
      path.join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json"),
    ];
    if (process.platform === "linux") {
      paths.push(
        path.join(homedir(), ".config", "kiro-server", "kiro-auth-token.json"),
      );
    }
    return paths;
  }

  function profilePath(): string {
    if (process.platform === "darwin") {
      return path.join(
        homedir(),
        "Library",
        "Application Support",
        "Kiro",
        "User",
        "globalStorage",
        "kiro.kiroagent",
        "profile.json",
      );
    }
    if (process.platform === "win32") {
      const appData = process.env.APPDATA;
      if (appData != null && appData.trim() !== "") {
        return path.join(
          appData,
          "Kiro",
          "User",
          "globalStorage",
          "kiro.kiroagent",
          "profile.json",
        );
      }
    }
    return path.join(
      homedir(),
      ".config",
      "Kiro",
      "User",
      "globalStorage",
      "kiro.kiroagent",
      "profile.json",
    );
  }

  async function discoverImports(
    signal: AbortSignal,
  ): Promise<ImportCandidate[]> {
    const settings = await store.loadSettings();
    const override = settings.importPathOverrides.kiro?.trim();
    const paths = tokenPaths();
    if (override != null && override !== "") paths.push(override);
    const candidates: ImportCandidate[] = [];
    for (const tokenPath of paths) {
      if (signal.aborted) break;
      if (await pathReadable(tokenPath)) {
        candidates.push({
          provider: "kiro",
          source: "file",
          label: `Kiro auth token (${tokenPath})`,
          path: tokenPath,
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
        "Kiro import requires a credential file path",
      );
    }
    // Confirmed-first walk (see the Codex adapter): the confirmed token file
    // leads, remaining discovered token files follow (SSO cache, the Linux
    // Kiro-server variant, then the configured override); typed failures
    // skip forward; only the winning token is persisted, after the build.
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
      (entry): DiscoverySource<StoredKiroAccount> => ({
        candidate: entry,
        load: async (loadSignal) => {
          const tokenPath = entry.path;
          if (tokenPath == null) {
            throw new DiscoveryError(
              "NoCredentialFound",
              "Kiro import requires a credential file path",
            );
          }
          const token = asRecord(
            await readJsonCredentialFile(tokenPath, loadSignal),
          );
          if (token == null) {
            throw new DiscoveryError(
              "CorruptCredential",
              `Kiro auth token is not an object: ${tokenPath}`,
              [tokenPath],
            );
          }
          if (pickString(token, ACCESS_TOKEN_KEYS) == null) {
            throw new DiscoveryError(
              "EmptyCredential",
              `Kiro auth token missing access token: ${tokenPath}`,
              [tokenPath],
            );
          }
          return buildAndSaveAccount(
            token,
            await readProfileFile(loadSignal),
            loadSignal,
            { persist: false },
          );
        },
      }),
    );
    const confirmed = await confirmFirstSource(ordered, signal);
    await store.upsert("kiro", confirmed.value);
    return [await summaryOf(confirmed.value.id)];
  }

  async function readProfileFile(
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    const profileFilePath = profilePath();
    if (!(await pathReadable(profileFilePath))) return undefined;
    try {
      return (
        asRecord(await readJsonCredentialFile(profileFilePath, signal)) ??
        undefined
      );
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Browser OAuth (candidate loopback port) with manual submission
  // -------------------------------------------------------------------------

  async function beginAuth(signal: AbortSignal): Promise<AuthFlow> {
    const state = randomToken(32);
    const { codeVerifier, codeChallenge } = newPkcePair(32);
    const server = await callbackServer.start({
      kind: "kiro",
      expectedState: state,
      timeoutMs: OAUTH_TIMEOUT_MS,
      signal,
    });
    // Cognito's localhost special-casing: registered without port or path.
    const callbackUrl = server.baseUrl;
    const authUrl = [
      `${AUTH_PORTAL_URL}?state=${encodeQueryComponent(state)}`,
      `code_challenge=${encodeQueryComponent(codeChallenge)}`,
      "code_challenge_method=S256",
      `redirect_uri=${encodeQueryComponent(callbackUrl)}`,
      "redirect_from=KiroIDE",
    ].join("&");
    const expiresAt = clock.now() + OAUTH_TIMEOUT_MS;

    let manualResolve: ((callback: CallbackSuccess) => void) | undefined;
    const manual = new Promise<CallbackSuccess>((resolve) => {
      manualResolve = resolve;
    });

    const result = (async () => {
      try {
        const callback = await Promise.race([server.result, manual]);
        const data = callbackDataFrom(callback);
        const redirectUri = buildRedirectUri(callbackUrl, data);
        const token = await exchangeCodeForToken(
          data.code,
          codeVerifier,
          redirectUri,
          data.loginOption,
          data.issuerUrl,
          data.idcRegion,
          signal,
        );
        const account = await buildAndSaveAccount(token, undefined, signal);
        return [await summaryOf(account.id)];
      } finally {
        await server.close();
      }
    })();

    const flow: BrowserCallbackAuthFlow = {
      mode: "browserCallback",
      provider: "kiro",
      authUrl,
      callbackUrl,
      expiresAt,
      result,
      submit: async (submission: AuthSubmission) => {
        if (submission.kind !== "kiro") {
          throw new Error("Kiro login accepts only kiro submissions.");
        }
        const parsed = parseKiroCallbackUrl(submission.callbackUrl);
        if (parsed.state != null && parsed.state !== state) {
          throw new Error("State mismatch in callback URL.");
        }
        manualResolve?.({
          code: parsed.code,
          state: parsed.state ?? state,
          path: "",
          params:
            parsed.loginOption != null
              ? { login_option: parsed.loginOption }
              : {},
        });
      },
      cancel: async () => {
        await server.cancel();
      },
    };
    return flow;
  }

  function callbackDataFrom(callback: CallbackSuccess): CallbackData {
    const params = callback.params;
    const loginOption = (
      params.login_option ??
      params.loginOption ??
      ""
    ).toLowerCase();
    const issuerUrl = nonEmpty(params.issuer_url ?? params.issuerUrl);
    const idcRegion = nonEmpty(params.idc_region ?? params.idcRegion);
    return {
      code: callback.code,
      path: callback.path,
      loginOption,
      issuerUrl,
      idcRegion,
    };
  }

  function nonEmpty(value: string | undefined): string | null {
    return value != null && value !== "" ? value : null;
  }

  /** Rebuilds the exact redirect_uri Kiro validated, from the real path. */
  function buildRedirectUri(callbackUrl: string, data: CallbackData): string {
    const schemeEnd = callbackUrl.indexOf("://");
    const pathStart =
      schemeEnd >= 0
        ? callbackUrl.indexOf("/", schemeEnd + 3)
        : callbackUrl.indexOf("/");
    const baseUrl =
      pathStart >= 0
        ? callbackUrl.slice(0, pathStart)
        : callbackUrl.replace(/\/+$/, "");
    const callbackPath =
      data.path === ""
        ? "/oauth/callback"
        : data.path.startsWith("/")
          ? data.path
          : `/${data.path}`;
    if (data.loginOption === "") {
      return `${baseUrl}${callbackPath}`;
    }
    return `${baseUrl}${callbackPath}?login_option=${encodeQueryComponent(data.loginOption)}`;
  }

  async function exchangeCodeForToken(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    loginOption: string,
    issuerUrl: string | null,
    idcRegion: string | null,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        TOKEN_ENDPOINT,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri,
          }),
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
        },
        fetch,
      );
    } catch (error) {
      throw new Error(`Kiro token exchange failed: ${errorText(error)}`);
    }
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Kiro token exchange error: status=${response.status} body_len=${body.length}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(
        `Could not parse Kiro token response: ${errorText(error)}`,
      );
    }
    const root = unwrapDataEnvelope(asRecord(parsed));
    if (root == null) {
      throw new Error("Could not parse Kiro token response: not an object");
    }
    if (loginOption !== "") {
      const provider = providerFromLoginOption(loginOption);
      root.login_option = root.login_option ?? loginOption;
      root.provider = root.provider ?? provider;
      root.loginProvider = root.loginProvider ?? provider;
    }
    if (issuerUrl != null) {
      root.issuer_url = root.issuer_url ?? issuerUrl;
    }
    if (idcRegion != null) {
      root.idc_region = root.idc_region ?? idcRegion;
      root.idcRegion = root.idcRegion ?? idcRegion;
    }
    ensureExpiresAt(root, clock.now());
    return root;
  }

  async function tryRefreshToken(
    refreshToken: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        REFRESH_ENDPOINT,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
        },
        fetch,
      );
    } catch (error) {
      throw new Error(`Kiro token refresh failed: ${errorText(error)}`);
    }
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Kiro refresh token error: status=${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(
        `Could not parse Kiro refresh response: ${errorText(error)}`,
      );
    }
    const root = unwrapDataEnvelope(asRecord(parsed));
    if (root == null) {
      throw new Error("Could not parse Kiro refresh response: not an object");
    }
    ensureExpiresAt(root, clock.now());
    return root;
  }

  function unwrapDataEnvelope(
    root: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (root == null) return undefined;
    const data = root.data;
    const dataRecord = asRecord(data);
    return dataRecord != null ? dataRecord : root;
  }

  function ensureExpiresAt(
    token: Record<string, unknown>,
    nowMs: number,
  ): void {
    if ("expiresAt" in token || "expires_at" in token) return;
    const expiresInSeconds =
      pickNumber(token, [["expiresIn"], ["expires_in"]]) ?? 0;
    if (expiresInSeconds > 0) {
      token.expiresAt = Math.trunc(nowMs + expiresInSeconds * 1000);
    }
  }

  // -------------------------------------------------------------------------
  // Account build/save with live usage fetch
  // -------------------------------------------------------------------------

  async function buildAndSaveAccount(
    authToken: Record<string, unknown>,
    profile: Record<string, unknown> | undefined,
    signal: AbortSignal,
    options: { persist?: boolean } = {},
  ): Promise<StoredKiroAccount> {
    const accessToken = pickString(authToken, ACCESS_TOKEN_KEYS);
    if (accessToken == null) {
      throw new Error("Kiro auth token missing access token field.");
    }
    const refreshToken = pickString(authToken, REFRESH_TOKEN_KEYS) ?? null;
    const expiresAt = pickTimestamp(authToken, EXPIRES_AT_KEYS);
    const idcRegion = pickString(authToken, IDC_REGION_KEYS) ?? null;
    const clientId = pickString(authToken, CLIENT_ID_KEYS) ?? null;
    const loginProviderRaw = pickString(authToken, LOGIN_PROVIDER_KEYS);
    const loginProvider =
      loginProviderRaw != null
        ? providerFromLoginOption(loginProviderRaw)
        : null;
    const email =
      pickString(profile, [
        ["email"],
        ["account", "email"],
        ["primaryEmail"],
      ]) ??
      pickString(authToken, [
        ["email"],
        ["userEmail"],
        ["login_hint"],
        ["loginHint"],
      ]) ??
      jwtEmailHint(decodeJwtPayload(accessToken)) ??
      "";

    const profileArn = extractProfileArn(authToken, profile);
    const now = clock.now();
    let account: StoredKiroAccount = {
      provider: "kiro",
      id: "",
      email,
      loginProvider,
      accessToken,
      refreshToken,
      expiresAt,
      idcRegion,
      clientId,
      planName: null,
      planTier: null,
      creditsTotal: null,
      creditsUsed: null,
      bonusTotal: null,
      bonusUsed: null,
      usageResetAt: null,
      bonusExpireDays: null,
      kiroAuthTokenRaw: authToken,
      kiroProfileRaw: profile,
      status: "active",
      statusReason: null,
      quotaQueryLastError: null,
      quotaQueryLastErrorAt: null,
      usageUpdatedAt: null,
      createdAt: now,
      lastUsed: now,
    };

    if (profileArn != null) {
      try {
        account = await fetchAndApplyUsage(account, profileArn, signal);
      } catch (error) {
        const nowMs = clock.now();
        account = {
          ...account,
          quotaQueryLastError: errorText(error),
          quotaQueryLastErrorAt: nowMs,
        };
      }
    }

    const idEmail = account.email.includes("@")
      ? account.email
      : tokenSeed(accessToken);
    const finalArn =
      profileArn ??
      extractProfileArn(
        asRecord(account.kiroAuthTokenRaw) ?? {},
        asRecord(account.kiroProfileRaw),
      );
    account = {
      ...account,
      id: kiroAccountId(idEmail, finalArn ?? undefined),
      lastUsed: clock.now(),
    };
    if (options.persist !== false) {
      await store.upsert("kiro", account);
    }
    return account;
  }

  async function fetchAndApplyUsage(
    account: StoredKiroAccount,
    profileArn: string,
    signal: AbortSignal,
  ): Promise<StoredKiroAccount> {
    let current = account;
    let usage: unknown;
    try {
      usage = await fetchRuntimeUsage(current.accessToken, profileArn, signal);
    } catch (error) {
      const refreshToken = current.refreshToken;
      if (refreshToken == null || refreshToken === "") {
        throw error;
      }
      const newToken = await tryRefreshToken(refreshToken, signal);
      const accessToken = pickString(newToken, ACCESS_TOKEN_KEYS);
      const nextRefresh = pickString(newToken, REFRESH_TOKEN_KEYS);
      const expiresAt = pickTimestamp(newToken, EXPIRES_AT_KEYS);
      current = {
        ...current,
        accessToken: accessToken ?? current.accessToken,
        refreshToken: nextRefresh ?? current.refreshToken,
        expiresAt: expiresAt ?? current.expiresAt,
        kiroAuthTokenRaw: mergeTokenRecords(
          asRecord(current.kiroAuthTokenRaw),
          newToken,
        ),
      };
      usage = await fetchRuntimeUsage(current.accessToken, profileArn, signal);
    }
    return applyUsage(current, usage, clock.now());
  }

  function mergeTokenRecords(
    previous: Record<string, unknown> | undefined,
    next: Record<string, unknown>,
  ): Record<string, unknown> {
    return previous == null ? next : { ...previous, ...next };
  }

  async function fetchRuntimeUsage(
    accessToken: string,
    profileArn: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const endpoint = runtimeEndpointForRegion(
      parseProfileArnRegion(profileArn),
    );
    const url = [
      `${endpoint.replace(/\/+$/, "")}/getUsageLimits`,
      "origin=AI_EDITOR",
      `profileArn=${encodeQueryComponent(profileArn)}`,
      "resourceType=AGENTIC_REQUEST",
      "isEmailRequired=true",
    ].join("&");
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        {
          headers: { Authorization: `Bearer ${accessToken.trim()}` },
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
        },
        fetch,
      );
    } catch (error) {
      throw new Error(`Kiro runtime usage request failed: ${errorText(error)}`);
    }
    const body = await response.text();
    if (!response.ok) {
      // 403 typically means the account is banned or disabled.
      if (response.status === 403) {
        throw new Error(
          `BANNED:${parseRuntimeError(body) ?? snippet(body, 200)}`,
        );
      }
      throw new Error(`Kiro runtime usage error: status=${response.status}`);
    }
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(
        `Could not parse Kiro usage response: ${errorText(error)}`,
      );
    }
  }

  function parseRuntimeError(body: string): string | undefined {
    try {
      const root = asRecord(JSON.parse(body));
      return pickString(root, [
        ["reason"],
        ["message"],
        ["errorMessage"],
        ["error", "message"],
        ["detail"],
      ]);
    } catch {
      return undefined;
    }
  }

  function applyUsage(
    account: StoredKiroAccount,
    usage: unknown,
    nowMs: number,
  ): StoredKiroAccount {
    const parsed = parseUsage(usage);
    return {
      ...account,
      email:
        parsed.email?.includes("@") === true ? parsed.email : account.email,
      planName:
        parsed.planName != null
          ? resolvePlanDisplay(parsed.planName)
          : account.planName,
      creditsTotal: parsed.creditsTotal ?? account.creditsTotal,
      creditsUsed: parsed.creditsUsed ?? account.creditsUsed,
      bonusTotal: parsed.bonusTotal ?? account.bonusTotal,
      bonusUsed: parsed.bonusUsed ?? account.bonusUsed,
      usageResetAt: parsed.usageResetAt ?? account.usageResetAt,
      bonusExpireDays: parsed.bonusExpireDays ?? account.bonusExpireDays,
      quotaQueryLastError: null,
      quotaQueryLastErrorAt: null,
      usageUpdatedAt: nowMs,
    };
  }

  function parseUsage(raw: unknown): ParsedUsage {
    const record = asRecord(raw) ?? {};
    const root = resolveUsageRoot(record);
    const email =
      pickString(record, [["userInfo", "email"], ["email"]]) ?? null;
    const breakdown = findPrimaryBreakdown(root);
    const freeTrial =
      breakdown != null
        ? (asRecord(breakdown.freeTrialUsage) ??
          asRecord(breakdown.freeTrialInfo))
        : undefined;

    const planName =
      pickString(root, [
        ["planName"],
        ["currentPlanName"],
        ["subscriptionInfo", "subscriptionName"],
        ["subscriptionInfo", "subscriptionTitle"],
        ["subscriptionInfo", "type"],
        ["usageBreakdowns", "planName"],
        ["plan", "name"],
      ]) ??
      (breakdown != null
        ? pickString(breakdown, [
            ["displayName"],
            ["displayNamePlural"],
            ["type"],
            ["unit"],
          ])
        : undefined) ??
      null;

    const creditsTotal =
      pickNumber(root, [
        ["estimatedUsage", "total"],
        ["usageBreakdowns", "plan", "totalCredits"],
      ]) ??
      (breakdown != null
        ? pickNumber(breakdown, [
            ["usageLimitWithPrecision"],
            ["usageLimit"],
            ["limit"],
            ["total"],
            ["totalCredits"],
          ])
        : undefined) ??
      null;
    const creditsUsed =
      pickNumber(root, [
        ["estimatedUsage", "used"],
        ["usageBreakdowns", "plan", "usedCredits"],
      ]) ??
      (breakdown != null
        ? pickNumber(breakdown, [
            ["currentUsageWithPrecision"],
            ["currentUsage"],
            ["used"],
            ["usedCredits"],
          ])
        : undefined) ??
      null;
    const bonusTotal =
      pickNumber(freeTrial, [
        ["usageLimitWithPrecision"],
        ["usageLimit"],
        ["limit"],
        ["total"],
      ]) ??
      pickNumber(root, [
        ["bonusCredits", "total"],
        ["bonus", "total"],
      ]) ??
      null;
    const bonusUsed =
      pickNumber(freeTrial, [
        ["currentUsageWithPrecision"],
        ["currentUsage"],
        ["used"],
      ]) ??
      pickNumber(root, [
        ["bonusCredits", "used"],
        ["bonus", "used"],
      ]) ??
      null;
    const bonusExpireDays = (() => {
      const days = pickNumber(freeTrial, [
        ["daysRemaining"],
        ["expiryDays"],
        ["expireDays"],
      ]);
      if (days != null) return Math.round(days);
      const expiry = pickTimestamp(freeTrial, [
        ["expiryDate"],
        ["freeTrialExpiry"],
      ]);
      if (expiry == null) return null;
      const now = clock.now();
      if (expiry <= now) return 0;
      return Math.ceil((expiry - now) / 86_400_000);
    })();
    const usageResetAt =
      pickTimestamp(root, [
        ["resetAt"],
        ["resetTime"],
        ["resetOn"],
        ["nextDateReset"],
        ["usageBreakdowns", "resetAt"],
      ]) ??
      (breakdown != null
        ? pickTimestamp(breakdown, [["resetDate"], ["resetAt"]])
        : null);

    return {
      planName,
      creditsTotal,
      creditsUsed,
      bonusTotal,
      bonusUsed,
      usageResetAt,
      bonusExpireDays,
      email: email ?? null,
    };
  }

  function resolveUsageRoot(
    record: Record<string, unknown>,
  ): Record<string, unknown> {
    const state = asRecord(record["kiro.resourceNotifications.usageState"]);
    if (state != null) return state;
    const usageState = asRecord(record.usageState);
    if (usageState != null) return usageState;
    return record;
  }

  function findPrimaryBreakdown(
    root: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const list = Array.isArray(root.usageBreakdownList)
      ? root.usageBreakdownList
      : Array.isArray(root.usageBreakdowns)
        ? root.usageBreakdowns
        : undefined;
    if (list == null || list.length === 0) return undefined;
    for (const entry of list) {
      const record = asRecord(entry);
      if (record != null && typeof record.type === "string") {
        if ((record.type as string).toLowerCase() === "credit") return record;
      }
    }
    return asRecord(list[0]) ?? undefined;
  }

  // -------------------------------------------------------------------------
  // Refresh
  // -------------------------------------------------------------------------

  async function refresh(
    accountId: string,
    signal: AbortSignal,
  ): Promise<AccountSummary> {
    const accounts = await store.listStored("kiro");
    const account = accounts.find(
      (entry): entry is StoredKiroAccount =>
        entry.provider === "kiro" && entry.id === accountId,
    );
    if (account == null) {
      throw new Error(`Could not read Kiro account: ${accountId}`);
    }
    const profileArn = extractProfileArn(
      asRecord(account.kiroAuthTokenRaw) ?? {},
      asRecord(account.kiroProfileRaw),
    );
    let current = account;
    if (profileArn != null) {
      try {
        current = await fetchAndApplyUsage(current, profileArn, signal);
      } catch (error) {
        const message = errorText(error);
        const banned = message.startsWith("BANNED:");
        const reason = banned ? message.slice("BANNED:".length) : message;
        const nowMs = clock.now();
        current = {
          ...current,
          quotaQueryLastError: reason,
          quotaQueryLastErrorAt: nowMs,
          status: banned ? "banned" : current.status,
          statusReason: banned ? reason : current.statusReason,
        };
      }
    } else {
      const nowMs = clock.now();
      current = {
        ...current,
        quotaQueryLastError:
          "Cannot refresh: no profile ARN in stored credentials.",
        quotaQueryLastErrorAt: nowMs,
      };
    }
    await store.upsert("kiro", { ...current, lastUsed: clock.now() });
    return summaryOf(current.id);
  }

  async function refreshAll(signal: AbortSignal): Promise<AccountSummary[]> {
    const accounts = await store.listStored("kiro");
    for (const account of accounts) {
      if (signal.aborted) break;
      try {
        await refresh(account.id, signal);
      } catch {
        // Per-account failures already persisted their typed error state.
      }
    }
    return store.list("kiro");
  }

  async function summaryOf(accountId: string): Promise<AccountSummary> {
    const summaries = await store.list("kiro");
    const match = summaries.find((summary) => summary.id === accountId);
    if (match == null) {
      throw new Error("Kiro account is missing from the private store");
    }
    return match;
  }

  return {
    list: () => store.list("kiro"),
    discoverImports,
    import: importCandidate,
    beginAuth,
    refresh,
    refreshAll,
    remove: (accountId: string) => store.remove("kiro", accountId),
  };
}
