import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  AUTH_ALREADY_IN_PROGRESS,
  CLAUDE_COOLDOWN_NOTICE,
  CLAUDE_DISABLED_REASON,
  clampIntervalSeconds,
  MonitorController,
} from "../../src/core/monitor.js";
import { DEFAULT_SETTINGS } from "../../src/core/store.js";
import { createManualClock } from "../../src/core/time.js";
import type {
  AccountSummary,
  ProviderId,
  StoredClaudeAccount,
  StoredCodexAccount,
} from "../../src/core/types.js";
import type {
  AuthFlow,
  ProviderAdapter,
  ProviderRegistry,
} from "../../src/providers/provider.js";
import type { Runtime } from "../../src/runtime.js";
import { createRuntime } from "../../src/runtime.js";

const EMPTY_CLAUDE_QUOTA = {
  fiveHourRemainingPercent: 30,
  fiveHourResetAt: null,
  weeklyRemainingPercent: 60,
  weeklyResetAt: null,
  weeklySonnetRemainingPercent: null,
  weeklySonnetResetAt: null,
  extraUsageRemainingPercent: null,
  extraUsageResetAt: null,
  extraUsageUsedCents: null,
  extraUsageLimitCents: null,
};

function claudeStored(id: string): StoredClaudeAccount {
  return {
    provider: "claude",
    id,
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: 1,
    createdAt: 1,
    lastUsed: 1,
    email: `${id}@example.com`,
    authMode: "oauth",
    accessToken: "token-value-123456",
    refreshToken: null,
    tokenType: null,
    scopes: [],
    expiresAt: null,
    accountUuid: null,
    organizationUuid: null,
    organizationName: null,
    displayName: null,
    avatarUrl: null,
    planType: null,
    quota: EMPTY_CLAUDE_QUOTA,
  };
}

function codexStoredAccount(id: string): StoredCodexAccount {
  return {
    provider: "codex",
    id,
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: 1,
    createdAt: 1,
    lastUsed: 1,
    email: `${id}@example.com`,
    authMode: "oauth",
    openAIApiKey: null,
    apiBaseUrl: null,
    userId: null,
    plan: null,
    accountId: null,
    organizationId: null,
    tokens: null,
    quota: {
      hourlyRemainingPercent: 60,
      hourlyResetAt: null,
      hourlyWindowMinutes: 180,
      weeklyRemainingPercent: null,
      weeklyResetAt: null,
      weeklyWindowMinutes: null,
    },
  };
}

function codexRefreshedSummary(id: string): AccountSummary {
  const stored = codexStoredAccount(id);
  return {
    provider: "codex",
    id: stored.id,
    status: stored.status,
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: stored.usageUpdatedAt,
    createdAt: stored.createdAt,
    lastUsed: stored.lastUsed,
    email: stored.email,
    authMode: stored.authMode,
    apiBaseUrl: null,
    userId: null,
    plan: null,
    accountId: null,
    organizationId: null,
    quota: stored.quota,
    metrics: [],
  };
}

function claudeSummary(id: string): AccountSummary {
  const stored = claudeStored(id);
  return {
    provider: "claude",
    id,
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: 1,
    createdAt: 1,
    lastUsed: 1,
    metrics: [
      {
        id: "claude.fiveHour",
        label: "5h usage",
        remainingPercent: 30,
        used: null,
        total: null,
        resetAt: null,
      },
    ],
    email: stored.email,
    authMode: "oauth",
    accountUuid: null,
    organizationUuid: null,
    organizationName: null,
    displayName: null,
    avatarUrl: null,
    planType: null,
    quota: EMPTY_CLAUDE_QUOTA,
  } satisfies AccountSummary;
}

interface AdapterCalls {
  refreshAll: number;
  removes: string[];
  authCancels: number;
}

function fakeAdapters(
  calls: AdapterCalls,
  behavior: {
    refresh?: (
      provider: ProviderId,
    ) => AccountSummary[] | Promise<AccountSummary[]>;
    beginAuth?: () => AuthFlow | Promise<AuthFlow>;
    discover?: (signal: AbortSignal) => Promise<never>;
    remove?: (accountId: string) => Promise<void>;
  } = {},
): ProviderRegistry {
  const adapter: ProviderAdapter = {
    list: async () => [],
    discoverImports: async (signal: AbortSignal) => {
      if (behavior.discover !== undefined) {
        await behavior.discover(signal);
      }
      return [];
    },
    import: async () => [],
    beginAuth: async (signal: AbortSignal) => {
      const flow: AuthFlow =
        behavior.beginAuth !== undefined
          ? await behavior.beginAuth()
          : {
              provider: "claude",
              mode: "manualCode",
              authUrl: "https://auth.example/claude",
              callbackUrl: "https://callback.example/done",
              expiresAt: Number.MAX_SAFE_INTEGER,
              result: Promise.withResolvers<AccountSummary[]>().promise,
              submit: async () => {},
              cancel: async () => {
                calls.authCancels += 1;
                void signal;
              },
            };
      return flow;
    },
    refresh: async () => claudeSummary("claude-1"),
    refreshAll: async () => {
      calls.refreshAll += 1;
      const provider: ProviderId = "claude";
      return behavior.refresh !== undefined
        ? behavior.refresh(provider)
        : [claudeSummary("claude-1")];
    },
    remove: async (accountId: string) => {
      if (behavior.remove !== undefined) {
        await behavior.remove(accountId);
      }
      calls.removes.push(accountId);
    },
  };
  const registry: Partial<Record<ProviderId, ProviderAdapter>> = {};
  for (const provider of [
    "githubCopilot",
    "codex",
    "antigravity",
    "claude",
    "kiro",
    "cursor",
    "omp",
    "opencode",
    "fuelGauge",
  ] as const) {
    registry[provider] = {
      ...adapter,
      refreshAll: async () => {
        calls.refreshAll += 1;
        return behavior.refresh !== undefined
          ? behavior.refresh(provider)
          : [claudeSummary("claude-1")];
      },
    };
  }
  return registry as ProviderRegistry;
}

async function withRuntime(
  adapters: ProviderRegistry,
  run: (runtime: Runtime) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-monitor-"));
  try {
    const runtime = createRuntime({ configRoot: root, adapters });
    await runtime.store.upsert("claude", claudeStored("claude-1"));
    await run(runtime);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function settle(): Promise<void> {
  // Let detached monitor sequences (startup refresh, auto ticks) finish.
  for (let i = 0; i < 50; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

test("interval clamping keeps 30-3600 with 600 default", () => {
  assert.equal(clampIntervalSeconds(120), 120);
  assert.equal(clampIntervalSeconds(10), 30);
  assert.equal(clampIntervalSeconds(0), 30);
  assert.equal(clampIntervalSeconds(-5), 30);
  assert.equal(clampIntervalSeconds(9999), 3600);
  assert.equal(clampIntervalSeconds(Number.NaN), 600);
  assert.equal(clampIntervalSeconds(Number.POSITIVE_INFINITY), 600);
});

test("cached summaries publish first, then the silent startup refresh", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  await withRuntime(fakeAdapters(calls), async (runtime) => {
    const controller = new MonitorController({
      runtime,
      settings: {
        ...DEFAULT_SETTINGS,
        claudePolicyAccepted: true,
      },
      clock: createManualClock(1_000).clock,
    });
    const seen: { refreshes: number; claudeAccounts: number }[] = [];
    controller.subscribe(() => {
      seen.push({
        refreshes: calls.refreshAll,
        claudeAccounts:
          controller.getSnapshot().providers.get("claude")?.accounts.length ??
          -1,
      });
    });

    await controller.start();
    await settle();
    // The cached claude account was visible BEFORE any adapter refresh ran.
    const beforeFirstRefresh = seen.find(
      (entry) => entry.refreshes === 0 && entry.claudeAccounts === 1,
    );
    assert.ok(
      beforeFirstRefresh !== undefined,
      "cached account published first",
    );
    assert.equal(
      calls.refreshAll,
      1,
      "startup refresh touched only non-empty providers",
    );

    const snapshot = controller.getSnapshot();
    for (const provider of snapshot.providers.keys()) {
      const state = snapshot.providers.get(provider);
      assert.ok(state !== undefined);
      assert.equal(state.phase, "idle");
    }
    assert.equal(controller.getSnapshot().busy, false);
    await controller.dispose();
  });
});

test("global lock: r and R during a refresh are ignored (no overlap)", {
  timeout: 5_000,
}, async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  const gate = Promise.withResolvers<void>();
  // Resolved INSIDE the first gated refresh callback, so awaiting it
  // proves the sequence actually reached the adapter — no fixed settle
  // window that can observe busy=false before the refresh begins.
  const started = Promise.withResolvers<void>();
  await withRuntime(
    fakeAdapters(calls, {
      refresh: () => {
        if (calls.refreshAll === 1) {
          started.resolve();
          return gate.promise.then(() => [claudeSummary("claude-1")]);
        }
        return [claudeSummary("claude-1")];
      },
    }),
    async (runtime) => {
      const controller = new MonitorController({
        runtime,
        settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: true },
        clock: createManualClock().clock,
      });
      const done = controller.start();
      await started.promise;

      assert.equal(
        controller.getSnapshot().busy,
        true,
        "lock held mid-refresh",
      );
      await controller.refreshSelected("claude");
      await controller.refreshAll();
      assert.equal(
        calls.refreshAll <= 1,
        true,
        "manual refreshes while busy are dropped",
      );

      gate.resolve();
      await done;
      await settle();
      assert.equal(controller.getSnapshot().busy, false);
      await controller.dispose();
    },
  );
});

test("r refreshes only the selected provider; empty and disabled are skipped", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  const perProvider = new Map<ProviderId, number>();
  await withRuntime(
    fakeAdapters(calls, {
      refresh: (provider) => {
        perProvider.set(provider, (perProvider.get(provider) ?? 0) + 1);
        return [];
      },
    }),
    async (runtime) => {
      const controller = new MonitorController({
        runtime,
        settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: false },
        clock: createManualClock().clock,
      });
      await controller.start();
      await settle();
      perProvider.clear();
      await controller.refreshSelected("claude");
      assert.equal(
        perProvider.has("claude"),
        false,
        "claude disabled pre-policy",
      );

      // Cursor has no accounts at all.
      await controller.refreshSelected("cursor");
      assert.equal(perProvider.has("cursor"), false, "empty provider skipped");

      await controller.dispose();
    },
  );
});

test("failed refresh keeps cached summaries and records the error", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  await withRuntime(
    fakeAdapters(calls, {
      refresh: () => {
        throw new Error("upstream 503");
      },
    }),
    async (runtime) => {
      const controller = new MonitorController({
        runtime,
        settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: true },
        clock: createManualClock().clock,
      });
      await controller.start();
      await settle();
      const state = controller.getSnapshot().providers.get("claude");
      assert.ok(state !== undefined);
      assert.equal(state.accounts.length, 1, "cached account retained");
      assert.equal(state.error, "upstream 503");
      assert.equal(state.phase, "idle", "silent startup refresh stays quiet");

      await controller.dispose();
    },
  );
});

test("claude keeps a 180s minimum gap between auto refreshes", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  await withRuntime(fakeAdapters(calls), async (runtime) => {
    const manual = createManualClock(0);
    const controller = new MonitorController({
      runtime,
      settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: true },
      clock: manual.clock,
    });
    await controller.start();
    await settle();
    calls.refreshAll = 0;

    // Startup refreshed claude at t=0; ticks at 30s/60s stay inside the gap.
    controller.configureAutoRefresh(true, 30);
    manual.advance(30_000);
    await settle();
    assert.equal(calls.refreshAll, 0, "first tick inside the 180s gap");

    manual.advance(30_000);
    await settle();
    assert.equal(calls.refreshAll, 0, "second tick still inside the gap");

    manual.advance(120_000);
    await settle();
    assert.equal(calls.refreshAll, 1, "after 180s claude refreshes again");
    await controller.dispose();
    assert.equal(manual.pending(), 0, "interval cleared on dispose");
  });
});

test("auto refresh clamps its interval and skips while busy", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  await withRuntime(fakeAdapters(calls), async (runtime) => {
    const manual = createManualClock(0);
    const controller = new MonitorController({
      runtime,
      settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: true },
      clock: manual.clock,
    });
    await controller.start();
    await settle();
    calls.refreshAll = 0;

    // 1s clamps up to 30s: ticks land at 30s multiples, and the first one
    // eligible after the startup refresh (180s Claude gap) fires at t=180s.
    controller.configureAutoRefresh(true, 1);
    manual.advance(29_000);
    await settle();
    assert.equal(calls.refreshAll, 0, "no tick before the clamped interval");
    manual.advance(151_000);
    await settle();
    assert.ok(calls.refreshAll >= 1, "tick fired at the clamped cadence");
    await controller.dispose();
  });
});

test("auth lifecycle: state, result, cancel, and dispose cleanup", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  await withRuntime(fakeAdapters(calls), async (runtime) => {
    const manual = createManualClock(0);
    const controller = new MonitorController({
      runtime,
      settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: true },
      clock: manual.clock,
    });
    await controller.beginAuth("claude");
    const auth = controller.getSnapshot().auth;
    assert.ok(auth !== null);
    assert.equal(auth.provider, "claude");
    assert.equal(auth.flow.mode, "manualCode");
    assert.equal(
      controller.getSnapshot().providers.get("claude")?.phase,
      "authenticating",
    );

    await controller.cancelAuth();
    assert.equal(controller.getSnapshot().auth, null);
    assert.equal(calls.authCancels, 1, "flow cancelled exactly once");
    assert.equal(
      controller.getSnapshot().providers.get("claude")?.phase,
      "idle",
    );

    // Second begin + dispose: dispose must cancel the pending flow.
    await controller.beginAuth("claude");
    assert.ok(controller.getSnapshot().auth !== null);
    await controller.dispose();
    assert.equal(calls.authCancels, 2);
    assert.equal(controller.getSnapshot().auth, null);
    assert.equal(controller.getSnapshot().disposed, true);
  });
});

test("removeAccount drops the local copy and updates state", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  await withRuntime(fakeAdapters(calls), async (runtime) => {
    const controller = new MonitorController({
      runtime,
      settings: DEFAULT_SETTINGS,
      clock: createManualClock().clock,
    });
    await controller.start();
    await controller.removeAccount("claude", "claude-1");
    assert.deepEqual(calls.removes, ["claude-1"]);
    const state = controller.getSnapshot().providers.get("claude");
    assert.ok(state !== undefined);
    assert.equal(state.accounts.length, 0);
    await controller.dispose();
  });
});

test("duplicate refresh while the lock is held publishes the exact notice", {
  timeout: 5_000,
}, async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  const gate = Promise.withResolvers<void>();
  // Fired inside the first gated refresh so the busy assertion observes
  // the lock the moment the sequence actually reached the adapter.
  const started = Promise.withResolvers<void>();
  await withRuntime(
    fakeAdapters(calls, {
      refresh: () => {
        if (calls.refreshAll === 1) {
          started.resolve();
          return gate.promise.then(() => [claudeSummary("claude-1")]);
        }
        return [claudeSummary("claude-1")];
      },
    }),
    async (runtime) => {
      const controller = new MonitorController({
        runtime,
        settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: true },
        clock: createManualClock().clock,
      });
      const done = controller.start();
      await started.promise;
      assert.equal(controller.getSnapshot().busy, true);

      await controller.refreshSelected("claude");
      const state = controller.getSnapshot().providers.get("claude");
      assert.ok(state !== undefined);
      assert.equal(state.error, "refresh already running");
      assert.equal(calls.refreshAll, 1, "no second sequence started");

      gate.resolve();
      await done;
      await settle();
      assert.equal(controller.getSnapshot().busy, false);
      await controller.dispose();
    },
  );
});

test("dispose aborts and awaits the in-flight sequence", {
  timeout: 5_000,
}, async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  const gate = Promise.withResolvers<void>();
  // Fired synchronously inside the overridden refreshAll so awaiting it
  // proves the sequence reached the adapter — no fixed settle window.
  const started = Promise.withResolvers<void>();
  const adapters = fakeAdapters(calls);
  await withRuntime(adapters, async (runtime) => {
    // Honor the sequence abort signal like a real adapter, so dispose can
    // settle without waiting for the gate.
    runtime.adapters.claude.refreshAll = (
      signal: AbortSignal,
    ): Promise<AccountSummary[]> =>
      new Promise<AccountSummary[]>((resolve, reject) => {
        const onAbort = (): void => {
          reject(new Error("aborted"));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        started.resolve();
        gate.promise.then(
          () => {
            signal.removeEventListener("abort", onAbort);
            resolve([claudeSummary("claude-1")]);
          },
          (error: unknown) => reject(error),
        );
      });
    const controller = new MonitorController({
      runtime,
      settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: true },
      clock: createManualClock().clock,
    });
    void controller.start();
    await started.promise;
    assert.equal(controller.getSnapshot().busy, true);

    const disposed = controller.dispose();
    const raced = await Promise.race([
      disposed.then(() => "disposed"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("timeout"), 500);
      }),
    ]);
    assert.equal(raced, "disposed", "dispose settled without the gate");
    gate.resolve();
    await disposed;
    assert.equal(controller.getSnapshot().disposed, true);
  });
});

test("updateSettings unlocks claude; manual r and R respect the 180s gap", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  await withRuntime(fakeAdapters(calls), async (runtime) => {
    const manual = createManualClock(0);
    const controller = new MonitorController({
      runtime,
      settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: false },
      clock: manual.clock,
    });
    await controller.start();
    await settle();
    calls.refreshAll = 0;

    await controller.refreshSelected("claude");
    assert.equal(calls.refreshAll, 0, "claude gated before policy");

    controller.updateSettings({
      ...DEFAULT_SETTINGS,
      claudePolicyAccepted: true,
    });
    await controller.refreshSelected("claude");
    assert.equal(calls.refreshAll, 1, "unlocked after updateSettings");

    manual.advance(30_000);
    await controller.refreshSelected("claude");
    assert.equal(calls.refreshAll, 1, "manual r respects the cooldown");
    const state = controller.getSnapshot().providers.get("claude");
    assert.ok(state?.error?.includes("cooldown"), "cooldown notice published");

    await controller.refreshAll();
    assert.equal(calls.refreshAll, 1, "manual R respects the cooldown");

    manual.advance(180_000);
    await controller.refreshSelected("claude");
    assert.equal(calls.refreshAll, 2, "cooldown elapsed");
    await controller.dispose();
  });
});

test("import flow: discovery is read-free and import needs explicit confirmation", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  const ops = { discover: 0, imports: 0 };
  await withRuntime(fakeAdapters(calls), async (runtime) => {
    const controller = new MonitorController({
      runtime,
      settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: true },
      clock: createManualClock().clock,
    });
    await controller.start();
    await settle();

    const candidate = {
      provider: "claude" as const,
      source: "file" as const,
      label: "~/.claude/credentials.json",
      path: "/home/u/.claude/credentials.json",
    };
    runtime.adapters.claude.discoverImports = async () => {
      ops.discover += 1;
      return [candidate];
    };
    runtime.adapters.claude.import = async () => {
      ops.imports += 1;
      return [claudeSummary("claude-1")];
    };

    await controller.discoverImports("claude");
    assert.equal(ops.discover, 1);
    assert.deepEqual(
      controller.getSnapshot().providers.get("claude")?.importCandidates,
      [candidate],
    );

    assert.equal(ops.imports, 0, "nothing imported before confirmation");
    const ok = await controller.importCandidate("claude", candidate);
    assert.equal(ok, true);
    assert.equal(ops.imports, 1, "import ran exactly once after confirm");
    await controller.dispose();
  });
});

test("cancelled auth results publish nothing afterwards", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  await withRuntime(fakeAdapters(calls), async (runtime) => {
    const result = Promise.withResolvers<AccountSummary[]>();
    runtime.adapters.claude.beginAuth = async () => ({
      provider: "claude",
      mode: "manualCode",
      authUrl: "https://auth.example/claude",
      callbackUrl: "https://cb.example",
      expiresAt: Number.MAX_SAFE_INTEGER,
      result: result.promise,
      submit: async () => {},
      cancel: async () => {
        calls.authCancels += 1;
      },
    });
    const controller = new MonitorController({
      runtime,
      settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: true },
      clock: createManualClock().clock,
    });
    await controller.beginAuth("claude");
    assert.ok(controller.getSnapshot().auth !== null);

    await controller.cancelAuth();
    assert.equal(controller.getSnapshot().auth, null);

    result.resolve([claudeSummary("late")]);
    await settle();
    const state = controller.getSnapshot().providers.get("claude");
    assert.ok(state !== undefined);
    assert.equal(state.accounts.length, 0, "late result ignored");
    assert.equal(state.error, null, "no late error");
    await controller.dispose();
  });
});

test("startupComplete flips only after the silent startup settles", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  const gate = Promise.withResolvers<void>();
  await withRuntime(
    fakeAdapters(calls, {
      refresh: () => gate.promise.then(() => [claudeSummary("claude-1")]),
    }),
    async (runtime) => {
      const controller = new MonitorController({
        runtime,
        settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: true },
        clock: createManualClock().clock,
      });
      const done = controller.start();
      assert.equal(controller.getSnapshot().startupComplete, false);
      gate.resolve();
      await done;
      assert.equal(controller.getSnapshot().startupComplete, true);
      await controller.dispose();
    },
  );
});

test("beginAuth reports outcome and rejects duplicates during setup", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  const flowGate = Promise.withResolvers<AuthFlow>();
  await withRuntime(
    fakeAdapters(calls, { beginAuth: () => flowGate.promise }),
    async (runtime) => {
      const controller = new MonitorController({
        runtime,
        settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: true },
        clock: createManualClock(1_000).clock,
      });
      const first = controller.beginAuth("claude");
      // Pre-flow pending: a second start is rejected with the exact reason.
      const duplicate = await controller.beginAuth("claude");
      assert.equal(duplicate.ok, false);
      assert.equal(duplicate.reason, AUTH_ALREADY_IN_PROGRESS);
      assert.equal(
        controller.getSnapshot().providers.get("claude")?.error,
        AUTH_ALREADY_IN_PROGRESS,
      );
      flowGate.resolve({
        provider: "claude",
        mode: "manualCode",
        authUrl: "https://auth.example/claude",
        callbackUrl: "https://cb.example/done",
        expiresAt: Number.MAX_SAFE_INTEGER,
        result: Promise.withResolvers<AccountSummary[]>().promise,
        submit: async () => {},
        cancel: async () => {
          calls.authCancels += 1;
        },
      });
      const started = await first;
      assert.equal(started.ok, true);
      assert.notEqual(controller.getSnapshot().auth, null);
      await controller.dispose();
    },
  );
});

test("beginAuth on gated Claude publishes the policy reason and never calls the adapter", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  await withRuntime(fakeAdapters(calls), async (runtime) => {
    const controller = new MonitorController({
      runtime,
      settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: false },
      clock: createManualClock(1_000).clock,
    });
    const result = await controller.beginAuth("claude");
    assert.equal(result.ok, false);
    assert.equal(result.reason, CLAUDE_DISABLED_REASON);
    assert.equal(
      controller.getSnapshot().providers.get("claude")?.error,
      CLAUDE_DISABLED_REASON,
    );
    // Zero adapter network/auth surface before acceptance.
    assert.equal(controller.getSnapshot().auth, null);
    await controller.dispose();
  });
});

test("dispose aborts and awaits an in-flight discovery", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  const aborted = Promise.withResolvers<void>();
  await withRuntime(
    fakeAdapters(calls, {
      discover: (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted.resolve();
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    }),
    async (runtime) => {
      const controller = new MonitorController({
        runtime,
        settings: DEFAULT_SETTINGS,
        clock: createManualClock(1_000).clock,
      });
      void controller.discoverImports("codex");
      await controller.dispose();
      // dispose awaited the aborted discovery (settled, no late publish).
      assert.equal(controller.getSnapshot().disposed, true);
      assert.equal(
        controller.getSnapshot().providers.get("codex")?.phase,
        "importing",
      );
      void aborted;
    },
  );
});

test("dispose awaits an in-flight removal even without a signal", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  const removalGate = Promise.withResolvers<void>();
  let removeSettled = false;
  await withRuntime(
    fakeAdapters(calls, {
      remove: async () => {
        await removalGate.promise;
        removeSettled = true;
      },
    }),
    async (runtime) => {
      const controller = new MonitorController({
        runtime,
        settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: true },
        clock: createManualClock(1_000).clock,
      });
      await controller.start();
      const removal = controller.removeAccount("claude", "claude-1");
      const disposed = controller.dispose();
      let disposeWon = false;
      await Promise.race([
        disposed.then(() => {
          disposeWon = true;
        }),
        new Promise((resolve) => setTimeout(resolve, 50)),
      ]);
      assert.equal(disposeWon, false, "dispose must await the removal");
      removalGate.resolve();
      await removal;
      await disposed;
      assert.equal(removeSettled, true);
      assert.equal(
        controller.getSnapshot().providers.get("claude")?.accounts.length,
        1,
        "no late publication after dispose",
      );
    },
  );
});

test("manual refreshAll explains a cooled-down Claude and still refreshes others", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  const refreshedProviders: ProviderId[] = [];
  const manual = createManualClock(1_000);
  await withRuntime(
    fakeAdapters(calls, {
      refresh: (provider) => {
        refreshedProviders.push(provider);
        return provider === "claude"
          ? [claudeSummary("claude-1")]
          : [codexRefreshedSummary("codex-1")];
      },
    }),
    async (runtime) => {
      await runtime.store.upsert("codex", codexStoredAccount("codex-1"));
      const controller = new MonitorController({
        runtime,
        settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: true },
        clock: manual.clock,
      });
      await controller.start();
      assert.equal(refreshedProviders.filter((p) => p === "claude").length, 1);
      assert.equal(refreshedProviders.filter((p) => p === "codex").length, 1);

      manual.advance(90_000); // 91s < 180s: Claude is cooled down.
      await controller.refreshAll();

      const snapshot = controller.getSnapshot();
      assert.equal(
        snapshot.providers.get("claude")?.error,
        CLAUDE_COOLDOWN_NOTICE,
      );
      assert.equal(snapshot.providers.get("codex")?.error, null);
      assert.equal(refreshedProviders.filter((p) => p === "claude").length, 1);
      assert.equal(refreshedProviders.filter((p) => p === "codex").length, 2);
      await controller.dispose();
    },
  );
});

test("startup auto-imports every discovered account, claude included", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  const ops = {
    discovered: [] as string[],
    imported: [] as string[],
    candidate: (provider: ProviderId) => ({
      provider,
      source: "file" as const,
      label: `~/.${provider}/credentials.json`,
      path: `/home/u/.${provider}/credentials.json`,
    }),
  };
  const registry = fakeAdapters(calls);
  for (const provider of [
    "githubCopilot",
    "codex",
    "antigravity",
    "claude",
    "kiro",
    "cursor",
    "omp",
    "opencode",
    "fuelGauge",
  ] as const) {
    registry[provider].discoverImports = async () => {
      ops.discovered.push(provider);
      return [ops.candidate(provider)];
    };
    registry[provider].import = async () => {
      ops.imported.push(provider);
      return [];
    };
  }
  await withRuntime(registry, async (runtime) => {
    const controller = new MonitorController({
      runtime,
      settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: true },
      clock: createManualClock().clock,
    });
    await controller.start();
    await settle();
    assert.deepEqual(ops.discovered, [
      "githubCopilot",
      "codex",
      "antigravity",
      "claude",
      "kiro",
      "cursor",
      "omp",
      "opencode",
      "fuelGauge",
    ]);
    assert.deepEqual(ops.imported, ops.discovered);
    await controller.dispose();
  });
});

test("startup auto-import skips claude while its policy is declined", async () => {
  const calls: AdapterCalls = { refreshAll: 0, removes: [], authCancels: 0 };
  const ops = { discovered: [] as string[] };
  const registry = fakeAdapters(calls);
  registry.claude.discoverImports = async () => {
    ops.discovered.push("claude");
    return [];
  };
  await withRuntime(registry, async (runtime) => {
    const controller = new MonitorController({
      runtime,
      settings: { ...DEFAULT_SETTINGS, claudePolicyAccepted: false },
      clock: createManualClock().clock,
    });
    await controller.start();
    await settle();
    assert.deepEqual(ops.discovered, [], "declined claude stays untouched");
    await controller.dispose();
  });
});
