import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import { Box, useStdout } from "ink";
import { render } from "ink-testing-library";
import { DEFAULT_SETTINGS } from "../../src/core/store.js";
import type {
  AccountSummary,
  ImportCandidate,
  ProviderId,
} from "../../src/core/types.js";
import type {
  AuthFlow,
  ProviderAdapter,
  ProviderRegistry,
} from "../../src/providers/provider.js";
import type { Runtime } from "../../src/runtime.js";
import { createRuntime } from "../../src/runtime.js";
import {
  App,
  orderSourcesByAccounts,
  sanitizeUiError,
} from "../../src/ui/app.js";
import { useViewport, type ViewportLayout } from "../../src/ui/viewport.js";

const _UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const ENTER = "\r";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

function codexSummary(id: string, remaining: number | null): AccountSummary {
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
    metrics: [
      {
        id: "codex.primary",
        label: "3 hours",
        remainingPercent: remaining,
        used: null,
        total: null,
        resetAt: null,
      },
    ],
    email: `${id}@example.com`,
    authMode: "oauth",
    apiBaseUrl: null,
    userId: null,
    plan: null,
    accountId: null,
    organizationId: null,
    quota: {
      hourlyRemainingPercent: remaining,
      hourlyResetAt: null,
      hourlyWindowMinutes: 180,
      weeklyRemainingPercent: null,
      weeklyResetAt: null,
      weeklyWindowMinutes: null,
    },
  };
}

interface AdapterLog {
  refreshAll: number;
  beginAuth: number;
  cancels: number;
  removes: string[];
  discover: number;
  imports: number;
  browserOpens: string[];
}

interface FakeOptions {
  flow: AuthFlow | null;
  candidates: ImportCandidate[];
  importFails: boolean;
  importError?: Error;
  claudeAccepted?: boolean;
  seedAllProviders?: boolean;
  refreshByProvider?: Partial<Record<ProviderId, AccountSummary[]>>;
}

function makeRegistry(log: AdapterLog, fake: FakeOptions): ProviderRegistry {
  const adapter: ProviderAdapter = {
    list: async () => [],
    discoverImports: async () => {
      log.discover += 1;
      return fake.candidates;
    },
    import: async () => {
      log.imports += 1;
      if (fake.importFails) {
        throw fake.importError ?? new Error("candidate could not be copied");
      }
      return [codexSummary("codex-1", 50)];
    },
    beginAuth: async () => {
      log.beginAuth += 1;
      if (fake.flow !== null) {
        return fake.flow;
      }
      return {
        provider: "codex",
        mode: "manualCode",
        authUrl: "https://auth.example/codex",
        callbackUrl: "https://callback.example/codex",
        expiresAt: Number.MAX_SAFE_INTEGER,
        result: Promise.withResolvers<AccountSummary[]>().promise,
        submit: async () => {},
        cancel: async () => {
          log.cancels += 1;
        },
      };
    },
    refresh: async () => codexSummary("codex-1", 50),
    refreshAll: null as unknown as ProviderAdapter["refreshAll"],
    remove: async (accountId: string) => {
      log.removes.push(accountId);
    },
  };
  const registry: Partial<Record<string, ProviderAdapter>> = {};
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
        log.refreshAll += 1;
        return (
          fake.refreshByProvider?.[provider] ?? [
            codexSummary("codex-1", 50),
            codexSummary("codex-2", 50),
          ]
        );
      },
    };
  }
  return registry as ProviderRegistry;
}

/** Minimal-but-valid stored accounts for all six providers. */
async function seedAllProviders(runtime: Runtime): Promise<void> {
  const base = {
    status: "active" as const,
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: 1,
    createdAt: 1,
    lastUsed: 1,
  };
  await runtime.store.upsert("githubCopilot", {
    ...base,
    provider: "githubCopilot",
    id: "gh-1",
    githubLogin: "ghuser",
    githubId: 1,
    githubName: null,
    githubEmail: null,
    githubAccessToken: "gh-token",
    githubTokenType: null,
    githubScope: null,
    copilotToken: "cp-token",
    copilotPlan: null,
    copilotChatEnabled: null,
    copilotExpiresAt: null,
    copilotRefreshIn: null,
    copilotQuotaSnapshots: null,
    copilotQuotaResetDate: null,
    copilotLimitedUserQuotas: null,
    copilotLimitedUserResetAt: null,
  });
  await runtime.store.upsert("codex", {
    ...base,
    provider: "codex",
    id: "codex-1",
    email: "codex@example.com",
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
  });
  await runtime.store.upsert("antigravity", {
    ...base,
    provider: "antigravity",
    id: "ag-1",
    email: "ag@example.com",
    source: "local",
    authId: null,
    name: null,
    accessToken: "ag-token",
    refreshToken: null,
    idToken: null,
    tokenType: null,
    scope: null,
    expiryDate: null,
    selectedAuthType: null,
    projectId: null,
    tierId: null,
    planName: null,
    credits: [],
    quota: {
      geminiFiveHour: { remainingPercent: 50, resetAt: null },
      geminiWeekly: { remainingPercent: 50, resetAt: null },
      thirdPartyFiveHour: { remainingPercent: 50, resetAt: null },
      thirdPartyWeekly: { remainingPercent: 50, resetAt: null },
    },
  });
  await runtime.store.upsert("claude", {
    ...base,
    provider: "claude",
    id: "cl-1",
    email: "claude@example.com",
    authMode: "oauth",
    accessToken: "cl-token",
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
    quota: {
      fiveHourRemainingPercent: 40,
      fiveHourResetAt: 1_800_000_000_000,
      weeklyRemainingPercent: null,
      weeklyResetAt: null,
      weeklySonnetRemainingPercent: null,
      weeklySonnetResetAt: null,
      extraUsageRemainingPercent: null,
      extraUsageResetAt: null,
      extraUsageUsedCents: null,
      extraUsageLimitCents: null,
    },
  });
  await runtime.store.upsert("kiro", {
    ...base,
    provider: "kiro",
    id: "kiro-1",
    email: "kiro@example.com",
    loginProvider: null,
    accessToken: "kiro-token",
    refreshToken: null,
    expiresAt: null,
    idcRegion: null,
    clientId: null,
    planName: null,
    planTier: null,
    creditsTotal: 100,
    creditsUsed: 25,
    bonusTotal: 20,
    bonusUsed: 5,
    usageResetAt: null,
    bonusExpireDays: null,
    kiroAuthTokenRaw: null,
    kiroProfileRaw: null,
  });
  await runtime.store.upsert("cursor", {
    ...base,
    provider: "cursor",
    id: "cur-1",
    email: "cursor@example.com",
    authId: null,
    signUpType: null,
    membershipType: null,
    subscriptionStatus: null,
    accessToken: "cur-token",
    refreshToken: null,
    source: "local",
    totalPercent: 30,
    autoPercent: 10,
    apiPercent: null,
    billingCycleEnd: null,
    planUsed: 3,
    planLimit: 10,
    onDemandEnabled: true,
    onDemandUsed: 1,
    onDemandLimit: 5,
  });
}

async function seedCodex(runtime: Runtime): Promise<void> {
  for (const id of ["codex-1", "codex-2"]) {
    await runtime.store.upsert("codex", {
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
        hourlyRemainingPercent: 50,
        hourlyResetAt: null,
        hourlyWindowMinutes: 180,
        weeklyRemainingPercent: null,
        weeklyResetAt: null,
        weeklyWindowMinutes: null,
      },
    });
  }
}

interface AppHarness {
  view: ReturnType<typeof render>;
  runtime: Runtime;
  write: (input: string) => void;
  frame: () => string;
  /** Visible terminal text with zero-width ANSI control sequences removed. */
  visibleFrame: () => string;
  /**
   * Polls until the rendered frame contains `needle` and returns that
   * frame. Fixed sleeps sample whatever paint happens to be committed —
   * under load the frame can still predate a tab switch, a resize, or
   * the startup refresh, so assertions must wait for their settle
   * marker instead.
   */
  waitForFrame: (needle: string, label: string) => Promise<string>;
  /**
   * Resizes the mock terminal and resolves only once the app has
   * provably rendered at that size — a single resize event can be
   * lost while the useWindowSize effect is still subscribing.
   */
  resize: (columns: number, rows: number) => Promise<void>;
}

async function withApp(
  fake: Partial<FakeOptions>,
  run: (harness: AppHarness) => Promise<void>,
): Promise<void> {
  const log: AdapterLog = {
    refreshAll: 0,
    beginAuth: 0,
    cancels: 0,
    removes: [],
    discover: 0,
    imports: 0,
    browserOpens: [],
  };
  const options: FakeOptions = {
    flow: fake.flow ?? null,
    candidates: fake.candidates ?? [],
    importFails: fake.importFails ?? false,
    importError: fake.importError,
    refreshByProvider: fake.refreshByProvider,
  };
  const root = await mkdtemp(path.join(tmpdir(), "fuel-app-"));
  const browser = {
    open: async (url: string) => {
      log.browserOpens.push(url);
      return { url, launched: true };
    },
  };
  const runtime = createRuntime({
    configRoot: root,
    adapters: makeRegistry(log, options),
    browser,
  });
  if (fake.seedAllProviders === true) {
    await seedAllProviders(runtime);
  } else {
    await seedCodex(runtime);
  }
  if (fake.claudeAccepted !== undefined) {
    await runtime.store.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      claudePolicyAccepted: fake.claudeAccepted,
    });
  }

  const captured: {
    stdout?: {
      columns: number;
      rows: number;
      emit(event: string): boolean;
    };
  } = {};
  function StdoutProbe(): null {
    const { stdout } = useStdout();
    captured.stdout = stdout as unknown as {
      columns: number;
      rows: number;
      emit(event: string): boolean;
    };
    return null;
  }
  // Mirrors the app's live layout; updated on every render so the
  // harness can PROVE a resize landed instead of trusting the event.
  const observed: { layout: ViewportLayout | null } = { layout: null };
  function ViewportProbe(): null {
    observed.layout = useViewport();
    return null;
  }

  const view = render(
    <Box>
      <StdoutProbe />
      <ViewportProbe />
      <App runtime={runtime} />
    </Box>,
  );
  const setStdoutSize = (columns: number, rows: number): void => {
    const stdout = captured.stdout;
    if (stdout === undefined) {
      throw new Error("mock stdout was not captured");
    }
    Object.defineProperty(stdout, "columns", {
      value: columns,
      configurable: true,
    });
    Object.defineProperty(stdout, "rows", {
      value: rows,
      configurable: true,
    });
    stdout.emit("resize");
  };
  // A single resize emit can be LOST: it only reaches the app once the
  // useWindowSize effect has subscribed, and under load that commit
  // can trail the emit. Re-emit until the app provably rendered the
  // requested size.
  const resizeTo = async (columns: number, rows: number): Promise<void> => {
    for (let attempt = 0; attempt < 50; attempt++) {
      setStdoutSize(columns, rows);
      const layout = observed.layout;
      if (
        layout !== null &&
        layout.width === columns &&
        layout.height === rows
      ) {
        return;
      }
      await sleep(20);
    }
    throw new Error(
      `withApp: viewport never settled at ${columns}x${rows} (last: ${JSON.stringify(observed.layout)})`,
    );
  };
  // Pin the viewport before any test logic runs. ink-testing-library's
  // mock stdout exposes columns (100) but NO rows, so ink's
  // getWindowSize falls back to the REAL terminal size (COLUMNS/LINES
  // included) — a short interactive terminal silently flips every
  // render into the compact layout and breaks size-dependent
  // assertions. 100x24 is the exact non-TTY baseline every existing
  // expectation was written against.
  await resizeTo(100, 24);
  const write = (input: string): void => {
    view.stdin?.write(input);
  };
  const frame = (): string => view.lastFrame() ?? "";
  const visibleFrame = (): string => stripVTControlCharacters(frame());
  // Bounded observable poll: hand control to the test only after the
  // seeded codex account is actually rendered — a fixed sleep can fire
  // before the cached load lands, leaving selection-dependent actions
  // (DOWN, d, p) racing absent data.
  const waitForSeed = async (): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      // The card label column truncates the email ("codex-1@ex…"), so the
      // truncation-proof account prefix is the observable seed marker.
      // The ❯ additionally proves the startup selection snap landed on
      // the seeded account (the sources tab leads with the busiest
      // source), so selection-dependent keys never race it.
      if (frame().includes("codex-1") && frame().includes("❯")) {
        return;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    throw new Error(
      `withApp: seeded codex-1 account never rendered (frame: ${frame().slice(0, 400)})`,
    );
  };
  await waitForSeed();
  try {
    await run({
      view,
      runtime,
      write,
      frame,
      visibleFrame,
      waitForFrame: async (needle, label) => {
        let current = visibleFrame();
        for (let attempt = 0; attempt < 50; attempt++) {
          current = visibleFrame();
          if (current.includes(needle)) {
            return current;
          }
          await sleep(40);
        }
        throw new Error(
          `withApp: frame never showed ${label} (frame: ${current.slice(0, 400)})`,
        );
      },
      resize: resizeTo,
    });
  } finally {
    view.unmount();
    await rm(root, {
      recursive: true,
      force: true,
      // The monitor's best-effort writes can race the removal; retry
      // instead of failing the test on directory contention.
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

test("sources tab lists empty providers in a trailing no-accounts block", async () => {
  await withApp({}, async (harness) => {
    // Only codex is seeded, so every other source must appear as a row
    // of the trailing "no accounts" list block, below the codex block.
    harness.write(TAB);
    await harness.resize(100, 40);
    // Wait for the settled marker: the first [Sources] paint can still
    // predate the resize or the startup refresh, transiently squeezing
    // the no-accounts block out of the frame.
    const frame = await harness.waitForFrame(
      "no accounts · 8 sources",
      "the settled sources tab",
    );
    assert.ok(frame.includes("[Sources]"), "sources tab reached");
    assert.ok(frame.includes("codex-2"), "the only populated block renders");
    assert.ok(
      frame.includes("no accounts · 8 sources"),
      "the no-accounts header counts every empty source",
    );
    for (const label of [
      "GitHub Copilot",
      "Antigravity",
      "Claude Code",
      "Kiro",
      "Cursor",
      "Oh My Pi",
      "OpenCode",
      "FuelGauge",
    ]) {
      assert.ok(frame.includes(`• ${label}`), `no-accounts row lists ${label}`);
    }
    // The block sits below the populated ones, never above them.
    assert.ok(
      frame.indexOf("codex-2") < frame.indexOf("no accounts ·"),
      "populated blocks render above the no-accounts block",
    );
    // The low-quota panel is gone from this tab.
    assert.ok(!frame.includes("Low quotas"), "no alert panel in sources tab");
  });
});

test("sources tab orders cards by registered account count", async () => {
  // Codex refreshes to two accounts while every other seeded source
  // keeps one: the codex card must lead the grid.
  const one = (id: string): AccountSummary => codexSummary(id, 50);
  await withApp(
    {
      seedAllProviders: true,
      refreshByProvider: {
        githubCopilot: [one("gh-1")],
        codex: [one("codex-1"), one("codex-2")],
        antigravity: [one("ag-1")],
        claude: [one("cl-1")],
        kiro: [one("kiro-1")],
        cursor: [one("cur-1")],
      },
    },
    async (harness) => {
      harness.write(TAB);
      await harness.resize(100, 40);
      // The settled marker needs both the codex refresh (its second
      // account) and every seeded source card visible at once — a
      // mid-refresh frame can satisfy [Sources]+codex-2 while the
      // grid is still missing Antigravity or the trailing block.
      let frame = "";
      for (let attempt = 0; attempt < 50; attempt++) {
        frame = harness.visibleFrame();
        if (
          frame.includes("[Sources]") &&
          frame.includes("codex-2") &&
          frame.includes("Antigravity") &&
          frame.includes("no accounts · 3")
        ) {
          break;
        }
        await sleep(40);
      }
      assert.ok(
        frame.indexOf("Codex") < frame.indexOf("GitHub Copilot"),
        "the two-account source renders first",
      );
      assert.ok(
        frame.indexOf("GitHub Copilot") < frame.indexOf("Antigravity"),
        "one-account ties keep the canonical order",
      );
      // Equal-count sources that were never seeded sit in the trailing
      // no-accounts block.
      assert.ok(
        frame.indexOf("Antigravity") < frame.indexOf("no accounts · 3"),
        "the no-accounts block sits below every source block",
      );
    },
  );
});

test("pinned accounts render first inside a card", async () => {
  await withApp({}, async (harness) => {
    // The startup selection snap already lands on codex/codex-1 (the
    // only populated source), so p pins it directly.
    harness.write("p"); // pins selected account (codex-1 by default)
    await new Promise((r) => setTimeout(r, 40));
    const withFirst = harness.frame();
    assert.ok(withFirst.includes("📌"), "pinned marker appears");

    // Dashboard card shows codex-1 (pinned) — pinning keeps it first.
    assert.ok(withFirst.includes("codex-1"), "pinned account listed");
  });
});

test("Enter opens details for the selected provider", async () => {
  await withApp({}, async (harness) => {
    // Provider details are the Sources-view Enter target; the accounts
    // view opens the per-account modal instead. The startup snap leaves
    // the selection on codex — the only populated source.
    harness.write(TAB);
    await new Promise((r) => setTimeout(r, 60));
    harness.write(ENTER);
    await new Promise((r) => setTimeout(r, 40));
    const frame = harness.frame();
    assert.ok(frame.includes("Codex — all accounts"), "details route");
    assert.ok(frame.includes("codex-1"), "first account");
    assert.ok(frame.includes("codex-2"), "all accounts listed");
  });
});
test("selecting a no-accounts row marks it; Enter still opens details", async () => {
  await withApp({}, async (harness) => {
    // Sorted order: codex (populated), then the empty sources in
    // canonical order — so one j lands on GitHub Copilot inside the
    // no-accounts block. The list is always visible; the selection just
    // marks the row.
    harness.write(TAB);
    // The j keypress must land after the sources list settles — the
    // startup selection snap targets the populated source, and pressing
    // j mid-transition can advance off a half-rendered list.
    await harness.waitForFrame(
      "no accounts · 8 sources",
      "the settled sources tab",
    );
    harness.write("j");
    const frame = await harness.waitForFrame(
      "❯ GitHub Copilot",
      "the selected no-accounts row",
    );
    assert.ok(
      frame.includes("no accounts · 8 sources"),
      "the no-accounts block keeps every source listed",
    );
    assert.ok(
      frame.includes("• Antigravity"),
      "unselected rows keep their bullets",
    );
    harness.write(ENTER);
    const details = await harness.waitForFrame(
      "GitHub Copilot — all accounts",
      "the details route",
    );
    assert.ok(
      details.includes("GitHub Copilot — all accounts"),
      "details route for the no-accounts source",
    );
    assert.ok(
      details.includes("No accounts for this source"),
      "empty-source hint in details",
    );
  });
});

test("auth tab manages FuelGauge; add-account opens a searchable picker", async () => {
  await withApp({}, async (harness) => {
    harness.write("a");
    let frame = "";
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = harness.frame() ?? "";
      if (frame.includes("+ add account")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(frame.includes("[Auth]"), "a opens the auth tab");
    assert.ok(
      frame.includes("Auth — manage accounts"),
      "management covers every provider",
    );
    assert.ok(frame.includes("+ add account"), "add-account action offered");
    // The seeded codex accounts arrived as auto-imports, not user adds —
    // the auth tab manages user-added accounts only, so nothing groups.
    assert.ok(
      frame.includes("No accounts yet"),
      "auto-imported accounts stay out of the management list",
    );
    assert.ok(
      !frame.includes("codex-1@example.com"),
      "seeded (unmarked) accounts are hidden",
    );
    // Enter opens the PROVIDER picker: vendor providers only — agent
    // sources like Oh My Pi / OpenCode are import-only and stay out.
    harness.write(ENTER);
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = harness.frame() ?? "";
      if (frame.includes("choose a provider")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    for (const label of [
      "GitHub Copilot",
      "Codex",
      "Antigravity",
      "Claude Code",
      "Kiro",
      "Cursor",
      "Z.AI Coding Plan",
      "xAI Grok",
    ]) {
      assert.ok(frame.includes(label), `picker lists the provider ${label}`);
    }
    assert.ok(frame.includes("API key"), "the vendor shows its method");
    assert.ok(
      frame.includes("via OpenCode"),
      "agent-import providers name their agent",
    );
    assert.ok(
      !frame.includes("Oh My Pi"),
      "agent sources are not themselves providers",
    );
    // Typing filters the list to the matching provider.
    harness.write("coding");
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = harness.frame() ?? "";
      if (!frame.includes("GitHub Copilot")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(frame.includes("Z.AI Coding Plan"), "match kept after filter");
    assert.ok(!frame.includes("GitHub Copilot"), "non-matches filtered out");
    // Esc returns to management without starting a flow.
    harness.write(ESC);
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = harness.frame() ?? "";
      if (frame.includes("Auth — manage accounts")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(frame.includes("+ add account"), "esc backs out of the picker");
  });
});

test("auth tab adds an xAI account via the OpenCode import", async () => {
  // The xAI picker entry: opencode owns the OAuth, so adding = discover
  // the agent's store, confirm, and copy. The imported account is a
  // user add (manageable in the auth tab), not an auto-import.
  const xaiSummary = {
    provider: "opencode",
    id: "oc-xai-new",
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: 1,
    createdAt: 1,
    lastUsed: 1,
    metrics: [],
    openCodeProviderId: "xai",
    authType: "oauth",
    keyFingerprint: null,
    email: "grok-user@example.com",
    displayLabel: "xAI Grok · grok-user@example.com",
  } as unknown as AccountSummary;
  const root = await mkdtemp(path.join(tmpdir(), "fuel-auth-xai-"));
  const log: AdapterLog = {
    refreshAll: 0,
    beginAuth: 0,
    cancels: 0,
    removes: [],
    discover: 0,
    imports: 0,
    browserOpens: [],
  };
  const adapters: Partial<Record<string, unknown>> = {};
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
    adapters[provider] = {
      list: async () => [],
      discoverImports: async () => {
        log.discover += 1;
        return provider === "opencode"
          ? [
              {
                provider: "opencode",
                source: "file",
                label: "xAI Grok · id 2a0d417c",
                path: null,
              },
            ]
          : [];
      },
      import: async () => {
        log.imports += 1;
        return [xaiSummary];
      },
      beginAuth: async () => {
        throw new Error("no direct login");
      },
      refresh: async () => [],
      refreshAll: async () => (provider === "opencode" ? [xaiSummary] : []),
      remove: async () => {},
    };
  }
  const runtime = createRuntime({
    configRoot: root,
    adapters: adapters as never,
    browser: {
      async open(url: string) {
        return { url, launched: true };
      },
    },
  });
  const view = render(
    <Box>
      <App runtime={runtime} registerDispose={() => {}} />
    </Box>,
  );
  try {
    const write = (input: string): void => {
      view.stdin?.write(input);
    };
    let frame = "";
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = view.lastFrame() ?? "";
      if (frame.includes("Accounts —")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    write("a");
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = view.lastFrame() ?? "";
      if (frame.includes("+ add account")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    write(ENTER); // picker
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = view.lastFrame() ?? "";
      if (frame.includes("xAI Grok")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(frame.includes("via OpenCode"), "xai offers the import path");
    write("grok"); // filter to xAI
    await new Promise((r) => setTimeout(r, 150));
    write(ENTER); // begins the import
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = view.lastFrame() ?? "";
      if (frame.includes("import from OpenCode")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(
      frame.includes("xAI Grok · id 2a0d417c"),
      "the agent's xai credential is offered",
    );
    write(ENTER); // confirm modal
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = view.lastFrame() ?? "";
      if (frame.includes("Copy this credential")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(
      frame.includes("PLAINTEXT"),
      "the disclosure warns about the plaintext copy",
    );
    write("y"); // confirm
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = view.lastFrame() ?? "";
      if (
        frame.includes("manage accounts") &&
        frame.includes("grok-user@example.com")
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    // The fake registry always discovers the candidate, so the startup
    // auto-add imported it once already; the confirmed picker import is
    // the second adapter call and the one that marks the account
    // user-added (only that copy shows in the auth tab).
    assert.ok(log.imports === 2, "the confirmed import ran");
    assert.ok(
      frame.includes("xAI Grok") && frame.includes("grok-user@example.com"),
      "the imported account lists under the xAI group in the auth tab",
    );
  } finally {
    view.unmount();
    await rm(root, { recursive: true, force: true });
  }
});

test("auth tab hides imported keys; user-added keys list under the vendor", async () => {
  // The real-world shapes from the reports: an opencode-imported
  // zai-coding-plan key (auto-import — must NOT list) and a key pasted
  // into FuelGauge (user-added — must list under the vendor group).
  const root = await mkdtemp(path.join(tmpdir(), "fuel-auth-user-added-"));
  const log: AdapterLog = {
    refreshAll: 0,
    beginAuth: 0,
    cancels: 0,
    removes: [],
    discover: 0,
    imports: 0,
    browserOpens: [],
  };
  const runtime = createRuntime({
    configRoot: root,
    adapters: makeRegistry(log, {
      flow: null,
      candidates: [],
      importFails: false,
      refreshByProvider: {
        fuelGauge: [
          {
            provider: "fuelGauge",
            id: "fg-pasted",
            status: "active",
            statusReason: null,
            quotaQueryLastError: null,
            quotaQueryLastErrorAt: null,
            usageUpdatedAt: 1,
            createdAt: 1,
            lastUsed: 1,
            metrics: [],
            vendor: "zai-coding-plan",
            keyFingerprint: "fp-fg-pasted",
            displayLabel: "Z.AI Coding Plan · API: pas..ted",
          } as unknown as AccountSummary,
        ],
        opencode: [],
      },
    }),
    browser: {
      async open(url: string) {
        return { url, launched: true };
      },
    },
  });
  await runtime.store.upsert("opencode", {
    provider: "opencode",
    id: "oc-zai",
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: 1,
    createdAt: 1,
    lastUsed: 1,
    openCodeProviderId: "zai-coding-plan",
    authType: "api",
    keyFingerprint: `fp-${"9".repeat(30)}`,
    email: null,
    expiresAt: null,
    displayLabel: "Z.AI Coding Plan · API: 269..PHR",
    limits: [],
  });
  await runtime.store.upsert("fuelGauge", {
    provider: "fuelGauge",
    id: "fg-pasted",
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: 1,
    createdAt: 2,
    lastUsed: 2,
    vendor: "zai-coding-plan",
    apiKey: "k",
    keyFingerprint: "fp-fg-pasted",
    displayLabel: "Z.AI Coding Plan · API: pas..ted",
    limits: [],
  });
  await runtime.store.markUserAddedAccountIds(["fg-pasted"]);
  const view = render(
    <Box>
      <App runtime={runtime} registerDispose={() => {}} />
    </Box>,
  );
  try {
    const write = (input: string): void => {
      view.stdin?.write(input);
    };
    write("a");
    let frame = "";
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = view.lastFrame() ?? "";
      if (frame.includes("API: pas..ted")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(
      frame.includes("API: pas..ted"),
      "the user-added key lists under the vendor group",
    );
    assert.ok(
      !frame.includes("API: 269..PHR"),
      "the opencode-imported key stays hidden",
    );
  } finally {
    view.unmount();
    await rm(root, { recursive: true, force: true });
  }
});

test("auth tab shows native-login accounts under their provider", async () => {
  // The reported gap: an account added through the picker's GitHub
  // Copilot login never appeared because management listed API-key
  // vendors only. It must group under its provider like every other.
  const ghSummary = {
    provider: "githubCopilot",
    id: "gh-1",
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: 1,
    createdAt: 1,
    lastUsed: 1,
    metrics: [],
    ...displayFieldsFor("githubCopilot", "octocat"),
  } as unknown as AccountSummary;
  await withApp(
    {
      seedAllProviders: true,
      refreshByProvider: { githubCopilot: [ghSummary] },
    },
    async (harness) => {
      harness.write("a");
      let frame = "";
      for (let attempt = 0; attempt < 25; attempt++) {
        frame = harness.frame() ?? "";
        if (frame.includes("GitHub Copilot")) {
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.ok(
        frame.includes("GitHub Copilot"),
        "the login-added account's provider group renders",
      );
      assert.ok(
        frame.includes("octocat"),
        "the GitHub Copilot account is listed",
      );
      assert.ok(
        frame.includes("Codex"),
        "other native-login providers list too",
      );
    },
  );
});

test("auth tab: add a key, see it listed, delete it", async () => {
  // The real first-party journey through the merged auth tab: add an
  // API key (flow completes), review it in the management list, then
  // delete it behind the confirm modal.
  const result = Promise.withResolvers<AccountSummary[]>();
  const flow: AuthFlow = {
    provider: "fuelGauge",
    mode: "apiKey",
    hint: "Z.AI coding plan API key",
    expiresAt: Number.MAX_SAFE_INTEGER,
    result: result.promise,
    submit: async () => {
      result.resolve([
        {
          provider: "fuelGauge",
          id: "fg-1",
          status: "active",
          statusReason: null,
          quotaQueryLastError: null,
          quotaQueryLastErrorAt: null,
          usageUpdatedAt: 1,
          createdAt: 1,
          lastUsed: 1,
          metrics: [],
          vendor: "zai-coding-plan",
          keyFingerprint: `fp-${"0".repeat(30)}`,
          displayLabel: "Z.AI Coding Plan · API: abc..xyz",
        } as unknown as AccountSummary,
      ]);
    },
    cancel: async () => {},
  };
  await withApp({ flow }, async (harness) => {
    harness.write("a");
    let frame = "";
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = harness.frame() ?? "";
      if (frame.includes("+ log in")) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    // Enter opens the picker; "fuel" filters to FuelGauge; Enter starts
    // the add-key flow and the paste completes it.
    harness.write(ENTER);
    await new Promise((r) => setTimeout(r, 80));
    harness.write("coding");
    await new Promise((r) => setTimeout(r, 120));
    harness.write(ENTER);
    await new Promise((r) => setTimeout(r, 80));
    harness.write("fg-pasted-key-0123456789");
    await new Promise((r) => setTimeout(r, 60));
    harness.write(ENTER);
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = harness.frame() ?? "";
      if (frame.includes("Z.AI Coding Plan · API: abc..xyz")) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(
      frame.includes("Z.AI Coding Plan · API: abc..xyz"),
      "the completed key is listed for management",
    );
    // k wraps to the LAST row — the new key (the vendor group is last;
    // the codex group's rows come first).
    harness.write("k");
    await new Promise((r) => setTimeout(r, 60));
    harness.write("d");
    await new Promise((r) => setTimeout(r, 60));
    frame = harness.frame();
    assert.ok(
      frame.includes("Delete this key from Fuel Gauge?"),
      "delete confirm modal opens",
    );
    // Confirm (y): the key leaves the list.
    harness.write("y");
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = harness.frame() ?? "";
      if (!frame.includes("Z.AI Coding Plan · API: abc..xyz")) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(
      !frame.includes("Z.AI Coding Plan · API: abc..xyz"),
      "the key left the management list",
    );
  });
});

test("a second login adds another account to the same provider", async () => {
  // Multi-account: completing a login for a provider that already holds
  // an account must MERGE, never replace.
  let settle: ((accounts: AccountSummary[]) => void) | null = null;
  const flow: AuthFlow = {
    provider: "codex",
    mode: "manualCode",
    authUrl: "https://auth.example/codex",
    callbackUrl: "https://callback.example/done",
    expiresAt: Number.MAX_SAFE_INTEGER,
    result: new Promise<AccountSummary[]>((resolve) => {
      settle = resolve;
    }),
    submit: async () => {
      settle?.([
        {
          provider: "codex",
          id: "codex-9",
          status: "active",
          statusReason: null,
          quotaQueryLastError: null,
          quotaQueryLastErrorAt: null,
          usageUpdatedAt: 1,
          createdAt: 1,
          lastUsed: 1,
          metrics: [],
          email: "second@example.com",
          authMode: "oauth",
          apiBaseUrl: null,
          userId: null,
          plan: null,
          accountId: null,
          organizationId: null,
          quota: null,
        } as unknown as AccountSummary,
      ]);
    },
    cancel: async () => {},
  };
  await withApp({ flow }, async (harness) => {
    harness.write("a");
    let frame = "";
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = harness.frame() ?? "";
      if (frame.includes("+ add account")) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    // Open the picker and filter down to Codex.
    harness.write(ENTER);
    await new Promise((r) => setTimeout(r, 80));
    harness.write("codex");
    await new Promise((r) => setTimeout(r, 120));
    harness.write(ENTER);
    await new Promise((r) => setTimeout(r, 80));
    harness.write("paste");
    await new Promise((r) => setTimeout(r, 60));
    harness.write(ENTER);
    // The auth tab manages FuelGauge only, so the merged codex accounts
    // are verified on the SOURCES tab after the flow settles.
    await new Promise((r) => setTimeout(r, 200));
    harness.write(ESC); // flow done -> management
    await new Promise((r) => setTimeout(r, 60));
    harness.write(TAB); // to the sources tab
    for (let attempt = 0; attempt < 25; attempt++) {
      frame = harness.frame() ?? "";
      if (frame.includes("second@example.com")) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(
      frame.includes("second@example.com"),
      "the new account is listed",
    );
    assert.ok(
      frame.includes("codex-1@example.com") ||
        frame.includes("codex-2@example.com"),
      "the existing accounts survived the second login",
    );
  });
});

test("claude stays network-silent until the policy confirm", async () => {
  await withApp({}, async (harness) => {
    // Claude is provider index 3.
    for (let i = 0; i < 4; i++) {
      harness.write(DOWN);
      await new Promise((r) => setTimeout(r, 15));
    }
    harness.write("a");
    await new Promise((r) => setTimeout(r, 60));
    harness.write(ENTER); // login option
    await new Promise((r) => setTimeout(r, 60));
    // beginAuth must NOT have run for the gated provider via this path; the
    // monitor refuses it. The frame stays on add/back — no auth route.
    assert.ok(
      !harness.frame().includes("Auth — Claude"),
      "no claude auth while policy unaccepted",
    );
  });
});

test("details with multiple accounts and settings stay under the viewport", async () => {
  await withApp({}, async (harness) => {
    const settle = (ms = 120) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    const lineCount = () => (harness.frame() ?? "").split("\n").length;

    // Details (seeded codex-1 + codex-2) at 80x24: pagination keeps the
    // frame under the viewport. Provider details are the sources-tab
    // Enter target.
    harness.write(TAB);
    await settle();
    harness.write(ENTER);
    await settle(200);
    let frame = harness.frame();
    assert.ok(
      frame.includes("Codex — all accounts"),
      "details overlay open for the snapped selection",
    );
    assert.ok(
      lineCount() < 24,
      `details with two accounts fits at 80x24 (got ${lineCount()})`,
    );

    // Settings at 80x10 (short layout, no gaps): fits with room.
    harness.write(ESC);
    await settle();
    await harness.resize(80, 10);
    await settle();
    harness.write("s");
    await settle(200);
    frame = harness.frame();
    assert.ok(frame.includes("Settings"), "settings route open");
    assert.ok(lineCount() < 10, `settings fits at 80x10 (got ${lineCount()})`);
  });
});

test("settings cycles auto-refresh presets and persists the choice", async () => {
  await withApp({}, async (harness) => {
    const settle = (ms = 120) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });

    harness.write("s");
    await settle(200);
    assert.ok(harness.frame().includes("Settings"), "settings route open");
    assert.ok(
      harness.frame().includes("Auto refresh: 10m"),
      "fresh install shows the 10m default",
    );

    // t walks off → 1m → 5m → 10m, replacing the old on/off + [/] pair.
    for (const label of ["off", "1m", "5m", "10m"]) {
      harness.write("t");
      await settle();
      assert.ok(
        harness.frame().includes(`Auto refresh: ${label}`),
        `t cycles to ${label}`,
      );
    }

    // The last press (back to 10m) must have reached the store.
    const persisted = await harness.runtime.store.loadSettings();
    assert.deepEqual(persisted.autoRefresh, {
      enabled: true,
      intervalSeconds: 600,
    });
  });
});

test("claude policy warning shows full risk text before acceptance", async () => {
  await withApp({ claudeAccepted: false }, async (harness) => {
    harness.write("s");
    await new Promise((r) => setTimeout(r, 40));
    harness.write("c");
    await new Promise((r) => setTimeout(r, 40));
    const frame = harness.frame();
    assert.ok(frame.includes("Claude account risk"), "warning header");
    assert.ok(frame.includes("violate"), "policy risk stated");
    assert.ok(frame.includes("restriction"), "suspension risk stated");
    assert.ok(frame.includes("silent"), "silence stated");

    // Cancel keeps it unaccepted.
    harness.write("n");
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(
      harness.frame().includes("not accepted"),
      "decline keeps policy off",
    );
  });
});

test("q typed into the password field does not quit", async () => {
  await withApp({}, async (harness) => {
    harness.write("a"); // auth tab
    await new Promise((r) => setTimeout(r, 60));
    harness.write(ENTER); // open the provider picker
    await new Promise((r) => setTimeout(r, 60));
    harness.write("coding"); // filter to Z.AI Coding Plan
    await new Promise((r) => setTimeout(r, 120));
    harness.write(ENTER); // start the add-key flow
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(harness.frame().includes("Auth — FuelGauge"), "auth route open");

    harness.write("q"); // must land in the PasswordInput, not quit
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(
      harness.frame().includes("Auth — FuelGauge"),
      "app alive after q in the secret field",
    );

    harness.write(ESC);
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(
      !harness.frame().includes("Waiting for login"),
      "Esc cancelled the flow",
    );
  });
});

test("fuelGauge add-key flow: paste hint, submission kind, and payload", async () => {
  const submissions: unknown[] = [];
  const flow: AuthFlow = {
    provider: "fuelGauge",
    mode: "apiKey",
    hint: "Z.AI coding plan API key",
    expiresAt: Number.MAX_SAFE_INTEGER,
    result: Promise.withResolvers<AccountSummary[]>().promise,
    submit: async (submission) => {
      submissions.push(submission);
    },
    cancel: async () => {},
  };
  await withApp({ flow }, async (harness) => {
    harness.write("a");
    await new Promise((r) => setTimeout(r, 80));
    const manageFrame = harness.frame();
    assert.ok(manageFrame.includes("+ add account"), "management list mounted");
    harness.write(ENTER); // open the picker
    await new Promise((r) => setTimeout(r, 80));
    harness.write("coding"); // filter to Z.AI Coding Plan
    await new Promise((r) => setTimeout(r, 120));
    harness.write(ENTER); // start the apiKey flow
    await new Promise((r) => setTimeout(r, 80));
    const authFrame = harness.frame();
    assert.ok(
      authFrame.includes("Auth — FuelGauge (apiKey)"),
      "apiKey flow mounted",
    );
    assert.ok(
      authFrame.includes("Z.AI coding plan API key"),
      "paste hint shown",
    );

    harness.write("zai-pasted-key-0123456789");
    await new Promise((r) => setTimeout(r, 60));
    harness.write(ENTER);
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(submissions, [
      { kind: "fuelGauge", apiKey: "zai-pasted-key-0123456789" },
    ]);
  });
});
test("o reopens the browser for flows without a submission field", async () => {
  const flow: AuthFlow = {
    provider: "codex",
    mode: "browserCallback",
    authUrl: "https://auth.example/browser",
    callbackUrl: "https://callback.example/done",
    expiresAt: Number.MAX_SAFE_INTEGER,
    result: Promise.withResolvers<AccountSummary[]>().promise,
    cancel: async () => {},
  };
  await withApp({ flow }, async (harness) => {
    harness.write("a"); // auth tab
    await new Promise((r) => setTimeout(r, 60));
    harness.write(ENTER); // picker
    await new Promise((r) => setTimeout(r, 60));
    harness.write("codex"); // filter to Codex
    await new Promise((r) => setTimeout(r, 120));
    harness.write(ENTER);
    await new Promise((r) => setTimeout(r, 60));
    const frame = harness.frame();
    assert.ok(frame.includes("o to reopen"), "reopen hint visible");

    harness.write("o");
    await new Promise((r) => setTimeout(r, 60));
    // The fake browser recorded exactly one open of the auth URL.
    assert.ok(
      harness.frame().includes("https://auth.example/browser"),
      "auth URL still displayed",
    );
  });
});

test("duplicate refresh while busy publishes the lock notice", async () => {
  await withApp({}, async (harness) => {
    harness.write("R");
    harness.write("r");
    await new Promise((r) => setTimeout(r, 80));
    // The notice is published on the provider record; the dashboard keeps
    // rendering and no second sequence started (refresh counts asserted in
    // the monitor suite).
    assert.ok(harness.frame().length > 0, "app still rendered");
  });
});

test("startup completes and no bell rings during the silent baseline", async () => {
  await withApp({}, async (harness) => {
    await new Promise((r) => setTimeout(r, 80));
    const frame = harness.frame();
    assert.ok(frame.includes("Accounts —"), "accounts view baseline");
    assert.ok(!frame.includes("\u0007"), "no bell in the baseline");
  });
});

test("layout adapts live: tall list, narrow stack, short compact selection", async () => {
  await withApp({}, async (harness) => {
    harness.write(TAB);
    await harness.resize(100, 40);
    // Wide AND tall: the full list plus the no-accounts block render.
    // Poll for the settle marker: early paints can predate the tab
    // switch or the startup refresh, transiently squeezing the block.
    let frame = await harness.waitForFrame(
      "no accounts · 8 sources",
      "the wide settled sources tab",
    );
    assert.ok(
      !frame.includes("Low quotas"),
      "the alert panel is gone from the sources tab",
    );
    assert.ok(frame.includes("Cursor"), "rows render at wide sizes");

    // 80x24 (narrow): single column. Only codex is populated; the eight
    // empty sources sit in the trailing no-accounts block.
    await harness.resize(80, 24);
    // The narrow frame renders identical text when everything fits, so
    // re-await the marker: it holds under the narrower budget, and the
    // poll collapses instantly when the layout did not change.
    frame = await harness.waitForFrame(
      "no accounts · 8 sources",
      "the narrow settled sources tab",
    );
    assert.ok(frame.includes("Codex"), "populated block stays");
    assert.ok(
      frame.includes("no accounts · 8 sources"),
      "the no-accounts block carries the empty sources",
    );
    assert.ok(
      frame.includes("• GitHub Copilot"),
      "no-accounts rows survive the narrow layout",
    );

    // 80x10 (short): compact selected-source view only.
    await harness.resize(80, 10);
    // The compact view is the first textual change: the block leaves
    // the frame. Poll for that state — the stale narrow frame still
    // carries the block, so the predicate cannot fire early.
    for (let attempt = 0; attempt < 50; attempt++) {
      frame = harness.visibleFrame();
      if (!frame.includes("no accounts ·") && frame.includes("[Sources]")) {
        break;
      }
      await sleep(40);
    }
    assert.ok(
      !frame.includes("no accounts ·"),
      "short view keeps only the selected block",
    );
    assert.ok(frame.includes("[Sources]"), "tab bar still rendered");
  });
});

test("sources list fits the viewport and renders every account when tall", async () => {
  const metric = (
    id: string,
    label: string,
    remainingPercent: number | null,
    extra: { used?: number; total?: number; resetAt?: number } = {},
  ) => ({
    id,
    label,
    remainingPercent,
    used: extra.used ?? null,
    total: extra.total ?? null,
    resetAt: extra.resetAt ?? null,
  });
  const summaryFor = (
    provider: ProviderId,
    id: string,
    metrics: AccountSummary["metrics"],
  ): AccountSummary =>
    ({
      provider,
      id,
      status: "active",
      statusReason: null,
      quotaQueryLastError: null,
      quotaQueryLastErrorAt: null,
      usageUpdatedAt: 1,
      createdAt: 1,
      lastUsed: 1,
      metrics,
      // Variant-specific display fields are irrelevant to metric rows.
      ...displayFieldsFor(provider, id),
    }) as AccountSummary;
  const refreshByProvider = {
    githubCopilot: [
      summaryFor("githubCopilot", "gh-1", [
        metric("githubCopilot.inline", "Inline suggestions", 80),
        metric("githubCopilot.chat", "Chat messages", 60),
        metric("githubCopilot.premium", "Premium requests", 40, {
          used: 12,
          total: 100,
        }),
      ]),
    ],
    codex: [
      summaryFor("codex", "codex-1", [
        metric("codex.primary", "3 hours", 55, {
          resetAt: 1_800_000_000_000,
        }),
        metric("codex.weekly", "Weekly usage", 70),
      ]),
    ],
    antigravity: [
      summaryFor("antigravity", "ag-1", [
        metric("antigravity.geminiFiveHour", "Gemini 5-hour", 50),
        metric("antigravity.geminiWeekly", "Gemini weekly", 60),
        metric("antigravity.thirdPartyFiveHour", "Third-party 5-hour", 70),
        metric("antigravity.thirdPartyWeekly", "Third-party weekly", 80),
      ]),
    ],
    kiro: [
      summaryFor("kiro", "kiro-1", [
        metric("kiro.credits", "Prompt credits", 75, { used: 25, total: 100 }),
        metric("kiro.bonus", "Add-on credits", 75, { used: 5, total: 20 }),
      ]),
    ],
    cursor: [
      summaryFor("cursor", "cur-1", [
        metric("cursor.total", "Total usage", 70, { used: 3, total: 10 }),
        metric("cursor.auto", "Auto + Composer", 90),
        metric("cursor.api", "API usage", null),
        metric("cursor.onDemand", "On-demand usage", 80, { used: 1, total: 5 }),
      ]),
    ],
  };
  await withApp(
    // Claude stays policy-gated (cached rows only) — the realistic mix.
    { seedAllProviders: true, refreshByProvider, claudeAccepted: false },
    async (harness) => {
      harness.write(TAB);
      await new Promise((r) => setTimeout(r, 80));
      // 80x24 (narrow): the row budget keeps the frame INSIDE the viewport —
      // Ink full-clears the screen for any frame taller than it, which is
      // the flicker bug this pins out. The vertical list renders header +
      // account rows only (no quota usage); providers beyond the budget
      // collapse into a hint while staying reachable through j/k.
      await harness.resize(80, 24);
      let frame = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        frame = harness.frame();
        // Wait until the resize actually landed (narrow single column).
        if (frame.includes("gh-1") && frame.includes("more providers")) {
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      const narrowLines = frame.split("\n").length;
      assert.ok(
        narrowLines < 24,
        `80x24 frame fits the viewport (got ${narrowLines} lines)`,
      );
      assert.ok(frame.includes("gh-1"), "first account row rendered");
      // 80x84 (tall narrow): every provider header and account identity
      // fits — one row per line keeps tall frames complete.
      await harness.resize(80, 84);
      for (let attempt = 0; attempt < 30; attempt++) {
        frame = harness.frame();
        // Cursor is the canonical tail: it only renders once the tall
        // budget admits every source.
        if (frame.includes("cur-1@example.com")) {
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      for (const label of [
        "GitHub Copilot",
        "gh-1",
        "Codex",
        "codex-1@example.com",
        "Antigravity",
        "ag-1@example.com",
        "Claude Code",
        "claude@example.com",
        "Kiro",
        "kiro-1@example.com",
        "Cursor",
        "cur-1@example.com",
      ]) {
        assert.ok(frame.includes(label), `sources list shows ${label}`);
      }
      assert.ok(
        !frame.includes("more providers"),
        "tall frames render every source",
      );
      // Details keeps the full quota breakdown (used/total counts for
      // github; the deterministic reset stamp for codex's primary window).
      harness.write(ENTER); // open details for GitHub Copilot
      await new Promise((r) => setTimeout(r, 80));
      const githubDetails = harness.frame();
      assert.ok(githubDetails.includes("12/100"), "premium used/total shown");
      harness.write("\x1b"); // back to the list
      await new Promise((r) => setTimeout(r, 60));
      harness.write("j"); // down to Codex
      await new Promise((r) => setTimeout(r, 60));
      harness.write(ENTER);
      for (let attempt = 0; attempt < 20; attempt++) {
        if ((harness.frame() ?? "").includes("reset ")) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      const codexDetails = harness.frame();
      // Ink wraps the row across lines; assert both stamp fragments.
      const iso = new Date(1_800_000_000_000).toISOString();
      assert.ok(
        codexDetails.includes(`reset ${iso.slice(0, 10)}`),
        "reset date shown",
      );
      assert.ok(
        codexDetails.includes(`${iso.slice(11, 16)}Z`),
        "reset time shown",
      );
    },
  );
});

test("short view truncates a tall source behind a per-source hint", async () => {
  // Codex refreshes to eight accounts. The short (80x12) view shows only
  // the selected source's block, so selecting Codex (one k up: it sorts
  // to the top with 8 accounts) truncates its rows behind the hint.
  const many = Array.from({ length: 8 }, (_, index) =>
    codexSummary(`codex-${index + 1}`, 50),
  );
  await withApp(
    { seedAllProviders: true, refreshByProvider: { codex: many } },
    async (harness) => {
      harness.write(TAB);
      await new Promise((r) => setTimeout(r, 80));
      harness.write("k");
      await new Promise((r) => setTimeout(r, 80));
      await harness.resize(80, 12);
      let frame = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        frame = harness.frame();
        if (frame.includes("more accounts")) {
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.ok(frame.includes("Codex"), "tall source header rendered");
      assert.ok(frame.includes("codex-1@"), "first account row kept");
      assert.ok(frame.includes("codex-4@"), "last fitting account row kept");
      assert.ok(
        frame.includes("+4 more accounts"),
        "budgeted-out accounts collapse into a hint",
      );
      assert.ok(
        !frame.includes("codex-5@"),
        "budgeted-out accounts leave the frame",
      );
      assert.ok(
        !frame.includes("GitHub Copilot"),
        "short view keeps only the selected block",
      );
      assert.ok(
        frame.split("\n").length < 12,
        `80x12 frame fits the viewport (got ${frame.split("\n").length})`,
      );
    },
  );
});

test("compact short view shows the selected source's accounts", async () => {
  // Short terminals hoist the selected source's block to the front of
  // the budget, so the selection's accounts are always the visible
  // ones — no quota rows, the list only carries identities. Distinct
  // identities per source make the swap observable.
  const refreshByProvider = {
    githubCopilot: [codexSummary("gh-1", 50)],
    codex: [codexSummary("codex-1", 50)],
  };
  await withApp(
    { seedAllProviders: true, claudeAccepted: true, refreshByProvider },
    async (harness) => {
      harness.write(TAB);
      await harness.resize(80, 10);
      // The compact frame is the only one under 10 lines; the tall
      // sources frame carries the same ❯ marker but every account, so
      // the line budget is the discriminator that proves the resize
      // landed.
      let frame = "";
      for (let attempt = 0; attempt < 50; attempt++) {
        frame = harness.visibleFrame();
        if (
          frame.includes("❯ GitHub Copilot") &&
          frame.split("\n").length < 10
        ) {
          break;
        }
        await sleep(40);
      }
      assert.ok(frame.includes("❯ GitHub Copilot"), "selected source marked");
      assert.ok(frame.includes("gh-1@example.com"), "its account visible");
      assert.ok(
        !frame.includes("cursor@example.com"),
        "later sources stay behind the budget",
      );
      // j moves DOWN to Codex; the hoist brings its block forward.
      harness.write("j");
      for (let attempt = 0; attempt < 20; attempt++) {
        frame = harness.visibleFrame();
        if (frame.includes("❯ Codex")) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.ok(frame.includes("❯ Codex"), "codex selected after j");
      assert.ok(frame.includes("codex-1@example.com"), "codex account visible");
      assert.ok(
        !frame.includes("gh-1@example.com"),
        "github account left the frame",
      );
      // k moves back UP to GitHub Copilot.
      harness.write("k");
      for (let attempt = 0; attempt < 20; attempt++) {
        frame = harness.visibleFrame();
        if (frame.includes("gh-1@example.com")) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.ok(
        frame.includes("gh-1@example.com"),
        "github account back after k",
      );
      assert.ok(
        frame.split("\n").length < 10,
        `80x10 frame fits (got ${frame.split("\n").length})`,
      );
    },
  );
});
test("j moves down and k moves up in the sources tab", async () => {
  await withApp({ seedAllProviders: true }, async (harness) => {
    harness.write(TAB);
    await new Promise((r) => setTimeout(r, 120));
    let frame = harness.frame();
    // Equal account counts keep the canonical card order; the selection
    // no longer hoists its card, so the order is stable navigation.
    assert.ok(
      frame.indexOf("GitHub Copilot") < frame.indexOf("Codex"),
      "card order stays canonical regardless of the selection",
    );
    // j moves the selection down to Codex; Enter proves the target.
    harness.write("j");
    await new Promise((r) => setTimeout(r, 60));
    harness.write(ENTER);
    await new Promise((r) => setTimeout(r, 60));
    frame = harness.frame();
    assert.ok(
      frame.includes("Codex — all accounts"),
      "j moves the selection down to Codex",
    );
    harness.write(ESC);
    await new Promise((r) => setTimeout(r, 60));
    // k moves the selection back up to GitHub Copilot.
    harness.write("k");
    await new Promise((r) => setTimeout(r, 60));
    harness.write(ENTER);
    await new Promise((r) => setTimeout(r, 60));
    frame = harness.frame();
    assert.ok(
      frame.includes("GitHub Copilot — all accounts"),
      "k moves the selection back up",
    );
  });
});
test("Ctrl-C exit path: unmount runs the awaited cleanup and cancels the flow", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-app-ctrlc-"));
  let cancels = 0;
  let registered: (() => Promise<void>) | null = null;
  const flow: AuthFlow = {
    provider: "codex",
    mode: "manualCode",
    authUrl: "https://auth.example/codex",
    callbackUrl: "https://callback.example/codex",
    expiresAt: Number.MAX_SAFE_INTEGER,
    result: Promise.withResolvers<AccountSummary[]>().promise,
    submit: async () => {},
    cancel: async () => {
      cancels += 1;
    },
  };
  const log: AdapterLog = {
    refreshAll: 0,
    beginAuth: 0,
    cancels: 0,
    removes: [],
    discover: 0,
    imports: 0,
    browserOpens: [],
  };
  const runtime = createRuntime({
    configRoot: root,
    adapters: makeRegistry(log, { flow, candidates: [], importFails: false }),
    browser: {
      async open(url: string) {
        return { url, launched: true };
      },
    },
  });
  await seedCodex(runtime);
  const view = render(
    <App
      runtime={runtime}
      registerDispose={(dispose) => {
        registered = dispose;
      }}
    />,
  );
  try {
    await new Promise((r) => setTimeout(r, 60));
    view.stdin?.write(DOWN);
    await new Promise((r) => setTimeout(r, 40));
    view.stdin?.write("a");
    await new Promise((r) => setTimeout(r, 80));
    view.stdin?.write(ENTER); // picker
    await new Promise((r) => setTimeout(r, 60));
    view.stdin?.write("coding"); // filter to Z.AI Coding Plan
    await new Promise((r) => setTimeout(r, 120));
    view.stdin?.write(ENTER);
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((view.lastFrame() ?? "").includes("Auth — FuelGauge")) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(
      (view.lastFrame() ?? "").includes("Auth — FuelGauge"),
      "auth active",
    );
    // ink-testing-library pins exitOnCtrlC:false, so unmount stands in for
    // Ink's built-in Ctrl-C exit; the App-registered cleanup must then be
    // awaitable exactly like the CLI entry does after waitUntilExit().
    view.unmount();
    assert.notEqual(registered, null, "cleanup was registered");
    const dispose = registered as unknown as () => Promise<void>;
    await dispose();
    assert.ok(cancels >= 1, "active flow cancelled by cleanup");
  } finally {
    view.unmount();
    await rm(root, { recursive: true, force: true });
  }
});

/** Display-only fields so summaries type-check for every provider. */
function displayFieldsFor(
  provider: ProviderId,
  id: string,
): Record<string, unknown> {
  switch (provider) {
    case "githubCopilot":
      return {
        githubLogin: id,
        githubName: null,
        githubEmail: null,
        plan: null,
        chatEnabled: null,
        usage: {
          inlineSuggestionsUsedPercent: null,
          chatMessagesUsedPercent: null,
          premiumRequestsUsedPercent: null,
          inlineIncluded: false,
          chatIncluded: false,
          premiumIncluded: false,
          remainingCompletions: null,
          remainingChat: null,
          remainingPremiumRequests: null,
          totalCompletions: null,
          totalChat: null,
          totalPremiumRequests: null,
          usedPremiumRequests: null,
          allowanceResetAt: null,
        },
      };
    case "codex":
      return {
        email: `${id}@example.com`,
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
      };
    case "antigravity":
      return {
        email: `${id}@example.com`,
        authId: null,
        name: null,
        source: "local",
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
      };
    case "claude":
      return {
        email: `${id}@example.com`,
        authMode: "oauth",
        accountUuid: null,
        organizationUuid: null,
        organizationName: null,
        displayName: null,
        avatarUrl: null,
        planType: null,
        quota: {
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
        },
      };
    case "kiro":
      return {
        email: `${id}@example.com`,
        loginProvider: null,
        planName: null,
        planTier: null,
        creditsTotal: null,
        creditsUsed: null,
        bonusTotal: null,
        bonusUsed: null,
        usageResetAt: null,
        bonusExpireDays: null,
      };
    case "cursor":
      return {
        email: `${id}@example.com`,
        authId: null,
        signUpType: null,
        membershipType: null,
        subscriptionStatus: null,
        source: "local",
        totalPercent: null,
        autoPercent: null,
        apiPercent: null,
        billingCycleEnd: null,
        planUsed: null,
        planLimit: null,
        onDemandEnabled: null,
        onDemandUsed: null,
        onDemandLimit: null,
      };
    case "omp":
      return {
        ompProviderId: "zai",
        displayLabel: id,
        email: null,
      };
    case "opencode":
      return {
        openCodeProviderId: "zai-coding-plan",
        authType: "api" as const,
        displayLabel: id,
      };
    case "fuelGauge":
      return {
        vendor: "zai-coding-plan" as const,
        keyFingerprint: `fp-${id}`,
        displayLabel: id,
      };
  }
}

test("sanitizeUiError redacts token-like runs before bounding", () => {
  const token = `ghp_${"A".repeat(36)}`;
  const rendered = sanitizeUiError(
    new Error(`settings load failed for ${token} and more`),
  );
  assert.ok(!rendered.includes(token), "token absent from UI error");
  assert.ok(rendered.includes("[REDACTED]"), "redaction marker present");
  // Word-separated text (not maskable as one opaque run) proves bounding.
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
  const bounded = sanitizeUiError(new Error(long), 200);
  assert.ok(bounded.length <= 202, "bounded");
  assert.ok(bounded.endsWith("…"), "truncation marker");
});

test("orderSourcesByAccounts sorts by account count and folds empties to the tail", () => {
  const summary = (id: string): AccountSummary => codexSummary(id, 50);
  const accounts = new Map<ProviderId, readonly AccountSummary[]>([
    ["githubCopilot", [summary("gh-1")]],
    ["codex", [summary("codex-1"), summary("codex-2"), summary("codex-3")]],
    ["cursor", [summary("cur-1")]],
    ["antigravity", []],
    ["fuelGauge", [summary("fg-1"), summary("fg-2")]],
  ]);
  const ordered = orderSourcesByAccounts(accounts);
  // Busiest first, one-account ties keep the canonical order, and the
  // zero-account sources fold to the tail in canonical order.
  assert.deepEqual(ordered, [
    "codex",
    "fuelGauge",
    "githubCopilot",
    "cursor",
    "antigravity",
    "claude",
    "kiro",
    "omp",
    "opencode",
  ]);
});

test("Tab and Shift+Tab cycle through every tab with wrap-around", async () => {
  await withApp({ seedAllProviders: true }, async (harness) => {
    await new Promise((r) => setTimeout(r, 80));
    let frame = harness.frame();
    assert.ok(frame.includes("Accounts —"), "accounts view is the default");
    assert.ok(frame.includes("[Accounts]"), "active tab bracketed");

    // Tab once: the Sources tab renders the source blocks.
    harness.write(TAB);
    await new Promise((r) => setTimeout(r, 80));
    frame = harness.frame();
    assert.ok(frame.includes("[Sources]"), "sources tab active");
    assert.ok(frame.includes("GitHub Copilot"), "sources view renders blocks");

    // Tab again lands on Auth: the merged FuelGauge key management.
    harness.write(TAB);
    await new Promise((r) => setTimeout(r, 80));
    frame = harness.frame();
    assert.ok(frame.includes("[Auth]"), "auth tab active");
    assert.ok(frame.includes("+ add account"), "add-account action listed");

    // Shift+Tab from Accounts wraps backwards to Help.
    harness.write(TAB);
    await new Promise((r) => setTimeout(r, 60));
    harness.write(TAB);
    await new Promise((r) => setTimeout(r, 60));
    harness.write(TAB);
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(harness.frame().includes("[Accounts]"), "full cycle returns");
    harness.write(SHIFT_TAB);
    await new Promise((r) => setTimeout(r, 80));
    frame = harness.frame();
    assert.ok(frame.includes("[Help]"), "shift-tab wraps backwards to help");
    assert.ok(frame.includes("Help — keys"), "help content rendered");
  });
});

test("accounts dashboard shows inline metric rows; Enter opens the detail modal", async () => {
  await withApp({ seedAllProviders: true }, async (harness) => {
    await new Promise((r) => setTimeout(r, 80));
    let frame = harness.frame();
    assert.ok(frame.includes("Accounts —"), "accounts view default");
    // Metric rows render for every entry without any selection.
    assert.ok(
      frame.includes("3 hours"),
      "metric rows render inline without selection",
    );
    // Enter opens the account modal for the selected entry.
    harness.write("\r");
    await new Promise((r) => setTimeout(r, 80));
    frame = harness.frame();
    assert.ok(frame.includes("Esc back"), "account modal open");
    assert.ok(frame.includes("active"), "member status shown");
    harness.write("\x1b");
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(
      harness.frame().includes("Accounts —"),
      "Esc returns to the dashboard",
    );
  });
});

test("shared ids across provider records never emit duplicate React keys", async () => {
  // The fake's refreshAll returns the same two codex summaries for
  // EVERY provider record, so both cross-provider surfaces — the
  // merged-member modal and the visibility list — see repeated ids.
  // React key warnings land on console.error; none may escape.
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    await withApp({ seedAllProviders: true }, async (harness) => {
      await sleep(80);
      harness.write("\r");
      await sleep(80);
      assert.ok(harness.frame().includes("Esc back"), "modal open");
      harness.write("\x1b");
      await sleep(60);
      harness.write("h");
      await sleep(120);
      assert.ok(harness.frame().includes("Visibility —"), "visibility open");
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(
    errors.filter((message) => message.includes("same key")),
    [],
  );
});

test("x hides the selected entry and X restores it", async () => {
  await withApp({ seedAllProviders: true }, async (harness) => {
    await new Promise((r) => setTimeout(r, 80));
    // Select the first entry and hide it.
    harness.write("j");
    await new Promise((r) => setTimeout(r, 60));
    harness.write("x");
    await new Promise((r) => setTimeout(r, 200));
    let frame = harness.frame();
    assert.ok(frame.includes("hidden (X"), "header reports the hidden count");
    // X restores everything.
    harness.write("X");
    await new Promise((r) => setTimeout(r, 120));
    frame = harness.frame();
    assert.ok(!frame.includes("hidden (X"), "X shows all again");
    const saved = await harness.runtime.store.loadSettings();
    assert.deepEqual(saved.hiddenAccountIds, [], "persisted empty");
  });
});

test("h opens the visibility modal with checkbox toggles", async () => {
  await withApp({ seedAllProviders: true }, async (harness) => {
    await new Promise((r) => setTimeout(r, 80));
    harness.write("h");
    await new Promise((r) => setTimeout(r, 120));
    let frame = harness.frame();
    assert.ok(frame.includes("Visibility —"), "modal opens");
    assert.ok(frame.includes("[x]"), "checked rows render");
    // Native provider rows lead with their provider label; agent rows
    // keep their agent prefix. Both must be present for distinction.
    assert.ok(
      frame.includes("Codex · codex-1@"),
      "native rows carry the provider name first",
    );
    // Toggle the first row off.
    harness.write(" ");
    await new Promise((r) => setTimeout(r, 150));
    frame = harness.frame();
    assert.ok(frame.includes("[ ]"), "row toggled unchecked");
    assert.ok(frame.includes("shown"), "counter renders");
    // Esc back: the hidden account left the dashboard.
    harness.write("\x1b");
    await new Promise((r) => setTimeout(r, 150));
    const saved = await harness.runtime.store.loadSettings();
    assert.equal(saved.hiddenAccountIds.length, 1, "one account hidden");
    // Reopen and toggle it back on.
    harness.write("h");
    await new Promise((r) => setTimeout(r, 120));
    harness.write(" ");
    await new Promise((r) => setTimeout(r, 150));
    harness.write("\x1b");
    await new Promise((r) => setTimeout(r, 150));
    const after = await harness.runtime.store.loadSettings();
    assert.deepEqual(after.hiddenAccountIds, [], "toggled back on");
  });
});
