/**
 * Antigravity (Gemini) adapter: local `oauth_creds.json` discovery with
 * same-directory enrichment, ephemeral-port Google OAuth, and the
 * Code Assist quota protocol (loadCodeAssist → fetchAvailableModels →
 * retrieveUserQuotaSummary). Ported from
 * `ref/quota/src-tauri/src/antigravity.rs`. Requests never set
 * `Accept-Encoding`; timestamps are epoch milliseconds.
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
} from "../core/discovery.js";
import {
  encodeQueryComponent,
  fetchWithTimeout,
  postForm,
  redactSecrets,
  snippet,
} from "../core/http.js";
import { antigravityAccountId } from "../core/ids.js";
import { claimString, decodeJwtPayload } from "../core/jwt.js";
import { newPkcePair, pkceChallenge, randomToken } from "../core/oauth.js";
import { addSeconds } from "../core/time.js";
import type {
  AccountSummary,
  AntigravityCreditInfo,
  AntigravityQuotaSummary,
  AntigravityQuotaWindow,
  ImportCandidate,
  StoredAntigravityAccount,
} from "../core/types.js";
import type { RuntimeDependencies } from "../runtime.js";
import type {
  AuthFlow,
  BrowserCallbackAuthFlow,
  ProviderAdapter,
} from "./provider.js";

const DATA_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT =
  "https://www.googleapis.com/oauth2/v2/userinfo";
const OAUTH_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const OAUTH_CALLBACK_PATH = "/oauth-callback";
const OAUTH_TIMEOUT_MS = 300_000;
const CODE_ASSIST_BASE_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const CODE_ASSIST_LOAD_ENDPOINT = "v1internal:loadCodeAssist";
const CODE_ASSIST_FETCH_MODELS_ENDPOINT = "v1internal:fetchAvailableModels";
const CODE_ASSIST_RETRIEVE_QUOTA_ENDPOINT =
  "v1internal:retrieveUserQuotaSummary";
const IDE_VERSION = "1.20.5";
const GOOGLE_API_NODEJS_CLIENT_VERSION = "10.3.0";
const X_GOOG_API_CLIENT = "gl-node/22.21.1";
const HTTP_TIMEOUT_MS = 20_000;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const PREVIEW_LENGTH = 300;

interface CodeAssistStatus {
  tierId: string | null;
  tierName: string | null;
  projectId: string | null;
  credits: AntigravityCreditInfo[];
}

interface LocalCreds {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  tokenType: string | null;
  scope: string | null;
  expiryDate: number | null;
}

const EMPTY_WINDOW: AntigravityQuotaWindow = {
  remainingPercent: null,
  resetAt: null,
};

function emptyQuota(): AntigravityQuotaSummary {
  return {
    geminiFiveHour: { ...EMPTY_WINDOW },
    geminiWeekly: { ...EMPTY_WINDOW },
    thirdPartyFiveHour: { ...EMPTY_WINDOW },
    thirdPartyWeekly: { ...EMPTY_WINDOW },
  };
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(snippet(message, PREVIEW_LENGTH));
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

function isForbiddenError(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("status=403") ||
    lower.includes("403 forbidden") ||
    lower.includes("permission_denied") ||
    lower.includes("caller does not have permission")
  );
}

function responsePreview(text: string): string {
  return snippet(text, PREVIEW_LENGTH);
}

function userAgentOs(): "darwin" | "windows" | "linux" {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function userAgentArch(): "amd64" | "arm64" {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

function platformName(): string {
  const os = userAgentOs();
  const arch = userAgentArch();
  if (os === "darwin")
    return arch === "arm64" ? "DARWIN_ARM64" : "DARWIN_AMD64";
  if (os === "linux") return arch === "arm64" ? "LINUX_ARM64" : "LINUX_AMD64";
  return arch === "arm64" ? "PLATFORM_UNSPECIFIED" : "WINDOWS_AMD64";
}

function codeAssistUserAgent(endpoint: string): string {
  const base = `antigravity/${IDE_VERSION} ${userAgentOs()}/${userAgentArch()}`;
  if (endpoint.includes(CODE_ASSIST_LOAD_ENDPOINT)) {
    return `${base} google-api-nodejs-client/${GOOGLE_API_NODEJS_CLIENT_VERSION}`;
  }
  return base;
}

/** `preview` is already redacted by callers where bodies are untrusted. */
function quotaFailureMessage(status: number, text: string): string {
  return `Antigravity quota request failed: status=${status} body_length=${text.length} preview=${responsePreview(
    redactSecrets(text),
  )}`;
}

export function parseAntigravityQuota(raw: unknown): AntigravityQuotaSummary {
  const quota = emptyQuota();
  const root = asRecord(raw);
  const groups = root != null && Array.isArray(root.groups) ? root.groups : [];
  for (const groupEntry of groups) {
    const group = asRecord(groupEntry);
    if (group == null || !Array.isArray(group.buckets)) continue;
    for (const bucketEntry of group.buckets) {
      const bucket = asRecord(bucketEntry);
      if (bucket == null) continue;
      const bucketId =
        typeof bucket.bucketId === "string" ? bucket.bucketId : "";
      const window: AntigravityQuotaWindow = {
        remainingPercent: clampPercent(
          (numberOrNull(bucket.remainingFraction) ?? Number.NaN) * 100,
        ),
        resetAt: parseResetAt(bucket.resetTime),
      };
      if (bucketId === "gemini-5h") quota.geminiFiveHour = window;
      else if (bucketId === "gemini-weekly") quota.geminiWeekly = window;
      else if (bucketId === "3p-5h") quota.thirdPartyFiveHour = window;
      else if (bucketId === "3p-weekly") quota.thirdPartyWeekly = window;
    }
  }
  return quota;
}

function clampPercent(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function parseResetAt(value: unknown): number | null {
  const numeric = numberOrNull(value);
  if (numeric != null) return heuristicReset(numeric);
  const raw = textOrNull(value);
  if (raw == null) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && /^\d+$/.test(raw))
    return heuristicReset(asNumber);
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function heuristicReset(raw: number): number | null {
  if (raw <= 0) return null;
  // Above the shared threshold the value is already epoch milliseconds.
  return Math.trunc(raw > 10_000_000_000 ? raw : raw * 1000);
}

function tierPlanName(tierId: string): string {
  const lower = tierId.trim().toLowerCase();
  if (lower.includes("ultra")) return "Ultra";
  if (lower.includes("pro") || lower.includes("premium")) return "Pro";
  if (lower.includes("free") || lower === "standard-tier") return "Free";
  return tierId.trim();
}

export function parseAntigravityLoadStatus(raw: unknown): CodeAssistStatus {
  const root = asRecord(raw);
  const paidTier = root != null ? asRecord(root.paidTier) : undefined;
  const currentTier = root != null ? asRecord(root.currentTier) : undefined;
  const allowedTiers =
    root != null && Array.isArray(root.allowedTiers) ? root.allowedTiers : [];
  const firstAllowed = asRecord(allowedTiers[0]);
  const companionProject =
    root != null ? root.cloudaicompanionProject : undefined;
  const companionRecord = asRecord(companionProject);
  const credits: AntigravityCreditInfo[] = [];
  if (paidTier != null && Array.isArray(paidTier.availableCredits)) {
    for (const creditEntry of paidTier.availableCredits) {
      const credit = asRecord(creditEntry);
      if (credit == null) continue;
      const creditType = recordString(credit, "creditType");
      const creditAmount = recordString(credit, "creditAmount");
      if (creditType == null || creditAmount == null) continue;
      credits.push({
        creditType,
        creditAmount,
        minimumCreditAmountForUsage:
          recordString(credit, "minimumCreditAmountForUsage") ?? null,
      });
    }
  }
  return {
    tierId:
      tierField(paidTier, "id") ??
      tierField(currentTier, "id") ??
      tierField(firstAllowed, "id"),
    tierName: tierField(paidTier, "name") ?? tierField(currentTier, "name"),
    projectId:
      textOrNull(companionProject) ??
      (companionRecord != null
        ? recordString(companionRecord, "id")
        : undefined) ??
      (companionRecord != null
        ? recordString(companionRecord, "projectId")
        : undefined) ??
      null,
    credits,
  };
}

function tierField(
  tier: Record<string, unknown> | undefined,
  key: string,
): string | null {
  return tier != null ? textOrNull(tier[key]) : null;
}

export function createAntigravityProvider(
  deps: RuntimeDependencies,
): ProviderAdapter {
  const { store, fetch, clock, callbackServer } = deps;

  // -------------------------------------------------------------------------
  // Local discovery: $GEMINI_CLI_HOME/.gemini then ~/.gemini
  // -------------------------------------------------------------------------

  function credsPaths(
    env: Readonly<Record<string, string | undefined>>,
  ): string[] {
    const paths: string[] = [];
    const geminiHome = envOverride(env, "GEMINI_CLI_HOME");
    if (geminiHome != null) {
      paths.push(path.join(geminiHome, ".gemini", "oauth_creds.json"));
    }
    paths.push(path.join(homedir(), ".gemini", "oauth_creds.json"));
    return paths;
  }

  async function discoverImports(
    signal: AbortSignal,
  ): Promise<ImportCandidate[]> {
    const settings = await store.loadSettings();
    const override = settings.importPathOverrides.antigravity?.trim();
    const paths = credsPaths(process.env);
    if (override != null && override !== "") paths.push(override);
    const candidates: ImportCandidate[] = [];
    for (const credsPath of paths) {
      if (signal.aborted) break;
      if (await pathReadable(credsPath)) {
        candidates.push({
          provider: "antigravity",
          source: "file",
          label: `Antigravity/Gemini credentials (${credsPath})`,
          path: credsPath,
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
        "Antigravity import requires a credential file path",
      );
    }
    // Confirmed-first walk (see the Codex adapter): the confirmed candidate
    // leads, remaining discovered sources follow in precedence, typed
    // failures skip forward, and only the winning credential is persisted.
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
      (entry): DiscoverySource<StoredAntigravityAccount> => ({
        candidate: entry,
        load: (loadSignal) => {
          const credsPath = entry.path;
          if (credsPath == null) {
            throw new DiscoveryError(
              "NoCredentialFound",
              "Antigravity import requires a credential file path",
            );
          }
          return importFromCredsFile(credsPath, loadSignal);
        },
      }),
    );
    const confirmed = await confirmFirstSource(ordered, signal);
    await store.upsert("antigravity", confirmed.value);
    return [await summaryOf(confirmed.value.id)];
  }

  async function importFromCredsFile(
    credsPath: string,
    signal: AbortSignal,
  ): Promise<StoredAntigravityAccount> {
    const root = asRecord(await readJsonCredentialFile(credsPath, signal));
    if (root == null) {
      throw new DiscoveryError(
        "CorruptCredential",
        `Antigravity credentials are not an object: ${credsPath}`,
        [credsPath],
      );
    }
    const accessToken = recordString(root, "access_token");
    if (accessToken == null) {
      throw new DiscoveryError(
        "EmptyCredential",
        "Antigravity credentials have no access token",
        [credsPath],
      );
    }
    const creds: LocalCreds = {
      accessToken,
      refreshToken: recordString(root, "refresh_token") ?? null,
      idToken: recordString(root, "id_token") ?? null,
      tokenType: recordString(root, "token_type") ?? null,
      scope: recordString(root, "scope") ?? null,
      expiryDate: numberOrNull(root.expiry_date),
    };
    const directory = path.dirname(credsPath);
    const claims =
      creds.idToken != null ? decodeJwtPayload(creds.idToken) : undefined;
    const activeEmail = await readActiveGoogleEmail(directory, signal);
    const email =
      activeEmail ??
      (claims != null ? claimString(claims, ["email"]) : undefined) ??
      "unknown@gmail.com";
    const authId =
      claims != null ? (claimString(claims, ["sub"]) ?? null) : null;
    const name =
      claims != null ? (claimString(claims, ["name"]) ?? null) : null;
    const now = clock.now();
    return {
      provider: "antigravity",
      id: antigravityAccountId(email, authId ?? undefined),
      email,
      source: "local",
      authId,
      name,
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      idToken: creds.idToken,
      tokenType: creds.tokenType,
      scope: creds.scope,
      expiryDate: creds.expiryDate,
      selectedAuthType:
        (await readSelectedAuthType(directory, signal)) ?? "oauth-personal",
      projectId: null,
      tierId: null,
      planName: null,
      credits: [],
      quota: emptyQuota(),
      status: "active",
      statusReason: null,
      quotaQueryLastError: null,
      quotaQueryLastErrorAt: null,
      usageUpdatedAt: null,
      createdAt: now,
      lastUsed: now,
    };
  }

  /** Same-directory enrichment only; any failure simply yields undefined. */
  async function readActiveGoogleEmail(
    directory: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const root = asRecord(
        await readJsonCredentialFile(
          path.join(directory, "google_accounts.json"),
          signal,
        ),
      );
      if (root == null) return undefined;
      return (
        recordString(root, "active") ??
        recordString(root, "activeEmail") ??
        recordString(root, "current")
      );
    } catch {
      return undefined;
    }
  }

  async function readSelectedAuthType(
    directory: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const root = asRecord(
        await readJsonCredentialFile(
          path.join(directory, "settings.json"),
          signal,
        ),
      );
      const security = root != null ? asRecord(root.security) : undefined;
      const auth = security != null ? asRecord(security.auth) : undefined;
      return auth != null ? recordString(auth, "selectedType") : undefined;
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Browser OAuth on an ephemeral 127.0.0.1 port
  // -------------------------------------------------------------------------

  async function beginAuth(signal: AbortSignal): Promise<AuthFlow> {
    const state = randomToken(32);
    const { codeVerifier, codeChallenge } = newPkcePair(32);
    const server = await callbackServer.start({
      kind: "antigravity",
      expectedState: state,
      timeoutMs: OAUTH_TIMEOUT_MS,
      signal,
    });
    const callbackUrl = `${server.baseUrl}${OAUTH_CALLBACK_PATH}`;
    const authUrl = [
      `${OAUTH_AUTHORIZE_ENDPOINT}?response_type=code`,
      `client_id=${encodeQueryComponent(OAUTH_CLIENT_ID)}`,
      `redirect_uri=${encodeQueryComponent(callbackUrl)}`,
      "access_type=offline",
      `scope=${encodeQueryComponent(DATA_SCOPES.join(" "))}`,
      `state=${encodeQueryComponent(state)}`,
      `code_challenge=${encodeQueryComponent(codeChallenge)}`,
      "code_challenge_method=S256",
      "prompt=consent",
    ].join("&");
    const expiresAt = clock.now() + OAUTH_TIMEOUT_MS;

    const result = (async () => {
      try {
        const callback = await server.result;
        const response = await exchangeOAuthCode(
          codeVerifier,
          callbackUrl,
          callback.code,
          signal,
        );
        const accessToken = textOrNull(response.access_token);
        const profile =
          accessToken != null
            ? await fetchGoogleUserInfo(accessToken, signal)
            : undefined;
        const account = await upsertTokenResponse(response, profile);
        return [await summaryOf(account.id)];
      } finally {
        await server.close();
      }
    })();

    const flow: BrowserCallbackAuthFlow = {
      mode: "browserCallback",
      provider: "antigravity",
      authUrl,
      callbackUrl,
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
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await postForm(
        GOOGLE_TOKEN_ENDPOINT,
        [
          ["code", code],
          ["client_id", OAUTH_CLIENT_ID],
          ["redirect_uri", redirectUri],
          ["grant_type", "authorization_code"],
          ["code_verifier", codeVerifier],
        ],
        { signal, timeoutMs: HTTP_TIMEOUT_MS, fetchImpl: fetch },
      );
    } catch (error) {
      throw new Error(
        `Antigravity OAuth token request failed: ${errorText(error)}`,
      );
    }
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Antigravity OAuth token exchange returned ${response.status} with body length ${body.length}`,
      );
    }
    try {
      const parsed: unknown = JSON.parse(body);
      const root = asRecord(parsed);
      if (root == null) {
        throw new Error("Antigravity OAuth token response is not an object");
      }
      return root;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Antigravity"))
        throw error;
      throw new Error(
        `Could not parse Antigravity OAuth token response: ${errorText(error)}`,
      );
    }
  }

  async function upsertTokenResponse(
    response: Record<string, unknown>,
    profile: Record<string, unknown> | undefined,
  ): Promise<StoredAntigravityAccount> {
    return applyAntigravityTokenResponseForTest(deps, response, profile);
  }

  // -------------------------------------------------------------------------
  // Refresh: token validity, loadCodeAssist, quota summary
  // -------------------------------------------------------------------------

  async function refresh(
    accountId: string,
    signal: AbortSignal,
  ): Promise<AccountSummary> {
    const accounts = await store.listStored("antigravity");
    const account = accounts.find(
      (entry): entry is StoredAntigravityAccount =>
        entry.provider === "antigravity" && entry.id === accountId,
    );
    if (account == null) {
      throw new Error(`Could not read Antigravity account: ${accountId}`);
    }

    const refreshed = await ensureAccessTokenValid(account, signal);
    if ("error" in refreshed) {
      return recordRefreshError(refreshed.account, refreshed.error);
    }
    let current = refreshed.account;

    let loadStatus: CodeAssistStatus;
    try {
      loadStatus = await loadCodeAssistStatus(current, signal);
    } catch (error) {
      return recordRefreshError(current, errorMessage(error));
    }

    const userinfo = await fetchGoogleUserInfo(current.accessToken, signal);
    if (userinfo != null) {
      const email = recordString(userinfo, "email");
      if (email != null) current = { ...current, email };
      if (current.authId == null) {
        current = { ...current, authId: recordString(userinfo, "id") ?? null };
      }
      if (current.name == null) {
        current = { ...current, name: recordString(userinfo, "name") ?? null };
      }
    }

    current = {
      ...current,
      projectId: loadStatus.projectId,
      tierId: loadStatus.tierId,
      planName:
        loadStatus.tierName ??
        (current.tierId != null ? tierPlanName(current.tierId) : null),
      credits: loadStatus.credits,
      lastUsed: clock.now(),
    };

    if (current.projectId != null) {
      try {
        const rawQuota = await retrieveUserQuota(
          current,
          current.projectId,
          signal,
        );
        current = {
          ...current,
          quota: parseAntigravityQuota(rawQuota),
          quotaQueryLastError: null,
          quotaQueryLastErrorAt: null,
          usageUpdatedAt: current.lastUsed,
          status: "active",
          statusReason: null,
        };
      } catch (error) {
        const message = errorMessage(error);
        current = {
          ...current,
          quotaQueryLastError: message,
          quotaQueryLastErrorAt: clock.now(),
          status: isForbiddenError(message) ? "forbidden" : current.status,
          statusReason: isForbiddenError(message)
            ? message
            : current.statusReason,
        };
      }
    }

    await store.upsert("antigravity", current);
    return summaryOf(current.id);
  }

  async function ensureAccessTokenValid(
    account: StoredAntigravityAccount,
    signal: AbortSignal,
  ): Promise<
    | { account: StoredAntigravityAccount }
    | { account: StoredAntigravityAccount; error: string }
  > {
    const expiresSoon =
      account.expiryDate != null &&
      account.expiryDate <= clock.now() + TOKEN_EXPIRY_SKEW_MS;
    if (!expiresSoon) {
      return { account };
    }
    if (account.refreshToken == null) {
      return { account, error: "Antigravity refresh token is missing." };
    }
    let response: Response;
    try {
      response = await postForm(
        GOOGLE_TOKEN_ENDPOINT,
        [
          ["client_id", OAUTH_CLIENT_ID],
          ["refresh_token", account.refreshToken],
          ["grant_type", "refresh_token"],
        ],
        { signal, timeoutMs: HTTP_TIMEOUT_MS, fetchImpl: fetch },
      );
    } catch (error) {
      return {
        account,
        error: `Could not refresh Antigravity token: ${errorText(error)}`,
      };
    }
    const text = await response.text();
    if (!response.ok) {
      return {
        account,
        error: `Antigravity token refresh failed: status=${response.status} ${responsePreview(redactSecrets(text))}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        account,
        error: `Could not parse Antigravity token response: ${errorText(error)}`,
      };
    }
    const root = asRecord(parsed);
    if (root == null) {
      return {
        account,
        error: "Could not parse Antigravity token response: not an object",
      };
    }
    if (root.error != null) {
      return {
        account,
        error:
          recordString(root, "error_description") ??
          `Antigravity token refresh error: ${snippet(JSON.stringify(root.error), 200)}`,
      };
    }
    const accessToken = recordString(root, "access_token");
    if (accessToken == null) {
      return {
        account,
        error: "Antigravity token refresh returned no access token.",
      };
    }
    const idToken = recordString(root, "id_token");
    const tokenType = recordString(root, "token_type");
    const scope = recordString(root, "scope");
    const expiresInSeconds = numberOrNull(root.expires_in);
    return {
      account: {
        ...account,
        accessToken,
        idToken: idToken ?? account.idToken,
        tokenType: tokenType ?? account.tokenType,
        scope: scope ?? account.scope,
        expiryDate:
          expiresInSeconds != null
            ? addSeconds(clock.now(), expiresInSeconds)
            : account.expiryDate,
      },
    };
  }

  async function loadCodeAssistStatus(
    account: StoredAntigravityAccount,
    signal: AbortSignal,
  ): Promise<CodeAssistStatus> {
    const raw = await postCodeAssistJson(
      account.accessToken,
      CODE_ASSIST_LOAD_ENDPOINT,
      buildAntigravityLoadCodeAssistPayload(),
      signal,
    );
    return parseAntigravityLoadStatus(raw);
  }

  async function retrieveUserQuota(
    account: StoredAntigravityAccount,
    projectId: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const projectPayload = { project: projectId };
    // The models call is required server-side state; its response is ignored.
    await postCodeAssistJson(
      account.accessToken,
      CODE_ASSIST_FETCH_MODELS_ENDPOINT,
      projectPayload,
      signal,
    );
    return postCodeAssistJson(
      account.accessToken,
      CODE_ASSIST_RETRIEVE_QUOTA_ENDPOINT,
      projectPayload,
      signal,
    );
  }

  async function postCodeAssistJson(
    accessToken: string,
    endpoint: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const url = `${CODE_ASSIST_BASE_ENDPOINT}/${endpoint}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": codeAssistUserAgent(endpoint),
            "x-goog-api-client": X_GOOG_API_CLIENT,
            Accept: "*/*",
          },
          body: JSON.stringify(payload),
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
        },
        fetch,
      );
    } catch (error) {
      throw new Error(`Antigravity quota request failed: ${errorText(error)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(quotaFailureMessage(response.status, text));
    }
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(
        `Could not parse Antigravity quota response: ${errorText(error)} endpoint=${endpoint} status=${response.status} body_length=${text.length} preview=${responsePreview(redactSecrets(text))}`,
      );
    }
  }

  async function fetchGoogleUserInfo(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await fetchWithTimeout(
        GOOGLE_USERINFO_ENDPOINT,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
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

  async function recordRefreshError(
    account: StoredAntigravityAccount,
    error: string,
  ): Promise<AccountSummary> {
    const now = clock.now();
    await store.upsert("antigravity", {
      ...account,
      lastUsed: now,
      quotaQueryLastError: error,
      quotaQueryLastErrorAt: now,
      status: isForbiddenError(error) ? "forbidden" : account.status,
      statusReason: isForbiddenError(error) ? error : account.statusReason,
    });
    return summaryOf(account.id);
  }

  async function refreshAll(signal: AbortSignal): Promise<AccountSummary[]> {
    const accounts = await store.listStored("antigravity");
    for (const account of accounts) {
      if (signal.aborted) break;
      try {
        await refresh(account.id, signal);
      } catch {
        // Per-account failures already persisted their typed error state.
      }
    }
    return store.list("antigravity");
  }

  async function summaryOf(accountId: string): Promise<AccountSummary> {
    const summaries = await store.list("antigravity");
    const match = summaries.find((summary) => summary.id === accountId);
    if (match == null) {
      throw new Error("Antigravity account is missing from the private store");
    }
    return match;
  }

  return {
    list: () => store.list("antigravity"),
    discoverImports,
    import: importCandidate,
    beginAuth,
    refresh,
    refreshAll,
    remove: (accountId: string) => store.remove("antigravity", accountId),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? redactSecrets(snippet(error.message, PREVIEW_LENGTH))
    : String(error);
}

/**
 * The exact header set sent to every Code Assist request. Exported for
 * the canonical integration port (Rust
 * `build_antigravity_code_assist_headers_for_test`).
 */
export function buildAntigravityCodeAssistHeaders(
  endpoint: string,
): Array<readonly [string, string]> {
  return [
    ["Content-Type", "application/json"],
    ["User-Agent", codeAssistUserAgent(endpoint)],
    ["x-goog-api-client", X_GOOG_API_CLIENT],
    ["Accept", "*/*"],
  ];
}

/**
 * Reference `parse_code_assist_response_text`: empty bodies parse as `{}`;
 * failures carry endpoint, status, body length, and a bounded preview.
 * Exported for the canonical integration port (Rust
 * `parse_antigravity_code_assist_response_for_test`).
 */
export function parseAntigravityCodeAssistResponse(
  endpoint: string,
  status: number,
  text: string,
): unknown {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Could not parse Antigravity quota response: ${errorText(error)} endpoint=${endpoint} status=${status} body_length=${text.length} preview=${responsePreview(redactSecrets(text))}`,
    );
  }
}

/**
 * Reference `build_load_code_assist_payload`. Exported for the canonical
 * integration port (Rust `build_antigravity_load_code_assist_payload_for_test`).
 */
export function buildAntigravityLoadCodeAssistPayload(): Record<
  string,
  unknown
> {
  return {
    mode: "FULL_ELIGIBILITY_CHECK",
    metadata: {
      ideName: "antigravity",
      ideType: "ANTIGRAVITY",
      ideVersion: IDE_VERSION,
      pluginVersion: "quota",
      platform: platformName(),
      updateChannel: "stable",
      pluginType: "GEMINI",
    },
  };
}

/**
 * Reference `build_oauth_start` for the ephemeral loopback callback.
 * Exported for the canonical integration port (Rust
 * `build_antigravity_oauth_start_for_test`).
 */
export function buildAntigravityOAuthStart(
  loginId: string,
  state: string,
  callbackPort: number,
  codeVerifier: string,
): { loginId: string; authUrl: string; callbackUrl: string } {
  const callbackUrl = `http://127.0.0.1:${callbackPort}${OAUTH_CALLBACK_PATH}`;
  const authUrl = [
    `${OAUTH_AUTHORIZE_ENDPOINT}?response_type=code`,
    `client_id=${encodeQueryComponent(OAUTH_CLIENT_ID)}`,
    `redirect_uri=${encodeQueryComponent(callbackUrl)}`,
    "access_type=offline",
    `scope=${encodeQueryComponent(DATA_SCOPES.join(" "))}`,
    `state=${encodeQueryComponent(state)}`,
    `code_challenge=${encodeQueryComponent(pkceChallenge(codeVerifier))}`,
    "code_challenge_method=S256",
    "prompt=consent",
  ].join("&");
  return { loginId, authUrl, callbackUrl };
}

/**
 * Reference `upsert_token_response_in` (Rust
 * `apply_antigravity_token_response_for_test`): builds and stores the
 * account from a Google token response plus optional userinfo profile.
 */
export async function applyAntigravityTokenResponseForTest(
  deps: RuntimeDependencies,
  response: unknown,
  profile: Record<string, unknown> | undefined,
): Promise<StoredAntigravityAccount> {
  const { store, clock } = deps;
  const root = asRecord(response);
  if (root == null) {
    throw new Error("Antigravity token response is not an object");
  }
  if (root.error != null) {
    const description = recordString(root, "error_description");
    throw new Error(
      description ??
        `Antigravity token response error: ${snippet(JSON.stringify(root.error), 200)}`,
    );
  }
  const accessToken = recordString(root, "access_token");
  if (accessToken == null) {
    throw new Error(
      "Antigravity token response did not include an access token.",
    );
  }
  const idToken = recordString(root, "id_token") ?? null;
  const claims = idToken != null ? decodeJwtPayload(idToken) : undefined;
  const email =
    (profile != null ? recordString(profile, "email") : undefined) ??
    (claims != null ? claimString(claims, ["email"]) : undefined) ??
    "unknown@gmail.com";
  const authId =
    (profile != null ? recordString(profile, "id") : undefined) ??
    (claims != null ? claimString(claims, ["sub"]) : undefined) ??
    null;
  const name =
    (profile != null ? recordString(profile, "name") : undefined) ??
    (claims != null ? claimString(claims, ["name"]) : undefined) ??
    null;
  const expiresInSeconds = numberOrNull(root.expires_in);
  const now = clock.now();
  const account: StoredAntigravityAccount = {
    provider: "antigravity",
    id: antigravityAccountId(email, authId ?? undefined),
    email,
    source: "oauth",
    authId,
    name,
    accessToken,
    refreshToken: recordString(root, "refresh_token") ?? null,
    idToken,
    tokenType: recordString(root, "token_type") ?? null,
    scope: recordString(root, "scope") ?? null,
    expiryDate:
      expiresInSeconds != null ? addSeconds(now, expiresInSeconds) : null,
    selectedAuthType: "oauth-personal",
    projectId: null,
    tierId: null,
    planName: null,
    credits: [],
    quota: emptyQuota(),
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: null,
    createdAt: now,
    lastUsed: now,
  };
  await store.upsert("antigravity", account);
  return account;
}
