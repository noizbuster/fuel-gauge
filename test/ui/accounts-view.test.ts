import assert from "node:assert/strict";
import test from "node:test";

import type { AccountSummary, ProviderId } from "../../src/core/types.js";
import {
  antigravityCliStaleText,
  ANTIGRAVITY_CLI_STALE_MS,
  markPinnedEntries,
  mergeAccountsByIdentity,
} from "../../src/ui/accounts-view.js";

interface AccountSeed {
  id: string;
  provider: ProviderId;
  source?: string;
  email?: string | null;
  keyFingerprint?: string | null;
  displayLabel?: string;
  remainingPercent?: number | null;
  resetAt?: number | null;
  status?: "active" | "requiresReauthentication";
  usageUpdatedAt?: number | null;
}

function summary(seed: AccountSeed): AccountSummary {
  const base = {
    id: seed.id,
    status: seed.status ?? "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: seed.usageUpdatedAt === undefined ? 1 : seed.usageUpdatedAt,
    createdAt: 1,
    lastUsed: 1,
    metrics:
      seed.remainingPercent === undefined
        ? []
        : [
            {
              id: `${seed.id}.m`,
              label: "usage",
              remainingPercent: seed.remainingPercent,
              used: null,
              total: null,
              resetAt: seed.resetAt ?? null,
            },
          ],
  };
  if (seed.provider === "antigravity") {
    return {
      ...base,
      provider: "antigravity",
      email: seed.email ?? "none@example.com",
      source: seed.source ?? "cli",
      authId: null,
      name: null,
      selectedAuthType: null,
      projectId: null,
      tierId: null,
      planName: null,
      credits: [],
      quota: {
        geminiFiveHour: { remainingPercent: null, resetAt: null },
        geminiWeekly: { remainingPercent: null, resetAt: null },
        thirdPartyFiveHour: { remainingPercent: null, resetAt: null },
        thirdPartyWeekly: { remainingPercent: null, resetAt: null },
      },
    } as AccountSummary;
  }
  if (seed.provider === "codex") {
    return {
      ...base,
      provider: "codex",
      email: seed.email ?? "none@example.com",
      authMode: "oauth",
      apiBaseUrl: null,
      userId: null,
      plan: null,
      accountId: null,
      organizationId: null,
      quota: {
        hourlyRemainingPercent: null,
        hourlyResetAt: null,
        hourlyWindowMinutes: null,
        weeklyRemainingPercent: null,
        weeklyResetAt: null,
        weeklyWindowMinutes: null,
      },
    } as AccountSummary;
  }
  if (seed.provider === "opencode") {
    return {
      ...base,
      provider: "opencode",
      openCodeProviderId: seed.id,
      authType: "api",
      keyFingerprint: seed.keyFingerprint ?? null,
      displayLabel: seed.displayLabel ?? "OpenCode · test",
    } as AccountSummary;
  }
  if (seed.provider === "gjc") {
    return {
      ...base,
      provider: "gjc",
      gjcProviderId: seed.id,
      credentialKind: seed.keyFingerprint == null ? "oauth" : "api_key",
      credentialSource: "stored",
      displayLabel: seed.displayLabel ?? `GJC · ${seed.email ?? seed.id}`,
      email: seed.email ?? null,
      identityLabel: seed.email ?? null,
      keyFingerprint: seed.keyFingerprint ?? null,
    } as AccountSummary;
  }
  return {
    ...base,
    provider: seed.provider,
    ompProviderId: seed.id,
    accountKey: seed.email ?? seed.id,
    displayLabel: seed.displayLabel ?? `Agent · ${seed.email ?? seed.id}`,
    email: seed.email ?? null,
    keyFingerprint: seed.keyFingerprint ?? null,
  } as AccountSummary;
}

test("same email merges within one vendor across sources", () => {
  const entries = mergeAccountsByIdentity([
    summary({ id: "a", provider: "codex", email: "Me@Example.com" }),
    summary({
      id: "openai-codex",
      provider: "omp",
      email: "me@example.com",
    }),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.vendorLabel, "Codex");
  assert.equal(entries[0]?.sourcesLabel, "codex, omp");
  assert.equal(entries[0]?.identityLabel, "me@example.com");
  assert.equal(entries[0]?.title, "Codex (codex, omp) me@example.com");
  assert.equal(entries[0]?.accounts.length, 2);
});

test("same GJC identity merges with the native vendor", () => {
  const entries = mergeAccountsByIdentity([
    summary({ id: "a", provider: "codex", email: "Me@Example.com" }),
    summary({
      id: "openai-codex",
      provider: "gjc",
      email: "me@example.com",
      displayLabel: "ChatGPT Codex · me@example.com",
    }),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.vendorLabel, "Codex");
  assert.equal(entries[0]?.sourcesLabel, "codex, gjc");
  assert.equal(entries[0]?.identityLabel, "me@example.com");
});

test("same Cursor identity merges across native and GJC sources", () => {
  const entries = mergeAccountsByIdentity([
    summary({ id: "native", provider: "cursor", email: "me@example.com" }),
    summary({
      id: "cursor",
      provider: "gjc",
      email: "me@example.com",
      displayLabel: "Cursor · me@example.com",
    }),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.sourcesLabel, "cursor, gjc");
});

test("duplicate (provider, id) inputs collapse into one member", () => {
  const entries = mergeAccountsByIdentity([
    summary({ id: "c1", provider: "codex", email: "dup@example.com" }),
    summary({ id: "c1", provider: "codex", email: "dup@example.com" }),
    summary({
      id: "openai-codex",
      provider: "omp",
      email: "dup@example.com",
    }),
  ]);
  assert.equal(entries.length, 1);
  assert.deepEqual(
    entries[0]?.accounts.map((account) => [account.provider, account.id]),
    [
      ["codex", "c1"],
      ["omp", "openai-codex"],
    ],
  );
});

test("same email on different vendors never merges", () => {
  const entries = mergeAccountsByIdentity([
    summary({ id: "a", provider: "codex", email: "dup@x.y" }),
    summary({
      id: "xai-oauth",
      provider: "omp",
      email: "dup@x.y",
      displayLabel: "xAI Grok · dup@x.y",
    }),
  ]);
  assert.equal(entries.length, 2);
  const xai = entries.find((entry) => entry.providers[0] === "omp");
  assert.equal(xai?.vendorLabel, "xAI Grok");
  assert.equal(xai?.identityLabel, "dup@x.y");
});

test("same api-key fingerprint merges within one vendor; null never does", () => {
  const entries = mergeAccountsByIdentity([
    summary({ id: "zai", provider: "omp", keyFingerprint: "abc" }),
    summary({
      id: "zai-coding-plan",
      provider: "opencode",
      keyFingerprint: "abc",
    }),
    summary({ id: "xai", provider: "opencode", keyFingerprint: null }),
  ]);
  assert.equal(entries.length, 2);
  const merged = entries.find((entry) => entry.accounts.length === 2);
  assert.ok(merged !== undefined, "same-vendor fingerprint pair merged");
});

test("distinct identities stay separate and order by provider rank", () => {
  const entries = mergeAccountsByIdentity([
    summary({ id: "z", provider: "opencode", displayLabel: "Z.AI" }),
    summary({ id: "c", provider: "codex", email: "c@x.y" }),
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.providers[0], "codex");
  assert.equal(entries[1]?.providers[0], "opencode");
});

test("entries signed into more sources sort before single-source ones", () => {
  const entries = mergeAccountsByIdentity([
    summary({ id: "gh", provider: "githubCopilot", email: "gh@x.y" }),
    summary({ id: "a", provider: "codex", email: "Me@Example.com" }),
    summary({
      id: "openai-codex",
      provider: "omp",
      email: "me@example.com",
    }),
  ]);
  // The codex+omp identity has the later first-provider rank (codex vs
  // githubCopilot) but two sources, so it must lead the list.
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.sourcesLabel, "codex, omp");
  assert.equal(entries[1]?.providers[0], "githubCopilot");
});

test("worst remaining and attention flags aggregate members", () => {
  const entries = mergeAccountsByIdentity([
    summary({
      id: "a",
      provider: "codex",
      email: "dup@x.y",
      remainingPercent: 90,
    }),
    summary({
      id: "openai-codex",
      provider: "omp",
      email: "dup@x.y",
      remainingPercent: 12,
      status: "requiresReauthentication",
    }),
  ]);
  assert.equal(entries[0]?.worstRemainingPercent, 12);
  assert.equal(entries[0]?.needsAttention, true);
});

test("accounts without metrics report null remaining, not zero", () => {
  const entries = mergeAccountsByIdentity([
    summary({ id: "a", provider: "codex", email: "x@y.z" }),
  ]);
  assert.equal(entries[0]?.worstRemainingPercent, null);
  assert.equal(entries[0]?.needsAttention, false);
});

test("pinned marking flags entries with any pinned member", () => {
  const entries = mergeAccountsByIdentity([
    summary({ id: "a", provider: "codex", email: "x@y.z" }),
    summary({ id: "b", provider: "omp", email: "other@x.y" }),
  ]);
  const marked = markPinnedEntries(entries, ["b"]);
  assert.equal(marked[0]?.pinned, false);
  assert.equal(marked[1]?.pinned, true);
});

test("entry title carries masked api key and merged metric rows", () => {
  const entries = mergeAccountsByIdentity([
    summary({
      id: "zai-coding-plan",
      provider: "opencode",
      keyFingerprint: "d41d",
      displayLabel: "Z.AI Coding Plan · API: z3d..f9z",
      remainingPercent: 100,
    }),
  ]);
  assert.equal(entries[0]?.title, "Z.AI Coding Plan (opencode) API: z3d..f9z");
  assert.deepEqual(
    entries[0]?.metricRows.map((row) => row.remainingPercent),
    [100],
  );
});

test("duplicate metric labels collapse to the worst percent", () => {
  const entries = mergeAccountsByIdentity([
    summary({
      id: "a",
      provider: "codex",
      email: "dup@x.y",
      remainingPercent: 94,
    }),
    summary({
      id: "openai-codex",
      provider: "omp",
      email: "dup@x.y",
      remainingPercent: 50,
    }),
  ]);
  const labels = entries[0]?.metricRows.map((row) => row.remainingPercent);
  assert.deepEqual(labels, [50]);
});

test("omp and opencode accounts sharing one api key merge", () => {
  const entries = mergeAccountsByIdentity([
    summary({
      id: "zai",
      provider: "omp",
      keyFingerprint: "deadbeef",
      displayLabel: "Z.AI (GLM) · API: z3d..f9z",
    }),
    summary({
      id: "zai-coding-plan",
      provider: "opencode",
      keyFingerprint: "deadbeef",
      displayLabel: "Z.AI Coding Plan · API: z3d..f9z",
    }),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.sourcesLabel, "omp, opencode");
  assert.equal(entries[0]?.identityLabel, "API: z3d..f9z");
});

test("a gjc api-key fingerprint merges with the same key in other agents", () => {
  const entries = mergeAccountsByIdentity([
    summary({ id: "zai", provider: "opencode", keyFingerprint: "abc" }),
    summary({ id: "zai", provider: "gjc", keyFingerprint: "abc" }),
    summary({ id: "zai-other", provider: "gjc", keyFingerprint: null }),
  ]);
  assert.equal(entries.length, 2);
  const merged = entries.find((entry) => entry.providers.length === 2);
  assert.ok(merged != null);
  assert.deepEqual(merged.providers, ["gjc", "opencode"]);
  // The identity-less gjc row without a fingerprint never folds in.
  const single = entries.find((entry) => entry.providers.length === 1);
  assert.ok(single != null);
  assert.deepEqual(single.providers, ["gjc"]);
});

test("metric rows carry the reset time of their worst member", () => {
  const entries = mergeAccountsByIdentity([
    summary({
      id: "a",
      provider: "codex",
      email: "dup@x.y",
      remainingPercent: 90,
      resetAt: 1_700_999_000_000,
    }),
    summary({
      id: "openai-codex",
      provider: "omp",
      email: "dup@x.y",
      remainingPercent: 40,
      resetAt: 1_700_111_000_000,
    }),
  ]);
  const row = entries[0]?.metricRows[0];
  assert.equal(row?.remainingPercent, 40);
  assert.equal(row?.resetAt, 1_700_111_000_000);
});

test("null-percent metric rows are dropped from merged entries", () => {
  const entries = mergeAccountsByIdentity([
    summary({
      id: "a",
      provider: "codex",
      email: "x@y.z",
      remainingPercent: 55,
    }),
    summary({ id: "b", provider: "antigravity", email: "other@x.y" }),
  ]);
  // The antigravity account's metrics are all null-percent; its entry
  // renders no inline rows instead of four "--" placeholders.
  const antigravity = entries.find((e) => e.providers[0] === "antigravity");
  assert.equal(antigravity?.metricRows.length, 0);
  assert.equal(entries[0]?.metricRows.length, 1);
});

test("stale usage cannot override a newer snapshot of the same vendor identity", () => {
  const fresh = summary({
    id: "native",
    provider: "codex",
    email: "same@example.com",
    remainingPercent: 90,
    resetAt: 3_000_000,
    usageUpdatedAt: 2_000_000,
  });
  const stale = summary({
    id: "openai-codex",
    provider: "omp",
    email: "same@example.com",
    remainingPercent: 0,
    resetAt: 1_000_000,
    usageUpdatedAt: 1_399_999,
    status: "requiresReauthentication",
  });
  const [entry] = mergeAccountsByIdentity([stale, fresh]);
  assert.deepEqual(entry?.metricRows, [
    { label: "usage", remainingPercent: 90, resetAt: 3_000_000 },
  ]);
  assert.equal(entry?.worstRemainingPercent, 90);
  // Filtering usage must not prevent managing the old source or hide auth errors.
  assert.equal(entry?.accounts.length, 2);
  assert.equal(entry?.needsAttention, true);
});

test("usage at the ten-minute boundary still contributes conservatively", () => {
  const [entry] = mergeAccountsByIdentity([
    summary({
      id: "native",
      provider: "codex",
      remainingPercent: 90,
      usageUpdatedAt: 2_000_000,
    }),
    summary({
      id: "older",
      provider: "codex",
      remainingPercent: 20,
      usageUpdatedAt: 1_400_000,
      resetAt: 3_000_000,
    }),
  ]);
  assert.equal(entry?.worstRemainingPercent, 20);
  assert.deepEqual(entry?.metricRows, [
    { label: "usage", remainingPercent: 20, resetAt: 3_000_000 },
  ]);
});

test("unknown usage age is ignored only when the same identity has dated usage", () => {
  const unknown = summary({
    id: "unknown",
    provider: "codex",
    usageUpdatedAt: null,
    remainingPercent: 0,
  });
  const dated = summary({
    id: "dated",
    provider: "codex",
    usageUpdatedAt: 0,
    remainingPercent: 80,
  });
  assert.equal(
    mergeAccountsByIdentity([unknown, dated])[0]?.worstRemainingPercent,
    80,
  );
  assert.equal(mergeAccountsByIdentity([unknown])[0]?.worstRemainingPercent, 0);
});

test("newer usage for another vendor or identity never suppresses old usage", () => {
  const entries = mergeAccountsByIdentity([
    summary({
      id: "old",
      provider: "codex",
      email: "old@example.com",
      usageUpdatedAt: 1,
      remainingPercent: 5,
    }),
    summary({
      id: "new",
      provider: "codex",
      email: "new@example.com",
      usageUpdatedAt: 2_000_000,
      remainingPercent: 90,
    }),
    summary({
      id: "xai-oauth",
      provider: "omp",
      email: "old@example.com",
      usageUpdatedAt: 2_000_000,
      remainingPercent: 80,
    }),
  ]);
  assert.equal(
    entries.find((entry) =>
      entry.accounts.some((account) => account.id === "old"),
    )?.worstRemainingPercent,
    5,
  );
});

test("duplicate account records use newest usage regardless of input order", () => {
  const old = summary({
    id: "same",
    provider: "codex",
    usageUpdatedAt: null,
    remainingPercent: 0,
  });
  const fresh = summary({
    id: "same",
    provider: "codex",
    usageUpdatedAt: 2_000_000,
    remainingPercent: 75,
  });
  for (const accounts of [
    [old, fresh],
    [fresh, old],
  ]) {
    const [entry] = mergeAccountsByIdentity(accounts);
    assert.equal(entry?.accounts.length, 1);
    assert.equal(entry?.worstRemainingPercent, 75);
  }
});

test("antigravity CLI staleness warns only for old manual-only data", () => {
  const now = 10 * 3_600_000;
  const fresh = antigravityCliStaleText(
    summary({
      id: "ag",
      provider: "antigravity",
      source: "cli",
      usageUpdatedAt: now - ANTIGRAVITY_CLI_STALE_MS + 1,
    }),
    now,
  );
  assert.equal(fresh, null);

  const stale = antigravityCliStaleText(
    summary({
      id: "ag",
      provider: "antigravity",
      source: "cli",
      usageUpdatedAt: now - 2 * 3_600_000,
    }),
    now,
  );
  assert.match(stale ?? "", /stale \(2\.0h old\)/);

  const never = antigravityCliStaleText(
    summary({
      id: "ag",
      provider: "antigravity",
      source: "cli",
      usageUpdatedAt: null,
    }),
    now,
  );
  assert.match(never ?? "", /not fetched yet/);

  // OAuth-sourced and non-antigravity accounts never warn.
  assert.equal(
    antigravityCliStaleText(
      summary({
        id: "ag",
        provider: "antigravity",
        source: "oauth",
        usageUpdatedAt: null,
      }),
      now,
    ),
    null,
  );
  assert.equal(
    antigravityCliStaleText(
      summary({ id: "cx", provider: "codex", usageUpdatedAt: 1 }),
      now,
    ),
    null,
  );
});
