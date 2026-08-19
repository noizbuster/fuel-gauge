import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { gjcAccountId } from "../../src/core/ids.js";
import {
  SubprocessError,
  type SubprocessPort,
} from "../../src/core/subprocess.js";
import type {
  AccountSummary,
  GjcAccountSummary,
  ImportCandidate,
} from "../../src/core/types.js";
import { createGjcProvider } from "../../src/providers/gjc.js";
import {
  fixedClock,
  makeTestRuntime,
  noNetwork,
  signal,
  summaryJson,
} from "./runtime.js";

const SECRET = "gjc-secret-that-must-never-leak-123456789";

interface GjcCall {
  command: string;
  args: readonly string[];
}

type CheckFailure = "row" | "internal" | "command" | null;

function usageReport(remainingFraction = 0.72): Record<string, unknown> {
  return {
    provider: "openai-codex",
    fetchedAt: 1_700_000_100_000,
    limits: [
      {
        id: "codex.primary",
        label: "5 hours",
        scope: { provider: "openai-codex", windowId: "5h" },
        window: {
          id: "5h",
          label: "5 hours",
          durationMs: 18_000_000,
          resetsAt: 1_700_010_000_000,
        },
        amount: {
          unit: "percent",
          used: 28,
          limit: 100,
          remaining: 72,
          usedFraction: 1 - remainingFraction,
          remainingFraction,
        },
        status: "ok",
      },
    ],
    metadata: { token: SECRET },
    raw: { accessToken: SECRET },
  };
}

function accountRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "openai-codex:stored:7",
    credentialId: 7,
    provider: "openai-codex",
    credentialKind: "oauth",
    source: "stored",
    sourceLabel: "stored credential",
    identityLabel: "Me@Example.com",
    disabled: false,
    disabledCause: null,
    health: { status: "ok", reason: null },
    usage: {
      report: usageReport(),
      fetchedAt: 1_700_000_100_000,
      freshUntil: 1_700_000_400_000,
      retainUntil: 1_700_086_400_000,
      freshness: "fresh",
    },
    capabilities: {
      canCheck: true,
      canPin: true,
      canRemove: true,
      hasCachedUsage: true,
    },
    routing: { active: true, selected: true, marker: "active" },
    apiKey: SECRET,
    ...overrides,
  };
}

function accountsEnvelope(accounts: unknown[]): string {
  return JSON.stringify({ ok: true, generatedAt: 1, generation: 2, accounts });
}

function gjcPort(
  listOutputs: string[],
  calls: GjcCall[],
  checkFailure: CheckFailure,
): SubprocessPort {
  return {
    async run(command, args, options) {
      calls.push({ command, args: [...args] });
      if (options?.signal?.aborted) {
        throw new SubprocessError({
          code: "aborted",
          command,
          args,
          exitCode: null,
          signal: null,
          message: "test command aborted",
        });
      }
      if (args[0] === "accounts" && args[1] === "check") {
        if (checkFailure !== null) {
          throw new SubprocessError({
            code: checkFailure === "command" ? "timeout" : "failed",
            command,
            args,
            exitCode: checkFailure === "command" ? null : 1,
            signal: checkFailure === "command" ? "SIGTERM" : null,
            message:
              checkFailure === "row"
                ? "one GJC credential failed its check"
                : checkFailure === "internal"
                  ? "GJC account check failed internally"
                  : "GJC account check timed out",
          });
        }
        return { stdout: JSON.stringify({ ok: true, checks: [] }), stderr: "" };
      }
      const next = listOutputs.shift();
      if (next === undefined) {
        throw new Error(`unexpected extra gjc invocation: ${args.join(" ")}`);
      }
      return { stdout: next, stderr: "" };
    },
  };
}

function first(candidates: ImportCandidate[]): ImportCandidate {
  const candidate = candidates[0];
  if (candidate === undefined) {
    throw new Error("expected at least one GJC candidate");
  }
  return candidate;
}

function asGjcSummary(value: AccountSummary | undefined): GjcAccountSummary {
  if (value == null || value.provider !== "gjc") {
    throw new Error("expected GJC summary");
  }
  return value;
}

async function makeProvider(
  listOutputs: string[],
  checkFailure: CheckFailure = null,
) {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-gjc-"));
  const calls: GjcCall[] = [];
  const runtime = makeTestRuntime(noNetwork, {
    root,
    subprocess: gjcPort(listOutputs, calls, checkFailure),
    clock: fixedClock(),
  });
  return {
    calls,
    runtime,
    provider: createGjcProvider(runtime),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("GJC discovery and import use the redacted CLI inventory", async (t) => {
  const output = accountsEnvelope([accountRow()]);
  const harness = await makeProvider([output, output]);
  t.after(harness.cleanup);

  const candidates = await harness.provider.discoverImports(signal());
  assert.deepEqual(candidates, [
    {
      provider: "gjc",
      source: "subprocess",
      label: `ChatGPT Codex · Me@Example.com · gjc ID ${gjcAccountId(
        "openai-codex",
        "openai-codex:stored:7",
      )}`,
      path: null,
    },
  ]);

  const [value] = await harness.provider.import(first(candidates), signal());
  const summary = asGjcSummary(value);
  assert.equal(summary.gjcProviderId, "openai-codex");
  assert.equal(summary.email, "me@example.com");
  assert.deepEqual(
    summary.metrics.map((metric) => ({
      id: metric.id,
      label: metric.label,
      remainingPercent: metric.remainingPercent,
      used: metric.used,
      total: metric.total,
      resetAt: metric.resetAt,
    })),
    [
      {
        id: "gjc.openai-codex.codex.primary",
        label: "5 hours",
        remainingPercent: 72,
        used: 28,
        total: 100,
        resetAt: 1_700_010_000_000,
      },
    ],
  );
  assert.ok(!summaryJson(summary).includes(SECRET));
  const stored = (await harness.runtime.store.listStored("gjc"))[0];
  assert.ok(stored?.provider === "gjc");
  assert.equal(stored.credentialKind, "oauth");
  assert.equal(stored.credentialSource, "stored");
  assert.ok(!summaryJson(stored).includes(SECRET));
  assert.deepEqual(harness.calls, [
    { command: "gjc", args: ["accounts", "list", "--json"] },
    { command: "gjc", args: ["accounts", "check", "--json"] },
    { command: "gjc", args: ["accounts", "list", "--json"] },
  ]);
});

test("GJC duplicate identities remain individually importable", async (t) => {
  const output = accountsEnvelope([
    accountRow({ id: "openai-codex:stored:1", credentialId: 1 }),
    accountRow({ id: "openai-codex:stored:2", credentialId: 2 }),
  ]);
  const harness = await makeProvider([output]);
  t.after(harness.cleanup);

  const candidates = await harness.provider.discoverImports(signal());
  assert.deepEqual(
    candidates.map((candidate) => candidate.label),
    [
      `ChatGPT Codex · Me@Example.com · gjc ID ${gjcAccountId(
        "openai-codex",
        "openai-codex:stored:1",
      )}`,
      `ChatGPT Codex · Me@Example.com · gjc ID ${gjcAccountId(
        "openai-codex",
        "openai-codex:stored:2",
      )}`,
    ],
  );
});

test("GJC import follows the stable row when its identity label changes", async (t) => {
  const discovered = accountsEnvelope([accountRow()]);
  const updated = accountsEnvelope([
    accountRow({ identityLabel: "Changed@Example.com" }),
  ]);
  const harness = await makeProvider([discovered, updated]);
  t.after(harness.cleanup);

  const candidates = await harness.provider.discoverImports(signal());
  const [value] = await harness.provider.import(first(candidates), signal());
  const summary = asGjcSummary(value);
  assert.equal(summary.email, "changed@example.com");
  assert.equal(summary.identityLabel, "Changed@Example.com");
});

test("GJC refresh marks a delisted account and retains its safe quota", async (t) => {
  const output = accountsEnvelope([accountRow()]);
  const harness = await makeProvider([output, output, accountsEnvelope([])]);
  t.after(harness.cleanup);

  const candidates = await harness.provider.discoverImports(signal());
  const [imported] = await harness.provider.import(first(candidates), signal());
  assert.ok(imported !== undefined);

  const refreshed = asGjcSummary(
    await harness.provider.refresh(imported.id, signal()),
  );
  assert.equal(refreshed.status, "requiresReauthentication");
  assert.equal(refreshed.statusReason, "no longer listed by `gjc accounts`");
  assert.equal(refreshed.metrics[0]?.remainingPercent, 72);
  assert.deepEqual(harness.calls.at(-2), {
    command: "gjc",
    args: ["accounts", "check", "openai-codex", "--json"],
  });
});

test("a global GJC check failure does not taint a healthy account", async (t) => {
  const output = accountsEnvelope([
    accountRow({
      usage: {
        report: usageReport(0.61),
        fetchedAt: 1_700_000_100_000,
        freshUntil: 1_700_000_200_000,
        retainUntil: 1_700_086_400_000,
        freshness: "stale-last-good",
      },
    }),
    accountRow({
      id: "anthropic:stored:8",
      provider: "anthropic",
      identityLabel: "failed@example.com",
      health: { status: "failed", reason: "invalid credential" },
    }),
  ]);
  const harness = await makeProvider([output, output], "row");
  t.after(harness.cleanup);

  const candidates = await harness.provider.discoverImports(signal());
  const [value] = await harness.provider.import(first(candidates), signal());
  const summary = asGjcSummary(value);
  assert.equal(summary.metrics[0]?.remainingPercent, 61);
  assert.equal(summary.statusReason, "gjc usage cache is stale");
  assert.equal(summary.quotaQueryLastError, null);
});

test("GJC attaches failed health only to the affected account", async (t) => {
  const output = accountsEnvelope([
    accountRow({ health: { status: "failed", reason: "invalid credential" } }),
  ]);
  const harness = await makeProvider([output, output], "row");
  t.after(harness.cleanup);

  const candidates = await harness.provider.discoverImports(signal());
  const [value] = await harness.provider.import(first(candidates), signal());
  const summary = asGjcSummary(value);
  assert.equal(summary.status, "active");
  assert.equal(summary.statusReason, "gjc account check failed");
  assert.equal(summary.quotaQueryLastError, "gjc account check failed");
});

test("an internal GJC check failure marks retained usage stale", async (t) => {
  const output = accountsEnvelope([accountRow()]);
  const harness = await makeProvider([output, output], "internal");
  t.after(harness.cleanup);

  const candidates = await harness.provider.discoverImports(signal());
  const [value] = await harness.provider.import(first(candidates), signal());
  const summary = asGjcSummary(value);
  assert.equal(summary.status, "active");
  assert.equal(summary.quotaQueryLastError, "gjc account check failed");
});

test("GJC refresh propagates cancellation without changing the account", async (t) => {
  const output = accountsEnvelope([accountRow()]);
  const harness = await makeProvider([output, output]);
  t.after(harness.cleanup);

  const candidates = await harness.provider.discoverImports(signal());
  const [value] = await harness.provider.import(first(candidates), signal());
  const summary = asGjcSummary(value);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    harness.provider.refresh(summary.id, controller.signal),
    /aborted/,
  );
  const unchanged = asGjcSummary((await harness.provider.list())[0]);
  assert.equal(unchanged.quotaQueryLastError, null);
});

test("GJC disabled accounts are not offered for import", async (t) => {
  const harness = await makeProvider([
    accountsEnvelope([accountRow({ disabled: true })]),
  ]);
  t.after(harness.cleanup);
  assert.deepEqual(await harness.provider.discoverImports(signal()), []);
});

test("GJC login stays owned by the GJC CLI", async (t) => {
  const harness = await makeProvider([]);
  t.after(harness.cleanup);
  await assert.rejects(harness.provider.beginAuth(signal()), /\/login.*gjc/);
});
