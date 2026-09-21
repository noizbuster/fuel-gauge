import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type {
  AccountSummary,
  AntigravityAccountSummary,
  StoredAntigravityAccount,
} from "../../src/core/types.js";
import type { SubprocessPort } from "../../src/core/subprocess.js";
import {
  applyAntigravityTokenResponseForTest,
  buildAntigravityCodeAssistHeaders,
  buildAntigravityLoadCodeAssistPayload,
  buildAntigravityOAuthStart,
  createAntigravityProvider,
  extractAgyClientSecrets,
  parseAntigravityCodeAssistResponse,
  parseAntigravityLoadStatus,
  parseAntigravityCliLogin,
  parseAntigravityQuota,
  parseAntigravityUsageOutput,
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
const FAKE_AGY_SECRET = "GOCSPX-testcandidate0000000000000000";

/**
 * Puts a fake executable `agy` (containing `secrets`, concatenated the
 * way the real binary embeds them) first on PATH for one test.
 */
async function fakeAgyOnPath(
  t: TestContext,
  secrets: readonly string[] = [FAKE_AGY_SECRET],
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-path-"));
  const binary = path.join(dir, "agy");
  await writeFile(binary, secrets.join(""));
  await chmod(binary, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`;
  t.after(async () => {
    process.env.PATH = previous;
    await rm(dir, { recursive: true, force: true });
  });
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

test("antigravity source login exchanges a PKCE code with the public client secret", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fakeAgyOnPath(t);
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
  assert.match(params.get("client_secret") ?? "", /^GOCSPX-/);
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

test("antigravity stale token refreshes with the public client secret", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fakeAgyOnPath(t);
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
  assert.match(params.get("client_secret") ?? "", /^GOCSPX-/);
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

type AgyCall = { stdout: string; stderr?: string } | Error;

function agySubprocess(
  models: AgyCall,
  usage: AgyCall = { stdout: "" },
): SubprocessPort {
  return {
    async run(command, args) {
      if (command !== "agy") {
        throw new Error(`unexpected subprocess call: ${command}`);
      }
      const behavior = args[0] === "-p" && args[1] === "/usage" ? usage : models;
      if (args[0] === "models" || (args[0] === "-p" && args[1] === "/usage")) {
        if (behavior instanceof Error) throw behavior;
        return { stdout: behavior.stdout, stderr: behavior.stderr ?? "" };
      }
      throw new Error(`unexpected subprocess call: ${command} ${args.join(" ")}`);
    },
  };
}

const AGY_MODELS_OK = {
  stdout: "Fetching available models...\ngemini-3-pro-high\tGemini 3 Pro (High)\n",
};

const AGY_LOG_LINE = (email: string) =>
  `I0920 19:40:15.752967     322 server_oauth.go:192] applyAuthResult: email=${email}, authMethod=consumer, quotaProject=\n`;

test("antigravity discovers and imports the agy CLI login", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-home-"));
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const logDir = path.join(home, ".gemini", "antigravity-cli", "log");
  await mkdir(logDir, { recursive: true });
  await writeFile(
    path.join(logDir, "cli-20260920_194015.log"),
    AGY_LOG_LINE("cliuser@example.com"),
    "utf8",
  );
  const env = process.env;
  const previousHome = env.HOME;
  env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete env.HOME;
    else env.HOME = previousHome;
  });

  const deps = makeTestRuntime(noNetwork, {
    root,
    subprocess: agySubprocess(AGY_MODELS_OK),
  });
  const provider = createAntigravityProvider(deps);
  const candidates = await provider.discoverImports(signal());
  const cli = candidates.find((entry) => entry.source === "subprocess");
  if (cli == null) assert.fail("agy CLI candidate missing");
  assert.equal(cli.path, null);
  assert.equal(cli.label, "Antigravity CLI login (agy models)");

  const summaries = await provider.import(cli, signal());
  const summary = asAntigravitySummary(summaries[0]);
  assert.equal(summary.email, "cliuser@example.com");
  assert.equal(summary.source, "cli");
  assert.equal(summary.selectedAuthType, "consumer");

  const stored = await deps.store.listStored("antigravity");
  const account = stored[0];
  if (account == null || account.provider !== "antigravity") {
    assert.fail("stored agy CLI account missing");
  }
  assert.equal(account.accessToken, "");
  assert.equal(account.refreshToken, null);
  assert.equal(account.idToken, null);
  assert.equal(account.quota.geminiFiveHour.remainingPercent, null);
  const serialized = summaryJson(summary);
  assert.ok(!serialized.includes("ya29."));
  assert.ok(!serialized.includes("GOCSPX"));
});

test("antigravity hides the agy CLI candidate when the CLI cannot list models", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-home-"));
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const env = process.env;
  const previousHome = env.HOME;
  env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete env.HOME;
    else env.HOME = previousHome;
  });

  const deps = makeTestRuntime(noNetwork, {
    root,
    subprocess: agySubprocess(new Error("spawn agy ENOENT")),
  });
  const provider = createAntigravityProvider(deps);
  const candidates = await provider.discoverImports(signal());
  assert.equal(
    candidates.some((entry) => entry.source === "subprocess"),
    false,
  );

  const notLoggedIn = createAntigravityProvider(
    makeTestRuntime(noNetwork, {
      root,
      subprocess: agySubprocess({
        stdout: "Fetching available models...\n",
        stderr: "You are not logged into Antigravity.",
      }),
    }),
  );
  await assert.rejects(
    notLoggedIn.import(
      {
        provider: "antigravity",
        source: "subprocess",
        label: "Antigravity CLI login (agy models)",
        path: null,
      },
      signal(),
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "NoCredentialFound");
      assert.match((error as Error).message, /not logged in/);
      return true;
    },
  );
});

const AGY_USAGE_OK = {
  stdout: [
    "Gemini Models\tWeekly Limit Remaining\t98.98%\t2026-09-27T11:26:52Z",
    "Gemini Models\tFive Hour Limit Remaining\t96.78%\t2026-09-21T18:33:37Z",
    "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-28T13:43:50Z",
    "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-21T18:43:50Z",
  ].join("\n"),
};

test("antigravity manual refresh fetches quota through agy /usage", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-home-"));
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const logDir = path.join(home, ".gemini", "antigravity-cli", "log");
  await mkdir(logDir, { recursive: true });
  await writeFile(
    path.join(logDir, "cli-20260920_194015.log"),
    AGY_LOG_LINE("first@example.com"),
    "utf8",
  );
  const env = process.env;
  const previousHome = env.HOME;
  env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete env.HOME;
    else env.HOME = previousHome;
  });

  let usageCalls = 0;
  let usageFails = false;
  const subprocess: SubprocessPort = {
    async run(command, args) {
      if (command === "agy" && args[0] === "models") {
        return { stdout: AGY_MODELS_OK.stdout, stderr: "" };
      }
      if (command === "agy" && args[0] === "-p" && args[1] === "/usage") {
        usageCalls += 1;
        if (usageFails) {
          return {
            stdout: "",
            stderr: "You are not logged into Antigravity.",
          };
        }
        return { stdout: AGY_USAGE_OK.stdout, stderr: "" };
      }
      throw new Error(`unexpected subprocess call: ${command}`);
    },
  };
  const deps = makeTestRuntime(noNetwork, { root, subprocess });
  const provider = createAntigravityProvider(deps);

  // Import seeds presence only; quota arrives via manual refresh.
  const candidates = await provider.discoverImports(signal());
  const cli = candidates.find((entry) => entry.source === "subprocess");
  if (cli == null) assert.fail("agy CLI candidate missing");
  const imported = asAntigravitySummary((await provider.import(cli, signal()))[0]);
  assert.equal(imported.email, "first@example.com");
  assert.ok(
    imported.metrics.every((metric) => metric.remainingPercent === null),
  );
  assert.equal(usageCalls, 0);

  // Automatic passes must not touch the CLI account.
  await provider.refreshAll(signal());
  assert.equal(usageCalls, 0);

  // Manual refresh parses the /usage panel into quota windows.
  await provider.refreshAll(signal(), { manual: true });
  assert.equal(usageCalls, 1);
  const manual = asAntigravitySummary(
    (await deps.store.list("antigravity"))[0],
  );
  assert.equal(manual.email, "first@example.com");
  const byLabel = new Map(manual.metrics.map((m) => [m.label, m]));
  assert.equal(byLabel.get("Gemini 5-hour")?.remainingPercent, 96.78);
  assert.equal(byLabel.get("Gemini weekly")?.remainingPercent, 98.98);
  assert.equal(
    byLabel.get("Gemini 5-hour")?.resetAt,
    Date.parse("2026-09-21T18:33:37Z"),
  );
  assert.notEqual(manual.usageUpdatedAt, null);

  // A newer login in the logs is picked up on the next manual refresh.
  await writeFile(
    path.join(logDir, "cli-20260920_210000.log"),
    AGY_LOG_LINE("second@example.com"),
    "utf8",
  );
  usageFails = true;
  const failed = asAntigravitySummary(
    (await provider.refreshAll(signal(), { manual: true }))[0],
  );
  assert.equal(usageCalls, 2);
  assert.match(failed.quotaQueryLastError ?? "", /not logged in/);
});

test("antigravity parses the last applyAuthResult from agy log text", () => {
  assert.equal(parseAntigravityCliLogin("no auth here"), null);
  const single = parseAntigravityCliLogin(AGY_LOG_LINE("a@example.com"));
  assert.deepEqual(single, { email: "a@example.com", authMethod: "consumer" });
  const relogin = parseAntigravityCliLogin(
    `${AGY_LOG_LINE("a@example.com")}${AGY_LOG_LINE("b@example.com")}`,
  );
  assert.deepEqual(relogin, { email: "b@example.com", authMethod: "consumer" });
});
test("antigravity parses the agy /usage TSV panel", () => {
  const quota = parseAntigravityUsageOutput(
    [
      "Gemini Models\tWeekly Limit Remaining\t98.98%\t2026-09-27T11:26:52Z",
      "Gemini Models\tFive Hour Limit Remaining\t96.78%\t2026-09-21T18:33:37Z",
      "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-28T13:43:50Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-21T18:43:50Z",
      "Fetching available models...",
      "surprise row\twithout\tpercent",
    ].join("\n"),
  );
  assert.equal(quota.geminiWeekly.remainingPercent, 98.98);
  assert.equal(quota.geminiWeekly.resetAt, Date.parse("2026-09-27T11:26:52Z"));
  assert.equal(quota.geminiFiveHour.remainingPercent, 96.78);
  assert.equal(quota.thirdPartyWeekly.remainingPercent, 100);
  assert.equal(quota.thirdPartyFiveHour.remainingPercent, 100);

  const empty = parseAntigravityUsageOutput("Fetching...\n");
  assert.equal(empty.geminiWeekly.remainingPercent, null);
  assert.equal(empty.thirdPartyFiveHour.resetAt, null);
});

test("agy client secret extraction splits concatenated tokens", () => {
  const blob =
    "noiseGOCSPX-firstcandidate0000000000000000GOCSPX-secondcandidate000000000000000tail";
  assert.deepEqual(extractAgyClientSecrets(blob), [
    "GOCSPX-firstcandidate0000000000000000",
    "GOCSPX-secondcandidate000000000000000tail",
  ]);
  // Duplicates collapse and short bodies are binary noise, not tokens.
  assert.deepEqual(
    extractAgyClientSecrets(
      "GOCSPX-duplicate0000000000000000GOCSPX-duplicate0000000000000000",
    ),
    ["GOCSPX-duplicate0000000000000000"],
  );
  assert.deepEqual(extractAgyClientSecrets("GOCSPX-abc"), []);
  assert.deepEqual(extractAgyClientSecrets("GOCSPX-"), []);
});

test("token exchange rotates agy client secrets on invalid_client", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fakeAgyOnPath(t, [
    "GOCSPX-wrongcandidate0000000000000000",
    "GOCSPX-rightcandidate0000000000000000",
  ]);
  const tokenRequests: string[] = [];
  const deps = makeTestRuntime(
    async (input, init) => {
      if (String(input) === GOOGLE_TOKEN_URL) {
        tokenRequests.push(String(init?.body ?? ""));
        if (tokenRequests.length === 1) {
          return jsonResponse({ error: "invalid_client" }, 401);
        }
        return jsonResponse({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          id_token: jwtWith({ email: "rotate@example.com", sub: "rot-1" }),
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      throw new Error(`unexpected url ${String(input)}`);
    },
    {
      root,
      callbackServer: {
        async start(options) {
          return {
            host: "127.0.0.1",
            port: 1466,
            baseUrl: "http://127.0.0.1:1466",
            callbackUrl: "http://127.0.0.1:1466/oauth-callback",
            expectedState: "state-1",
            result: Promise.resolve({
              code: "auth_code_2",
              state: options.expectedState,
              path: "/oauth-callback",
              params: {},
            }),
            async cancel() {},
            async close() {},
          };
        },
      },
    },
  );
  const provider = createAntigravityProvider(deps);
  const flow = await provider.beginAuth(signal());
  if (flow.mode !== "browserCallback") {
    assert.fail("expected browserCallback flow");
  }
  const summaries = await flow.result;
  assert.equal(summaries[0]?.provider, "antigravity");

  assert.equal(tokenRequests.length, 2);
  assert.equal(
    new URLSearchParams(tokenRequests[0]).get("client_secret"),
    "GOCSPX-wrongcandidate0000000000000000",
  );
  assert.equal(
    new URLSearchParams(tokenRequests[1]).get("client_secret"),
    "GOCSPX-rightcandidate0000000000000000",
  );
});

test("oauth login fails with a clear error when agy is not installed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // PATH without any agy binary anywhere.
  const emptyDir = await mkdtemp(path.join(tmpdir(), "fuel-gauge-empty-"));
  t.after(() => rm(emptyDir, { recursive: true, force: true }));
  const previous = process.env.PATH;
  process.env.PATH = emptyDir;
  t.after(() => {
    process.env.PATH = previous;
  });
  const deps = makeTestRuntime(noNetwork, {
    root,
    callbackServer: {
      async start(options) {
        return {
          host: "127.0.0.1",
          port: 1466,
          baseUrl: "http://127.0.0.1:1466",
          callbackUrl: "http://127.0.0.1:1466/oauth-callback",
          expectedState: options.expectedState,
          result: Promise.resolve({
            code: "auth_code_3",
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
  await assert.rejects(
    () => flow.result,
    /Antigravity OAuth token request failed: .*agy CLI/,
  );
});
