import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  AccountSummary,
  CursorAccountSummary,
} from "../../src/core/types.js";
import { createCursorProvider } from "../../src/providers/cursor.js";
import { jsonResponse, makeTestRuntime, noNetwork, signal } from "./runtime.js";

const USAGE_URL = "https://cursor.com/api/usage-summary";
const USER_META_URL =
  "https://api2.cursor.sh/aiserver.v1.AuthService/GetUserMeta";
const FULL_STRIPE_URL = "https://api2.cursor.sh/auth/full_stripe_profile";
const STRIPE_URL = "https://api2.cursor.sh/auth/stripe_profile";
const REFRESH_URL = "https://api2.cursor.sh/oauth/token";

function headerOf(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers;
  if (headers == null) assert.fail("request had no headers");
  return (headers as Record<string, string>)[name] ?? "";
}

/** The reference uses a JWT whose `sub` tail is a `user_…` WorkOS id. */
function accessTokenWithSub(sub: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub })}.${encode({})}`;
}

async function makeCursorDb(rows: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "fuel-gauge-cursor-db-"));
  const dbPath = path.join(dir, "state.vscdb");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  db.close();
  return dbPath;
}

test("cursor import reads cursorAuth rows read-only and applies usage aliases", async (t) => {
  const accessToken = accessTokenWithSub("workos|user_abc123");
  const dbPath = await makeCursorDb({
    "cursorAuth/accessToken": accessToken,
    "cursorAuth/refreshToken": "cur-refresh",
    "cursorAuth/cachedEmail": "Cursor@Example.com",
    "cursorAuth/authId": "auth-1",
    "cursorAuth/stripeMembershipType": "pro",
    "memento/other": "ignored",
  });
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-cursor-"));
  t.after(async () => {
    await rm(path.dirname(dbPath), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === USER_META_URL) {
      return jsonResponse({
        email: "cursor@example.com",
        signUpType: "github",
        workosId: "user_abc123",
      });
    }
    if (url === FULL_STRIPE_URL) return jsonResponse({}, 404);
    if (url === STRIPE_URL) return jsonResponse("pro-subscriber-string");
    if (url === USAGE_URL) {
      return jsonResponse({
        individualUsage: {
          plan: {
            totalPercentUsed: 30,
            autoPercentUsed: 10,
            used: 15,
            limit: 100,
          },
          onDemand: { enabled: true, individualUsed: 3, pooledLimit: 25 },
        },
        billingCycleEnd: "2026-09-01T00:00:00Z",
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.saveSettings({
    schemaVersion: 1,
    autoRefresh: { enabled: false, intervalSeconds: 120 },
    alerts: { enabled: false, thresholdPercent: 20 },
    providerOrder: [
      "githubCopilot",
      "codex",
      "antigravity",
      "claude",
      "kiro",
      "cursor",
    ],
    hiddenAccountIds: [],
    pinnedAccountIds: [],
    importPathOverrides: { cursor: dbPath },
    claudePolicyAccepted: false,
  });
  const provider = createCursorProvider(deps);
  const candidates = await provider.discoverImports(signal());
  const match = candidates.find((entry) => entry.path === dbPath);
  if (match == null) assert.fail(`discovery missed ${dbPath}`);
  const summaries = await provider.import(match, signal());
  const summary = asCursorSummary(summaries[0]);
  assert.equal(summary.email, "cursor@example.com");
  assert.equal(summary.source, "local");
  assert.equal(summary.membershipType, "pro");
  assert.equal(summary.totalPercent, 30);
  assert.equal(summary.autoPercent, 10);
  assert.equal(summary.planUsed, 15);
  assert.equal(summary.planLimit, 100);
  assert.equal(summary.onDemandEnabled, true);
  assert.equal(summary.onDemandUsed, 3);
  assert.equal(summary.onDemandLimit, 25);
  assert.equal(summary.billingCycleEnd, Date.parse("2026-09-01T00:00:00Z"));
  assert.match(summary.id, /^cursor_[0-9a-f]{32}$/);
});

test("cursor import without an access token row is EmptyCredential", async (t) => {
  const dbPath = await makeCursorDb({
    "cursorAuth/cachedEmail": "x@example.com",
  });
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-cursor-"));
  t.after(async () => {
    await rm(path.dirname(dbPath), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const deps = makeTestRuntime(noNetwork, { root });
  const provider = createCursorProvider(deps);
  await assert.rejects(
    provider.import(
      { provider: "cursor", source: "sqlite", label: "db", path: dbPath },
      signal(),
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "EmptyCredential");
      assert.match((error as Error).message, /No Cursor access token/);
      return true;
    },
  );
});

test("cursor refresh retries usage once after a token refresh", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstToken = accessTokenWithSub("workos|user_first");
  const secondToken = accessTokenWithSub("workos|user_second");
  const usageCalls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === USAGE_URL) {
      usageCalls.push(String(headerOf(init, "Cookie")));
      const secondAttempt = usageCalls.length === 2;
      const cookie = usageCalls[usageCalls.length - 1] ?? "";
      if (cookie.includes(secondToken)) {
        return jsonResponse({
          individualUsage: { plan: { totalPercentUsed: 55 } },
        });
      }
      if (!secondAttempt) return jsonResponse({}, 401);
      return jsonResponse({}, 403);
    }
    if (url === USER_META_URL) return jsonResponse({}, 500);
    if (url === FULL_STRIPE_URL || url === STRIPE_URL)
      return jsonResponse({}, 404);
    if (url === REFRESH_URL) {
      return jsonResponse({
        accessToken: secondToken,
        refreshToken: "new-refresh",
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.upsert("cursor", {
    provider: "cursor",
    id: "cursor_seed",
    email: "cursor@example.com",
    authId: null,
    signUpType: null,
    membershipType: null,
    subscriptionStatus: null,
    accessToken: firstToken,
    refreshToken: "old-refresh",
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
    createdAt: 1,
    lastUsed: 1,
  });
  const provider = createCursorProvider(deps);
  const summary = asCursorSummary(
    await provider.refresh("cursor_seed", signal()),
  );
  assert.equal(summary.totalPercent, 55);
  assert.equal(usageCalls.length, 2);
});

test("cursor refresh marks reauthentication when no refresh token exists", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === USAGE_URL) return jsonResponse({}, 401);
    if (
      url === USER_META_URL ||
      url === FULL_STRIPE_URL ||
      url === STRIPE_URL
    ) {
      return jsonResponse({}, 404);
    }
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.upsert("cursor", {
    provider: "cursor",
    id: "cursor_dead",
    email: "dead@example.com",
    authId: null,
    signUpType: null,
    membershipType: null,
    subscriptionStatus: null,
    accessToken: accessTokenWithSub("workos|user_dead"),
    refreshToken: null,
    source: "local",
    totalPercent: 10,
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
    createdAt: 1,
    lastUsed: 1,
  });
  const provider = createCursorProvider(deps);
  const summary = asCursorSummary(
    await provider.refresh("cursor_dead", signal()),
  );
  assert.equal(summary.status, "requiresReauthentication");
  assert.equal(
    summary.quotaQueryLastError,
    "Cursor session expired. Re-import or reconnect your account.",
  );
  assert.equal(summary.totalPercent, 10);
});

function asCursorSummary(
  value: AccountSummary | undefined,
): CursorAccountSummary {
  if (value == null || value.provider !== "cursor") {
    throw new Error("expected cursor summary");
  }
  return value;
}

test("cursor sqlite busy retries once after ~250ms, then succeeds", async (t) => {
  // Genuine platform-timer behavior: the retry delay is a real 250 ms
  // sleep inside the provider, so this test needs real (short) waits.
  const accessToken = accessTokenWithSub("workos|user_busy");
  const dbPath = await makeCursorDb({
    "cursorAuth/accessToken": accessToken,
  });
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-cursor-"));
  t.after(async () => {
    await rm(path.dirname(dbPath), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const { DatabaseSync } = await import("node:sqlite");
  const writer = new DatabaseSync(dbPath);
  writer.exec("BEGIN EXCLUSIVE");
  const unlock = Promise.withResolvers<void>();
  const releaseTimer = setTimeout(() => {
    writer.exec("ROLLBACK");
    writer.close();
    unlock.resolve();
  }, 100);
  t.after(() => clearTimeout(releaseTimer));

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (
      url === USER_META_URL ||
      url === FULL_STRIPE_URL ||
      url === STRIPE_URL
    ) {
      return jsonResponse({}, 404);
    }
    if (url === USAGE_URL)
      return jsonResponse({
        individualUsage: { plan: { totalPercentUsed: 5 } },
      });
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  const provider = createCursorProvider(deps);
  const summaries = await provider.import(
    { provider: "cursor", source: "sqlite", label: "busy db", path: dbPath },
    signal(),
  );
  await unlock.promise;
  const summary = asCursorSummary(summaries[0]);
  assert.equal(summary.totalPercent, 5);
});

test("cursor remote poll: 404 keeps polling and exhausts at 150 attempts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let polls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://api2.cursor.sh/auth/poll")) {
      polls += 1;
      return jsonResponse({}, 404);
    }
    throw new Error(`unexpected url ${url}`);
  };
  const sleepLog: number[] = [];
  const deps = makeTestRuntime(fetchImpl, {
    root,
    clock: {
      now: () => 1_700_000_000_000,
      sleep: (ms) => {
        sleepLog.push(ms);
        return Promise.resolve();
      },
      setInterval: () => ({ clear() {} }),
      clearInterval() {},
    },
  });
  const provider = createCursorProvider(deps);
  const flow = await provider.beginAuth(signal());
  if (flow.mode !== "remotePoll") assert.fail("expected remotePoll flow");
  assert.equal(flow.intervalSeconds, 2);
  assert.match(
    flow.verificationUri,
    /loginDeepControl\?challenge=[^&]+&uuid=[0-9a-f-]{36}&mode=login$/,
  );
  await assert.rejects(flow.result, /Cursor login timed out/);
  assert.equal(polls, 150);
  assert.ok(sleepLog.every((ms) => ms === 2_000));
  assert.equal(sleepLog.length, 150);
});

test("cursor remote poll: 404 then success imports the polled tokens", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let polls = 0;
  const accessToken = accessTokenWithSub("workos|user_poll");
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://api2.cursor.sh/auth/poll")) {
      polls += 1;
      return polls < 3
        ? jsonResponse({}, 404)
        : jsonResponse({
            accessToken,
            refreshToken: "polled-refresh",
            authId: "wos_1",
          });
    }
    if (url === USER_META_URL)
      return jsonResponse({ email: "poll@example.com" });
    if (url === FULL_STRIPE_URL || url === STRIPE_URL)
      return jsonResponse({}, 404);
    if (url === USAGE_URL)
      return jsonResponse({
        individualUsage: { plan: { used: 1, limit: 10 } },
      });
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  const provider = createCursorProvider(deps);
  const flow = await provider.beginAuth(signal());
  const summaries = await flow.result;
  const summary = asCursorSummary(summaries[0]);
  assert.equal(polls, 3);
  assert.equal(summary.email, "poll@example.com");
  assert.equal(summary.source, "oauth");
  assert.equal(summary.planUsed, 1);
  assert.equal(summary.planLimit, 10);
});

test("cursor shouldLogout true refuses the refreshed session", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === USAGE_URL) return jsonResponse({}, 401);
    if (
      url === USER_META_URL ||
      url === FULL_STRIPE_URL ||
      url === STRIPE_URL
    ) {
      return jsonResponse({}, 404);
    }
    if (url === REFRESH_URL) {
      return jsonResponse({
        accessToken: "nope",
        refreshToken: "nope",
        shouldLogout: true,
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.upsert("cursor", {
    provider: "cursor",
    id: "cursor_logout",
    email: null,
    authId: null,
    signUpType: null,
    membershipType: null,
    subscriptionStatus: null,
    accessToken: accessTokenWithSub("workos|user_out"),
    refreshToken: "doomed-refresh",
    source: "oauth",
    totalPercent: 22,
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
    createdAt: 1,
    lastUsed: 1,
  });
  const provider = createCursorProvider(deps);
  const summary = asCursorSummary(
    await provider.refresh("cursor_logout", signal()),
  );
  assert.equal(summary.status, "requiresReauthentication");
  assert.equal(
    summary.quotaQueryLastError,
    "Cursor session expired. Re-import or reconnect your account.",
  );
  assert.equal(summary.totalPercent, 22);
});

test("cursor refreshAll visits accounts in stored order", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === USAGE_URL) {
      const cookie = headerOf(init, "Cookie");
      seen.push(decodeURIComponent(cookie.split("%3A%3A")[1] ?? ""));
      return jsonResponse({ individualUsage: { plan: {} } });
    }
    if (
      url === USER_META_URL ||
      url === FULL_STRIPE_URL ||
      url === STRIPE_URL
    ) {
      return jsonResponse({}, 404);
    }
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  const seedOrder = [
    ["cursor_a", "workos|user_a"],
    ["cursor_b", "workos|user_b"],
  ] as const;
  for (const [id, sub] of seedOrder) {
    await deps.store.upsert("cursor", {
      provider: "cursor",
      id,
      email: null,
      authId: null,
      signUpType: null,
      membershipType: null,
      subscriptionStatus: null,
      accessToken: accessTokenWithSub(sub),
      refreshToken: null,
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
      createdAt: 1,
      lastUsed: 1,
    });
  }
  const provider = createCursorProvider(deps);
  await provider.refreshAll(signal());
  // New accounts are prepended: stored order is [b, a].
  assert.deepEqual(seen, [
    accessTokenWithSub("workos|user_b"),
    accessTokenWithSub("workos|user_a"),
  ]);
});

test("cursor import skips an auth-less confirmed db and falls through to the lowercase variant", async (t) => {
  const xdg = await mkdtemp(path.join(tmpdir(), "fuel-gauge-cursor-xdg-"));
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-cursor-"));
  t.after(async () => {
    await rm(xdg, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const upperDir = path.join(xdg, "Cursor", "User", "globalStorage");
  await mkdir(upperDir, { recursive: true });
  const upperDb = new DatabaseSync(path.join(upperDir, "state.vscdb"));
  upperDb.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  upperDb.exec(
    "INSERT INTO ItemTable (key, value) VALUES ('memento/x', 'no-auth')",
  );
  upperDb.close();

  const validDbPath = await makeCursorDb({
    "cursorAuth/accessToken": accessTokenWithSub("workos|user_fb1"),
    "cursorAuth/refreshToken": "cur-fb-refresh",
    "cursorAuth/cachedEmail": "fb@cursor.example",
  });
  // makeCursorDb makes its own fuel-gauge-cursor-db-* temp dir; unlike the
  // other call sites, its cleanup is not bundled into the shared root.
  t.after(() =>
    rm(path.dirname(validDbPath), { recursive: true, force: true }),
  );
  const lowerDir = path.join(xdg, "cursor", "User", "globalStorage");
  await mkdir(lowerDir, { recursive: true });
  await (await import("node:fs/promises")).copyFile(
    validDbPath,
    path.join(lowerDir, "state.vscdb"),
  );

  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  });

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === USER_META_URL) {
      return jsonResponse({
        email: "fb@cursor.example",
        signUpType: "github",
        workosId: "user_fb1",
      });
    }
    if (url === FULL_STRIPE_URL) return jsonResponse({}, 404);
    if (url === STRIPE_URL) return jsonResponse("free");
    if (url === USAGE_URL) {
      return jsonResponse({
        individualUsage: { plan: { totalPercentUsed: 10 } },
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.saveSettings({
    schemaVersion: 1,
    autoRefresh: { enabled: false, intervalSeconds: 120 },
    alerts: { enabled: false, thresholdPercent: 20 },
    providerOrder: [
      "githubCopilot",
      "codex",
      "antigravity",
      "claude",
      "kiro",
      "cursor",
    ],
    hiddenAccountIds: [],
    pinnedAccountIds: [],
    importPathOverrides: {},
    claudePolicyAccepted: false,
  });
  const provider = createCursorProvider(deps);
  const candidates = await provider.discoverImports(signal());
  assert.equal(
    candidates[0]?.path,
    path.join(upperDir, "state.vscdb"),
    "Cursor (uppercase) leads",
  );
  assert.equal(candidates[1]?.path, path.join(lowerDir, "state.vscdb"));

  const summaries = await provider.import(candidates[0] as never, signal());
  const summary = asCursorSummary(summaries[0]);
  assert.equal(summary.email, "fb@cursor.example");
  assert.equal(summary.totalPercent, 10);
  const stored = await deps.store.listStored("cursor");
  assert.equal(stored.length, 1, "exactly one account persisted");
  assert.equal(
    (stored[0] as { refreshToken?: string | null }).refreshToken,
    "cur-fb-refresh",
    "the lowercase fallback db won",
  );
});
