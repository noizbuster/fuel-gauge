import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AccountSummary,
  ClaudeAccountSummary,
} from "../../src/core/types.js";
import {
  buildClaudeOAuthStart,
  classifyClaudeRefreshFailure,
  createClaudeProvider,
  parseClaudeCallbackInput,
  parseClaudeQuota,
} from "../../src/providers/claude.js";
import {
  headerOf,
  jsonResponse,
  makeTestRuntime,
  noNetwork,
  signal,
} from "./runtime.js";

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

test("parseClaudeCallbackInput accepts URL query, bare code, and code#state", () => {
  // The reference ignores `state` in pasted URLs; it only trusts `code#state`.
  assert.deepEqual(parseClaudeCallbackInput("https://x/cb?code=abc&state=st"), {
    code: "abc",
    state: null,
  });
  assert.deepEqual(parseClaudeCallbackInput("?code=abc"), {
    code: "abc",
    state: null,
  });
  assert.deepEqual(parseClaudeCallbackInput("abc"), {
    code: "abc",
    state: null,
  });
  assert.deepEqual(parseClaudeCallbackInput("code=abc"), {
    code: "abc",
    state: null,
  });
  assert.deepEqual(parseClaudeCallbackInput("abc#st&junk"), {
    code: "abc",
    state: "st&junk",
  });
  assert.deepEqual(parseClaudeCallbackInput("abc&other=1"), {
    code: "abc",
    state: null,
  });
});

test("parseClaudeQuota maps windows, sonnet aliases, and the extra-usage gate", () => {
  const quota = parseClaudeQuota({
    five_hour: { utilization: 25.4, resets_at: 1_800_000_000 },
    seven_day: { utilization: "60", resets_at: "2026-01-01T00:00:00Z" },
    seven_day_sonnet_4: { utilization: 10, resets_at: 1_800_000_000_000 },
    extra_usage: { is_enabled: false, utilization: 90, resets_at: 5 },
  });
  assert.equal(quota.fiveHourRemainingPercent, 75);
  assert.equal(quota.fiveHourResetAt, 1_800_000_000_000);
  assert.equal(quota.weeklyRemainingPercent, 40);
  assert.equal(quota.weeklyResetAt, Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(quota.weeklySonnetRemainingPercent, 90);
  assert.equal(quota.weeklySonnetResetAt, 1_800_000_000_000);
  assert.equal(quota.extraUsageRemainingPercent, null);
  // The reference gates only the percentage on is_enabled; the reset still parses.
  assert.equal(quota.extraUsageResetAt, 5_000);

  const enabled = parseClaudeQuota({
    extra_usage: {
      is_enabled: true,
      utilization: 90,
      resets_at: 5,
      used_credits: "120",
      monthly_limit: 2000,
    },
  });
  assert.equal(enabled.extraUsageRemainingPercent, 10);
  assert.equal(enabled.extraUsageResetAt, 5_000);
  assert.equal(enabled.extraUsageUsedCents, 120);
  assert.equal(enabled.extraUsageLimitCents, 2000);
});

test("claude discovery is empty until the policy is acknowledged", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = makeTestRuntime(noNetwork, { root });
  const provider = createClaudeProvider(deps);

  assert.deepEqual(await provider.discoverImports(signal()), []);

  await deps.store.saveSettings(acceptedSettings());
  const env = process.env;
  const previous = env.CLAUDE_CODE_OAUTH_TOKEN;
  env.CLAUDE_CODE_OAUTH_TOKEN = "env-oauth-token";
  t.after(() => {
    if (previous === undefined) delete env.CLAUDE_CODE_OAUTH_TOKEN;
    else env.CLAUDE_CODE_OAUTH_TOKEN = previous;
  });
  const candidates = await provider.discoverImports(signal());
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.source, "env");
  assert.equal(candidates[0]?.path, null);
});

test("claude env-token import requires profile and usage success and never refreshes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requested.push(url);
    if (url === PROFILE_URL) {
      assert.equal(headerOf(init, "User-Agent"), "claude-code/2.1.233");
      return jsonResponse({
        account: {
          uuid: "acct-1",
          email: "dev@example.com",
          display_name: "Dev",
        },
        organization: {
          uuid: "org-1",
          name: "Acme",
          organization_type: "claude_max",
        },
      });
    }
    if (url === USAGE_URL) {
      return jsonResponse({ five_hour: { utilization: 40, resets_at: 100 } });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.saveSettings(acceptedSettings());
  const provider = createClaudeProvider(deps);
  const env = process.env;
  const previous = env.CLAUDE_CODE_OAUTH_TOKEN;
  env.CLAUDE_CODE_OAUTH_TOKEN = "env-oauth-token";
  t.after(() => {
    if (previous === undefined) delete env.CLAUDE_CODE_OAUTH_TOKEN;
    else env.CLAUDE_CODE_OAUTH_TOKEN = previous;
  });

  const summaries = await provider.import(
    {
      provider: "claude",
      source: "env",
      label: "CLAUDE_CODE_OAUTH_TOKEN environment variable",
      path: null,
    },
    signal(),
  );
  const summary = asClaudeSummary(summaries[0]);
  assert.equal(summary.authMode, "environmentToken");
  assert.equal(summary.email, "dev@example.com");
  assert.equal(summary.planType, "Max");
  assert.equal(summary.quota.fiveHourRemainingPercent, 60);
  assert.ok(
    !requested.includes(TOKEN_URL),
    "refresh endpoint must never be called",
  );

  const stored = await deps.store.listStored("claude");
  const account = stored[0];
  if (account == null || account.provider !== "claude")
    assert.fail("account not stored");
  assert.equal(account.refreshToken, null);
});

test("claude env-token import persists nothing when the usage probe fails", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === PROFILE_URL) {
      return jsonResponse({
        account: { uuid: "acct-1", email: "dev@example.com" },
      });
    }
    if (url === USAGE_URL) return jsonResponse({}, 403);
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.saveSettings(acceptedSettings());
  const provider = createClaudeProvider(deps);
  await assert.rejects(
    provider.import(
      {
        provider: "claude",
        source: "env",
        label: "CLAUDE_CODE_OAUTH_TOKEN environment variable",
        path: null,
      },
      signal(),
    ),
  );
  assert.deepEqual(await deps.store.listStored("claude"), []);
});

test("claude file import requires the profile probe and stores scopes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-claude-"));
  const credsDir = path.join(root, "home", ".claude");
  await mkdir(credsDir, { recursive: true });
  const credsPath = path.join(credsDir, ".credentials.json");
  await writeFile(
    credsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "file-access",
        refreshToken: "file-refresh",
        expiresAt: 1_700_000_300_000,
        scopes: ["user:profile", "user:inference"],
      },
    }),
    "utf8",
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === PROFILE_URL) {
      return jsonResponse({
        account: { uuid: "acct-2", email: "file@example.com" },
      });
    }
    throw new Error(`unexpected url ${String(input)}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.saveSettings(acceptedSettings());
  const provider = createClaudeProvider(deps);
  const summaries = await provider.import(
    {
      provider: "claude",
      source: "file",
      label: "Claude credentials",
      path: credsPath,
    },
    signal(),
  );
  const summary = asClaudeSummary(summaries[0]);
  assert.equal(summary.authMode, "oauth");
  assert.equal(summary.email, "file@example.com");
  const stored = await deps.store.listStored("claude");
  const account = stored[0];
  if (account == null || account.provider !== "claude")
    assert.fail("account not stored");
  assert.deepEqual(account.scopes, ["user:profile", "user:inference"]);
  assert.equal(account.expiresAt, 1_700_000_300_000);
});

function _headerOf(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers;
  if (headers == null) assert.fail("request had no headers");
  return (headers as Record<string, string>)[name] ?? "";
}

function acceptedSettings() {
  return {
    schemaVersion: 1 as const,
    autoRefresh: { enabled: false, intervalSeconds: 120 },
    alerts: { enabled: false, thresholdPercent: 20 },
    providerOrder: [
      "githubCopilot",
      "codex",
      "antigravity",
      "claude",
      "kiro",
      "cursor",
    ] as ["githubCopilot", "codex", "antigravity", "claude", "kiro", "cursor"],
    hiddenAccountIds: [],
    pinnedAccountIds: [],
    importPathOverrides: {},
    claudePolicyAccepted: true,
  };
}

test("claude refresh honors the hard 180s usage cooldown", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let usageCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === USAGE_URL) {
      usageCalls += 1;
      return jsonResponse({ five_hour: { utilization: 10, resets_at: 1 } });
    }
    throw new Error(`unexpected url ${String(input)}`);
  };
  const clock = {
    now: () => 1_700_000_000_000,
    sleep: () => new Promise<void>((resolve) => resolve()),
    setInterval: () => ({ clear() {} }),
    clearInterval() {},
  };
  const deps = makeTestRuntime(fetchImpl, { root, clock });
  await deps.store.upsert("claude", {
    provider: "claude",
    id: "claude_cool",
    email: "dev@example.com",
    authMode: "oauth",
    accessToken: "live",
    refreshToken: "r",
    tokenType: null,
    scopes: [],
    expiresAt: null,
    accountUuid: null,
    organizationUuid: null,
    organizationName: null,
    displayName: null,
    avatarUrl: null,
    planType: null,
    quota: {
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
    },
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: 1_700_000_000_000 - 100_000,
    createdAt: 1,
    lastUsed: 1,
  });
  const provider = createClaudeProvider(deps);
  const summary = asClaudeSummary(
    await provider.refresh("claude_cool", signal()),
  );
  assert.equal(usageCalls, 0, "cooldown must suppress the usage request");
  assert.equal(summary.quota.fiveHourRemainingPercent, null);
});

function asClaudeSummary(
  value: AccountSummary | undefined,
): ClaudeAccountSummary {
  if (value == null || value.provider !== "claude") {
    throw new Error("expected claude summary");
  }
  return value;
}

/** Canonical case: builds_claude_oauth_start_with_pkce_and_manual_callback */
test("builds claude oauth start with pkce and manual callback", () => {
  const start = buildClaudeOAuthStart("login_123", "state_123", "verifier_123");
  assert.equal(start.loginId, "login_123");
  assert.equal(
    start.callbackUrl,
    "https://platform.claude.com/oauth/code/callback",
  );
  assert.ok(
    start.authUrl.startsWith("https://claude.com/cai/oauth/authorize?"),
  );
  assert.ok(
    start.authUrl.includes("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e"),
  );
  assert.ok(start.authUrl.includes("response_type=code"));
  assert.ok(start.authUrl.includes("state=state_123"));
  assert.ok(start.authUrl.includes("code_challenge_method=S256"));
  assert.ok(start.authUrl.includes("user%3Aprofile"));
  assert.ok(start.authUrl.includes("user%3Asessions%3Aclaude_code"));
  assert.ok(!start.authUrl.includes("verifier_123"));
});

/** Canonical case: classifies_expired_claude_refresh_tokens_as_reauthentication_required */
test("classifies expired claude refresh tokens as reauthentication required", () => {
  const body = JSON.stringify({
    error: "invalid_grant",
    error_description: "Refresh token expired",
  });
  const classified = classifyClaudeRefreshFailure(400, body);
  assert.equal(classified.requiresReauthentication, true);
  assert.equal(
    classified.message,
    "Claude Code authorization expired. Reauthenticate to continue.",
  );
  assert.ok(!classified.message.includes(body));
});

/** Canonical case: applies_claude_oauth_token_response_without_returning_tokens_in_summary */
test("applies claude oauth token response without returning tokens in summary", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exchanges: Array<{ headers: Record<string, string>; body: string }> =
    [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      exchanges.push({
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body),
      });
      return jsonResponse({
        access_token: "claude-access-token",
        refresh_token: "claude-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "user:profile user:inference user:sessions:claude_code",
        account: { uuid: "account-uuid", email_address: "sizzle@example.com" },
        organization: { uuid: "org-uuid", name: "Pink Pixel" },
      });
    }
    if (url === PROFILE_URL) {
      return jsonResponse({
        account: {
          uuid: "account-uuid",
          email_address: "sizzle@example.com",
          display_name: "Sizzle",
          avatar_url: "https://example.com/avatar.png",
        },
        organization: {
          uuid: "org-uuid",
          name: "Pink Pixel",
          organization_type: "claude_pro",
        },
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.saveSettings(acceptedSettings());
  const provider = createClaudeProvider(deps);
  const flow = await provider.beginAuth(signal());
  if (flow.mode !== "manualCode") assert.fail("expected manualCode flow");
  assert.equal(
    flow.callbackUrl,
    "https://platform.claude.com/oauth/code/callback",
  );
  const state = /state=([^&]+)/.exec(flow.authUrl)?.[1] ?? "";
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  await flow.submit({
    kind: "claude",
    callbackOrCode: `claude-code-1#${decodeURIComponent(state)}`,
  });
  const summaries = await flow.result;
  const summary = asClaudeSummary(summaries[0]);
  assert.equal(summary.email, "sizzle@example.com");
  assert.equal(summary.accountUuid, "account-uuid");
  assert.equal(summary.organizationUuid, "org-uuid");
  assert.equal(summary.organizationName, "Pink Pixel");
  assert.equal(summary.planType, "Pro");

  const exchange = exchanges[0];
  if (exchange == null) assert.fail("token exchange missing");
  assert.equal(exchange.headers["User-Agent"], "claude-code/2.1.233");
  assert.equal(exchange.headers.Accept, "application/json, text/plain, */*");
  const exchangeBody = JSON.parse(exchange.body) as Record<string, string>;
  assert.equal(exchangeBody.grant_type, "authorization_code");
  assert.equal(exchangeBody.client_id, "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  assert.equal(exchangeBody.code, "claude-code-1");
  assert.equal(
    exchangeBody.redirect_uri,
    "https://platform.claude.com/oauth/code/callback",
  );
  assert.match(exchangeBody.code_verifier ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(exchangeBody.state, decodeURIComponent(state));
  assert.ok(!JSON.stringify(summary).includes("claude-access-token"));
  assert.ok(!JSON.stringify(summary).includes("claude-refresh-token"));
  const raw = await import("node:fs/promises").then((fs) =>
    fs.readFile(path.join(root, "providers", "claude.json"), "utf8"),
  );
  assert.ok(raw.includes("claude-access-token"));
  assert.ok(raw.includes("claude-refresh-token"));
});

test("claude sole UA claude-code/2.1.233 on every request; rotation persists on later failure", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userAgents: string[] = [];
  let usageCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    userAgents.push(headerOf(init, "User-Agent"));
    if (url === USAGE_URL) {
      usageCalls += 1;
      if (usageCalls === 1) return jsonResponse({}, 401);
      return jsonResponse({ message: "upstream exploded" }, 500);
    }
    if (url === TOKEN_URL) {
      return jsonResponse({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.upsert("claude", {
    provider: "claude",
    id: "claude_race",
    email: "race@example.com",
    authMode: "oauth",
    accessToken: "expiring-access",
    refreshToken: "expiring-refresh",
    tokenType: null,
    scopes: [],
    expiresAt: 1_700_000_100_000,
    accountUuid: null,
    organizationUuid: null,
    organizationName: null,
    displayName: null,
    avatarUrl: null,
    planType: null,
    quota: emptyClaudeQuota(),
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: null,
    createdAt: 1,
    lastUsed: 1,
  });
  const provider = createClaudeProvider(deps);
  const summary = asClaudeSummary(
    await provider.refresh("claude_race", signal()),
  );
  // Stale-token refresh, 401 usage, post-401 refresh, failing retry usage:
  // every request carries exactly the sole permitted User-Agent.
  assert.deepEqual(userAgents, [
    "claude-code/2.1.233",
    "claude-code/2.1.233",
    "claude-code/2.1.233",
    "claude-code/2.1.233",
  ]);
  assert.equal(usageCalls, 2);
  // The rotated refresh token survives even though the retried usage failed.
  const stored = await deps.store.listStored("claude");
  const account = stored[0];
  if (account == null || account.provider !== "claude") assert.fail("missing");
  assert.equal(account.refreshToken, "rotated-refresh");
  assert.equal(account.accessToken, "rotated-access");
  assert.match(summary.quotaQueryLastError ?? "", /upstream exploded|failed/);
  assert.notEqual(summary.status, "requiresReauthentication");
});

test("claude profile fallback uses the token response account email", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      return jsonResponse({
        access_token: "fallback-access",
        refresh_token: "fallback-refresh",
        expires_in: 3600,
        account: { uuid: "uuid-1", email_address: "fallback@example.com" },
      });
    }
    if (url === PROFILE_URL) return jsonResponse({}, 500);
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.saveSettings(acceptedSettings());
  const provider = createClaudeProvider(deps);
  const flow = await provider.beginAuth(signal());
  if (flow.mode !== "manualCode") assert.fail("expected manualCode flow");
  await flow.submit({ kind: "claude", callbackOrCode: "code-only-1" });
  const summaries = await flow.result;
  const summary = asClaudeSummary(summaries[0]);
  assert.equal(summary.email, "fallback@example.com");
  assert.equal(summary.accountUuid, "uuid-1");
});

function emptyClaudeQuota() {
  return {
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
}

test("claude error surfaces redact opaque token runs from response bodies", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = `sk-ant-o01-${"x".repeat(40)}`;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === USAGE_URL) {
      return jsonResponse({ message: `session invalid ${secret}` }, 500);
    }
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  await deps.store.upsert("claude", {
    provider: "claude",
    id: "claude_redact",
    email: "r@example.com",
    authMode: "oauth",
    accessToken: "live-access",
    refreshToken: "r",
    tokenType: null,
    scopes: [],
    expiresAt: null,
    accountUuid: null,
    organizationUuid: null,
    organizationName: null,
    displayName: null,
    avatarUrl: null,
    planType: null,
    quota: emptyClaudeQuota(),
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: null,
    createdAt: 1,
    lastUsed: 1,
  });
  const provider = createClaudeProvider(deps);
  const summary = asClaudeSummary(
    await provider.refresh("claude_redact", signal()),
  );
  assert.ok(summary.quotaQueryLastError != null);
  assert.ok(!summary.quotaQueryLastError?.includes(secret));
  assert.ok(summary.quotaQueryLastError?.includes("[REDACTED]"));
});

/** Canonical case: parses_claude_usage_into_remaining_percentages */
test("parses claude usage into remaining percentages (canonical fixture)", () => {
  const quota = parseClaudeQuota({
    five_hour: { utilization: 25.0, resets_at: "2026-06-25T22:30:00Z" },
    seven_day: { utilization: 80, resets_at: 1_771_718_400_000 },
    seven_day_sonnet: { utilization: 10, resets_at: 1_771_718_400 },
    extra_usage: {
      is_enabled: true,
      utilization: 50,
      resets_at: 1_771_736_400,
      used_credits: 120,
      monthly_limit: 1000,
    },
  });
  assert.equal(quota.fiveHourRemainingPercent, 75);
  assert.ok(quota.fiveHourResetAt != null);
  assert.equal(quota.weeklyRemainingPercent, 20);
  assert.equal(quota.weeklyResetAt, 1_771_718_400_000);
  assert.equal(quota.weeklySonnetRemainingPercent, 90);
  assert.equal(quota.weeklySonnetResetAt, 1_771_718_400_000);
  assert.equal(quota.extraUsageRemainingPercent, 50);
  assert.equal(quota.extraUsageResetAt, 1_771_736_400_000);
  assert.equal(quota.extraUsageUsedCents, 120);
  assert.equal(quota.extraUsageLimitCents, 1000);
});

test("claude import skips a rejected confirmed source and falls through, policy-gated", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-claude-home-"));
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-claude-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const configDir = path.join(home, "cfg");
  await mkdir(path.join(configDir), { recursive: true });
  await writeFile(
    path.join(configDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { refreshToken: "but-no-access" } }),
    "utf8",
  );
  const credsDir = path.join(home, ".claude");
  await mkdir(credsDir, { recursive: true });
  await writeFile(
    path.join(credsDir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "fallback-access",
        refreshToken: "fallback-refresh",
      },
    }),
    "utf8",
  );
  const previousHome = process.env.HOME;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  });

  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === PROFILE_URL) {
      return jsonResponse({
        account: { uuid: "acct-fb", email: "fallback@example.com" },
      });
    }
    throw new Error(`unexpected url ${String(input)}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });

  // Policy gate first: without acceptance, import refuses outright.
  await deps.store.saveSettings({
    ...acceptedSettings(),
    claudePolicyAccepted: false,
  });
  const gatedProvider = createClaudeProvider(deps);
  await assert.rejects(
    gatedProvider.import(
      {
        provider: "claude",
        source: "file",
        label: "Claude credentials",
        path: path.join(configDir, ".credentials.json"),
      },
      signal(),
    ),
    /disabled until the policy/,
  );

  await deps.store.saveSettings(acceptedSettings());
  const provider = createClaudeProvider(deps);
  const candidates = await provider.discoverImports(signal());
  assert.equal(
    candidates[0]?.path,
    path.join(configDir, ".credentials.json"),
    "CLAUDE_CONFIG_DIR leads on Linux/Windows",
  );
  const summaries = await provider.import(candidates[0] as never, signal());
  const summary = asClaudeSummary(summaries[0]);
  assert.equal(summary.email, "fallback@example.com");
  const stored = await deps.store.listStored("claude");
  assert.equal(stored.length, 1, "exactly one account persisted");
  assert.equal(
    (stored[0] as { accessToken?: string }).accessToken,
    "fallback-access",
    "the fallback source won",
  );
});
