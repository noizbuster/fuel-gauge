import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCredentialStore } from "../../src/core/store.js";
import type { SubprocessPort } from "../../src/core/subprocess.js";
import type {
  AccountSummary,
  GitHubCopilotAccountSummary,
  StoredGitHubCopilotAccount,
} from "../../src/core/types.js";
import { createGitHubCopilotProvider } from "../../src/providers/github-copilot.js";
import {
  countingClock,
  fixedClock,
  headerOf,
  jsonResponse,
  makeTestRuntime,
  noNetwork,
  signal,
  summaryJson,
} from "./runtime.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const DEVICE_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
const CLIENT_ID = "01ab8ac9400c4e429b23";
const SCOPE_FORM = "read%3Auser+user%3Aemail+repo+workflow";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Scripted fetch that records every request for exactness assertions. */
class FetchRecorder {
  readonly requests: RecordedRequest[] = [];
  readonly #script: (
    request: RecordedRequest,
    attempt: number,
  ) => Response | Promise<Response>;

  constructor(
    script: (
      request: RecordedRequest,
      attempt: number,
    ) => Response | Promise<Response>,
  ) {
    this.#script = script;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : "",
    };
    this.requests.push(request);
    return this.#script(request, this.requests.length);
  };
}

/** gh CLI double that records the sanitized-environment options. */
function ghPort(
  optionsLog: {
    envRemove: readonly string[] | undefined;
  }[],
): SubprocessPort {
  return {
    async run(command, args, runOptions) {
      optionsLog.push({ envRemove: runOptions?.envRemove });
      if (command === "gh" && args[0] === "--version") {
        return { stdout: "gh version 2.40.0\n", stderr: "" };
      }
      if (command === "gh" && args[0] === "auth" && args[1] === "token") {
        return { stdout: "gh-cli-token\n", stderr: "" };
      }
      throw new Error(`unexpected gh invocation: ${command} ${args.join(" ")}`);
    },
  };
}

function asCopilotSummary(
  value: AccountSummary | undefined,
): GitHubCopilotAccountSummary {
  if (value == null || value.provider !== "githubCopilot") {
    throw new Error("expected githubCopilot summary");
  }
  return value;
}

test("copilot device flow: exact endpoints, headers, form bodies, and poll branches", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ghcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sleepLog: number[] = [];
  const recorder = new FetchRecorder((request, attempt) => {
    if (request.url === DEVICE_CODE_URL) {
      return jsonResponse({
        device_code: "DC1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        verification_uri_complete:
          "https://github.com/login/device?user_code=ABCD-1234",
        expires_in: 900,
        interval: 2,
      });
    }
    if (request.url === DEVICE_TOKEN_URL) {
      if (attempt === 2)
        return jsonResponse({ error: "authorization_pending" });
      if (attempt === 3) return jsonResponse({ error: "slow_down" });
      return jsonResponse({
        access_token: "gho-github-oauth",
        token_type: "bearer",
        scope: "read:user user:email repo workflow",
      });
    }
    if (request.url === USER_URL) {
      return jsonResponse({ login: "sizzlebop", id: 4242, name: "Sizzle" });
    }
    if (request.url === EMAILS_URL) {
      return jsonResponse([
        { email: "secondary@example.com", primary: false, verified: true },
        { email: "primary@example.com", primary: true, verified: true },
      ]);
    }
    if (request.url === COPILOT_TOKEN_URL) {
      return jsonResponse({
        token: "copilot-session-token;rd=1771736400:0",
        sku: "free",
        chat_enabled: true,
      });
    }
    if (request.url === COPILOT_USER_URL) {
      return jsonResponse({
        copilot_plan: "pro",
        quota_snapshots: {
          chat: { entitlement: 200, remaining: 50, percent_remaining: 25 },
        },
      });
    }
    throw new Error(`unexpected url ${request.url}`);
  });
  const deps = makeTestRuntime(recorder.fetch, {
    root,
    clock: countingClock(sleepLog),
  });
  const provider = createGitHubCopilotProvider(deps);
  const flow = await provider.beginAuth(signal());
  if (flow.mode !== "deviceCode") assert.fail("expected deviceCode flow");
  assert.equal(flow.userCode, "ABCD-1234");
  assert.equal(flow.verificationUri, "https://github.com/login/device");
  assert.equal(
    flow.verificationUriComplete,
    "https://github.com/login/device?user_code=ABCD-1234",
  );
  assert.equal(flow.intervalSeconds, 2);
  assert.equal(flow.expiresAt, 1_700_000_000_000 + 900_000);

  const summaries = await flow.result;
  const summary = asCopilotSummary(summaries[0]);

  const deviceCodeRequest = recorder.requests.find(
    (entry) => entry.url === DEVICE_CODE_URL,
  );
  if (deviceCodeRequest == null) assert.fail("device code request missing");
  assert.equal(deviceCodeRequest.method, "POST");
  assert.equal(
    headerOf({ headers: deviceCodeRequest.headers }, "User-Agent"),
    "quota",
  );
  assert.equal(
    (deviceCodeRequest.headers.Accept as string) ?? "",
    "application/json",
  );
  assert.equal(
    deviceCodeRequest.body,
    `client_id=${CLIENT_ID}&scope=${SCOPE_FORM}`,
  );

  const tokenRequests = recorder.requests.filter(
    (entry) => entry.url === DEVICE_TOKEN_URL,
  );
  assert.equal(tokenRequests.length, 3);
  for (const request of tokenRequests) {
    assert.equal(request.method, "POST");
    assert.equal(request.body.startsWith(`client_id=${CLIENT_ID}&`), true);
  }
  assert.equal(
    tokenRequests[0]?.body,
    `client_id=${CLIENT_ID}&device_code=DC1&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code`,
  );

  const userRequest = recorder.requests.find((entry) => entry.url === USER_URL);
  if (userRequest == null) assert.fail("user request missing");
  assert.equal(userRequest.headers.Authorization, "Bearer gho-github-oauth");
  assert.equal(userRequest.headers.Accept, "application/vnd.github+json");

  const copilotRequest = recorder.requests.find(
    (entry) => entry.url === COPILOT_TOKEN_URL,
  );
  if (copilotRequest == null) assert.fail("copilot token request missing");
  assert.equal(copilotRequest.headers.Authorization, "token gho-github-oauth");
  assert.equal(copilotRequest.headers["X-GitHub-Api-Version"], "2025-04-01");

  // Pending polls sleep interval*5 ticks; slow_down sleeps (interval+5)*5.
  assert.equal(sleepLog.filter((ms) => ms === 200).length, 10 + 35);
  assert.equal(summary.githubLogin, "sizzlebop");
  assert.equal(summary.githubEmail, "primary@example.com");
  assert.equal(summary.plan, "pro");
  assert.equal(summary.chatEnabled, true);
  assert.equal(summary.usage.chatMessagesUsedPercent, 75);
  assert.equal(summary.usage.remainingChat, 50);
  assert.equal(summary.usage.totalChat, 200);
  // No limited_user_reset_date or quota_reset_date: the token `rd=` wins.
  assert.equal(summary.usage.allowanceResetAt, 1_771_736_400_000);

  const stored = await deps.store.listStored("githubCopilot");
  const account = stored[0];
  if (account == null || account.provider !== "githubCopilot") {
    assert.fail("account not stored");
  }
  assert.equal(account.githubAccessToken, "gho-github-oauth");
  assert.equal(account.copilotToken, "copilot-session-token;rd=1771736400:0");
  assert.ok(!summaryJson(summary).includes("gho-github-oauth"));
  assert.ok(!summaryJson(summary).includes("copilot-session-token"));
});

test("copilot device flow: expired, denied, and unknown error branches", async (_t) => {
  const cases: Array<{
    error: string;
    description?: string;
    message: string;
  }> = [
    {
      error: "expired_token",
      message: "GitHub authorization expired. Start again.",
    },
    { error: "access_denied", message: "GitHub authorization was denied." },
    {
      error: "unsupported_grant_type",
      description: "grant type is not supported",
      message: "grant type is not supported",
    },
    {
      error: "server_error",
      message: "GitHub authorization failed: server_error",
    },
  ];
  for (const testCase of cases) {
    const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ghcp-"));
    await rm(root, { recursive: true, force: true }).catch(() => {});
    const recorder = new FetchRecorder((request) => {
      if (request.url === DEVICE_CODE_URL) {
        return jsonResponse({
          device_code: "DC1",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 1,
        });
      }
      if (request.url === DEVICE_TOKEN_URL) {
        return jsonResponse({
          error: testCase.error,
          ...(testCase.description != null
            ? { error_description: testCase.description }
            : {}),
        });
      }
      throw new Error(`unexpected url ${request.url}`);
    });
    const deps = makeTestRuntime(recorder.fetch, {
      root,
      clock: countingClock([]),
    });
    const provider = createGitHubCopilotProvider(deps);
    const flow = await provider.beginAuth(signal());
    await assert.rejects(flow.result, (error: unknown) => {
      assert.equal((error as Error).message, testCase.message);
      return true;
    });
  }
});

test("copilot device flow cancel is idempotent and settles the result", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ghcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = new FetchRecorder((request) => {
    if (request.url === DEVICE_CODE_URL) {
      return jsonResponse({
        device_code: "DC1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1,
      });
    }
    return jsonResponse({ error: "authorization_pending" });
  });
  const deps = makeTestRuntime(recorder.fetch, {
    root,
    clock: countingClock([]),
  });
  const provider = createGitHubCopilotProvider(deps);
  const flow = await provider.beginAuth(signal());
  await flow.cancel();
  await flow.cancel();
  await assert.rejects(flow.result, /Login flow was cancelled/);
});

test("copilot precedence: rejected env token falls through to sanitized gh", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ghcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ghOptions: { envRemove: readonly string[] | undefined }[] = [];
  const userTokens: string[] = [];
  const recorder = new FetchRecorder((request) => {
    if (request.url === USER_URL) {
      const auth = request.headers.Authorization ?? "";
      const token = auth.replace("Bearer ", "");
      userTokens.push(token);
      if (token === "bad-env-token") {
        return jsonResponse({ message: "Bad credentials" }, 401);
      }
      return jsonResponse({ login: "ghuser", id: 99, name: "GH User" });
    }
    if (request.url === EMAILS_URL) {
      return jsonResponse([
        { email: "gh@example.com", primary: true, verified: true },
      ]);
    }
    if (request.url === COPILOT_TOKEN_URL) {
      return jsonResponse({ token: "gh-copilot-token", sku: "pro" });
    }
    if (request.url === COPILOT_USER_URL) return jsonResponse({});
    throw new Error(`unexpected url ${request.url}`);
  });
  const deps = makeTestRuntime(recorder.fetch, {
    root,
    subprocess: ghPort(ghOptions),
  });
  const env = process.env;
  const previous = env.COPILOT_GITHUB_TOKEN;
  env.COPILOT_GITHUB_TOKEN = "bad-env-token";
  t.after(() => {
    if (previous === undefined) delete env.COPILOT_GITHUB_TOKEN;
    else env.COPILOT_GITHUB_TOKEN = previous;
  });

  const provider = createGitHubCopilotProvider(deps);
  const candidates = await provider.discoverImports(signal());
  const envCandidate = candidates.find((entry) => entry.source === "env");
  const ghCandidate = candidates.find((entry) => entry.source === "subprocess");
  if (envCandidate == null || ghCandidate == null)
    assert.fail("candidates missing");

  // Importing the confirmed env candidate still walks the full precedence.
  const summaries = await provider.import(envCandidate, signal());
  const summary = asCopilotSummary(summaries[0]);
  assert.equal(summary.githubLogin, "ghuser");
  assert.deepEqual(userTokens, ["bad-env-token", "gh-cli-token"]);

  const stored = await deps.store.listStored("githubCopilot");
  const account = stored[0];
  if (account == null || account.provider !== "githubCopilot") {
    assert.fail("account not stored");
  }
  assert.equal(account.githubAccessToken, "gh-cli-token");

  // Every gh invocation (availability probes and the token read) is sanitized.
  assert.ok(ghOptions.length >= 2);
  for (const options of ghOptions) {
    assert.deepEqual(options.envRemove, [
      "COPILOT_GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
    ]);
  }
});

test("copilot quota_reset_date date-only fallback lands at UTC midnight", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ghcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = makeTestRuntime(noNetwork, { root });
  const account: StoredGitHubCopilotAccount = {
    provider: "githubCopilot",
    id: "ghcp_seed",
    githubLogin: "resetuser",
    githubId: 1,
    githubName: null,
    githubEmail: null,
    githubAccessToken: "gh-token",
    githubTokenType: null,
    githubScope: null,
    copilotToken: "no-rd-here",
    copilotPlan: null,
    copilotChatEnabled: null,
    copilotExpiresAt: null,
    copilotRefreshIn: null,
    copilotQuotaSnapshots: null,
    copilotQuotaResetDate: "2026-06-25",
    copilotLimitedUserQuotas: null,
    copilotLimitedUserResetAt: null,
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: null,
    createdAt: 1,
    lastUsed: 1,
  };
  await deps.store.upsert("githubCopilot", account);
  const [summary] = await deps.store.list("githubCopilot");
  if (summary == null || summary.provider !== "githubCopilot") {
    assert.fail("summary missing");
  }
  assert.equal(
    summary.usage.allowanceResetAt,
    Date.parse("2026-06-25T00:00:00Z"),
  );
});

test("copilot import from hosts.json keeps the source file on remove", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ghcp-home-"));
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ghcp-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const hostsDir = path.join(home, ".config", "github-copilot");
  await mkdir(hostsDir, { recursive: true });
  const hostsPath = path.join(hostsDir, "hosts.json");
  await writeFile(
    hostsPath,
    JSON.stringify({ "github.com": { oauth_token: "hosts-file-token" } }),
    "utf8",
  );
  const recorder = new FetchRecorder((request) => {
    if (request.url === USER_URL) {
      return jsonResponse({ login: "hostsuser", id: 5 });
    }
    if (request.url === EMAILS_URL) return jsonResponse([]);
    if (request.url === COPILOT_TOKEN_URL) {
      return jsonResponse({ token: "hosts-copilot-token" });
    }
    if (request.url === COPILOT_USER_URL) return jsonResponse({});
    throw new Error(`unexpected url ${request.url}`);
  });
  const env = process.env;
  const previousHome = env.HOME;
  env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete env.HOME;
    else env.HOME = previousHome;
  });
  const deps = makeTestRuntime(recorder.fetch, { root, clock: fixedClock() });
  const provider = createGitHubCopilotProvider(deps);
  const candidates = await provider.discoverImports(signal());
  const hostsCandidate = candidates.find((entry) => entry.path === hostsPath);
  if (hostsCandidate == null) assert.fail("hosts.json candidate missing");
  const summaries = await provider.import(hostsCandidate, signal());
  if (summaries[0]?.provider !== "githubCopilot") assert.fail("import failed");

  await provider.remove(summaries[0].id);
  await provider.remove(summaries[0].id);
  assert.deepEqual(await provider.list(), []);
  // Storage-only removal: the source credential file is untouched.
  const stillThere = await import("node:fs/promises").then((fs) =>
    fs.access(hostsPath).then(
      () => true,
      () => false,
    ),
  );
  assert.equal(stillThere, true);
});

async function seedCopilotAccount(root: string, id: string): Promise<void> {
  await createCredentialStore(root).upsert("githubCopilot", {
    provider: "githubCopilot",
    id,
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: 1_000,
    createdAt: 1,
    lastUsed: 1,
    githubLogin: "refreshee",
    githubId: 77,
    githubName: null,
    githubEmail: null,
    githubAccessToken: `gh-stored-${id}`,
    githubTokenType: "bearer",
    githubScope: null,
    copilotToken: "tid=old-session;",
    copilotPlan: "pro",
    copilotChatEnabled: true,
    copilotExpiresAt: null,
    copilotRefreshIn: null,
    copilotQuotaSnapshots: {
      completions: { entitlement: 200, percent_remaining: 40 },
    },
    copilotQuotaResetDate: null,
    copilotLimitedUserQuotas: null,
    copilotLimitedUserResetAt: null,
  });
}

test("copilot refresh records a redacted reauth error and keeps the last safe quota", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ghcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = new FetchRecorder((request) => {
    if (request.url === COPILOT_TOKEN_URL) {
      // 403 with a secret-shaped body: the rejection must classify as
      // reauthentication and the body must never reach the stored error.
      return jsonResponse(
        { message: "denied for gho_secrettoken1234567890" },
        403,
      );
    }
    throw new Error(`unexpected url ${request.url}`);
  });
  await seedCopilotAccount(root, "copilot-refresh-1");
  const deps = makeTestRuntime(recorder.fetch, { root, clock: fixedClock() });
  const provider = createGitHubCopilotProvider(deps);

  const summaries = await provider.refresh("copilot-refresh-1", signal());
  const summary = asCopilotSummary(summaries);
  assert.equal(summary.status, "requiresReauthentication");
  assert.equal(
    summary.quotaQueryLastError,
    "GitHub token was rejected. Reconnect the GitHub Copilot account.",
  );
  assert.ok(summary.quotaQueryLastErrorAt !== null);
  assert.ok(
    !JSON.stringify(summary).includes("gho_secrettoken"),
    "no token material in the summary",
  );
  // Last safe quota retained: the seeded completion snapshot still renders.
  assert.equal(summary.usage.inlineSuggestionsUsedPercent, 60);

  const stored = await deps.store.listStored("githubCopilot");
  const account = stored[0] as StoredGitHubCopilotAccount;
  assert.equal(
    account.githubAccessToken,
    "gh-stored-copilot-refresh-1",
    "token not rotated",
  );
  assert.equal(account.copilotToken, "tid=old-session;", "session not rotated");
  assert.equal(account.usageUpdatedAt, 1_000, "usage timestamp retained");
});

test("copilot refresh records a temporary redacted error without reauth", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ghcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = new FetchRecorder(() => {
    throw new TypeError("network down: bearer eyJfailed.REQUEST.payload");
  });
  await seedCopilotAccount(root, "copilot-refresh-1");
  const deps = makeTestRuntime(recorder.fetch, { root, clock: fixedClock() });
  const provider = createGitHubCopilotProvider(deps);

  const summaries = await provider.refresh("copilot-refresh-1", signal());
  const summary = asCopilotSummary(summaries);
  assert.equal(summary.status, "active", "temporary failure keeps status");
  assert.ok(summary.quotaQueryLastError?.includes("[REDACTED]"), "redacted");
  assert.ok(!summary.quotaQueryLastError?.includes("eyJfailed"));
  assert.equal(summary.usage.inlineSuggestionsUsedPercent, 60);
});

test("copilot refreshAll stays sequential and persists per-account failures", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-ghcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen: string[] = [];
  const recorder = new FetchRecorder((request) => {
    seen.push(request.url);
    if (request.url === COPILOT_TOKEN_URL) {
      return seen.filter((url) => url === COPILOT_TOKEN_URL).length === 1
        ? jsonResponse({ token: "fresh-session-token" })
        : jsonResponse({ message: "denied" }, 403);
    }
    if (request.url === COPILOT_USER_URL) return jsonResponse({});
    throw new Error(`unexpected url ${request.url}`);
  });
  await seedCopilotAccount(root, "copilot-refresh-1");
  await seedCopilotAccount(root, "copilot-refresh-2");
  const deps = makeTestRuntime(recorder.fetch, { root, clock: fixedClock() });
  const provider = createGitHubCopilotProvider(deps);

  const summaries = await provider.refreshAll(signal());
  assert.equal(summaries.length, 2, "both accounts listed");
  // Stored order (most recent first) drives the sequential pass: the first
  // listed account gets the healthy exchange, the second is rejected.
  const healthy = summaries[0];
  const failed = summaries[1];
  if (healthy == null || failed == null) assert.fail("accounts missing");
  assert.equal(asCopilotSummary(healthy).quotaQueryLastError, null);
  assert.equal(asCopilotSummary(failed).status, "requiresReauthentication");
  assert.ok(asCopilotSummary(failed).quotaQueryLastError !== null);
  // Two sequential token exchanges: each account exactly once, in order.
  assert.equal(
    seen.filter((url) => url === COPILOT_TOKEN_URL).length,
    2,
    "each account refreshed once, in order",
  );
});
