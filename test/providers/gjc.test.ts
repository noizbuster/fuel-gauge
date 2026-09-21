import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { gjcAccountId, md5Hex } from "../../src/core/ids.js";
import {
  SubprocessError,
  type SubprocessPort,
} from "../../src/core/subprocess.js";
import type {
  AccountSummary,
  GjcAccountSummary,
  ImportCandidate,
} from "../../src/core/types.js";
import {
  gjcAgentDbPath,
  gjcKeyFingerprints,
  createGjcProvider,
} from "../../src/providers/gjc.js";
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
  sanitized: { envRemove: readonly string[] | undefined }[],
): SubprocessPort {
  return {
    async run(command, args, options) {
      calls.push({ command, args: [...args] });
      sanitized.push({ envRemove: options?.envRemove });
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
  const sanitizedEnv: { envRemove: readonly string[] | undefined }[] = [];
  // Pin GJC's agent dir into the sandbox so key-fingerprint reads can
  // never touch the real ~/.gjc/agent/agent.db.
  const previousAgentDir = process.env.GJC_CODING_AGENT_DIR;
  process.env.GJC_CODING_AGENT_DIR = path.join(root, "agent");
  const runtime = makeTestRuntime(noNetwork, {
    root,
    subprocess: gjcPort(listOutputs, calls, checkFailure, sanitizedEnv),
    clock: fixedClock(),
  });
  return {
    calls,
    sanitizedEnv,
    runtime,
    provider: createGjcProvider(runtime),
    async cleanup() {
      if (previousAgentDir === undefined) {
        delete process.env.GJC_CODING_AGENT_DIR;
      } else {
        process.env.GJC_CODING_AGENT_DIR = previousAgentDir;
      }
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
  // Discovery and import both run the CLI; omp's agent-dir alias must never
  // reach any of them or GJC reads omp's database instead of its own.
  assert.equal(harness.sanitizedEnv.length, 3);
  for (const options of harness.sanitizedEnv) {
    assert.deepEqual(options.envRemove, ["PI_CODING_AGENT_DIR"]);
  }
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

test("gjc agent db path follows GJC_CODING_AGENT_DIR, never the omp alias", () => {
  assert.equal(
    gjcAgentDbPath({ GJC_CODING_AGENT_DIR: "/custom/agent" }),
    "/custom/agent/agent.db",
  );
  // omp exports PI_CODING_AGENT_DIR for its own agent directory; honoring
  // it would read omp's database instead of GJC's.
  assert.equal(
    gjcAgentDbPath({ PI_CODING_AGENT_DIR: "/omp/agent" }),
    path.join(homedir(), ".gjc", "agent", "agent.db"),
  );
  assert.equal(
    gjcAgentDbPath({}),
    path.join(homedir(), ".gjc", "agent", "agent.db"),
  );
});

test("gjc key fingerprints mirror gjc's own key resolution", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-gjc-fp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const database = new DatabaseSync(path.join(agentDir, "agent.db"));
  database.exec(`
    CREATE TABLE auth_credentials (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      data TEXT NOT NULL,
      disabled_cause TEXT DEFAULT NULL,
      identity_key TEXT DEFAULT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = database.prepare(
    "INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run(1, "zai", "api_key", JSON.stringify({ key: "literal-zai-key" }), null);
  insert.run(2, "zai", "api_key", JSON.stringify({ key: "!config:zai" }), null);
  insert.run(3, "xai", "api_key", JSON.stringify({ key: "XAI_TEST_KEY" }), null);
  insert.run(4, "zai", "api_key", JSON.stringify({ key: "revoked-key" }), "revoked");
  insert.run(5, "zai", "api_key", "not-json", null);
  insert.run(6, "openai-codex", "oauth", JSON.stringify({ email: "me@x.y" }), null);
  database.close();

  const fingerprints = gjcKeyFingerprints(path.join(agentDir, "agent.db"), {
    XAI_TEST_KEY: "resolved-env-key",
  });
  assert.equal(fingerprints.get(1), md5Hex("literal-zai-key"));
  // `!` config references resolve inside gjc, not on disk.
  assert.equal(fingerprints.has(2), false);
  // Env-named keys fingerprint the resolved environment value.
  assert.equal(fingerprints.get(3), md5Hex("resolved-env-key"));
  // Disabled rows and unparseable payloads never fingerprint.
  assert.equal(fingerprints.has(4), false);
  assert.equal(fingerprints.has(5), false);
  assert.equal(fingerprints.has(6), false);

  const missing = gjcKeyFingerprints(path.join(root, "absent", "agent.db"), {});
  assert.equal(missing.size, 0);
});

test("GJC api-key accounts carry a mergeable fingerprint, never the key", async (t) => {
  const zaiKey = "269-zai-api-key-DO-NOT-LEAK-0000000001";
  const output = accountsEnvelope([
    accountRow({
      id: "zai:stored:2",
      credentialId: 2,
      provider: "zai",
      credentialKind: "api_key",
      identityLabel: null,
    }),
    accountRow({
      id: "zai:stored:3",
      credentialId: 3,
      provider: "zai",
      credentialKind: "api_key",
      identityLabel: null,
    }),
  ]);
  // discovery + two imports each run `gjc accounts list`.
  const harness = await makeProvider([output, output, output]);
  t.after(harness.cleanup);
  const agentDir = process.env.GJC_CODING_AGENT_DIR as string;
  mkdirSync(agentDir, { recursive: true });
  const database = new DatabaseSync(path.join(agentDir, "agent.db"));
  database.exec(`
    CREATE TABLE auth_credentials (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      data TEXT NOT NULL,
      disabled_cause TEXT DEFAULT NULL
    );
  `);
  const insert = database.prepare(
    "INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run(2, "zai", "api_key", JSON.stringify({ key: zaiKey }), null);
  insert.run(3, "zai", "api_key", JSON.stringify({ key: "!config:zai" }), null);
  database.close();

  const candidates = await harness.provider.discoverImports(signal());
  assert.equal(candidates.length, 2);
  const summaries: GjcAccountSummary[] = [];
  for (const candidate of candidates) {
    const [value] = await harness.provider.import(candidate, signal());
    summaries.push(asGjcSummary(value));
  }

  const [withKey, referenced] = summaries;
  assert.ok(withKey != null && referenced != null);
  assert.equal(withKey.keyFingerprint, md5Hex(zaiKey));
  assert.equal(referenced.keyFingerprint, null);
  const stored = await harness.runtime.store.listStored("gjc");
  assert.ok(!summaryJson(stored).includes(zaiKey));
  assert.ok(!summaryJson(summaries).includes(zaiKey));
});
