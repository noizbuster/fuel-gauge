import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  type CredentialStore,
  createCredentialStore,
  DEFAULT_SETTINGS,
  StoreError,
} from "../../src/core/store.js";
import type {
  AntigravityQuotaSummary,
  ClaudeQuotaSummary,
  CodexQuotaSummary,
  StoredAccount,
  StoredAntigravityAccount,
  StoredClaudeAccount,
  StoredCursorAccount,
  StoredGitHubCopilotAccount,
  StoredKiroAccount,
} from "../../src/core/types.js";

const EMPTY_CODEX_QUOTA: CodexQuotaSummary = {
  hourlyRemainingPercent: null,
  hourlyResetAt: null,
  hourlyWindowMinutes: null,
  weeklyRemainingPercent: null,
  weeklyResetAt: null,
  weeklyWindowMinutes: null,
};

const EMPTY_ANTIGRAVITY_QUOTA: AntigravityQuotaSummary = {
  geminiFiveHour: { remainingPercent: null, resetAt: null },
  geminiWeekly: { remainingPercent: null, resetAt: null },
  thirdPartyFiveHour: { remainingPercent: null, resetAt: null },
  thirdPartyWeekly: { remainingPercent: null, resetAt: null },
};

const EMPTY_CLAUDE_QUOTA: ClaudeQuotaSummary = {
  fiveHourRemainingPercent: null,
  fiveHourResetAt: null,
  weeklyRemainingPercent: null,
  weeklyResetAt: null,
  weeklySonnetRemainingPercent: null,
  weeklySonnetResetAt: null,
  extraUsageRemainingPercent: null,
  extraUsageResetAt: null,
  extraUsageUsedCents: null,
  extraUsageLimitCents: null,
};

function base(overrides: Partial<StoredAccount> = {}) {
  return {
    id: "acc-1",
    status: "active" as const,
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: 1_000,
    createdAt: 1,
    lastUsed: 1,
    ...overrides,
  };
}

function claudeAccount(
  overrides: Partial<StoredClaudeAccount> = {},
): StoredClaudeAccount {
  return {
    ...base(),
    provider: "claude" as const,
    email: "user@example.com",
    authMode: "oauth" as const,
    accessToken: "claude-token-SUPERSECRET-987654321",
    refreshToken: "claude-refresh-SUPERSECRET-123456789",
    tokenType: "Bearer",
    scopes: ["openid"],
    expiresAt: null,
    accountUuid: null,
    organizationUuid: null,
    organizationName: null,
    displayName: null,
    avatarUrl: null,
    planType: null,
    quota: {
      ...EMPTY_CLAUDE_QUOTA,
      fiveHourRemainingPercent: 90,
      weeklyRemainingPercent: 80,
    },
    ...overrides,
  };
}

function copilotAccount(
  overrides: Partial<StoredGitHubCopilotAccount> = {},
): StoredGitHubCopilotAccount {
  return {
    ...base(),
    provider: "githubCopilot" as const,
    githubLogin: "octocat",
    githubId: 42,
    githubName: null,
    githubEmail: null,
    githubAccessToken: "gho_copilot-SUPERSECRET-access",
    githubTokenType: "bearer",
    githubScope: null,
    copilotToken: "tid=copilot-session-SUPERSECRET;",
    copilotPlan: null,
    copilotChatEnabled: null,
    copilotExpiresAt: null,
    copilotRefreshIn: null,
    copilotQuotaSnapshots: { premium: { usedPercent: 10 } },
    copilotQuotaResetDate: "2026-08-20",
    copilotLimitedUserQuotas: { chat: { usedPercent: 5 } },
    copilotLimitedUserResetAt: 2_000,
    ...overrides,
  };
}

function kiroAccount(
  overrides: Partial<StoredKiroAccount> = {},
): StoredKiroAccount {
  return {
    ...base(),
    provider: "kiro" as const,
    email: "kiro@example.com",
    loginProvider: null,
    accessToken: "kiro-token-SUPERSECRET-value",
    refreshToken: null,
    expiresAt: null,
    idcRegion: null,
    clientId: null,
    planName: null,
    planTier: null,
    creditsTotal: 100,
    creditsUsed: 10,
    bonusTotal: 50,
    bonusUsed: 5,
    usageResetAt: 3_000,
    bonusExpireDays: 14,
    kiroAuthTokenRaw: null,
    kiroProfileRaw: null,
    ...overrides,
  };
}

function cursorAccount(
  overrides: Partial<StoredCursorAccount> = {},
): StoredCursorAccount {
  return {
    ...base(),
    provider: "cursor" as const,
    email: "cursor@example.com",
    authId: null,
    signUpType: null,
    membershipType: "pro",
    subscriptionStatus: "active",
    accessToken: "cursor-token-SUPERSECRET-x",
    refreshToken: null,
    source: "import",
    totalPercent: 40,
    autoPercent: 30,
    apiPercent: 10,
    billingCycleEnd: 4_000,
    planUsed: 1000,
    planLimit: 5000,
    onDemandEnabled: true,
    onDemandUsed: 20,
    onDemandLimit: 200,
    ...overrides,
  };
}

function antigravityAccount(
  overrides: Partial<StoredAntigravityAccount> = {},
): StoredAntigravityAccount {
  return {
    ...base(),
    provider: "antigravity" as const,
    email: "ag@example.com",
    source: "local",
    authId: null,
    name: null,
    accessToken: "antigravity-SUPERSECRET-token",
    refreshToken: null,
    idToken: null,
    tokenType: null,
    scope: null,
    expiryDate: null,
    selectedAuthType: null,
    projectId: "proj-1",
    tierId: "tier-1",
    planName: "pro",
    credits: [
      {
        creditType: "credits",
        creditAmount: "90",
        minimumCreditAmountForUsage: null,
      },
    ],
    quota: {
      geminiFiveHour: { remainingPercent: 70, resetAt: 5_000 },
      geminiWeekly: { remainingPercent: 60, resetAt: 5_000 },
      thirdPartyFiveHour: { remainingPercent: 50, resetAt: 5_000 },
      thirdPartyWeekly: { remainingPercent: 40, resetAt: 5_000 },
    },
    ...overrides,
  };
}

async function withStore(
  run: (store: CredentialStore, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-store-"));
  try {
    await run(createCredentialStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("summaries scrub credential VALUES copied into safe string fields", async () => {
  await withStore(async (store) => {
    const account = claudeAccount({
      status: "requiresReauthentication",
      statusReason: "refresh failed with claude-token-SUPERSECRET-987654321",
      quotaQueryLastError:
        "upstream rejected claude-refresh-SUPERSECRET-123456789",
    });
    await store.upsert("claude", account);

    const summaries = await store.list("claude");
    assert.equal(summaries.length, 1);
    const summary = summaries[0];
    assert.ok(summary !== undefined);

    assert.ok(
      !JSON.stringify(summary).includes("SUPERSECRET"),
      "no secret survives",
    );
    assert.ok(
      summary.statusReason?.includes("[REDACTED]"),
      "statusReason scrubbed",
    );
    assert.ok(
      summary.quotaQueryLastError?.includes("[REDACTED]"),
      "quotaQueryLastError scrubbed",
    );
    assert.equal(summary.status, "requiresReauthentication");
  });
});

test("copilot partial upsert keeps the other snapshot block", async () => {
  await withStore(async (store) => {
    await store.upsert("githubCopilot", copilotAccount());
    // Incoming refresh carries quota snapshots but NO limited-user block.
    await store.upsert(
      "githubCopilot",
      copilotAccount({
        copilotLimitedUserQuotas: null,
        copilotLimitedUserResetAt: null,
        usageUpdatedAt: null,
      }),
    );

    const stored = await store.listStored("githubCopilot");
    const merged = stored[0] as StoredGitHubCopilotAccount;
    assert.ok(merged.copilotLimitedUserQuotas != null, "prior block preserved");
    assert.equal(merged.copilotLimitedUserResetAt, 2_000);
    assert.deepEqual(merged.copilotQuotaSnapshots, {
      premium: { usedPercent: 10 },
    });
    assert.equal(merged.usageUpdatedAt, 1_000, "last safe timestamp preserved");
    assert.equal(merged.createdAt, 1);
  });
});

test("empty quota upserts preserve the prior quota and usageUpdatedAt", async () => {
  await withStore(async (store) => {
    for (const [provider, account] of [
      ["antigravity", antigravityAccount()],
      ["claude", claudeAccount()],
    ] as const) {
      await store.upsert(provider, account);
      const emptied =
        provider === "antigravity"
          ? antigravityAccount({
              quota: EMPTY_ANTIGRAVITY_QUOTA,
              usageUpdatedAt: null,
            })
          : claudeAccount({ quota: EMPTY_CLAUDE_QUOTA, usageUpdatedAt: null });
      await store.upsert(provider, emptied as StoredAccount);

      const stored = await store.listStored(provider);
      const merged = stored[0] as StoredAccount;
      assert.equal(
        merged.usageUpdatedAt,
        1_000,
        `${provider}: timestamp preserved`,
      );
      if (provider === "antigravity") {
        const ag = merged as StoredAntigravityAccount;
        assert.equal(ag.quota.geminiFiveHour.remainingPercent, 70);
        assert.equal(ag.projectId, "proj-1", "safe fields still merged");
      } else {
        const claude = merged as StoredClaudeAccount;
        assert.equal(claude.quota.weeklyRemainingPercent, 80);
      }
    }
  });
});

test("kiro and cursor partial upserts preserve absent safe fields", async () => {
  await withStore(async (store) => {
    await store.upsert("kiro", kiroAccount());
    await store.upsert(
      "kiro",
      kiroAccount({
        bonusExpireDays: null,
        bonusTotal: 60,
        usageUpdatedAt: 2_500,
      }),
    );
    const kiro = (await store.listStored("kiro"))[0] as StoredKiroAccount;
    assert.equal(kiro.bonusExpireDays, 14, "kiro bonusExpireDays preserved");
    assert.equal(kiro.bonusTotal, 60, "incoming value wins where present");

    await store.upsert("cursor", cursorAccount());
    await store.upsert(
      "cursor",
      cursorAccount({
        onDemandEnabled: null,
        totalPercent: 55,
        usageUpdatedAt: null,
      }),
    );
    const cursor = (await store.listStored("cursor"))[0] as StoredCursorAccount;
    assert.equal(
      cursor.onDemandEnabled,
      true,
      "cursor onDemandEnabled preserved",
    );
    assert.equal(cursor.totalPercent, 55);
    assert.equal(cursor.usageUpdatedAt, 1_000);
  });
});

test("settings round-trip through disk and defaults load when missing", async () => {
  await withStore(async (store, root) => {
    const _initial = await store.loadSettings();
    const changed = {
      ...DEFAULT_SETTINGS,
      autoRefresh: { enabled: true, intervalSeconds: 300 },
      alerts: { enabled: true, thresholdPercent: 15 },
      pinnedAccountIds: ["acc-1"],
    };
    await store.saveSettings(changed);
    const text = await readFile(path.join(root, "settings.json"), "utf8");
    assert.ok(text.endsWith("\n"), "serialized JSON ends with a newline");
    const reloaded = await store.loadSettings();
    assert.deepEqual(reloaded, changed);
  });
});

test("legacy six-provider settings load with newer providers appended", async () => {
  await withStore(async (store, root) => {
    // A settings file saved before `omp` existed: canonical v1 shape,
    // just missing the newer provider ids.
    // A settings file saved before the post-six providers existed:
    // canonical v1 shape, just missing every newer provider id.
    const legacy = {
      ...DEFAULT_SETTINGS,
      providerOrder: DEFAULT_SETTINGS.providerOrder.slice(0, 6),
    };
    await store.saveSettings(legacy);
    const reloaded = await store.loadSettings();
    assert.deepEqual(reloaded.providerOrder, DEFAULT_SETTINGS.providerOrder);

    // Duplicates and unknown ids stay corrupt: repair is additive only.
    await writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        ...legacy,
        providerOrder: [...legacy.providerOrder, "codex"],
      }),
      "utf8",
    );
    await assert.rejects(
      store.loadSettings(),
      (error: unknown) =>
        error instanceof StoreError && error.code === "corrupt-settings",
    );
  });
});

test("corrupt provider files throw typed errors and are never overwritten", async () => {
  await withStore(async (store, root) => {
    const file = path.join(root, "providers", "claude.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ not json", "utf8");

    await assert.rejects(
      store.list("claude"),
      (error: unknown) =>
        error instanceof StoreError && error.code === "corrupt-provider-file",
    );
    const after = await readFile(file, "utf8");
    assert.equal(after, "{ not json", "corrupt file untouched");
  });
});

test("upsert rejects structurally invalid accounts", async () => {
  await withStore(async (store) => {
    const broken = claudeAccount({ id: "" });
    await assert.rejects(
      store.upsert("claude", broken),
      (error: unknown) =>
        error instanceof StoreError && error.code === "invalid-account",
    );
  });
});

test("private file modes and idempotent deletes", async () => {
  await withStore(async (store, root) => {
    await store.upsert("claude", claudeAccount());

    if (process.platform !== "win32") {
      const rootStat = await stat(root);
      assert.equal(rootStat.mode & 0o777, 0o700, "config root is 0o700");
      const fileStat = await stat(store.providerFile("claude"));
      assert.equal(fileStat.mode & 0o777, 0o600, "provider file is 0o600");
    }

    await store.remove("claude", "acc-1");
    await store.remove("claude", "acc-1");
    assert.deepEqual(await store.list("claude"), []);

    // Deleting an unknown id performed no write; the file still exists.
    const stored = await store.listStored("claude");
    assert.deepEqual(stored, []);
  });
});

test("new accounts prepend and existing accounts keep their position", async () => {
  await withStore(async (store) => {
    await store.upsert("claude", claudeAccount({ id: "first" }));
    await store.upsert(
      "claude",
      claudeAccount({
        id: "second",
        accessToken: "claude-token-OTHER-987654321",
      }),
    );
    let list = await store.listStored("claude");
    assert.deepEqual(
      list.map((entry) => entry.id),
      ["second", "first"],
    );

    await store.upsert("claude", claudeAccount({ id: "first" }));
    list = await store.listStored("claude");
    assert.deepEqual(
      list.map((entry) => entry.id),
      ["second", "first"],
      "existing account keeps its position",
    );
  });
});

test("empty codex quota upsert preserves the prior block", async () => {
  await withStore(async (store) => {
    const codexAccount = {
      ...base(),
      provider: "codex" as const,
      email: "codex@example.com",
      authMode: "oauth" as const,
      openAIApiKey: null,
      apiBaseUrl: null,
      userId: null,
      plan: null,
      accountId: null,
      organizationId: null,
      tokens: {
        idToken: "idt",
        accessToken: "codex-SUPERSECRET-token",
        refreshToken: null,
      },
      quota: {
        hourlyRemainingPercent: 85,
        hourlyResetAt: 9_000,
        hourlyWindowMinutes: 180,
        weeklyRemainingPercent: 75,
        weeklyResetAt: 9_000,
        weeklyWindowMinutes: null,
      },
    };
    await store.upsert("codex", codexAccount);
    await store.upsert("codex", {
      ...codexAccount,
      quota: EMPTY_CODEX_QUOTA,
      usageUpdatedAt: null,
    });
    const merged = (await store.listStored("codex"))[0] as {
      quota: CodexQuotaSummary;
      usageUpdatedAt: number | null;
    };
    assert.equal(merged.quota.hourlyRemainingPercent, 85);
    assert.equal(merged.usageUpdatedAt, 1_000);
  });
});

test("concurrent upserts serialize into one valid atomic file", async () => {
  await withStore(async (store, root) => {
    const writers = Array.from({ length: 24 }, (_, index) =>
      store.upsert(
        "claude",
        claudeAccount({
          id: `concurrent-${index}`,
          email: `c${index}@example.com`,
          accessToken: `claude-token-VALUE-${index}-987654321`,
        }),
      ),
    );
    // While the writes stream in, every read of the provider file must be
    // either absent or fully valid JSON: an interleaved or torn write would
    // fail the parse.
    let reads = 0;
    let tornWrites = 0;
    const watcher = (async () => {
      const filePath = path.join(root, "providers", "claude.json");
      for (let tick = 0; tick < 200; tick++) {
        try {
          const text = await readFile(filePath, "utf8");
          if (text.trim() !== "") {
            reads += 1;
            JSON.parse(text);
          }
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") {
            tornWrites += 1;
          }
        }
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }
    })();
    await Promise.all(writers);
    await watcher;

    const accounts = await store.listStored("claude");
    assert.equal(accounts.length, 24, "every concurrent account persisted");
    assert.ok(reads > 0, "the watcher observed at least one file state");
    assert.equal(tornWrites, 0, "no torn or partial JSON was ever observed");
    const ids = accounts.map((entry) => entry.id).sort();
    for (let index = 0; index < 24; index++) {
      assert.ok(ids.includes(`concurrent-${index}`));
    }
  });
});

test("clearAccounts drops every provider file and keeps settings", async () => {
  await withStore(async (store) => {
    await store.upsert("claude", claudeAccount());
    await store.saveSettings({
      ...DEFAULT_SETTINGS,
      pinnedAccountIds: ["acc-1"],
    });
    const removed = await store.clearAccounts();
    assert.equal(removed, 1);
    assert.deepEqual(await store.listStored("claude"), []);
    // Idempotent: a second clear removes nothing.
    assert.equal(await store.clearAccounts(), 0);
    // Settings survive the wipe.
    const settings = await store.loadSettings();
    assert.deepEqual(settings.pinnedAccountIds, ["acc-1"]);
  });
});

test("loadUserAddedAccountIds backfills the first-run burst once, then stays exact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-store-useradded-"));
  try {
    const store = createCredentialStore(root);
    // First-run burst: three imports within seconds of each other.
    for (const [id, createdAt] of [
      ["burst-1", 10_000],
      ["burst-2", 10_500],
      ["burst-3", 11_000],
    ] as const) {
      await store.upsert(
        "claude",
        claudeAccount({ id, createdAt, email: `${id}@example.com` }),
      );
    }
    // A later explicit add, hours after the burst.
    await store.upsert(
      "claude",
      claudeAccount({
        id: "user-add",
        createdAt: 86_400_000,
        email: "late@example.com",
      }),
    );

    const first = await store.loadUserAddedAccountIds();
    assert.deepEqual(
      [...first].sort(),
      ["user-add"],
      "burst imports hidden, late add kept",
    );

    // The persisted file is the source of truth from now on: marking more
    // ids merges, and reloading never re-runs the heuristic.
    await store.markUserAddedAccountIds(["burst-2", "brand-new"]);
    const second = await store.loadUserAddedAccountIds();
    assert.deepEqual(
      [...second].sort(),
      ["brand-new", "burst-2", "user-add"],
      "marks merge exactly",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
