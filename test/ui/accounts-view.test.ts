import assert from "node:assert/strict";
import test from "node:test";

import type { AccountSummary, ProviderId } from "../../src/core/types.js";
import {
  markPinnedEntries,
  mergeAccountsByIdentity,
} from "../../src/ui/accounts-view.js";

interface AccountSeed {
  id: string;
  provider: ProviderId;
  email?: string | null;
  keyFingerprint?: string | null;
  displayLabel?: string;
  remainingPercent?: number | null;
  resetAt?: number | null;
  status?: "active" | "requiresReauthentication";
}

function summary(seed: AccountSeed): AccountSummary {
  const base = {
    id: seed.id,
    status: seed.status ?? "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: 1,
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
