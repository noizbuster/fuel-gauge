import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { md5Hex } from "../../src/core/ids.js";
import type { SubprocessPort } from "../../src/core/subprocess.js";
import type {
  AccountSummary,
  ImportCandidate,
  OmpAccountSummary,
} from "../../src/core/types.js";
import { createOmpProvider } from "../../src/providers/omp.js";
import {
  fixedClock,
  makeTestRuntime,
  noNetwork,
  signal,
  summaryJson,
} from "./runtime.js";

/** Recorded subprocess invocation. */
interface OmpCall {
  command: string;
  args: readonly string[];
}

/** Real `omp usage --json` shapes observed on a live install. */
function usageEnvelope(
  reports: unknown[],
  accountsWithoutUsage: unknown[] = [],
): string {
  return JSON.stringify({ generatedAt: 1, reports, accountsWithoutUsage });
}

function zaiReport(): Record<string, unknown> {
  return {
    provider: "zai",
    fetchedAt: 1_700_000_100_000,
    limits: [
      {
        id: "zai:features:zread:1mo",
        label: "ZAI Zread Quota",
        scope: { provider: "zai", windowId: "1mo" },
        window: {
          id: "1mo",
          label: "Monthly",
          durationMs: 2_592_000_000,
          resetsAt: 1_700_100_000_000,
        },
        amount: {
          unit: "requests",
          remaining: 4_000,
          used: 0,
          limit: 4_000,
          remainingFraction: 1,
          usedFraction: 0,
        },
        status: "ok",
      },
      {
        id: "zai:tokens:5h",
        label: "ZAI 5 Hours Token Quota",
        scope: { provider: "zai", windowId: "5h" },
        window: {
          id: "5h",
          label: "5 Hours",
          durationMs: 18_000_000,
          resetsAt: 1_700_010_000_000,
        },
        amount: {
          unit: "tokens",
          remainingFraction: 0.96,
          usedFraction: 0.04,
        },
        status: "ok",
      },
    ],
    metadata: { endpoint: "https://api.z.ai", modelUsage: {} },
  };
}

function codexReport(): Record<string, unknown> {
  return {
    provider: "openai-codex",
    fetchedAt: 1_700_000_100_000,
    limits: [
      {
        id: "openai-codex:default:7d",
        label: "7 days",
        scope: { provider: "openai-codex", windowId: "7d" },
        window: {
          id: "7d",
          label: "7 days",
          durationMs: 604_800_000,
          resetsAt: 1_700_200_000_000,
        },
        amount: {
          unit: "percent",
          remaining: 94,
          used: 6,
          limit: 100,
          remainingFraction: 0.94,
          usedFraction: 0.06,
        },
        status: "ok",
      },
    ],
    metadata: {
      endpoint: "https://chatgpt.com",
      email: "codex@example.com",
    },
  };
}

const TEST_ZAI_KEY = "test-zai-key-123456";

/** Subprocess double: scripted `omp usage` payloads plus token probes. */
function ompPort(outputs: string[], calls: OmpCall[]): SubprocessPort {
  return {
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (args[0] === "token" && args.includes("-l")) {
        return {
          stdout: `No OAuth accounts found for provider "${args[1]}".`,
          stderr: "",
        };
      }
      if (args[0] === "token" && args.includes("--raw")) {
        return { stdout: `${TEST_ZAI_KEY}\n`, stderr: "" };
      }
      const next = outputs.shift();
      if (next === undefined) {
        throw new Error(`unexpected extra omp invocation: ${args.join(" ")}`);
      }
      return { stdout: next, stderr: "" };
    },
  };
}

function md5Of(value: string): string {
  return md5Hex(value);
}

function asOmpSummary(value: AccountSummary | undefined): OmpAccountSummary {
  if (value == null || value.provider !== "omp") {
    throw new Error("expected omp summary");
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

async function makeProvider(outputs: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-omp-"));
  const calls: OmpCall[] = [];
  const runtime = makeTestRuntime(noNetwork, {
    root,
    subprocess: ompPort(outputs, calls),
    clock: fixedClock(),
  });
  return {
    calls,
    provider: createOmpProvider(runtime),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("omp discovery lists every account with token-free labels", async (t) => {
  const harness = await makeProvider([
    usageEnvelope([zaiReport(), codexReport()]),
  ]);
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  assert.deepEqual(
    candidates.map((candidate) => candidate.source),
    ["subprocess", "subprocess"],
  );
  assert.equal(candidates[0]?.label, "Z.AI (GLM) · API: tes..456");
  assert.equal(candidates[1]?.label, "ChatGPT Codex · codex@example.com");
  for (const candidate of candidates) {
    assert.equal(candidate.path, null);
    assert.equal(candidate.provider, "omp");
  }
  assert.deepEqual(harness.calls, [
    { command: "omp", args: ["usage", "--json"] },
    { command: "omp", args: ["token", "zai", "--raw"] },
  ]);
});

test("omp import persists identity-only account and normalizes limits", async (t) => {
  const harness = await makeProvider([
    usageEnvelope([zaiReport(), codexReport()]),
    usageEnvelope([codexReport(), zaiReport()]),
  ]);
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const summaries = await harness.provider.import(first(candidates), signal());
  const summary = asOmpSummary(summaries[0]);
  assert.equal(summary.ompProviderId, "zai");
  assert.equal(summary.email, null);
  assert.equal(summary.keyFingerprint, md5Of(TEST_ZAI_KEY));
  // requests-unit windows keep their counts; token-unit windows surface
  // the fraction as a percent because omp reports no absolute tokens.
  assert.deepEqual(
    summary.metrics.map((metric) => [
      metric.id,
      metric.label,
      metric.remainingPercent,
      metric.used,
      metric.total,
      metric.resetAt,
    ]),
    [
      [
        "zai:features:zread:1mo",
        "ZAI Zread Quota (Monthly)",
        100,
        0,
        4000,
        1_700_100_000_000,
      ],
      [
        "zai:tokens:5h",
        "ZAI 5 Hours Token Quota",
        96,
        null,
        null,
        1_700_010_000_000,
      ],
    ],
  );
  const listed = asOmpSummary((await harness.provider.list())[0]);
  assert.equal(listed.displayLabel, "Z.AI (GLM) · API: tes..456");
  // Identity-only adapter: no token-shaped value ever reaches the store.
  assert.ok(!summaryJson(summary).toLowerCase().includes('token":'));
});

test("omp import rejects a candidate omp no longer lists", async (t) => {
  const harness = await makeProvider([
    usageEnvelope([zaiReport()]),
    usageEnvelope([codexReport()]),
  ]);
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  await assert.rejects(
    harness.provider.import(first(candidates), signal()),
    /no longer listed/,
  );
});

test("omp refresh flags delisting and keeps the last safe quota", async (t) => {
  const harness = await makeProvider([
    usageEnvelope([codexReport()]),
    usageEnvelope([codexReport()]),
    usageEnvelope([]),
  ]);
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const imported = await harness.provider.import(first(candidates), signal());
  const id = imported[0]?.id;
  if (id === undefined) {
    throw new Error("expected an imported account");
  }
  const delisted = asOmpSummary(await harness.provider.refresh(id, signal()));
  assert.equal(delisted.status, "requiresReauthentication");
  assert.equal(delisted.statusReason, "no longer listed by `omp usage`");
  assert.equal(delisted.metrics[0]?.remainingPercent, 94);
});

test("omp refresh records CLI failure without losing the last quota", async (t) => {
  const harness = await makeProvider([
    usageEnvelope([codexReport()]),
    usageEnvelope([codexReport()]),
    "not json at all",
  ]);
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const imported = await harness.provider.import(first(candidates), signal());
  const id = imported[0]?.id;
  if (id === undefined) {
    throw new Error("expected an imported account");
  }
  const failed = asOmpSummary(await harness.provider.refresh(id, signal()));
  assert.ok(failed.quotaQueryLastError?.includes("omp usage"));
  assert.equal(failed.metrics[0]?.remainingPercent, 94);
});

test("omp refreshAll refreshes every stored account from one CLI run", async (t) => {
  const harness = await makeProvider([
    usageEnvelope([zaiReport(), codexReport()]),
    usageEnvelope([zaiReport(), codexReport()]),
    usageEnvelope([zaiReport(), codexReport()]),
    usageEnvelope([codexReport(), zaiReport()]),
  ]);
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const zai = candidates.find((candidate) => candidate.label.includes("Z.AI"));
  const codex = candidates.find((candidate) =>
    candidate.label.includes("Codex"),
  );
  if (zai === undefined || codex === undefined) {
    throw new Error("expected zai and codex candidates");
  }
  await harness.provider.import(zai, signal());
  await harness.provider.import(codex, signal());
  const summaries = await harness.provider.refreshAll(signal());
  assert.equal(summaries.length, 2);
  assert.ok(summaries.every((summary) => summary.status === "active"));
  // discovery + two imports + one refreshAll run; zai is probed on every
  // usage parse (no identity in its report), codex never is.
  const usageRuns = harness.calls.filter(
    (call) => call.args[0] === "usage",
  ).length;
  const zaiProbes = harness.calls.filter(
    (call) =>
      call.args[0] === "token" &&
      call.args[1] === "zai" &&
      call.args[2] === "--raw",
  ).length;
  const codexProbes = harness.calls.filter(
    (call) => call.args[0] === "token" && call.args[1] === "openai-codex",
  ).length;
  assert.equal(usageRuns, 4);
  assert.equal(zaiProbes, 4); // one probe per usage parse
  assert.equal(codexProbes, 0);
});

test("omp beginAuth explains the omp CLI import-only flow", async (t) => {
  const harness = await makeProvider([]);
  t.after(harness.cleanup);
  await assert.rejects(
    harness.provider.beginAuth(signal()),
    /omp auth-broker login/,
  );
});

test("omp discovery swallows a failing CLI", async (t) => {
  const harness = await makeProvider(["not json at all"]);
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  assert.equal(candidates.length, 0);
});

test("omp remove deletes only the stored copy", async (t) => {
  const harness = await makeProvider([
    usageEnvelope([codexReport()]),
    usageEnvelope([codexReport()]),
  ]);
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const imported = await harness.provider.import(first(candidates), signal());
  const id = imported[0]?.id;
  if (id === undefined) {
    throw new Error("expected an imported account");
  }
  await harness.provider.remove(id);
  assert.equal((await harness.provider.list()).length, 0);
});

test("omp accounts without usage stay listed with a typed reason", async (t) => {
  const harness = await makeProvider([
    usageEnvelope(
      [codexReport()],
      [{ provider: "opencode-go", type: "api_key" }],
    ),
    usageEnvelope(
      [codexReport()],
      [{ provider: "opencode-go", type: "api_key" }],
    ),
    usageEnvelope(
      [codexReport()],
      [{ provider: "opencode-go", type: "api_key" }],
    ),
  ]);
  t.after(harness.cleanup);
  const candidates = await harness.provider.discoverImports(signal());
  const go = candidates.find((candidate) =>
    candidate.label.includes("OpenCode Go"),
  );
  if (go === undefined) {
    throw new Error("expected an opencode-go candidate");
  }
  assert.equal(go.label, "OpenCode Go · API: tes..456");
  const imported = await harness.provider.import(go, signal());
  const summary = asOmpSummary(imported[0]);
  assert.equal(summary.status, "active");
  assert.match(summary.statusReason ?? "", /no usage endpoint/);
  assert.equal(summary.metrics.length, 0);
  // Delisting only happens when omp stops listing the account entirely.
  const refreshed = asOmpSummary(
    await harness.provider.refresh(imported[0]?.id as string, signal()),
  );
  assert.equal(refreshed.status, "active");
});
