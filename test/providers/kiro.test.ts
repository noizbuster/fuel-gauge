import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AccountSummary,
  KiroAccountSummary,
} from "../../src/core/types.js";
import {
  createKiroProvider,
  parseKiroCallbackUrl,
  parseProfileArnRegion,
} from "../../src/providers/kiro.js";
import {
  headerOf,
  jsonResponse,
  makeTestRuntime,
  noNetwork,
  signal,
} from "./runtime.js";

const USAGE_URL_PREFIX = "https://q.us-east-1.amazonaws.com/getUsageLimits";
const REFRESH_ENDPOINT =
  "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
const ARN = "arn:aws:q:us-east-1:123:profile/p";

test("parseKiroCallbackUrl accepts URLs, bare queries, and rejects missing codes", () => {
  assert.deepEqual(
    parseKiroCallbackUrl(
      "http://localhost:3128/cb?code=a&state=s&login_option=Github",
    ),
    {
      code: "a",
      loginOption: "Github",
      state: "s",
    },
  );
  assert.deepEqual(parseKiroCallbackUrl("code=a&login_option=google"), {
    code: "a",
    loginOption: "google",
    state: null,
  });
  assert.deepEqual(parseKiroCallbackUrl("?code=a"), {
    code: "a",
    loginOption: null,
    state: null,
  });
  assert.throws(() => parseKiroCallbackUrl("  "), /Callback URL is empty/);
  assert.throws(
    () => parseKiroCallbackUrl("http://x/cb"),
    /no query parameters/,
  );
  assert.throws(() => parseKiroCallbackUrl("?state=s"), /No code parameter/);
});

test("parseProfileArnRegion extracts the region segment", () => {
  assert.equal(
    parseProfileArnRegion("arn:aws:q:eu-central-1:123:profile/x"),
    "eu-central-1",
  );
  assert.equal(parseProfileArnRegion("arn:aws:q::123:profile/x"), null);
  assert.equal(parseProfileArnRegion("not-an-arn"), null);
});

test("kiro local import reads the token file and applies live usage", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-kiro-home-"));
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-kiro-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(home, ".aws", "sso", "cache"), { recursive: true });
  await writeFile(
    path.join(home, ".aws", "sso", "cache", "kiro-auth-token.json"),
    JSON.stringify({
      accessToken: "kiro-access",
      refreshToken: "kiro-refresh",
      expiresAt: 1_800_000_000_000,
      profileArn: "arn:aws:q:us-east-1:123:profile/p",
      login_option: "google",
    }),
    "utf8",
  );

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith(USAGE_URL_PREFIX)) {
      assert.ok(
        url.includes(
          "profileArn=arn%3Aaws%3Aq%3Aus-east-1%3A123%3Aprofile%2Fp",
        ),
      );
      assert.ok(url.includes("origin=AI_EDITOR"));
      assert.ok(url.includes("resourceType=AGENTIC_REQUEST"));
      return jsonResponse({
        userInfo: { email: "kiro@example.com" },
        usageState: {
          planName: "Kiro Pro Tier",
          usageBreakdownList: [
            {
              type: "credit",
              usageLimitWithPrecision: "100",
              currentUsageWithPrecision: "25.5",
              resetDate: 1_800_000_000,
              freeTrialUsage: {
                usageLimit: 20,
                currentUsage: 5,
                daysRemaining: 3,
              },
            },
          ],
        },
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const env = process.env;
  const previousHome = env.HOME;
  env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete env.HOME;
    else env.HOME = previousHome;
  });

  const deps = makeTestRuntime(fetchImpl, { root });
  const provider = createKiroProvider(deps);
  const candidates = await provider.discoverImports(signal());
  const first = candidates.at(-1);
  if (first == null) assert.fail("no candidate discovered");
  const summaries = await provider.import(first, signal());
  const summary = asKiroSummary(summaries[0]);
  assert.equal(summary.email, "kiro@example.com");
  assert.equal(summary.loginProvider, "Google");
  assert.equal(summary.planName, "PRO");
  assert.equal(summary.creditsTotal, 100);
  assert.equal(summary.creditsUsed, 25.5);
  assert.equal(summary.bonusTotal, 20);
  assert.equal(summary.bonusUsed, 5);
  assert.equal(summary.bonusExpireDays, 3);
  assert.equal(summary.usageResetAt, 1_800_000_000_000);
  assert.match(summary.id, /^kiro_[0-9a-f]{32}$/);
});

test("kiro refresh maps 403 usage responses to the banned status", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-kiro-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).startsWith(USAGE_URL_PREFIX)) {
      return jsonResponse(
        { reason: "account suspended for policy violations" },
        403,
      );
    }
    throw new Error(`unexpected url ${String(input)}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.upsert("kiro", {
    provider: "kiro",
    id: "kiro_banned",
    email: "b@example.com",
    loginProvider: null,
    accessToken: "a",
    refreshToken: null,
    expiresAt: null,
    idcRegion: null,
    clientId: null,
    planName: null,
    planTier: null,
    creditsTotal: null,
    creditsUsed: null,
    bonusTotal: null,
    bonusUsed: null,
    usageResetAt: null,
    bonusExpireDays: null,
    kiroAuthTokenRaw: {
      accessToken: "a",
      profileArn: "arn:aws:q:us-east-1:1:p",
    },
    kiroProfileRaw: null,
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: null,
    createdAt: 1,
    lastUsed: 1,
  });
  const provider = createKiroProvider(deps);
  const summary = asKiroSummary(
    await provider.refresh("kiro_banned", signal()),
  );
  assert.equal(summary.status, "banned");
  assert.equal(summary.statusReason, "account suspended for policy violations");
});

test("kiro import rejects a token file without an access token", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-kiro-home-"));
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-kiro-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(home, ".aws", "sso", "cache"), { recursive: true });
  const tokenPath = path.join(
    home,
    ".aws",
    "sso",
    "cache",
    "kiro-auth-token.json",
  );
  await writeFile(tokenPath, JSON.stringify({ refreshToken: "only" }), "utf8");

  const deps = makeTestRuntime(noNetwork, { root });
  const provider = createKiroProvider(deps);
  await assert.rejects(
    provider.import(
      { provider: "kiro", source: "file", label: "t", path: tokenPath },
      signal(),
    ),
    /missing access token/,
  );
});

function asKiroSummary(value: AccountSummary | undefined): KiroAccountSummary {
  if (value == null || value.provider !== "kiro") {
    throw new Error("expected kiro summary");
  }
  return value;
}

test("kiro usage failure unwraps the {data} refresh envelope and rotates tokens", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-kiro-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bodies: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(USAGE_URL_PREFIX)) {
      const usageAttempt = bodies.filter((entry) =>
        entry.startsWith("usage"),
      ).length;
      bodies.push(`usage:${usageAttempt + 1}`);
      return usageAttempt === 0
        ? jsonResponse({ message: "expired token" }, 400)
        : jsonResponse({ usageState: { planName: "pro" } });
    }
    if (url === REFRESH_ENDPOINT) {
      bodies.push(`refresh:${String(init?.body)}`);
      return jsonResponse({
        data: {
          accessToken: "rotated-access",
          refreshToken: "rotated-refresh",
          expiresIn: 3600,
        },
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.upsert("kiro", {
    provider: "kiro",
    id: "kiro_data",
    email: "d@example.com",
    loginProvider: null,
    accessToken: "stale-access",
    refreshToken: "stale-refresh",
    expiresAt: null,
    idcRegion: null,
    clientId: null,
    planName: null,
    planTier: null,
    creditsTotal: null,
    creditsUsed: null,
    bonusTotal: null,
    bonusUsed: null,
    usageResetAt: null,
    bonusExpireDays: null,
    kiroAuthTokenRaw: { accessToken: "stale-access", profileArn: ARN },
    kiroProfileRaw: null,
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: null,
    createdAt: 1,
    lastUsed: 1,
  });
  const provider = createKiroProvider(deps);
  const summary = asKiroSummary(await provider.refresh("kiro_data", signal()));
  assert.equal(bodies[0], "usage:1");
  assert.equal(bodies[1], 'refresh:{"refreshToken":"stale-refresh"}');
  assert.equal(bodies[2], "usage:2");
  const stored = await deps.store.listStored("kiro");
  const account = stored[0];
  if (account == null || account.provider !== "kiro") assert.fail("missing");
  assert.equal(account.accessToken, "rotated-access");
  assert.equal(account.refreshToken, "rotated-refresh");
  assert.equal(summary.planName, "PRO");
});

test("kiro usage parsing covers usageBreakdowns and bonusCredit aliases", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-kiro-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).startsWith(USAGE_URL_PREFIX)) {
      return jsonResponse({
        usageState: {
          planName: "business tier",
          usageBreakdowns: [
            {
              totalCredits: 500,
              usedCredits: 100,
              resetAt: 1_800_000_000,
            },
          ],
          bonusCredits: { total: 40, used: 10 },
        },
      });
    }
    throw new Error(`unexpected url ${String(input)}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.upsert("kiro", {
    provider: "kiro",
    id: "kiro_alias",
    email: "a@example.com",
    loginProvider: null,
    accessToken: "alias-access",
    refreshToken: null,
    expiresAt: null,
    idcRegion: null,
    clientId: null,
    planName: null,
    planTier: null,
    creditsTotal: null,
    creditsUsed: null,
    bonusTotal: null,
    bonusUsed: null,
    usageResetAt: null,
    bonusExpireDays: null,
    kiroAuthTokenRaw: { accessToken: "alias-access", profileArn: ARN },
    kiroProfileRaw: null,
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: null,
    createdAt: 1,
    lastUsed: 1,
  });
  const provider = createKiroProvider(deps);
  const summary = asKiroSummary(await provider.refresh("kiro_alias", signal()));
  assert.equal(summary.planName, "BUSINESS");
  assert.equal(summary.creditsTotal, 500);
  assert.equal(summary.creditsUsed, 100);
  assert.equal(summary.bonusTotal, 40);
  assert.equal(summary.bonusUsed, 10);
  assert.equal(summary.usageResetAt, 1_800_000_000_000);
});

test("kiro refreshAll visits accounts in stored order", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-kiro-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(USAGE_URL_PREFIX)) {
      const authorization = headerOf(init, "Authorization");
      seen.push(authorization.replace("Bearer ", ""));
      return jsonResponse({ usageState: {} });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  for (const [id, token] of [
    ["kiro_first", "first-token"],
    ["kiro_second", "second-token"],
  ] as const) {
    await deps.store.upsert("kiro", {
      provider: "kiro",
      id,
      email: `${id}@example.com`,
      loginProvider: null,
      accessToken: token,
      refreshToken: null,
      expiresAt: null,
      idcRegion: null,
      clientId: null,
      planName: null,
      planTier: null,
      creditsTotal: null,
      creditsUsed: null,
      bonusTotal: null,
      bonusUsed: null,
      usageResetAt: null,
      bonusExpireDays: null,
      kiroAuthTokenRaw: { accessToken: token, profileArn: ARN },
      kiroProfileRaw: null,
      status: "active",
      statusReason: null,
      quotaQueryLastError: null,
      quotaQueryLastErrorAt: null,
      usageUpdatedAt: null,
      createdAt: 1,
      lastUsed: 1,
    });
  }
  const provider = createKiroProvider(deps);
  await provider.refreshAll(signal());
  // New accounts are prepended (reference ordering), so stored order is
  // [second, first]; refreshAll must preserve exactly that order.
  assert.deepEqual(seen, ["second-token", "first-token"]);
});

test("kiro import skips a token-less confirmed source and falls through to the override", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-kiro-home-"));
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-kiro-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const ssoDir = path.join(home, ".aws", "sso", "cache");
  await mkdir(ssoDir, { recursive: true });
  await writeFile(
    path.join(ssoDir, "kiro-auth-token.json"),
    JSON.stringify({ refreshToken: "but-no-access" }),
    "utf8",
  );
  const overridePath = path.join(root, "kiro-auth-token.json");
  await writeFile(
    overridePath,
    JSON.stringify({
      accessToken: "kiro-fallback-access",
      refreshToken: "kiro-fallback-refresh",
      email: "fallback@kiro.example",
    }),
    "utf8",
  );
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const deps = makeTestRuntime(noNetwork, { root });
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
    importPathOverrides: { kiro: overridePath },
    claudePolicyAccepted: false,
  });
  const provider = createKiroProvider(deps);
  const candidates = await provider.discoverImports(signal());
  assert.equal(
    candidates[0]?.path,
    path.join(ssoDir, "kiro-auth-token.json"),
    "SSO cache leads",
  );
  assert.equal(candidates[candidates.length - 1]?.path, overridePath);

  const summaries = await provider.import(candidates[0] as never, signal());
  const summary = asKiroSummary(summaries[0]);
  assert.equal(summary.email, "fallback@kiro.example");
  const stored = await deps.store.listStored("kiro");
  assert.equal(stored.length, 1, "exactly one account persisted");
  assert.equal(
    (stored[0] as { accessToken?: string }).accessToken,
    "kiro-fallback-access",
    "the fallback source won",
  );
  assert.ok(!JSON.stringify(summary).includes("kiro-fallback-access"));
});
