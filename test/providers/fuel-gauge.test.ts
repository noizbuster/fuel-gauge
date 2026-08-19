import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { md5Hex } from "../../src/core/ids.js";
import type { StoredFuelGaugeAccount } from "../../src/core/types.js";
import { createFuelGaugeProvider } from "../../src/providers/fuel-gauge.js";
import type { ApiKeyAuthFlow } from "../../src/providers/provider.js";
import { ZAI_USAGE_URL } from "../../src/providers/zai-quota.js";
import type { RuntimeDependencies } from "../../src/runtime.js";
import {
  FIXED_NOW_MS,
  fixedClock,
  headerOf,
  jsonResponse,
  makeTestRuntime,
  signal,
  summaryJson,
} from "./runtime.js";

const API_KEY = "zai-key-0123456789abcdef";

const ZAI_SUCCESS = {
  code: 200,
  data: {
    limits: [
      {
        type: "TIME_LIMIT",
        usage: 4000,
        currentValue: 1000,
        percentage: 25,
        nextResetTime: 1_700_100_000_000,
      },
      {
        type: "TOKENS_LIMIT",
        percentage: 17,
        nextResetTime: 1_700_200_000_000,
      },
    ],
  },
};

/**
 * Scripted fetch recording every request; unscripted URLs throw so tests
 * pin exactly which vendor endpoints are touched. Entries are CONSUMED in
 * order, so sequential scripts against one URL (reject, then succeed)
 * replay deterministically.
 */
function fetchScript(
  script: {
    url: string;
    status?: number;
    body: unknown;
  }[],
): { fetch: typeof fetch; requests: { url: string; init?: RequestInit }[] } {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    const index = script.findIndex((candidate) =>
      url.startsWith(candidate.url),
    );
    if (index === -1) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    const [entry] = script.splice(index, 1);
    if (entry === undefined) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    return jsonResponse(entry.body, entry.status ?? 200);
  };
  return { fetch, requests };
}

async function makeHarness(
  options: { script?: { url: string; status?: number; body: unknown }[] } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-gauge-fg-"));
  const { fetch, requests } = fetchScript(options.script ?? []);
  const runtime = makeTestRuntime(fetch, {
    root: path.join(root, "store"),
    clock: fixedClock(),
  });
  return {
    provider: createFuelGaugeProvider(runtime),
    runtime,
    requests,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function storedAccounts(
  runtime: RuntimeDependencies,
): Promise<StoredFuelGaugeAccount[]> {
  const accounts = await runtime.store.listStored("fuelGauge");
  return accounts as StoredFuelGaugeAccount[];
}

test("first-party source has nothing to discover or import", async (t) => {
  const harness = await makeHarness();
  t.after(() => harness.cleanup());
  assert.deepEqual(await harness.provider.discoverImports(signal()), []);
  await assert.rejects(
    harness.provider.import(
      { provider: "fuelGauge", source: "file", label: "x", path: null },
      signal(),
    ),
    /nothing to import/,
  );
});

test("add flow verifies the key, stores the account, and resolves token-free", async (t) => {
  const harness = await makeHarness({
    script: [{ url: ZAI_USAGE_URL, body: ZAI_SUCCESS }],
  });
  t.after(() => harness.cleanup());

  const flow = (await harness.provider.beginAuth(signal())) as ApiKeyAuthFlow;
  assert.equal(flow.mode, "apiKey");
  assert.equal(flow.provider, "fuelGauge");
  assert.equal(flow.hint, "Z.AI coding plan API key");
  assert.equal(flow.expiresAt, FIXED_NOW_MS + 600_000);

  await flow.submit({ kind: "fuelGauge", apiKey: API_KEY });
  const [summary] = await flow.result;

  assert.ok(summary !== undefined);
  assert.equal(harness.requests.length, 1);
  assert.ok(harness.requests[0]?.url.startsWith(ZAI_USAGE_URL));
  assert.equal(
    headerOf(harness.requests[0]?.init, "Authorization"),
    `Bearer ${API_KEY}`,
  );

  // Stored shape: fingerprint, masked label, both quota windows.
  const [stored] = await storedAccounts(harness.runtime);
  assert.equal(stored?.apiKey, API_KEY);
  assert.equal(stored?.keyFingerprint, md5Hex(API_KEY));
  assert.equal(stored?.vendor, "zai-coding-plan");
  assert.equal(stored?.displayLabel, "Z.AI Coding Plan · API: zai..def");

  // Public summary: metrics derived, no raw key anywhere.
  assert.equal(summary.provider, "fuelGauge");
  assert.deepEqual(
    summary.metrics.map((metric) => [metric.id, metric.remainingPercent]),
    [
      ["fuelgauge.zai.time_limit", 75],
      ["fuelgauge.zai.tokens_limit", 83],
    ],
  );
  assert.ok(!summaryJson(summary).includes(API_KEY), "key leaked into summary");
});

test("a rejected key throws without settling so the flow accepts a retry", async (t) => {
  const harness = await makeHarness({
    script: [
      { url: ZAI_USAGE_URL, status: 401, body: { message: "bad key" } },
      { url: ZAI_USAGE_URL, body: ZAI_SUCCESS },
    ],
  });
  t.after(() => harness.cleanup());

  const flow = (await harness.provider.beginAuth(signal())) as ApiKeyAuthFlow;
  await assert.rejects(
    flow.submit({ kind: "fuelGauge", apiKey: API_KEY }),
    /Z\.AI usage/,
  );
  // A settled result would run its reaction on the next microtask; racing
  // one microtask turn proves the flow is still pending, deterministically.
  const outcome = await Promise.race([
    Promise.resolve(flow.result).then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    Promise.resolve().then(() => "pending" as const),
  ]);
  assert.equal(outcome, "pending", "result must stay pending after a bad key");
  assert.deepEqual(await storedAccounts(harness.runtime), []);

  // The corrected paste settles the SAME flow.
  await flow.submit({ kind: "fuelGauge", apiKey: API_KEY });
  const [summary] = await flow.result;
  assert.ok(summary !== undefined);
  assert.equal(summary.provider, "fuelGauge");
});
test("too-short keys and foreign submissions are rejected before any network", async (t) => {
  const harness = await makeHarness();
  t.after(() => harness.cleanup());
  const flow = (await harness.provider.beginAuth(signal())) as ApiKeyAuthFlow;
  await assert.rejects(
    flow.submit({ kind: "fuelGauge", apiKey: "short" }),
    /too short/,
  );
  await assert.rejects(
    flow.submit({ kind: "claude", callbackOrCode: "x" }),
    /only fuelGauge submissions/,
  );
  assert.deepEqual(harness.requests, []);
  await flow.cancel();
  await assert.rejects(flow.result, /cancelled/);
});

test("re-adding the same key is idempotent and keeps createdAt", async (t) => {
  const harness = await makeHarness({
    script: [
      { url: ZAI_USAGE_URL, body: ZAI_SUCCESS },
      { url: ZAI_USAGE_URL, body: ZAI_SUCCESS },
    ],
  });
  t.after(() => harness.cleanup());
  const first = (await harness.provider.beginAuth(signal())) as ApiKeyAuthFlow;
  await first.submit({ kind: "fuelGauge", apiKey: API_KEY });
  await first.result;

  const second = (await harness.provider.beginAuth(signal())) as ApiKeyAuthFlow;
  await second.submit({ kind: "fuelGauge", apiKey: `  ${API_KEY}  ` });
  await second.result;

  const accounts = await storedAccounts(harness.runtime);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.createdAt, FIXED_NOW_MS);
});

test("refresh updates quotas and retains the last safe one on failure", async (t) => {
  const harness = await makeHarness({
    script: [
      { url: ZAI_USAGE_URL, body: ZAI_SUCCESS },
      { url: ZAI_USAGE_URL, body: ZAI_SUCCESS },
      { url: ZAI_USAGE_URL, status: 500, body: {} },
      { url: ZAI_USAGE_URL, status: 401, body: {} },
    ],
  });
  t.after(() => harness.cleanup());

  const add = (await harness.provider.beginAuth(signal())) as ApiKeyAuthFlow;
  await add.submit({ kind: "fuelGauge", apiKey: API_KEY });
  const [seeded] = await add.result;
  assert.ok(seeded !== undefined);

  // Successful refresh reflects the vendor windows.
  const refreshed = await harness.provider.refresh(seeded.id, signal());
  assert.equal(refreshed.status, "active");
  assert.equal(refreshed.metrics.length, 2);

  // Server error: quota retained, status untouched, error recorded.
  const degraded = await harness.provider.refresh(seeded.id, signal());
  assert.equal(degraded.status, "active");
  assert.equal(degraded.metrics.length, 2, "last safe quota retained");
  assert.ok(degraded.quotaQueryLastError?.includes("status=500"));

  // Rejected key: flagged for re-adding, quota still retained.
  const rejected = await harness.provider.refresh(seeded.id, signal());
  assert.equal(rejected.status, "requiresReauthentication");
  assert.equal(rejected.metrics.length, 2);
  assert.ok(!summaryJson(rejected).includes(API_KEY));

  await assert.rejects(
    harness.provider.refresh("fg_missing", signal()),
    /no longer stored/,
  );
});

test("refreshAll refreshes every stored account, remove deletes it", async (t) => {
  const harness = await makeHarness({
    script: [
      { url: ZAI_USAGE_URL, body: ZAI_SUCCESS },
      { url: ZAI_USAGE_URL, body: ZAI_SUCCESS },
      { url: ZAI_USAGE_URL, body: ZAI_SUCCESS },
    ],
  });
  t.after(() => harness.cleanup());

  const add = (await harness.provider.beginAuth(signal())) as ApiKeyAuthFlow;
  await add.submit({ kind: "fuelGauge", apiKey: API_KEY });
  const [seeded] = await add.result;
  assert.ok(seeded !== undefined);

  const summaries = await harness.provider.refreshAll(signal());
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.id, seeded.id);

  await harness.provider.remove(seeded.id);
  assert.deepEqual(await harness.provider.list(), []);
});
