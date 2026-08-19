/**
 * Cursor adapter: read-only `state.vscdb` import via `node:sqlite`
 * (one SQLITE_BUSY retry), the DeepControl remote-poll login, and the
 * usage-summary/stripe/user-meta refresh chain with a single token
 * refresh retry. Ported from `ref/quota/src-tauri/src/cursor.rs`;
 * timestamps are epoch milliseconds.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  asRecord,
  confirmFirstSource,
  DiscoveryError,
  type DiscoverySource,
  envOverride,
  pathReadable,
  recordString,
} from "../core/discovery.js";
import {
  encodeQueryComponent,
  fetchWithTimeout,
  redactSecrets,
  snippet,
} from "../core/http.js";
import { cursorAccountId, tokenSeed } from "../core/ids.js";
import { claimString, decodeJwtPayload } from "../core/jwt.js";
import { newPkcePair } from "../core/oauth.js";
import type {
  AccountSummary,
  ImportCandidate,
  StoredCursorAccount,
} from "../core/types.js";
import type { RuntimeDependencies } from "../runtime.js";
import type {
  AuthFlow,
  ProviderAdapter,
  RemotePollAuthFlow,
} from "./provider.js";

const LOGIN_URL = "https://cursor.com/loginDeepControl";
const POLL_URL = "https://api2.cursor.sh/auth/poll";
const USAGE_URL = "https://cursor.com/api/usage-summary";
const USER_META_URL =
  "https://api2.cursor.sh/aiserver.v1.AuthService/GetUserMeta";
const FULL_STRIPE_URL = "https://api2.cursor.sh/auth/full_stripe_profile";
const STRIPE_URL = "https://api2.cursor.sh/auth/stripe_profile";
const OAUTH_TOKEN_URL = "https://api2.cursor.sh/oauth/token";
const AUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_ATTEMPTS = 150;
const OAUTH_TIMEOUT_MS = 300_000;
const HTTP_TIMEOUT_MS = 20_000;
const SQLITE_BUSY_RETRY_MS = 250;
const SESSION_COOKIE_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
const AUTH_EXPIRED = "cursor_auth_expired";
const SESSION_EXPIRED_MESSAGE =
  "Cursor session expired. Re-import or reconnect your account.";

interface LocalDbCredentials {
  accessToken: string;
  refreshToken: string | null;
  email: string | null;
  authId: string | null;
  membershipType: string | null;
}

interface StripeProfile {
  membershipType: string | null;
  individualMembershipType: string | null;
  subscriptionStatus: string | null;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(snippet(message, 300));
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : "";
}

/** Reference `resolve_membership`: individual wins unless enterprise. */
function resolveMembership(profile: StripeProfile): string | null {
  const membership = textOrNull(profile.membershipType);
  const individual = textOrNull(profile.individualMembershipType);
  if (
    individual != null &&
    individual.toLowerCase() !== "free" &&
    !(membership != null && membership.toLowerCase() === "enterprise")
  ) {
    return individual;
  }
  return membership ?? individual;
}

/** `sub` tail after the last `|` must start with `user_` (WorkOS user id). */
function extractWorkosUserId(accessToken: string): string | null {
  const claims = decodeJwtPayload(accessToken);
  const sub = claims != null ? claimString(claims, ["sub"]) : undefined;
  if (sub == null) return null;
  const userId = sub.slice(sub.lastIndexOf("|") + 1);
  return userId.startsWith("user_") ? userId : null;
}

function buildSessionCookie(accessToken: string): string | null {
  const userId = extractWorkosUserId(accessToken);
  if (userId == null) return null;
  return `WorkosCursorSessionToken=${userId}%3A%3A${accessToken}`;
}

function isSqliteBusy(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ERR_SQLITE_BUSY" || code === "SQLITE_BUSY") return true;
  }
  return error instanceof Error && error.message.includes("database is locked");
}

export function createCursorProvider(
  deps: RuntimeDependencies,
): ProviderAdapter {
  const { store, fetch, clock } = deps;

  // -------------------------------------------------------------------------
  // Local discovery: platform state.vscdb, lowercase variant, override
  // -------------------------------------------------------------------------

  function databasePaths(): string[] {
    const paths: string[] = [];
    const configHome =
      process.platform === "win32"
        ? envOverride(process.env, "APPDATA")
        : process.platform === "darwin"
          ? path.join(homedir(), "Library", "Application Support")
          : (envOverride(process.env, "XDG_CONFIG_HOME") ??
            path.join(homedir(), ".config"));
    if (configHome == null) return paths;
    for (const appName of ["Cursor", "cursor"]) {
      paths.push(
        path.join(configHome, appName, "User", "globalStorage", "state.vscdb"),
      );
    }
    return paths;
  }

  async function discoverImports(
    signal: AbortSignal,
  ): Promise<ImportCandidate[]> {
    const settings = await store.loadSettings();
    const override = settings.importPathOverrides.cursor?.trim();
    const paths = databasePaths();
    if (override != null && override !== "") paths.push(override);
    const candidates: ImportCandidate[] = [];
    for (const dbPath of paths) {
      if (signal.aborted) break;
      if (await pathReadable(dbPath)) {
        candidates.push({
          provider: "cursor",
          source: "sqlite",
          label: `Cursor local database (${dbPath})`,
          path: dbPath,
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
        "Cursor import requires a database path",
      );
    }
    // Confirmed-first walk (see the Codex adapter): the confirmed database
    // leads, remaining discovered databases follow (Cursor then lowercase
    // cursor then override), typed failures skip forward, and only the
    // winning credential is refreshed and persisted.
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
      (entry): DiscoverySource<LocalDbCredentials> => ({
        candidate: entry,
        load: (loadSignal) => {
          const dbPath = entry.path;
          if (dbPath == null) {
            throw new DiscoveryError(
              "NoCredentialFound",
              "Cursor import requires a database path",
            );
          }
          return readLocalDatabase(dbPath, loadSignal);
        },
      }),
    );
    const confirmed = await confirmFirstSource(ordered, signal);
    const now = clock.now();
    const account: StoredCursorAccount = {
      provider: "cursor",
      id: "",
      email: confirmed.value.email,
      authId: confirmed.value.authId,
      signUpType: null,
      membershipType: confirmed.value.membershipType,
      subscriptionStatus: null,
      accessToken: confirmed.value.accessToken,
      refreshToken: confirmed.value.refreshToken,
      source: "local",
      totalPercent: null,
      autoPercent: null,
      apiPercent: null,
      billingCycleEnd: null,
      planUsed: null,
      planLimit: null,
      onDemandEnabled: null,
      onDemandUsed: null,
      onDemandLimit: null,
      status: "active",
      statusReason: null,
      quotaQueryLastError: null,
      quotaQueryLastErrorAt: null,
      usageUpdatedAt: null,
      createdAt: now,
      lastUsed: now,
    };
    const refreshed = await doRefreshAccount(account, signal);
    const stored = await upsertAccount(refreshed);
    return [await summaryOf(stored.id)];
  }

  /**
   * Opens the database read-only, reads only the `cursorAuth/*` rows, and
   * closes immediately. One SQLITE_BUSY retry (~250 ms) precedes SourceBusy.
   */
  async function readLocalDatabase(
    dbPath: string,
    signal: AbortSignal,
  ): Promise<LocalDbCredentials> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal.aborted) break;
      if (attempt === 1) {
        const retryDelay = Promise.withResolvers<void>();
        setTimeout(retryDelay.resolve, SQLITE_BUSY_RETRY_MS);
        await retryDelay.promise;
      }
      let database: DatabaseSync | undefined;
      try {
        database = new DatabaseSync(dbPath, { readOnly: true });
        const statement = database.prepare(
          "SELECT key, value FROM ItemTable WHERE key LIKE 'cursorAuth/%'",
        );
        const rows = statement.all() as Array<{ key: unknown; value: unknown }>;
        database.close();
        database = undefined;
        return credentialsFromRows(rows, dbPath);
      } catch (error) {
        if (database != null) {
          try {
            database.close();
          } catch {
            // Best-effort close; the typed error below is what matters.
          }
        }
        if (error instanceof DiscoveryError) throw error;
        if (isSqliteBusy(error) && attempt === 0) continue;
        throw databaseError(dbPath, error);
      }
    }
    throw new DiscoveryError(
      "SourceBusy",
      `Cursor database is busy: ${dbPath}`,
      [dbPath],
    );
  }

  function credentialsFromRows(
    rows: Array<{ key: unknown; value: unknown }>,
    dbPath: string,
  ): LocalDbCredentials {
    let accessToken = "";
    let refreshToken: string | null = null;
    let email: string | null = null;
    let authId: string | null = null;
    let membershipType: string | null = null;
    for (const row of rows) {
      const key = typeof row.key === "string" ? row.key : "";
      const value = typeof row.value === "string" ? row.value.trim() : "";
      if (key === "cursorAuth/accessToken") accessToken = value;
      else if (key === "cursorAuth/refreshToken")
        refreshToken = value === "" ? null : value;
      else if (key === "cursorAuth/cachedEmail")
        email = normalizeEmail(value) || null;
      else if (key === "cursorAuth/authId")
        authId = value === "" ? null : value;
      else if (key === "cursorAuth/stripeMembershipType") {
        membershipType = value === "" ? null : value;
      }
    }
    if (accessToken === "") {
      throw new DiscoveryError(
        "EmptyCredential",
        "No Cursor access token found in local database. Sign in to Cursor first.",
        [dbPath],
      );
    }
    return { accessToken, refreshToken, email, authId, membershipType };
  }

  function databaseError(dbPath: string, error: unknown): DiscoveryError {
    if (isSqliteBusy(error)) {
      return new DiscoveryError(
        "SourceBusy",
        `Cursor database is busy: ${dbPath}`,
        [dbPath],
      );
    }
    return new DiscoveryError(
      "SourceProtected",
      `Could not read Cursor database: ${errorText(error)}`,
      [dbPath],
    );
  }

  // -------------------------------------------------------------------------
  // DeepControl remote-poll login
  // -------------------------------------------------------------------------

  async function beginAuth(signal: AbortSignal): Promise<AuthFlow> {
    const { codeVerifier, codeChallenge } = newPkcePair(32);
    const uuid = randomUUID();
    const verificationUri = [
      `${LOGIN_URL}?challenge=${encodeQueryComponent(codeChallenge)}`,
      `uuid=${encodeQueryComponent(uuid)}`,
      "mode=login",
    ].join("&");
    const expiresAt = clock.now() + OAUTH_TIMEOUT_MS;
    const state = { cancelled: false };

    const result = (async () => {
      try {
        const tokens = await pollForTokens(
          uuid,
          codeVerifier,
          expiresAt,
          state,
          signal,
        );
        const now = clock.now();
        const account: StoredCursorAccount = {
          provider: "cursor",
          id: "",
          email:
            tokens.authId?.includes("@") === true
              ? normalizeEmail(tokens.authId) || null
              : null,
          authId: tokens.authId,
          signUpType: null,
          membershipType: null,
          subscriptionStatus: null,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          source: "oauth",
          totalPercent: null,
          autoPercent: null,
          apiPercent: null,
          billingCycleEnd: null,
          planUsed: null,
          planLimit: null,
          onDemandEnabled: null,
          onDemandUsed: null,
          onDemandLimit: null,
          status: "active",
          statusReason: null,
          quotaQueryLastError: null,
          quotaQueryLastErrorAt: null,
          usageUpdatedAt: null,
          createdAt: now,
          lastUsed: now,
        };
        const refreshed = await doRefreshAccount(account, signal);
        const stored = await upsertAccount(refreshed);
        return [await summaryOf(stored.id)];
      } catch (error) {
        if (state.cancelled) {
          throw new Error("Login was cancelled");
        }
        throw error;
      }
    })();

    const flow: RemotePollAuthFlow = {
      mode: "remotePoll",
      provider: "cursor",
      verificationUri,
      expiresAt,
      intervalSeconds: POLL_INTERVAL_MS / 1000,
      result,
      cancel: async () => {
        state.cancelled = true;
      },
    };
    return flow;
  }

  async function pollForTokens(
    uuid: string,
    codeVerifier: string,
    expiresAt: number,
    state: { cancelled: boolean },
    signal: AbortSignal,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    authId: string | null;
  }> {
    const pollUrl = [
      `${POLL_URL}?uuid=${encodeQueryComponent(uuid)}`,
      `verifier=${encodeQueryComponent(codeVerifier)}`,
    ].join("&");
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
      if (state.cancelled) throw new Error("Login was cancelled");
      if (clock.now() > expiresAt) throw new Error("Login session expired");
      if (signal.aborted) throw new Error("Login was cancelled");
      try {
        const response = await fetchWithTimeout(
          pollUrl,
          {
            headers: { Accept: "application/json" },
            signal,
            timeoutMs: HTTP_TIMEOUT_MS,
          },
          fetch,
        );
        if (response.status !== 200) {
          // 404 means the login has not completed yet; keep polling.
          await clock.sleep(POLL_INTERVAL_MS, signal);
          continue;
        }
        const body = await response.text();
        const root = asRecord(JSON.parse(body));
        const accessToken =
          root != null ? recordString(root, "accessToken") : undefined;
        const refreshToken =
          root != null ? recordString(root, "refreshToken") : undefined;
        if (accessToken != null && refreshToken != null) {
          return {
            accessToken,
            refreshToken,
            authId:
              root != null ? (recordString(root, "authId") ?? null) : null,
          };
        }
        await clock.sleep(POLL_INTERVAL_MS, signal);
      } catch (error) {
        if (state.cancelled || signal.aborted) throw error;
        await clock.sleep(POLL_INTERVAL_MS * 2, signal);
      }
    }
    throw new Error("Cursor login timed out. Please try again.");
  }

  // -------------------------------------------------------------------------
  // Refresh chain: user meta, stripe profile, usage (+ one token refresh)
  // -------------------------------------------------------------------------

  async function doRefreshAccount(
    account: StoredCursorAccount,
    signal: AbortSignal,
  ): Promise<StoredCursorAccount> {
    let current = account;

    const meta = await fetchUserMeta(current.accessToken, signal);
    if (meta != null) {
      const email = meta.email?.includes("@") === true ? meta.email : null;
      current = {
        ...current,
        email: email ?? current.email,
        authId: meta.workosId ?? current.authId,
        signUpType: meta.signUpType ?? current.signUpType,
      };
    }

    const stripe = await fetchStripeProfile(current.accessToken, signal);
    if (stripe != null) {
      const membership = resolveMembership(stripe);
      current = {
        ...current,
        membershipType: membership ?? current.membershipType,
        subscriptionStatus:
          stripe.subscriptionStatus ?? current.subscriptionStatus,
      };
    }

    const usage = await fetchUsageRaw(current.accessToken, signal);
    if (usage.ok) {
      const nowMs = clock.now();
      return {
        ...applyUsage(current, usage.value),
        quotaQueryLastError: null,
        quotaQueryLastErrorAt: null,
        usageUpdatedAt: nowMs,
      };
    }
    if (usage.error !== AUTH_EXPIRED) {
      return { ...current, quotaQueryLastError: usage.error };
    }

    const refreshed = await maybeRefreshTokens(current, signal);
    if (refreshed == null) {
      return {
        ...current,
        quotaQueryLastError: SESSION_EXPIRED_MESSAGE,
        status: "requiresReauthentication",
        statusReason: SESSION_EXPIRED_MESSAGE,
      };
    }
    const retry = await fetchUsageRaw(refreshed.accessToken, signal);
    if (retry.ok) {
      const nowMs = clock.now();
      return {
        ...applyUsage(refreshed, retry.value),
        quotaQueryLastError: null,
        quotaQueryLastErrorAt: null,
        usageUpdatedAt: nowMs,
      };
    }
    return { ...refreshed, quotaQueryLastError: retry.error };
  }

  async function fetchUserMeta(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<{
    email: string | null;
    signUpType: string | null;
    workosId: string | null;
  } | null> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        USER_META_URL,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: "{}",
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
        },
        fetch,
      );
    } catch {
      return null;
    }
    if (response.status === 401 || response.status === 403) return null;
    if (response.status !== 200) return null;
    try {
      const root = asRecord(JSON.parse(await response.text()));
      if (root == null) return null;
      return {
        email: recordString(root, "email") ?? null,
        signUpType: recordString(root, "signUpType") ?? null,
        workosId: recordString(root, "workosId") ?? null,
      };
    } catch {
      return null;
    }
  }

  async function fetchStripeProfile(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<StripeProfile | null> {
    for (const url of [FULL_STRIPE_URL, STRIPE_URL]) {
      try {
        const response = await fetchWithTimeout(
          url,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
            },
            signal,
            timeoutMs: HTTP_TIMEOUT_MS,
          },
          fetch,
        );
        if (response.status !== 200) continue;
        const body = await response.text();
        const root = asRecord(JSON.parse(body));
        if (root != null) {
          return {
            membershipType: recordString(root, "membershipType") ?? null,
            individualMembershipType:
              recordString(root, "individualMembershipType") ?? null,
            subscriptionStatus:
              recordString(root, "subscriptionStatus") ?? null,
          };
        }
        // The basic profile returns a plain string for pro subscribers.
        const plain = JSON.parse(body);
        if (typeof plain === "string" && plain.trim() !== "") {
          return {
            membershipType: "pro",
            individualMembershipType: null,
            subscriptionStatus: null,
          };
        }
      } catch {}
    }
    return null;
  }

  async function fetchUsageRaw(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<
    { ok: true; value: Record<string, unknown> } | { ok: false; error: string }
  > {
    const cookie = buildSessionCookie(accessToken);
    if (cookie == null) {
      return { ok: false, error: AUTH_EXPIRED };
    }
    let response: Response;
    try {
      response = await fetchWithTimeout(
        USAGE_URL,
        {
          headers: {
            Accept: "application/json",
            Cookie: cookie,
            "User-Agent": SESSION_COOKIE_UA,
          },
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
        },
        fetch,
      );
    } catch (error) {
      return {
        ok: false,
        error: `Cursor usage request failed: ${errorText(error)}`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: AUTH_EXPIRED };
    }
    if (response.status !== 200) {
      return {
        ok: false,
        error: `Cursor usage API returned status ${response.status}`,
      };
    }
    try {
      const root = asRecord(JSON.parse(await response.text()));
      if (root == null) {
        return { ok: false, error: "Cursor usage response is not an object" };
      }
      return { ok: true, value: root };
    } catch (error) {
      return {
        ok: false,
        error: `Failed to parse usage JSON: ${errorText(error)}`,
      };
    }
  }

  /** One refresh attempt; `null` when re-import/reconnect is required. */
  async function maybeRefreshTokens(
    account: StoredCursorAccount,
    signal: AbortSignal,
  ): Promise<StoredCursorAccount | null> {
    if (account.refreshToken == null) return null;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        OAUTH_TOKEN_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            client_id: AUTH_CLIENT_ID,
            refresh_token: account.refreshToken,
          }),
          signal,
          timeoutMs: HTTP_TIMEOUT_MS,
        },
        fetch,
      );
    } catch {
      return null;
    }
    if (response.status === 401 || response.status === 403) return null;
    if (response.status !== 200) return null;
    try {
      const root = asRecord(JSON.parse(await response.text()));
      if (root == null) return null;
      if (root.shouldLogout === true || root.should_logout === true)
        return null;
      const accessToken = recordString(root, "accessToken");
      const refreshToken = recordString(root, "refreshToken");
      if (accessToken == null || refreshToken == null) return null;
      return { ...account, accessToken, refreshToken };
    } catch {
      return null;
    }
  }

  function applyUsage(
    account: StoredCursorAccount,
    raw: Record<string, unknown>,
  ): StoredCursorAccount {
    const individual =
      asRecord(raw.individualUsage) ?? asRecord(raw.individual_usage);
    const plan =
      (individual != null ? asRecord(individual.plan) : undefined) ??
      asRecord(raw.planUsage) ??
      asRecord(raw.plan_usage);
    const onDemandRecord =
      (individual != null ? asRecord(individual.onDemand) : undefined) ??
      asRecord(raw.spendLimitUsage) ??
      asRecord(raw.spend_limit_usage);
    const billingCycleEnd = (() => {
      const rawEnd =
        textOrNull(raw.billingCycleEnd) ?? textOrNull(raw.billing_cycle_end);
      if (rawEnd == null) return account.billingCycleEnd;
      const parsed = Date.parse(rawEnd);
      return Number.isNaN(parsed) ? account.billingCycleEnd : parsed;
    })();
    return {
      ...account,
      totalPercent: pickPercent(plan, [
        "totalPercentUsed",
        "total_percent_used",
      ]),
      autoPercent: pickPercent(plan, ["autoPercentUsed", "auto_percent_used"]),
      apiPercent: pickPercent(plan, ["apiPercentUsed", "api_percent_used"]),
      planUsed: pickNumber(plan, ["used", "totalSpend", "total_spend"]),
      planLimit: pickNumber(plan, ["limit"]),
      onDemandUsed: pickNumber(onDemandRecord, [
        "used",
        "totalSpend",
        "total_spend",
        "individualUsed",
        "individual_used",
      ]),
      onDemandLimit: pickNumber(onDemandRecord, [
        "limit",
        "individualLimit",
        "individual_limit",
        "pooledLimit",
        "pooled_limit",
      ]),
      onDemandEnabled:
        onDemandRecord != null && "enabled" in onDemandRecord
          ? onDemandRecord.enabled === true
          : account.onDemandEnabled,
      billingCycleEnd,
    };
  }

  function pickPercent(
    record: Record<string, unknown> | undefined,
    keys: readonly string[],
  ): number | null {
    const value = pickNumber(record, keys);
    if (value == null) return null;
    return Math.min(100, Math.max(0, Math.round(value)));
  }

  function pickNumber(
    record: Record<string, unknown> | undefined,
    keys: readonly string[],
  ): number | null {
    if (record == null) return null;
    for (const key of keys) {
      const raw = record[key];
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      if (typeof raw === "string") {
        const parsed = Number(raw.trim());
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Adapter operations
  // -------------------------------------------------------------------------

  async function upsertAccount(
    account: StoredCursorAccount,
  ): Promise<StoredCursorAccount> {
    const idEmail =
      account.email?.includes("@") === true
        ? account.email
        : tokenSeed(account.accessToken);
    const withId: StoredCursorAccount = {
      ...account,
      id: cursorAccountId(idEmail, account.accessToken),
      lastUsed: clock.now(),
    };
    await store.upsert("cursor", withId);
    return withId;
  }

  async function refresh(
    accountId: string,
    signal: AbortSignal,
  ): Promise<AccountSummary> {
    const accounts = await store.listStored("cursor");
    const account = accounts.find(
      (entry): entry is StoredCursorAccount =>
        entry.provider === "cursor" && entry.id === accountId,
    );
    if (account == null) {
      throw new Error(`Could not read Cursor account: ${accountId}`);
    }
    const refreshed = await doRefreshAccount(account, signal);
    await store.upsert("cursor", refreshed);
    return summaryOf(refreshed.id);
  }

  async function refreshAll(signal: AbortSignal): Promise<AccountSummary[]> {
    const accounts = await store.listStored("cursor");
    for (const account of accounts) {
      if (signal.aborted) break;
      try {
        await refresh(account.id, signal);
      } catch {
        // Per-account failures keep their prior safe quota (store merge).
      }
    }
    return store.list("cursor");
  }

  async function summaryOf(accountId: string): Promise<AccountSummary> {
    const summaries = await store.list("cursor");
    const match = summaries.find((summary) => summary.id === accountId);
    if (match == null) {
      throw new Error("Cursor account is missing from the private store");
    }
    return match;
  }

  return {
    list: () => store.list("cursor"),
    discoverImports,
    import: importCandidate,
    beginAuth,
    refresh,
    refreshAll,
    remove: (accountId: string) => store.remove("cursor", accountId),
  };
}
