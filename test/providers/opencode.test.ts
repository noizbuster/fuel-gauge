import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AccountSummary,
  ImportCandidate,
  OpenCodeAccountSummary,
} from "../../src/core/types.js";
import { createOpenCodeProvider } from "../../src/providers/opencode.js";
import {
  fixedClock,
  jsonResponse,
  makeTestRuntime,
  signal,
} from "./runtime.js";

/**
 * Scripted fetch keyed by URL prefix; unscripted URLs throw so tests
 * pin exactly which vendor endpoints are touched.
 */
function fetchScript(
  script: {
    url: string;
    status?: number;
    body: unknown;
  }[],
): typeof fetch {
  return async (input) => {
    const url = String(input);
    const entry = script.find((candidate) => url.startsWith(candidate.url));
    if (entry === undefined) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    return jsonResponse(entry.body, entry.status ?? 200);
  };
}

const ZAI_SUCCESS = {
  code: 200,
  data: {
    limits: [
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 4000,
        currentValue: 1000,
        remaining: 3000,
        percentage: 25,
        nextResetTime: 1_700_100_000_000,
        usageDetails: [],
      },
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        percentage: 17,
        nextResetTime: 1_700_200_000_000,
        usageDetails: [],
      },
    ],
  },
};

const OPENAI_SUCCESS = {
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 40,
      limit_window_seconds: 10800,
      reset_after_seconds: 3600,
    },
    secondary_window: {
      used_percent: 10,
      limit_window_seconds: 604800,
      reset_at: 1_700_300_000,
    },
  },
};

const XAI_SUCCESS = {
  total_credits: 200,
  remaining_credits: 50,
  reset_at: 1_700_400_000,
};

async function makeHarness(options: {
  fetchImpl?: typeof fetch;
  authFile?: Record<string, unknown> | null;
}) {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-oc-"));
  const dataHome = path.join(root, "data");
  await mkdir(path.join(dataHome, "opencode"), { recursive: true });
  const previousDataHome = process.env.XDG_DATA_HOME;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  // Isolate dashboard-credential resolution from this machine's real
  // opencode-quota plugin state.
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  const authFile = options.authFile;
  if (authFile !== null) {
    await writeFile(
      path.join(dataHome, "opencode", "auth.json"),
      JSON.stringify(authFile ?? defaultAuthFile()),
      "utf8",
    );
  }
  const runtime = makeTestRuntime(options.fetchImpl ?? fetchScript([]), {
    root: path.join(root, "store"),
    clock: fixedClock(),
  });
  return {
    provider: createOpenCodeProvider(runtime),
    async cleanup() {
      if (previousDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousDataHome;
      }
      if (previousConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousConfigHome;
      }
      delete process.env.OPENCODE_GO_WORKSPACE_ID;
      delete process.env.OPENCODE_GO_AUTH_COOKIE;
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** FIXED_NOW_MS is far past every oauth expiry used here. */
function defaultAuthFile(): Record<string, unknown> {
  return {
    "zai-coding-plan": { type: "api", key: "zai-key" },
    openai: { type: "oauth", access: "openai-access", expires: 1 },
    google: { type: "oauth", access: "google-access", expires: 1 },
    xai: { type: "oauth", access: "xai-access", expires: 1 },
    "opencode-go": { type: "api", key: "go-key" },
  };
}

function asOcSummary(
  value: AccountSummary | undefined,
): OpenCodeAccountSummary {
  if (value == null || value.provider !== "opencode") {
    throw new Error("expected opencode summary");
  }
  return value;
}

function first(candidates: ImportCandidate[]): ImportCandidate {
  const candidate = candidates[0];
  if (candidate === undefined) {
    throw new Error("expected at least one candidate");
  }
  return candidate;
}

test("opencode discovery lists every credential without secrets", async (t) => {
  const harness = await makeHarness({});
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  assert.deepEqual(
    candidates.map((candidate) => candidate.label),
    [
      "Z.AI Coding Plan · API key",
      "OpenAI (ChatGPT) · OAuth",
      "Google · OAuth",
      "xAI Grok · OAuth",
      "OpenCode Go · API key",
    ],
  );
  for (const candidate of candidates) {
    assert.ok(!JSON.stringify(candidate).includes("zai-key"));
    assert.ok(!JSON.stringify(candidate).includes("openai-access"));
    assert.equal(candidate.provider, "opencode");
    assert.equal(candidate.source, "file");
  }
});

test("opencode zai refresh maps live API windows to metrics", async (t) => {
  const harness = await makeHarness({
    fetchImpl: fetchScript([{ url: "https://api.z.ai", body: ZAI_SUCCESS }]),
  });
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const zai = candidates.find((label) =>
    label.label.includes("Z.AI Coding Plan"),
  );
  if (zai === undefined) {
    throw new Error("expected zai candidate");
  }
  const imported = await harness.provider.import(zai, signal());
  const refreshed = asOcSummary(
    await harness.provider.refresh(imported[0]?.id as string, signal()),
  );
  assert.deepEqual(
    refreshed.metrics.map((metric) => [
      metric.id,
      metric.label,
      metric.remainingPercent,
      metric.used,
      metric.total,
      metric.resetAt,
    ]),
    [
      [
        "opencode.zai.time_limit",
        "ZAI Zread Quota (Monthly)",
        75,
        1000,
        4000,
        1_700_100_000_000,
      ],
      [
        "opencode.zai.tokens_limit",
        "ZAI 5 Hours Token Quota",
        83,
        null,
        null,
        1_700_200_000_000,
      ],
    ],
  );
});

test("opencode openai refresh parses subscription windows", async (t) => {
  const harness = await makeHarness({
    authFile: { openai: { type: "oauth", access: "live-token" } },
    fetchImpl: fetchScript([
      { url: "https://chatgpt.com", body: OPENAI_SUCCESS },
    ]),
  });
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const imported = await harness.provider.import(first(candidates), signal());
  const refreshed = asOcSummary(
    await harness.provider.refresh(imported[0]?.id as string, signal()),
  );
  assert.equal(refreshed.status, "active");
  assert.deepEqual(
    refreshed.metrics.map((metric) => [metric.label, metric.remainingPercent]),
    [
      ["3 hours", 60],
      ["7 days", 90],
    ],
  );
});

test("opencode expired oauth accounts demand an opencode refresh", async (t) => {
  const harness = await makeHarness({ authFile: defaultAuthFile() });
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const openai = candidates.find((c) => c.label.includes("OpenAI"));
  if (openai === undefined) {
    throw new Error("expected openai candidate");
  }
  const imported = await harness.provider.import(openai, signal());
  const refreshed = asOcSummary(
    await harness.provider.refresh(imported[0]?.id as string, signal()),
  );
  assert.equal(refreshed.status, "requiresReauthentication");
  assert.match(refreshed.statusReason ?? "", /run opencode to refresh/);
});

test("opencode providers without a usage endpoint stay listed", async (t) => {
  const harness = await makeHarness({ authFile: defaultAuthFile() });
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const google = candidates.find((c) => c.label.startsWith("Google"));
  const go = candidates.find((c) => c.label.includes("OpenCode Go"));
  if (google === undefined || go === undefined) {
    throw new Error("expected google and opencode-go candidates");
  }
  const importedGoogle = await harness.provider.import(google, signal());
  const importedGo = await harness.provider.import(go, signal());
  const refreshedGoogle = asOcSummary(
    await harness.provider.refresh(importedGoogle[0]?.id as string, signal()),
  );
  const refreshedGo = asOcSummary(
    await harness.provider.refresh(importedGo[0]?.id as string, signal()),
  );
  assert.equal(refreshedGoogle.status, "active");
  assert.match(refreshedGoogle.statusReason ?? "", /no usage endpoint/);
  assert.equal(refreshedGo.status, "active");
  assert.equal(refreshedGo.metrics.length, 0);
});

test("opencode xai refresh maps grok credits", async (t) => {
  const harness = await makeHarness({
    authFile: { xai: { type: "oauth", access: "live-xai" } },
    fetchImpl: fetchScript([
      { url: "https://cli-chat-proxy.grok.com", body: XAI_SUCCESS },
    ]),
  });
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const imported = await harness.provider.import(first(candidates), signal());
  const refreshed = asOcSummary(
    await harness.provider.refresh(imported[0]?.id as string, signal()),
  );
  assert.deepEqual(
    refreshed.metrics.map((m) => [
      m.label,
      m.remainingPercent,
      m.used,
      m.total,
    ]),
    [["Grok credits", 25, 150, 200]],
  );
});

test("opencode removed credentials are flagged, not deleted", async (t) => {
  const harness = await makeHarness({
    authFile: { "zai-coding-plan": { type: "api", key: "k" } },
    fetchImpl: fetchScript([{ url: "https://api.z.ai", body: ZAI_SUCCESS }]),
  });
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const imported = await harness.provider.import(first(candidates), signal());
  const id = imported[0]?.id as string;
  // Credential vanishes from the agent's store before the next refresh.
  const dataHome = process.env.XDG_DATA_HOME as string;
  await writeFile(path.join(dataHome, "opencode", "auth.json"), "{}", "utf8");
  const refreshed = asOcSummary(await harness.provider.refresh(id, signal()));
  assert.equal(refreshed.status, "requiresReauthentication");
  assert.match(refreshed.statusReason ?? "", /removed from opencode/);
});

test("opencode beginAuth explains the CLI flow", async (t) => {
  const harness = await makeHarness({});
  t.after(harness.cleanup);
  await assert.rejects(
    harness.provider.beginAuth(signal()),
    /opencode auth login/,
  );
});

test("opencode discovery swallows a missing auth store", async (t) => {
  const harness = await makeHarness({ authFile: null });
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  assert.equal(candidates.length, 0);
});

const GO_DASHBOARD_HTML = [
  "<script>",
  "rollingUsage:$R[1]={resetInSec:18000,usagePercent:12.5}",
  "weeklyUsage:$R[2]={usagePercent:3,resetInSec:562401}",
  "monthlyUsage:$R[3]={usagePercent:46,resetInSec:193110}",
  "</script>",
].join("");

test("opencode-go reads the dashboard windows when configured", async (t) => {
  process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_test";
  process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-value";
  const harness = await makeHarness({
    authFile: { "opencode-go": { type: "api", key: "go-key-123456" } },
    fetchImpl: fetchScript([
      { url: "https://opencode.ai/workspace/", body: GO_DASHBOARD_HTML },
    ]),
  });
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const imported = await harness.provider.import(
    candidates[0] as never,
    signal(),
  );
  const refreshed = asOcSummary(
    await harness.provider.refresh(imported[0]?.id as string, signal()),
  );
  assert.equal(refreshed.status, "active");
  assert.equal(refreshed.statusReason, null);
  assert.deepEqual(
    refreshed.metrics.map((m) => [m.label, m.remainingPercent]),
    [
      ["Rolling usage", 87.5],
      ["Weekly usage", 97],
      ["Monthly usage", 54],
    ],
  );
  const rolling = refreshed.metrics[0];
  assert.ok(
    rolling?.resetAt !== null && rolling?.resetAt !== undefined,
    "rolling reset countdown present",
  );
});

test("opencode-go without dashboard credentials explains the setup", async (t) => {
  const harness = await makeHarness({
    authFile: { "opencode-go": { type: "api", key: "go-key-123456" } },
  });
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const imported = await harness.provider.import(
    candidates[0] as never,
    signal(),
  );
  const refreshed = asOcSummary(
    await harness.provider.refresh(imported[0]?.id as string, signal()),
  );
  assert.equal(refreshed.status, "active");
  assert.match(refreshed.statusReason ?? "", /OPENCODE_GO_AUTH_COOKIE/);
  assert.equal(refreshed.metrics.length, 0);
});

test("opencode-go expired dashboard cookie demands a refresh", async (t) => {
  process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_test";
  process.env.OPENCODE_GO_AUTH_COOKIE = "stale";
  const harness = await makeHarness({
    authFile: { "opencode-go": { type: "api", key: "go-key-123456" } },
    fetchImpl: fetchScript([
      { url: "https://opencode.ai/workspace/", status: 401, body: "" },
    ]),
  });
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const imported = await harness.provider.import(
    candidates[0] as never,
    signal(),
  );
  const refreshed = asOcSummary(
    await harness.provider.refresh(imported[0]?.id as string, signal()),
  );
  assert.equal(refreshed.status, "requiresReauthentication");
  assert.match(refreshed.statusReason ?? "", /OPENCODE_GO_AUTH_COOKIE/);
});

function jwtWithClaims(claims: Record<string, unknown>): string {
  const enc = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

test("opencode oauth identity is decoded from the access-token JWT", async (t) => {
  const harness = await makeHarness({
    authFile: {
      openai: {
        type: "oauth",
        access: jwtWithClaims({
          email: "noizbuster@naver.com",
          "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" },
        }),
        expires: 1,
      },
    },
  });
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  assert.equal(candidates[0]?.label, "OpenAI (ChatGPT) · noizbuster@naver.com");
  const imported = await harness.provider.import(
    candidates[0] as never,
    signal(),
  );
  const summary = asOcSummary(imported[0]);
  assert.equal(summary.email, "noizbuster@naver.com");
  // Expired token keeps the decoded identity for display and merging.
  const refreshed = asOcSummary(
    await harness.provider.refresh(imported[0]?.id as string, signal()),
  );
  assert.equal(refreshed.email, "noizbuster@naver.com");
  assert.equal(refreshed.status, "requiresReauthentication");
});
