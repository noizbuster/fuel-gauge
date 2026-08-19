import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCredentialStore } from "../../src/core/store.js";
import type {
  AccountSummary,
  CodexAccountSummary,
  StoredCodexAccount,
} from "../../src/core/types.js";
import {
  buildCodexOAuthStart,
  classifyCodexRefreshFailure,
  createCodexProvider,
  parseCodexQuota,
} from "../../src/providers/codex.js";
import type { RuntimeDependencies } from "../../src/runtime.js";
import { fixedClock, makeTestRuntime } from "./runtime.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Deterministic runtime dependencies around a fresh private store. */
function makeRuntime(fetchImpl: typeof fetch): {
  deps: RuntimeDependencies;
  root: string;
} {
  const root = path.join(
    tmpdir(),
    `fuel-gauge-codex-${Date.now()}-${Math.random()}`,
  );
  return {
    deps: {
      configRoot: root,
      store: createCredentialStore(root),
      fetch: fetchImpl,
      clock: fixedClock(),
      browser: {
        async open() {
          return { url: "", launched: false };
        },
      },
      subprocess: {
        async run() {
          throw new Error("subprocess not expected in codex tests");
        },
      },
      callbackServer: {
        async start() {
          throw new Error("callback server not expected in codex tests");
        },
      },
    },
    root,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jwtWith(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.${encode({})}`;
}

const noNetwork: typeof fetch = async () => {
  throw new Error("no network expected in this test");
};

const signal = () => new AbortController().signal;

const fileCandidate = (filePath: string) =>
  ({
    provider: "codex",
    source: "file",
    label: `Codex auth file (${filePath})`,
    path: filePath,
  }) as const;

test("codex import prefers CODEX_HOME auth.json and parses OAuth claims", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-codex-home-"));
  const { deps, root } = makeRuntime(noNetwork);
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const codexHome = path.join(home, "custom-codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    path.join(codexHome, "auth.json"),
    JSON.stringify({
      auth_mode: "oauth",
      tokens: {
        id_token: jwtWith({
          email: "dev@example.com",
          sub: "user-123",
          "https://api.openai.com/auth": {
            chatgpt_user_id: "chatgpt-1",
            chatgpt_plan_type: "plus",
            chatgpt_account_id: "acc-9",
            chatgpt_organization_id: "org-7",
          },
        }),
        access_token: "sess-access-token",
        refresh_token: "sess-refresh-token",
      },
    }),
    "utf8",
  );
  const previous = process.env.CODEX_HOME;
  const previousHome = process.env.HOME;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const provider = createCodexProvider(deps);
  const candidates = await provider.discoverImports(signal());
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.path, path.join(codexHome, "auth.json"));

  const first = candidates[0];
  if (first == null) assert.fail("no candidate discovered");
  const summaries = await provider.import(first, signal());
  const summary = asCodexSummary(summaries[0]);
  assert.equal(summary.email, "dev@example.com");
  assert.equal(summary.authMode, "oauth");
  assert.equal(summary.plan, "plus");
  assert.equal(summary.accountId, "acc-9");
  assert.equal(summary.organizationId, "org-7");
  assert.match(summary.id, /^codex_[0-9a-f]{32}$/);
});

test("codex import falls back to ~/.codex/auth.json API keys", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-codex-home-"));
  const { deps, root } = makeRuntime(noNetwork);
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test-key" }),
    "utf8",
  );
  const env = process.env;
  const previousCodexHome = env.CODEX_HOME;
  const previousHome = env.HOME;
  delete env.CODEX_HOME;
  env.HOME = home;
  t.after(() => {
    if (previousCodexHome === undefined) delete env.CODEX_HOME;
    else env.CODEX_HOME = previousCodexHome;
    if (previousHome === undefined) delete env.HOME;
    else env.HOME = previousHome;
  });

  const provider = createCodexProvider(deps);
  const candidates = await provider.discoverImports(signal());
  assert.equal(candidates.length, 1);
  const first = candidates[0];
  if (first == null) assert.fail("no candidate discovered");
  const summaries = await provider.import(first, signal());
  const summary = asCodexSummary(summaries[0]);
  assert.equal(summary.authMode, "apikey");
  assert.equal(summary.plan, "API Key");
  assert.match(summary.id, /^codex_apikey_[0-9a-f]{32}$/);
});

test("codex keyring-mode auth files classify as NoCredentialFound", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-codex-home-"));
  const { deps, root } = makeRuntime(noNetwork);
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    path.join(home, "auth.json"),
    JSON.stringify({ auth_mode: "keyring" }),
    "utf8",
  );
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  t.after(() => {
    process.env.HOME = previousHome ?? "";
    if (previousHome === undefined) delete process.env.HOME;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  const provider = createCodexProvider(deps);
  await assert.rejects(
    provider.import(fileCandidate(path.join(home, "auth.json")), signal()),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "NoCredentialFound");
      assert.match((error as Error).message, /OS keyring/);
      return true;
    },
  );
});

test("codex apikey refresh records the exact safe error and skips network", async (t) => {
  const { deps, root } = makeRuntime(noNetwork);
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedOAuthAccount(deps, {
    id: "codex_apikey_seed",
    authMode: "apikey",
    tokens: null,
    plan: "API Key",
  });
  const provider = createCodexProvider(deps);
  const summary = asCodexSummary(
    await provider.refresh("codex_apikey_seed", signal()),
  );
  assert.equal(
    summary.quotaQueryLastError,
    "API key accounts do not expose Codex web quota in this slice.",
  );
});

test("codex refresh retries once after 401 and parses both windows", async (t) => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === USAGE_URL) {
      const usageAttempt = calls.filter((entry) => entry === USAGE_URL).length;
      return usageAttempt === 1
        ? jsonResponse({ error: "unauthorized" }, 401)
        : jsonResponse({
            plan_type: "pro",
            rate_limit: {
              primary_window: {
                used_percent: 25,
                limit_window_seconds: 7_200,
                reset_after_seconds: 90,
              },
              secondary_window: {
                used_percent: 200,
                reset_at: 1_800_000_000,
                limit_window_seconds: 604_800,
              },
            },
          });
    }
    if (url === TOKEN_URL) {
      return jsonResponse({
        id_token: jwtWith({ email: "dev@example.com" }),
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const { deps, root } = makeRuntime(fetchImpl);
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedOAuthAccount(deps, {
    id: "codex_retry",
    authMode: "oauth",
    tokens: {
      idToken: jwtWith({ email: "dev@example.com" }),
      accessToken: "stale-access",
      refreshToken: "valid-refresh",
    },
    plan: "plus",
  });

  const provider = createCodexProvider(deps);
  const summary = asCodexSummary(
    await provider.refresh("codex_retry", signal()),
  );
  assert.equal(summary.quota.hourlyRemainingPercent, 75);
  assert.equal(summary.quota.hourlyWindowMinutes, 120);
  assert.equal(summary.quota.hourlyResetAt, 1_700_000_090_000);
  assert.equal(summary.quota.weeklyRemainingPercent, 0);
  assert.equal(summary.plan, "pro");
  assert.deepEqual(calls, [USAGE_URL, TOKEN_URL, USAGE_URL]);
});

test("codex refresh marks reauthentication when the refresh token is rejected", async (t) => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === USAGE_URL) return jsonResponse({ error: "unauthorized" }, 401);
    if (url === TOKEN_URL) {
      return jsonResponse(
        { error: "invalid_grant", error_description: "refresh token expired" },
        400,
      );
    }
    throw new Error(`unexpected url ${url}`);
  };
  const { deps, root } = makeRuntime(fetchImpl);
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedOAuthAccount(deps, {
    id: "codex_reauth",
    authMode: "oauth",
    tokens: {
      idToken: jwtWith({ email: "dev@example.com" }),
      accessToken: "stale",
      refreshToken: "revoked",
    },
    plan: null,
    quota: {
      hourlyRemainingPercent: 42,
      hourlyResetAt: 1_000,
      hourlyWindowMinutes: 60,
      weeklyRemainingPercent: null,
      weeklyResetAt: null,
      weeklyWindowMinutes: null,
    },
  });

  const provider = createCodexProvider(deps);
  const summary = asCodexSummary(
    await provider.refresh("codex_reauth", signal()),
  );
  assert.equal(summary.status, "requiresReauthentication");
  assert.equal(
    summary.quotaQueryLastError,
    "Codex authorization expired. Reauthenticate to continue.",
  );
  assert.equal(summary.quota.hourlyRemainingPercent, 42);
});

test("codex refreshAll refreshes sequentially and keeps per-account failures", async (t) => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === USAGE_URL) {
      return jsonResponse({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 3_600 },
        },
      });
    }
    throw new Error(`unexpected url ${String(input)}`);
  };
  const { deps, root } = makeRuntime(fetchImpl);
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedOAuthAccount(deps, {
    id: "codex_ok",
    authMode: "oauth",
    tokens: {
      idToken: jwtWith({ email: "ok@example.com" }),
      accessToken: "ok-access",
      refreshToken: null,
    },
    plan: null,
  });
  await deps.store.upsert("codex", {
    provider: "codex",
    id: "codex_missing_tokens",
    email: "broken@example.com",
    authMode: "oauth",
    openAIApiKey: null,
    apiBaseUrl: null,
    userId: null,
    plan: null,
    accountId: null,
    organizationId: null,
    tokens: {
      idToken: jwtWith({ email: "broken@example.com" }),
      accessToken: "",
      refreshToken: null,
    },
    quota: emptyQuota(),
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: null,
    createdAt: 2,
    lastUsed: 2,
  });

  const provider = createCodexProvider(deps);
  const summaries = await provider.refreshAll(signal());
  assert.equal(summaries.length, 2);
  const ok = summaries.find((entry) => entry.id === "codex_ok");
  const broken = summaries.find((entry) => entry.id === "codex_missing_tokens");
  if (ok == null || broken == null)
    assert.fail("accounts missing after refreshAll");
  if (ok.provider !== "codex" || broken.provider !== "codex")
    assert.fail("wrong summaries");
  assert.equal(ok.quota.hourlyRemainingPercent, 90);
  assert.equal(
    broken.quotaQueryLastError,
    "Codex account does not have an OAuth access token",
  );
});

function emptyQuota() {
  return {
    hourlyRemainingPercent: null,
    hourlyResetAt: null,
    hourlyWindowMinutes: null,
    weeklyRemainingPercent: null,
    weeklyResetAt: null,
    weeklyWindowMinutes: null,
  };
}

async function seedOAuthAccount(
  deps: RuntimeDependencies,
  seed: {
    id: string;
    authMode: "oauth" | "apikey";
    tokens: StoredCodexAccount["tokens"];
    plan: string | null;
    quota?: StoredCodexAccount["quota"];
  },
): Promise<void> {
  const account: StoredCodexAccount = {
    provider: "codex",
    id: seed.id,
    email: "dev@example.com",
    authMode: seed.authMode,
    openAIApiKey: null,
    apiBaseUrl: null,
    userId: null,
    plan: seed.plan,
    accountId: null,
    organizationId: null,
    tokens: seed.tokens,
    quota: seed.quota ?? emptyQuota(),
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: null,
    createdAt: 1,
    lastUsed: 1,
  };
  await deps.store.upsert("codex", account);
}

function asCodexSummary(
  value: AccountSummary | undefined,
): CodexAccountSummary {
  if (value == null || value.provider !== "codex") {
    throw new Error("expected codex summary");
  }
  return value;
}

function sha256ChallengeBase64Url(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

/** Canonical case: builds_codex_oauth_start_with_pkce_state_and_local_callback */
test("builds codex oauth start with pkce state and local callback", () => {
  const start = buildCodexOAuthStart("login_123", "state_123", "verifier_123");
  assert.equal(start.loginId, "login_123");
  assert.equal(start.callbackUrl, "http://localhost:1455/auth/callback");
  assert.ok(
    start.authUrl.startsWith("https://auth.openai.com/oauth/authorize?"),
  );
  assert.ok(start.authUrl.includes("client_id=app_EMoamEEZ73f0CkXaXp7hrann"));
  assert.ok(
    start.authUrl.includes(
      "redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
    ),
  );
  assert.ok(start.authUrl.includes("response_type=code"));
  assert.ok(start.authUrl.includes("state=state_123"));
  // The S256 challenge is base64url(SHA-256(verifier)) — never the verifier.
  const expectedChallenge = sha256ChallengeBase64Url("verifier_123");
  assert.ok(start.authUrl.includes(`code_challenge=${expectedChallenge}`));
  assert.ok(start.authUrl.includes("code_challenge_method=S256"));
  assert.ok(!start.authUrl.includes("verifier_123"));
  assert.ok(!start.authUrl.includes("verifier_123"));
});

/** Canonical case: parses_current_codex_primary_weekly_window */
test("parses current codex primary weekly window", () => {
  const parsed = parseCodexQuota(
    {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 35,
          limit_window_seconds: 604800,
          reset_at: 1_771_736_400,
        },
      },
    },
    1_700_000_000_000,
  );
  assert.equal(parsed.plan, "plus");
  assert.equal(parsed.quota.hourlyRemainingPercent, 65);
  assert.equal(parsed.quota.hourlyWindowMinutes, 10080);
  assert.equal(parsed.quota.hourlyResetAt, 1_771_736_400_000);
  assert.equal(parsed.quota.weeklyRemainingPercent, null);
  assert.equal(parsed.quota.weeklyWindowMinutes, null);
  assert.equal(parsed.quota.weeklyResetAt, null);
});

/** Canonical case: classifies_rejected_codex_refresh_tokens_without_exposing_response_bodies */
test("classifies rejected codex refresh tokens without exposing response bodies", () => {
  const body = JSON.stringify({
    error: "invalid_grant",
    secret: "must-not-leak",
  });
  const rejected = classifyCodexRefreshFailure(401, body);
  assert.equal(rejected.requiresReauthentication, true);
  assert.equal(
    rejected.message,
    "Codex authorization expired. Reauthenticate to continue.",
  );
  assert.ok(!rejected.message.includes("must-not-leak"));

  const temporary = classifyCodexRefreshFailure(503, body);
  assert.equal(temporary.requiresReauthentication, false);
  assert.equal(
    temporary.message,
    `Codex token refresh returned 503 with body length ${body.length}`,
  );
});

test("codex beginAuth posts the exact exchange form for the captured code", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bodies: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      bodies.push(String(init?.body));
      return jsonResponse({
        id_token: jwtWith({
          email: "dev@example.com",
          "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" },
        }),
        access_token: "exchanged-access",
        refresh_token: "exchanged-refresh",
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
  let expectedState = "";
  const deps = makeTestRuntime(fetchImpl, {
    root,
    callbackServer: {
      async start(options) {
        expectedState = options.expectedState;
        return {
          host: "127.0.0.1",
          port: 1455,
          baseUrl: "http://localhost:1455",
          result: Promise.resolve({
            code: "auth_code_1",
            state: options.expectedState,
            path: "/auth/callback",
            params: {},
          }),
          async cancel() {},
          async close() {},
        };
      },
    },
  });
  const provider = createCodexProvider(deps);
  const flow = await provider.beginAuth(signal());
  if (flow.mode !== "browserCallback")
    assert.fail("expected browserCallback flow");
  assert.equal(flow.callbackUrl, "http://localhost:1455/auth/callback");
  assert.ok(flow.authUrl.includes("originator=codex_vscode"));
  assert.ok(
    flow.authUrl.includes(`state=${encodeURIComponent(expectedState)}`),
  );
  const summaries = await flow.result;
  const summary = asCodexSummary(summaries[0]);
  if (summary.provider !== "codex") assert.fail("wrong summary");

  const body = bodies[0];
  if (body == null) assert.fail("exchange body missing");
  const verifier = /code_verifier=([^&]+)$/.exec(body)?.[1] ?? "";
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    body,
    "grant_type=authorization_code" +
      "&client_id=app_EMoamEEZ73f0CkXaXp7hrann" +
      "&code=auth_code_1" +
      "&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback" +
      `&code_verifier=${verifier}`,
  );
});

/** Canonical case: applies_codex_refresh_response_and_preserves_existing_refresh_token_when_omitted */
test("codex refresh response omission preserves the stored refresh token", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-codex-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({
      tokens: {
        id_token: jwtWith({
          email: "sizzlebop@example.com",
          sub: "user_123",
          "https://api.openai.com/auth": {
            chatgpt_user_id: "user_123",
            chatgpt_plan_type: "plus",
            account_id: "acc_123",
            organization_id: "org_123",
          },
        }),
        access_token: "old-access-token",
        refresh_token: "old-refresh-token",
      },
      last_refresh: 1_771_718_400,
    }),
    "utf8",
  );
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === USAGE_URL) return jsonResponse({}, 401);
    if (url === TOKEN_URL) {
      // Refresh response omits refresh_token entirely.
      return jsonResponse({
        id_token: jwtWith({
          email: "sizzlebop@example.com",
          "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
        }),
        access_token: "new-access-token",
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, { root });
  const env = process.env;
  const previousHome = env.HOME;
  const previousCodex = env.CODEX_HOME;
  env.HOME = home;
  delete env.CODEX_HOME;
  t.after(() => {
    if (previousHome === undefined) delete env.HOME;
    else env.HOME = previousHome;
    if (previousCodex !== undefined) env.CODEX_HOME = previousCodex;
  });
  const provider = createCodexProvider(deps);
  const candidates = await provider.discoverImports(signal());
  const firstCandidate = candidates[0];
  if (firstCandidate == null) assert.fail("candidate missing");
  const imported = await provider.import(firstCandidate, signal());
  const importedFirst = imported[0];
  if (importedFirst == null) assert.fail("import produced no summary");

  const summary = await provider.refresh(importedFirst.id, signal());
  if (summary.provider !== "codex") assert.fail("wrong summary");
  assert.equal(summary.plan, "pro");
  const raw = await import("node:fs/promises").then((fs) =>
    fs.readFile(path.join(root, "providers", "codex.json"), "utf8"),
  );
  assert.ok(raw.includes("new-access-token"));
  assert.ok(raw.includes("old-refresh-token"));
  assert.ok(!JSON.stringify(summary).includes("new-access-token"));
  assert.ok(!JSON.stringify(summary).includes("old-refresh-token"));
});

test("codex JWT alias fallbacks: sub and tokens.account_id", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-codex-"));
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-codex-home-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({
      tokens: {
        id_token: jwtWith({ email: "alias@example.com", sub: "sub-user-9" }),
        access_token: "a",
        refresh_token: null,
        account_id: "fallback-account",
      },
    }),
    "utf8",
  );
  const env = process.env;
  const previousHome = env.HOME;
  const previousCodex = env.CODEX_HOME;
  env.HOME = home;
  delete env.CODEX_HOME;
  t.after(() => {
    if (previousHome === undefined) delete env.HOME;
    else env.HOME = previousHome;
    if (previousCodex !== undefined) env.CODEX_HOME = previousCodex;
  });
  const deps = makeTestRuntime(noNetwork, { root });
  const provider = createCodexProvider(deps);
  const candidates = await provider.discoverImports(signal());
  const firstCandidate = candidates[0];
  if (firstCandidate == null) assert.fail("candidate missing");
  const summaries = await provider.import(firstCandidate, signal());
  const summary = asCodexSummary(summaries[0]);
  if (summary.provider !== "codex") assert.fail("wrong summary");
  assert.equal(summary.userId, "sub-user-9");
  assert.equal(summary.accountId, "fallback-account");
  assert.equal(summary.organizationId, null);
});

test("codex beginAuth drives the injected callback-server seam end to end", async (t) => {
  // The real fixed-port listener behavior (binding, routes, state,
  // idempotent close/cancel) is proven in test/core/callback-server.test.ts;
  // this proves the provider wiring deterministically without binding 1455.
  const started: Array<{
    kind: string;
    expectedState: string;
    timeoutMs: number | undefined;
  }> = [];
  let closeCount = 0;
  let cancelCount = 0;
  const callbacks = Promise.withResolvers<{
    code: string;
    state: string;
    path: string;
    params: Record<string, string>;
  }>();
  callbacks.resolve({
    code: "seeded-code",
    state: "later-filled",
    path: "/auth/callback",
    params: {},
  });

  const fakeServer = {
    host: "127.0.0.1" as const,
    port: 1455,
    baseUrl: "http://localhost:1455",
    result: callbacks.promise,
    close: async () => {
      closeCount += 1;
    },
    cancel: async () => {
      cancelCount += 1;
    },
  };

  const exchanges: Array<URLSearchParams> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    exchanges.push(new URLSearchParams(body));
    return jsonResponse({
      id_token: jwtWith({
        email: "seam@example.com",
        "https://api.openai.com/auth": {
          user_id: "user-seam",
          organization_id: "org-seam",
        },
        chatgpt_plan_type: "team",
      }),
      access_token: "codex-access",
      refresh_token: "codex-refresh",
    });
  };

  const root = path.join(
    tmpdir(),
    `fuel-gauge-codex-seam-${Date.now()}-${Math.random()}`,
  );
  const deps: RuntimeDependencies = {
    configRoot: root,
    store: createCredentialStore(root),
    fetch: fetchImpl,
    clock: fixedClock(),
    browser: {
      async open() {
        return { url: "", launched: false };
      },
    },
    subprocess: {
      async run() {
        throw new Error("subprocess not expected");
      },
    },
    callbackServer: {
      async start(options) {
        started.push({
          kind: options.kind,
          expectedState: options.expectedState,
          timeoutMs: options.timeoutMs,
        });
        return fakeServer;
      },
    },
  };
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const provider = createCodexProvider(deps);
  const flow = await provider.beginAuth(signal());

  assert.equal(started.length, 1, "one loopback start");
  const start = started[0];
  if (start == null) assert.fail("start missing");
  assert.equal(start.kind, "codex");
  assert.ok(start.expectedState.length >= 32, "strong state");
  assert.ok(start.timeoutMs !== undefined && start.timeoutMs > 0);
  assert.equal(flow.mode, "browserCallback");
  assert.equal(flow.callbackUrl, "http://localhost:1455/auth/callback");
  assert.match(flow.authUrl, /code_challenge_method=S256/);
  assert.match(flow.authUrl, /originator=codex_vscode/);

  const summaries = await flow.result;
  assert.equal(asCodexSummary(summaries[0]).email, "seam@example.com");
  await flow.cancel();
  assert.equal(
    cancelCount,
    1,
    "cancel reaches the loopback server (idempotency is the server's)",
  );
  assert.equal(closeCount, 1, "server closed after the flow resolves");
  assert.equal(exchanges.length, 1, "one token exchange for the callback code");
  assert.equal(exchanges[0]?.get("code"), "seeded-code");
});

test("codex import skips a corrupt confirmed source and falls through to the next", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-codex-home-"));
  const { deps, root } = makeRuntime(noNetwork);
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const codexHome = path.join(home, "custom-codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "auth.json"), "{ not json", "utf8");
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-next-key" }),
    "utf8",
  );
  const previousCodexHome = process.env.CODEX_HOME;
  const previousHome = process.env.HOME;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = home;
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const provider = createCodexProvider(deps);
  const candidates = await provider.discoverImports(signal());
  assert.equal(candidates.length, 2, "both sources discovered in precedence");
  assert.equal(
    candidates[0]?.path,
    path.join(codexHome, "auth.json"),
    "CODEX_HOME leads",
  );
  const summaries = await provider.import(candidates[0] as never, signal());
  const summary = asCodexSummary(summaries[0]);
  assert.equal(summary.authMode, "apikey");
  assert.match(summary.id, /^codex_apikey_[0-9a-f]{32}$/);
  assert.equal(
    (await deps.store.listStored("codex")).length,
    1,
    "exactly one account persisted",
  );
});

test("codex import aggregates typed failures with every tried path", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-codex-home-"));
  const { deps, root } = makeRuntime(noNetwork);
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const codexHome = path.join(home, "custom-codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ auth_mode: "keyring" }),
    "utf8",
  );
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({ auth_mode: "keyring" }),
    "utf8",
  );
  const previousCodexHome = process.env.CODEX_HOME;
  const previousHome = process.env.HOME;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = home;
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const provider = createCodexProvider(deps);
  const candidates = await provider.discoverImports(signal());
  await assert.rejects(
    provider.import(candidates[0] as never, signal()),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "NoCredentialFound");
      const message = (error as Error).message;
      assert.ok(message.includes(path.join(codexHome, "auth.json")));
      assert.ok(message.includes(path.join(home, ".codex", "auth.json")));
      return true;
    },
  );
  assert.equal(
    (await deps.store.listStored("codex")).length,
    0,
    "nothing persisted when every source fails",
  );
});
