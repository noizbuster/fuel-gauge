import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AccountSummary,
  AntigravityAccountSummary,
  StoredAntigravityAccount,
} from "../../src/core/types.js";
import {
  applyAntigravityTokenResponseForTest,
  buildAntigravityCodeAssistHeaders,
  buildAntigravityLoadCodeAssistPayload,
  buildAntigravityOAuthStart,
  createAntigravityProvider,
  parseAntigravityCodeAssistResponse,
  parseAntigravityLoadStatus,
  parseAntigravityQuota,
} from "../../src/providers/antigravity.js";
import {
  fixedClock,
  jsonResponse,
  jwtWith,
  makeTestRuntime,
  noNetwork,
  signal,
  summaryJson,
} from "./runtime.js";

const CODE_ASSIST_BASE = "https://daily-cloudcode-pa.googleapis.com";
const LOAD_URL = `${CODE_ASSIST_BASE}/v1internal:loadCodeAssist`;
const MODELS_URL = `${CODE_ASSACT_MODELS_URL()}`;
const QUOTA_URL = `${CODE_ASSIST_BASE}/v1internal:retrieveUserQuotaSummary`;
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function CODE_ASSACT_MODELS_URL(): string {
  return `${CODE_ASSIST_BASE}/v1internal:fetchAvailableModels`;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

type FetchLike = typeof globalThis.fetch;

function asAntigravitySummary(
  value: AccountSummary | undefined,
): AntigravityAccountSummary {
  if (value == null || value.provider !== "antigravity") {
    throw new Error("expected antigravity summary");
  }
  return value;
}

function recorder(
  script: (request: RecordedRequest, attempt: number) => Response,
): { requests: RecordedRequest[]; fetch: FetchLike } {
  const requests: RecordedRequest[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : "",
    };
    requests.push(request);
    return script(request, requests.length);
  };
  return { requests, fetch: fetchLike };
}

/** Canonical case: imports_local_antigravity_credentials_without_returning_tokens_in_summary */
test("imports local antigravity credentials without returning tokens in summary", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-home-"));
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const geminiDir = path.join(home, ".gemini");
  await (await import("node:fs/promises")).mkdir(geminiDir, {
    recursive: true,
  });
  await writeFile(
    path.join(geminiDir, "oauth_creds.json"),
    JSON.stringify({
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: jwtWith({
        email: "sizzlebop@example.com",
        sub: "google-user-123",
        name: "Sizzle Bop",
      }),
      token_type: "Bearer",
      scope: "email profile",
      expiry_date: 1_771_718_400_000,
    }),
    "utf8",
  );
  await writeFile(
    path.join(geminiDir, "google_accounts.json"),
    JSON.stringify({ active: "sizzlebop@example.com" }),
    "utf8",
  );
  await writeFile(
    path.join(geminiDir, "settings.json"),
    JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }),
    "utf8",
  );
  const env = process.env;
  const previousHome = env.HOME;
  const previousGemini = env.GEMINI_CLI_HOME;
  env.HOME = home;
  delete env.GEMINI_CLI_HOME;
  t.after(() => {
    if (previousHome === undefined) delete env.HOME;
    else env.HOME = previousHome;
    if (previousGemini !== undefined) env.GEMINI_CLI_HOME = previousGemini;
  });

  const deps = makeTestRuntime(noNetwork, { root });
  const provider = createAntigravityProvider(deps);
  const candidates = await provider.discoverImports(signal());
  const creds = candidates.find(
    (entry) => entry.path === path.join(home, ".gemini", "oauth_creds.json"),
  );
  if (creds == null) assert.fail("oauth_creds.json candidate missing");
  const summaries = await provider.import(creds, signal());
  const summary = asAntigravitySummary(summaries[0]);
  assert.equal(summary.email, "sizzlebop@example.com");
  assert.equal(summary.authId, "google-user-123");
  assert.equal(summary.name, "Sizzle Bop");
  assert.equal(summary.selectedAuthType, "oauth-personal");
  assert.equal(summary.source, "local");
  const serialized = summaryJson(summary);
  assert.ok(!serialized.includes("access-token"));
  assert.ok(!serialized.includes("refresh-token"));
  assert.ok(!serialized.includes("id_token"));
});

/** Canonical case: parses_antigravity_quota_buckets_into_remaining_percentages */
test("parses antigravity quota buckets into remaining percentages", () => {
  const quota = parseAntigravityQuota({
    groups: [
      {
        buckets: [
          {
            bucketId: "gemini-5h",
            remainingFraction: 0.42,
            resetTime: "2026-06-25T16:30:00Z",
          },
          {
            bucketId: "gemini-weekly",
            remainingFraction: 0.8,
            resetTime: 1_771_718_400,
          },
          {
            bucketId: "3p-5h",
            remainingFraction: "0.25",
            resetTime: 1_771_736_400_000,
          },
          { bucketId: "3p-weekly", remainingFraction: 0, resetTime: null },
        ],
      },
    ],
  });
  assert.equal(quota.geminiFiveHour.remainingPercent, 42);
  assert.equal(
    quota.geminiFiveHour.resetAt,
    Date.parse("2026-06-25T16:30:00Z"),
  );
  assert.equal(quota.geminiWeekly.remainingPercent, 80);
  assert.equal(quota.geminiWeekly.resetAt, 1_771_718_400_000);
  assert.equal(quota.thirdPartyFiveHour.remainingPercent, 25);
  assert.equal(quota.thirdPartyFiveHour.resetAt, 1_771_736_400_000);
  assert.equal(quota.thirdPartyWeekly.remainingPercent, 0);
  assert.equal(quota.thirdPartyWeekly.resetAt, null);
});

/** Canonical case: builds_antigravity_load_code_assist_payload_with_antigravity_metadata */
test("builds antigravity load code assist payload with antigravity metadata", () => {
  const payload = buildAntigravityLoadCodeAssistPayload();
  const metadata = payload.metadata as Record<string, unknown>;
  assert.equal(payload.mode, "FULL_ELIGIBILITY_CHECK");
  assert.equal(metadata.ideName, "antigravity");
  assert.equal(metadata.ideType, "ANTIGRAVITY");
  assert.equal(metadata.ideVersion, "1.20.5");
  assert.equal(metadata.pluginVersion, "quota");
  assert.equal(metadata.updateChannel, "stable");
  assert.equal(metadata.pluginType, "GEMINI");
  assert.equal(typeof metadata.platform, "string");
});

/** Canonical case: parses_antigravity_ai_credits_from_paid_tier */
test("parses antigravity ai credits from paid tier", () => {
  const status = parseAntigravityLoadStatus({
    cloudaicompanionProject: "project-123",
    paidTier: {
      id: "g1-pro-tier",
      name: "Pro",
      availableCredits: [
        {
          creditType: "GOOGLE_ONE_AI",
          creditAmount: "25,000",
          minimumCreditAmountForUsage: "50",
        },
        { creditType: "IGNORED_WITHOUT_AMOUNT" },
      ],
    },
  });
  assert.equal(status.projectId, "project-123");
  assert.equal(status.tierId, "g1-pro-tier");
  assert.equal(status.tierName, "Pro");
  assert.equal(status.credits.length, 1);
  const credit = status.credits[0];
  if (credit == null) assert.fail("credit missing");
  assert.equal(credit.creditType, "GOOGLE_ONE_AI");
  assert.equal(credit.creditAmount, "25,000");
  assert.equal(credit.minimumCreditAmountForUsage, "50");
});

/** Canonical case: builds_antigravity_oauth_start_with_google_scopes_and_local_callback */
test("builds antigravity oauth start with google scopes and local callback", () => {
  const start = buildAntigravityOAuthStart(
    "login_123",
    "state_123",
    1466,
    "verifier_123",
  );
  assert.equal(start.loginId, "login_123");
  assert.ok(start.callbackUrl.startsWith("http://127.0.0.1:"));
  assert.ok(start.callbackUrl.endsWith("/oauth-callback"));
  assert.ok(
    start.authUrl.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"),
  );
  assert.ok(start.authUrl.includes("response_type=code"));
  assert.ok(start.authUrl.includes("access_type=offline"));
  assert.ok(start.authUrl.includes("state=state_123"));
  const expectedChallenge = createHash("sha256")
    .update("verifier_123", "utf8")
    .digest("base64url");
  assert.ok(start.authUrl.includes(`code_challenge=${expectedChallenge}`));
  assert.ok(start.authUrl.includes("code_challenge_method=S256"));
  assert.ok(!start.authUrl.includes("verifier_123"));
  assert.ok(
    start.authUrl.includes(
      "client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    ),
  );
  assert.ok(
    start.authUrl.includes(
      "https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform",
    ),
  );
  assert.ok(
    start.authUrl.includes(
      "https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email",
    ),
  );
  assert.ok(
    start.authUrl.includes(
      "https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile",
    ),
  );
  assert.ok(
    start.authUrl.includes("https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcclog"),
  );
  assert.ok(
    start.authUrl.includes(
      "https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fexperimentsandconfigs",
    ),
  );
});

test("antigravity source login exchanges a PKCE code without a client secret", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exchangeBodies: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === GOOGLE_TOKEN_URL) {
      exchangeBodies.push(String(init?.body));
      return jsonResponse({
        access_token: "exchanged-access",
        refresh_token: "exchanged-refresh",
        id_token: jwtWith({
          email: "source-login@example.com",
          sub: "source-login-1",
        }),
        expires_in: 3600,
      });
    }
    if (url === USERINFO_URL) {
      return jsonResponse({
        email: "source-login@example.com",
        id: "source-login-1",
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const deps = makeTestRuntime(fetchImpl, {
    root,
    callbackServer: {
      async start(options) {
        return {
          host: "127.0.0.1",
          port: 1466,
          baseUrl: "http://127.0.0.1:1466",
          result: Promise.resolve({
            code: "auth_code_1",
            state: options.expectedState,
            path: "/oauth-callback",
            params: {},
          }),
          async cancel() {},
          async close() {},
        };
      },
    },
  });
  const provider = createAntigravityProvider(deps);
  const flow = await provider.beginAuth(signal());
  if (flow.mode !== "browserCallback") {
    assert.fail("expected browserCallback flow");
  }
  const authUrl = new URL(flow.authUrl);
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  const summaries = await flow.result;
  assert.equal(summaries[0]?.provider, "antigravity");

  const body = exchangeBodies[0];
  if (body == null) assert.fail("exchange body missing");
  const params = new URLSearchParams(body);
  const verifier = params.get("code_verifier") ?? "";
  const challenge = createHash("sha256")
    .update(verifier, "utf8")
    .digest("base64url");
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authUrl.searchParams.get("code_challenge"), challenge);
  assert.equal(params.get("code"), "auth_code_1");
  assert.equal(
    params.get("client_id"),
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  );
  assert.equal(
    params.get("redirect_uri"),
    "http://127.0.0.1:1466/oauth-callback",
  );
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.equal(params.has("client_secret"), false);
});

/** Canonical case: applies_antigravity_oauth_token_response_without_returning_tokens_in_summary */
test("applies antigravity oauth token response without returning tokens in summary", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = makeTestRuntime(noNetwork, { root });
  const account = await applyAntigravityTokenResponseForTest(
    deps,
    {
      access_token: "oauth-access-token",
      refresh_token: "oauth-refresh-token",
      id_token: jwtWith({
        email: "oauth-sizzle@example.com",
        sub: "google-user-oauth",
        name: "OAuth Sizzle",
      }),
      token_type: "Bearer",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      expires_in: 3600,
    },
    undefined,
  );
  assert.equal(account.email, "oauth-sizzle@example.com");
  assert.equal(account.authId, "google-user-oauth");
  assert.equal(account.name, "OAuth Sizzle");
  assert.equal(account.source, "oauth");
  assert.equal(account.expiryDate, 1_700_000_000_000 + 3_600_000);

  const summaries = await deps.store.list("antigravity");
  const summary = summaries[0];
  if (summary == null || summary.provider !== "antigravity") {
    assert.fail("summary missing");
  }
  const serialized = summaryJson(summary);
  assert.ok(!serialized.includes("oauth-access-token"));
  assert.ok(!serialized.includes("oauth-refresh-token"));
  const raw = await import("node:fs/promises").then((fs) =>
    fs.readFile(path.join(root, "providers", "antigravity.json"), "utf8"),
  );
  assert.ok(raw.includes("oauth-access-token"));
  assert.ok(raw.includes("oauth-refresh-token"));
});

/** Canonical case: parses_empty_successful_antigravity_code_assist_response_as_empty_object */
test("parses empty successful antigravity code assist response as empty object", () => {
  const parsed = parseAntigravityCodeAssistResponse(MODELS_URL, 200, "");
  assert.deepEqual(parsed, {});
});

/** Canonical case: reports_antigravity_code_assist_parse_errors_with_response_context */
test("reports antigravity code assist parse errors with response context", () => {
  assert.throws(
    () => parseAntigravityCodeAssistResponse(QUOTA_URL, 200, "not json"),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.ok(message.includes("Could not parse Antigravity quota response"));
      assert.ok(message.includes("status=200"));
      assert.ok(message.includes("body_length=8"));
      assert.ok(message.includes("not json"));
      return true;
    },
  );
});

/** Canonical case: antigravity_code_assist_headers_do_not_request_unsupported_compression */
test("antigravity code assist headers do not request unsupported compression", () => {
  const headers = buildAntigravityCodeAssistHeaders(LOAD_URL);
  assert.ok(
    headers.every(([name]) => name.toLowerCase() !== "accept-encoding"),
  );
  const names = Object.fromEntries(headers);
  assert.equal(names["x-goog-api-client"], "gl-node/22.21.1");
  assert.equal(names.Accept, "*/*");
});

/** Canonical case: records_antigravity_refresh_errors_on_the_account_summary */
test("records antigravity refresh errors on the account summary", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seeded = await applyAntigravityTokenResponseForTest(
    makeTestRuntime(noNetwork, { root }),
    {
      access_token: "oauth-access-token",
      refresh_token: "oauth-refresh-token",
      id_token: jwtWith({
        email: "error-sizzle@example.com",
        sub: "google-user-error",
        name: "Error Sizzle",
      }),
      expires_in: 3600,
    },
    undefined,
  );
  const before = seeded.lastUsed;
  const { fetch } = recorder(() =>
    jsonResponse({ message: "caller does not have permission" }, 500),
  );
  const deps = makeTestRuntime(fetch, { root, clock: fixedClock() });
  const provider = createAntigravityProvider(deps);
  const summary = asAntigravitySummary(
    await provider.refresh(seeded.id, signal()),
  );
  assert.match(
    summary.quotaQueryLastError ?? "",
    /Antigravity quota request failed: status=500/,
  );
  assert.ok(summary.quotaQueryLastErrorAt != null);
  assert.ok(summary.lastUsed >= before);
  assert.equal(summary.status, "forbidden");
  const raw = await import("node:fs/promises").then((fs) =>
    fs.readFile(path.join(root, "providers", "antigravity.json"), "utf8"),
  );
  assert.ok(raw.includes("Antigravity quota request failed"));
});

test("antigravity refresh: exact sequence, headers, bodies; never Accept-Encoding", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seeded = await applyAntigravityTokenResponseForTest(
    makeTestRuntime(noNetwork, { root }),
    {
      access_token: "live-access",
      refresh_token: "live-refresh",
      id_token: jwtWith({ email: "seq@example.com", sub: "seq-1" }),
      expires_in: 3600,
    },
    undefined,
  );
  const calls: string[] = [];
  const { requests, fetch } = recorder((request) => {
    calls.push(request.url);
    if (request.url === LOAD_URL) {
      return jsonResponse({
        cloudaicompanionProject: "project-123",
        paidTier: { id: "tier-pro", name: "Pro", availableCredits: [] },
      });
    }
    if (request.url === MODELS_URL) return jsonResponse({ models: [] });
    if (request.url === QUOTA_URL) {
      return jsonResponse({
        groups: [
          { buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.5 }] },
        ],
      });
    }
    if (request.url === USERINFO_URL) return jsonResponse({});
    throw new Error(`unexpected url ${request.url}`);
  });
  const deps = makeTestRuntime(fetch, { root, clock: fixedClock() });
  const provider = createAntigravityProvider(deps);
  const summary = asAntigravitySummary(
    await provider.refresh(seeded.id, signal()),
  );

  assert.deepEqual(calls, [LOAD_URL, USERINFO_URL, MODELS_URL, QUOTA_URL]);
  // Reference order: loadCodeAssist, userinfo (best-effort), models, quota.
  const load = requests[0];
  const models = requests[2];
  const quota = requests[3];
  if (load == null || models == null || quota == null)
    assert.fail("calls missing");
  for (const request of [load, models, quota]) {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.Authorization, "Bearer live-access");
    assert.equal(request.headers["Content-Type"], "application/json");
    assert.equal(request.headers["x-goog-api-client"], "gl-node/22.21.1");
    assert.equal(request.headers.Accept, "*/*");
    assert.ok(!("Accept-Encoding" in request.headers));
    assert.ok(
      !Object.keys(request.headers).some(
        (name) => name.toLowerCase() === "accept-encoding",
      ),
    );
  }
  const expectedOs =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : "linux";
  const expectedArch = process.arch === "arm64" ? "arm64" : "amd64";
  assert.equal(
    load.headers["User-Agent"],
    `antigravity/1.20.5 ${expectedOs}/${expectedArch} google-api-nodejs-client/10.3.0`,
  );
  assert.equal(
    models.headers["User-Agent"],
    `antigravity/1.20.5 ${expectedOs}/${expectedArch}`,
  );
  assert.equal(
    quota.headers["User-Agent"],
    `antigravity/1.20.5 ${expectedOs}/${expectedArch}`,
  );
  assert.deepEqual(
    JSON.parse(load.body),
    buildAntigravityLoadCodeAssistPayload(),
  );
  assert.deepEqual(JSON.parse(models.body), { project: "project-123" });
  assert.deepEqual(JSON.parse(quota.body), { project: "project-123" });
  assert.equal(summary.quota.geminiFiveHour.remainingPercent, 50);
  assert.equal(summary.planName, "Pro");
  assert.equal(summary.projectId, "project-123");
});

test("antigravity stale token refreshes without a client secret", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seeded = await applyAntigravityTokenResponseForTest(
    makeTestRuntime(noNetwork, { root }),
    {
      access_token: "stale-access",
      refresh_token: "stale-refresh",
      id_token: jwtWith({ email: "refresh@example.com", sub: "ref-1" }),
      expires_in: -60,
    },
    undefined,
  );
  const { requests, fetch } = recorder((request) => {
    if (request.url === GOOGLE_TOKEN_URL) {
      return jsonResponse({
        access_token: "fresh-access",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (request.url === LOAD_URL) {
      return jsonResponse({ cloudaicompanionProject: "p1" });
    }
    if (request.url === MODELS_URL) return jsonResponse({});
    if (request.url === QUOTA_URL) return jsonResponse({});
    if (request.url === USERINFO_URL) return jsonResponse({});
    throw new Error(`unexpected url ${request.url}`);
  });
  const deps = makeTestRuntime(fetch, { root, clock: fixedClock() });
  const provider = createAntigravityProvider(deps);
  const summary = asAntigravitySummary(
    await provider.refresh(seeded.id, signal()),
  );
  const tokenRequest = requests[0];
  if (tokenRequest == null) assert.fail("token request missing");
  assert.equal(tokenRequest.method, "POST");
  const params = new URLSearchParams(tokenRequest.body);
  assert.equal(
    params.get("client_id"),
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  );
  assert.equal(params.get("refresh_token"), "stale-refresh");
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.has("client_secret"), false);
  const stored = await deps.store.listStored("antigravity");
  const account = stored[0];
  if (account == null || account.provider !== "antigravity")
    assert.fail("missing");
  assert.equal(account.accessToken, "fresh-access");
  void summary;
});

test("antigravity refresh keeps the last safe quota when the quota call fails", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seeded = await applyAntigravityTokenResponseForTest(
    makeTestRuntime(noNetwork, { root }),
    {
      access_token: "live",
      id_token: jwtWith({ email: "keep@example.com", sub: "keep-1" }),
      expires_in: 3600,
    },
    undefined,
  );
  const base = makeTestRuntime(noNetwork, { root });
  await base.store.upsert("antigravity", {
    ...seeded,
    quota: {
      geminiFiveHour: { remainingPercent: 77, resetAt: 123 },
      geminiWeekly: { remainingPercent: null, resetAt: null },
      thirdPartyFiveHour: { remainingPercent: null, resetAt: null },
      thirdPartyWeekly: { remainingPercent: null, resetAt: null },
    },
  } satisfies StoredAntigravityAccount);
  const { fetch } = recorder((request) => {
    if (request.url === LOAD_URL) {
      return jsonResponse({ cloudaicompanionProject: "p1" });
    }
    if (request.url === MODELS_URL) return jsonResponse({});
    if (request.url === QUOTA_URL) {
      return jsonResponse({ reason: "caller does not have permission" }, 403);
    }
    if (request.url === USERINFO_URL) return jsonResponse({});
    throw new Error(`unexpected url ${request.url}`);
  });
  const deps = makeTestRuntime(fetch, { root, clock: fixedClock() });
  const provider = createAntigravityProvider(deps);
  const summary = asAntigravitySummary(
    await provider.refresh(seeded.id, signal()),
  );
  assert.equal(summary.status, "forbidden");
  assert.equal(summary.quota.geminiFiveHour.remainingPercent, 77);
});

test("antigravity import skips a token-less confirmed source and falls through", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-home-"));
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const gemcli = path.join(home, "gemcli");
  const gemcliCreds = path.join(gemcli, ".gemini");
  await mkdir(gemcliCreds, { recursive: true });
  await writeFile(
    path.join(gemcliCreds, "oauth_creds.json"),
    JSON.stringify({ refresh_token: "but-no-access" }),
    "utf8",
  );
  const geminiDir = path.join(home, ".gemini");
  await mkdir(geminiDir, { recursive: true });
  await writeFile(
    path.join(geminiDir, "oauth_creds.json"),
    JSON.stringify({
      access_token: "fallback-access",
      refresh_token: "fallback-refresh",
      id_token: jwtWith({ email: "fallback@example.com", sub: "g-2" }),
    }),
    "utf8",
  );
  const env = process.env;
  const previousHome = env.HOME;
  const previousGemini = env.GEMINI_CLI_HOME;
  env.HOME = home;
  env.GEMINI_CLI_HOME = gemcli;
  t.after(() => {
    if (previousHome === undefined) delete env.HOME;
    else env.HOME = previousHome;
    if (previousGemini === undefined) delete env.GEMINI_CLI_HOME;
    else env.GEMINI_CLI_HOME = previousGemini;
  });

  const deps = makeTestRuntime(noNetwork, { root });
  const provider = createAntigravityProvider(deps);
  const candidates = await provider.discoverImports(signal());
  assert.equal(
    candidates[0]?.path,
    path.join(gemcliCreds, "oauth_creds.json"),
    "GEMINI_CLI_HOME leads",
  );
  const summaries = await provider.import(candidates[0] as never, signal());
  const summary = asAntigravitySummary(summaries[0]);
  assert.equal(summary.email, "fallback@example.com");
  assert.equal(
    (await deps.store.listStored("antigravity")).length,
    1,
    "exactly one account persisted",
  );
});

test("antigravity import aggregates typed failures across every tried path", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-home-"));
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const gemcli = path.join(home, "gemcli");
  const gemcliCreds = path.join(gemcli, ".gemini");
  await mkdir(gemcliCreds, { recursive: true });
  await writeFile(path.join(gemcliCreds, "oauth_creds.json"), "{ nope", "utf8");
  const geminiDir = path.join(home, ".gemini");
  await mkdir(geminiDir, { recursive: true });
  await writeFile(
    path.join(geminiDir, "oauth_creds.json"),
    JSON.stringify({ refresh_token: "only" }),
    "utf8",
  );
  const env = process.env;
  const previousHome = env.HOME;
  const previousGemini = env.GEMINI_CLI_HOME;
  env.HOME = home;
  env.GEMINI_CLI_HOME = gemcli;
  t.after(() => {
    if (previousHome === undefined) delete env.HOME;
    else env.HOME = previousHome;
    if (previousGemini === undefined) delete env.GEMINI_CLI_HOME;
    else env.GEMINI_CLI_HOME = previousGemini;
  });

  const deps = makeTestRuntime(noNetwork, { root });
  const provider = createAntigravityProvider(deps);
  const candidates = await provider.discoverImports(signal());
  await assert.rejects(
    provider.import(candidates[0] as never, signal()),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CorruptCredential");
      const message = (error as Error).message;
      assert.ok(message.includes(path.join(gemcliCreds, "oauth_creds.json")));
      assert.ok(message.includes(path.join(geminiDir, "oauth_creds.json")));
      return true;
    },
  );
});
