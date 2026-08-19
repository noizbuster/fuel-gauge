/**
 * Emitted-distribution E2E: drives the BUILT dist modules (App, runtime,
 * monitor constants, types) through a deterministic pseudo-TTY harness.
 *
 * Execution path is `npm run test:dist`, which always follows
 * `npm run build`. Everything external is faked: six-provider adapters,
 * fetch, clock, browser opener, subprocess, and callback server run
 * against a temp real CredentialStore — no production endpoints, live
 * credentials, or new dependencies are involved.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import { createElement } from "react";
import { render } from "ink";

// The SAME installed ink/react instances the emitted modules import.
const { App } = await import("../../dist/ui/app.js");
const { createRuntime } = await import("../../dist/runtime.js");
const { REFRESH_ALREADY_RUNNING } = await import("../../dist/core/monitor.js");
const { PROVIDER_ORDER } = await import("../../dist/core/types.js");

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

/** One metric row with the exact label storage derives for that provider. */
function metric(id, label, remainingPercent) {
  return { id, label, remainingPercent, used: null, total: null, resetAt: null };
}

function baseSummaryFields(id) {
  return {
    id,
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: 1,
    createdAt: 1,
    lastUsed: 1,
  };
}

function copilotSummary() {
  return {
    ...baseSummaryFields("gh-1"),
    provider: "githubCopilot",
    githubLogin: "ghuser",
    githubName: null,
    githubEmail: null,
    plan: null,
    chatEnabled: null,
    usage: {
      inlineSuggestionsUsedPercent: 20,
      chatMessagesUsedPercent: 40,
      premiumRequestsUsedPercent: 60,
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
    metrics: [
      metric("githubCopilot.inline", "Inline suggestions", 80),
      metric("githubCopilot.chat", "Chat messages", 60),
      metric("githubCopilot.premium", "Premium requests", 40),
    ],
  };
}

function codexSummary(remainingPercent = 55, status = "active", statusReason = null) {
  return {
    ...baseSummaryFields("codex-1"),
    status,
    statusReason,
    provider: "codex",
    email: "codex@example.com",
    authMode: "oauth",
    apiBaseUrl: null,
    userId: null,
    plan: null,
    accountId: null,
    organizationId: null,
    quota: {
      hourlyRemainingPercent: remainingPercent,
      hourlyResetAt: null,
      hourlyWindowMinutes: 180,
      weeklyRemainingPercent: null,
      weeklyResetAt: null,
      weeklyWindowMinutes: null,
    },
    metrics: [
      metric("codex.primary", "Primary usage (3h window)", remainingPercent),
      metric("codex.weekly", "Weekly usage", 70),
    ],
  };
}

function antigravitySummary() {
  return {
    ...baseSummaryFields("ag-1"),
    provider: "antigravity",
    email: "ag@example.com",
    authId: null,
    name: null,
    source: "local",
    selectedAuthType: null,
    projectId: null,
    tierId: null,
    planName: null,
    credits: [],
    quota: {
      geminiFiveHour: { remainingPercent: 50, resetAt: null },
      geminiWeekly: { remainingPercent: 60, resetAt: null },
      thirdPartyFiveHour: { remainingPercent: 70, resetAt: null },
      thirdPartyWeekly: { remainingPercent: 80, resetAt: null },
    },
    metrics: [
      metric("antigravity.geminiFiveHour", "Gemini 5-hour", 50),
      metric("antigravity.geminiWeekly", "Gemini weekly", 60),
      metric("antigravity.thirdPartyFiveHour", "Third-party 5-hour", 70),
      metric("antigravity.thirdPartyWeekly", "Third-party weekly", 80),
    ],
  };
}

function claudeSummary() {
  return {
    ...baseSummaryFields("cl-1"),
    provider: "claude",
    email: "claude@example.com",
    authMode: "oauth",
    accountUuid: null,
    organizationUuid: null,
    organizationName: null,
    displayName: null,
    avatarUrl: null,
    planType: null,
    quota: {
      fiveHourRemainingPercent: 40,
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
    metrics: [
      metric("claude.fiveHour", "5-hour usage", 60),
      metric("claude.weekly", "Weekly usage", 55),
      metric("claude.weeklySonnet", "Weekly Sonnet", 90),
      metric("claude.extraUsage", "Extra usage", 50),
    ],
  };
}

function kiroSummary() {
  return {
    ...baseSummaryFields("kiro-1"),
    provider: "kiro",
    email: "kiro@example.com",
    loginProvider: null,
    planName: null,
    planTier: null,
    creditsTotal: 100,
    creditsUsed: 25,
    bonusTotal: 20,
    bonusUsed: 5,
    usageResetAt: null,
    bonusExpireDays: null,
    metrics: [
      metric("kiro.credits", "Prompt credits", 75),
      metric("kiro.bonus", "Add-on credits", 75),
    ],
  };
}

function cursorSummary() {
  return {
    ...baseSummaryFields("cur-1"),
    provider: "cursor",
    email: "cursor@example.com",
    authId: null,
    signUpType: null,
    membershipType: null,
    subscriptionStatus: null,
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
    metrics: [
      metric("cursor.total", "Total usage", 70),
      metric("cursor.auto", "Auto + Composer", 90),
      metric("cursor.api", "API usage", null),
      metric("cursor.onDemand", "On-demand usage", 80),
    ],
  };
}

const SUMMARIES = {
  githubCopilot: () => [copilotSummary()],
  codex: () => [codexSummary()],
  antigravity: () => [antigravitySummary()],
  claude: () => [claudeSummary()],
  kiro: () => [kiroSummary()],
  cursor: () => [cursorSummary()],
  omp: () => [ompSummary()],
  opencode: () => [opencodeSummary()],
  fuelGauge: () => [fuelGaugeSummary()],
};

function fuelGaugeSummary() {
  return {
    ...baseSummaryFields("fg-1"),
    provider: "fuelGauge",
    vendor: "zai-coding-plan",
    keyFingerprint: "0".repeat(32),
    displayLabel: "Z.AI Coding Plan · API: abc..xyz",
    metrics: [metric("fuelgauge.zai.time_limit", "ZAI Zread Quota (FuelGauge)", 75)],
  };
}

function opencodeSummary() {
  return {
    ...baseSummaryFields("oc-1"),
    provider: "opencode",
    openCodeProviderId: "zai-coding-plan",
    authType: "api",
    displayLabel: "Z.AI Coding Plan · API key",
    metrics: [metric("opencode.zai.time_limit", "ZAI Zread Quota (Monthly)", 100)],
  };
};

function ompSummary() {
  return {
    ...baseSummaryFields("omp-1"),
    provider: "omp",
    ompProviderId: "zai",
    displayLabel: "Z.AI (GLM) · account 1",
    email: null,
    metrics: [metric("zai:tokens:5h", "ZAI 5 Hours Token Quota", 87)],
  };
}

/** Minimal-but-valid stored accounts so the REAL store serves cache. */
async function seedStore(runtime, providers) {
  const base = {
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: 1,
    createdAt: 1,
    lastUsed: 1,
  };
  const seeds = {
    githubCopilot: {
      ...base,
      provider: "githubCopilot",
      id: "gh-1",
      githubLogin: "ghuser",
      githubId: 1,
      githubName: null,
      githubEmail: null,
      githubAccessToken: "stored-gh-token",
      githubTokenType: null,
      githubScope: null,
      copilotToken: "stored-cp-token",
      copilotPlan: null,
      copilotChatEnabled: null,
      copilotExpiresAt: null,
      copilotRefreshIn: null,
      copilotQuotaSnapshots: null,
      copilotQuotaResetDate: null,
      copilotLimitedUserQuotas: null,
      copilotLimitedUserResetAt: null,
    },
    codex: {
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
        hourlyRemainingPercent: 55,
        hourlyResetAt: null,
        hourlyWindowMinutes: 180,
        weeklyRemainingPercent: null,
        weeklyResetAt: null,
        weeklyWindowMinutes: null,
      },
    },
    antigravity: {
      ...base,
      provider: "antigravity",
      id: "ag-1",
      email: "ag@example.com",
      source: "local",
      authId: null,
      name: null,
      accessToken: "stored-ag-token",
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
        geminiWeekly: { remainingPercent: 60, resetAt: null },
        thirdPartyFiveHour: { remainingPercent: 70, resetAt: null },
        thirdPartyWeekly: { remainingPercent: 80, resetAt: null },
      },
    },
    claude: {
      ...base,
      provider: "claude",
      id: "cl-1",
      email: "claude@example.com",
      authMode: "oauth",
      accessToken: "stored-cl-token",
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
    },
    kiro: {
      ...base,
      provider: "kiro",
      id: "kiro-1",
      email: "kiro@example.com",
      loginProvider: null,
      accessToken: "stored-kiro-token",
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
    },
    cursor: {
      ...base,
      provider: "cursor",
      id: "cur-1",
      email: "cursor@example.com",
      authId: null,
      signUpType: null,
      membershipType: null,
      subscriptionStatus: null,
      accessToken: "stored-cur-token",
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
    },
    omp: {
      ...base,
      provider: "omp",
      id: "omp-1",
      ompProviderId: "zai",
      accountKey: "account 1",
      displayLabel: "Z.AI (GLM) · account 1",
      email: null,
      limits: [
        {
          id: "zai:tokens:5h",
          label: "ZAI 5 Hours Token Quota",
          windowLabel: "5 Hours",
          remainingPercent: 87,
          used: null,
          total: null,
          resetAt: null,
        },
      ],
    },
    opencode: {
      ...base,
      provider: "opencode",
      id: "oc-1",
      openCodeProviderId: "zai-coding-plan",
      authType: "api",
      expiresAt: null,
      displayLabel: "Z.AI Coding Plan · API key",
      limits: [
        {
          id: "opencode.zai.time_limit",
          label: "ZAI Zread Quota (Monthly)",
          windowLabel: "",
          remainingPercent: 100,
          used: 0,
          total: 4000,
          resetAt: null,
        },
      ],
    },
    fuelGauge: {
      ...base,
      provider: "fuelGauge",
      id: "fg-1",
      vendor: "zai-coding-plan",
      keyFingerprint: "0".repeat(32),
      apiKey: "stored-fg-key",
      displayLabel: "Z.AI Coding Plan · API: abc..xyz",
      limits: [
        {
          id: "fuelgauge.zai.time_limit",
          label: "ZAI Zread Quota (FuelGauge)",
          windowLabel: "",
          remainingPercent: 75,
          used: 1000,
          total: 4000,
          resetAt: null,
        },
      ],
    },
  };
  for (const provider of providers) {
    await runtime.store.upsert(provider, seeds[provider]);
  }
}

class FakeStdout extends PassThrough {
  isTTY = true;
  columns;
  rows;
  constructor(columns, rows) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  resize(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

class FakeStdin extends Readable {
  isTTY = true;
  rawMode = null;
  /** Every setRawMode argument, in call order. */
  rawModeHistory = [];
  _read() {}
  setRawMode(mode) {
    this.rawMode = mode;
    this.rawModeHistory.push(mode);
    return this;
  }
  ref() {}
  unref() {}
  key(bytes) {
    this.push(Buffer.from(bytes, "utf8"));
    // ink's kitty detection removes its 'data' listener, which can leave
    // this synthetic stream in flowing mode with no consumer — later
    // pushes would be dropped. read(0) re-arms paused/readable mode (the
    // documented Node trick) so the chunk is buffered for ink's reader.
    this.read(0);
    // Node re-emits 'readable' only on a nextTick after NEW data arrives,
    // so the buffered chunk can still strand until the NEXT keypress
    // drains everything at once — and read() without a size concatenates
    // the buffer, so two buffered keystrokes parse as one pasted input
    // like "jr" that single-key handlers rightly ignore. Emit 'readable'
    // synchronously: ink's reader drains read() until null, so each
    // keystroke parses alone, immediately, idempotently.
    this.emit("readable");
  }
}

function stripAnsi(text) {
  return text.replace(/\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*\x07|\x07)/g, "");
}

/** Visible line count of the last complete synchronized frame. */
function frameLineCount(raw) {
  const begin = raw.lastIndexOf("\x1b[?2026h");
  const end = raw.indexOf("\x1b[?2026l", begin < 0 ? 0 : begin);
  const body = begin < 0 ? raw : end < 0 ? raw.slice(begin) : raw.slice(begin, end);
  const lines = stripAnsi(body).replace(/\r/g, "").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

/** Deterministic injectable clock with tracked intervals. */
function fakeClock() {
  const state = { now: 1_700_000_000_000, activeIntervals: 0 };
  return {
    state,
    clock: {
      now: () => state.now,
      sleep: () => Promise.resolve(),
      setInterval: (callback, intervalMs) => {
        state.activeIntervals += 1;
        let cleared = false;
        return {
          clear: () => {
            if (cleared) return;
            cleared = true;
            state.activeIntervals -= 1;
          },
        };
      },
      clearInterval: (timer) => timer.clear(),
    },
  };
}

/** Six fake adapters sharing one counters + behavior record. */
function fakeAdapters() {
  const calls = {};
  for (const provider of PROVIDER_ORDER) {
    calls[provider] = {
      list: 0,
      discover: 0,
      import: 0,
      beginAuth: 0,
      refresh: 0,
      refreshAll: 0,
      remove: 0,
    };
  }
  const behavior = {
    refreshAllImpl: null,
    beginAuthFlow: null,
    removeImpl: null,
  };
  const authSession = { cancels: 0, listenerCloses: 0 };
  const adapters = {};
  for (const provider of PROVIDER_ORDER) {
    adapters[provider] = {
      list: async () => {
        calls[provider].list += 1;
        return SUMMARIES[provider]();
      },
      discoverImports: async () => {
        calls[provider].discover += 1;
        return [];
      },
      import: async () => {
        calls[provider].import += 1;
        return SUMMARIES[provider]();
      },
      beginAuth: async () => {
        calls[provider].beginAuth += 1;
        if (behavior.beginAuthFlow !== null) {
          return behavior.beginAuthFlow;
        }
        const listener = {
          close: () => {
            authSession.listenerCloses += 1;
          },
        };
        return {
          provider,
          mode: "browserCallback",
          authUrl: `https://auth.example/${provider}`,
          callbackUrl: "http://127.0.0.1:1466/oauth-callback",
          expiresAt: Number.MAX_SAFE_INTEGER,
          result: new Promise(() => {}),
          cancel: async () => {
            authSession.cancels += 1;
            listener.close();
          },
        };
      },
      refresh: async () => {
        calls[provider].refresh += 1;
        return SUMMARIES[provider]()[0];
      },
      refreshAll: async (signal) => {
        calls[provider].refreshAll += 1;
        if (behavior.refreshAllImpl !== null) {
          return behavior.refreshAllImpl(provider, signal);
        }
        return SUMMARIES[provider]();
      },
      remove: async (accountId) => {
        calls[provider].remove += 1;
        if (behavior.removeImpl !== null) {
          await behavior.removeImpl(provider, accountId);
        }
      },
    };
  }
  return { adapters, calls, behavior, authSession };
}

/** Full pseudo-TTY harness around the emitted App. */
async function startHarness(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "fuel-e2e-"));
  const { adapters, calls, behavior, authSession } = fakeAdapters();
  const { state, clock } = fakeClock();
  const fetchLog = [];
  const subprocessRuns = [];
  const browserOpens = [];
  const callbackStarts = [];
  const runtime = createRuntime({
    configRoot: root,
    adapters,
    fetch: async (input) => {
      fetchLog.push(String(input));
      return new Response("{}", { status: 200 });
    },
    clock,
    browser: {
      async open(url) {
        browserOpens.push(url);
        return { url, launched: true };
      },
    },
    subprocess: {
      async run(command, args) {
        subprocessRuns.push(`${command} ${args.join(" ")}`);
        return { stdout: "", stderr: "" };
      },
    },
    callbackServer: {
      async start(startOptions) {
        callbackStarts.push(startOptions.kind);
        throw new Error("callback server must not start in e2e fakes");
      },
    },
  });
  const providers = options.providers ?? PROVIDER_ORDER;
  await seedStore(runtime, providers);
  if (options.autoRefreshSeconds != null || options.claudeDeclined === true) {
    // Persisted BEFORE the App mounts, exactly like a user's saved settings.
    await runtime.store.saveSettings({
      schemaVersion: 1,
      autoRefresh: {
        enabled: options.autoRefreshSeconds != null,
        intervalSeconds: options.autoRefreshSeconds ?? 120,
      },
      alerts: { enabled: false, thresholdPercent: 20 },
      providerOrder: [...PROVIDER_ORDER],
      pinnedAccountIds: [],
      importPathOverrides: {},
      claudePolicyAccepted: options.claudeDeclined === true ? false : true,
    });
  }
  const stdout = new FakeStdout(options.columns ?? 80, options.rows ?? 24);
  const stdin = new FakeStdin();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
    // Kitty auto-negotiation: answer the capability query as a level-0
    // (non-kitty) terminal so `kittyKeyboard: { mode: "auto" }` parses
    // every keystroke exactly once, exactly like a real terminal. The
    // reply is pushed without an artificial delay: a delayed reply lets
    // test keystrokes race into ink's detection buffer, which then
    // unshift-replays them (a double-delivery artifact).
    if (chunk.toString("utf8").includes("\x1b[?u")) {
      process.nextTick(() => {
        stdin.push(Buffer.from("\x1b[?0u", "utf8"));
      });
    }
  });
  let registeredDispose = null;
  const disposePromise = Promise.withResolvers();
  // Production render options, preserved exactly (incl. exitOnCtrlC).
  const instance = render(
    createElement(App, {
      runtime,
      registerDispose: (dispose) => {
        registeredDispose = dispose;
        disposePromise.resolve(dispose);
      },
    }),
    {
      stdin,
      stdout,
      interactive: true,
      alternateScreen: true,
      kittyKeyboard: { mode: "auto" },
      exitOnCtrlC: true,
      incrementalRendering: true,
    },
  );
  const harness = {
    root,
    runtime,
    calls,
    behavior,
    authSession,
    clockState: state,
    fetchLog,
    subprocessRuns,
    browserOpens,
    callbackStarts,
    stdout,
    stdin,
    instance,
    screen: () => stripAnsi(output),
    rawOutput: () => output,
    mark: () => output.length,
    since: (mark) => stripAnsi(output.slice(mark)),
    /** The last complete frame, whitespace-normalized (wrap-safe asserts). */
    frameText() {
      const begin = output.lastIndexOf("\x1b[?2026h");
      const body =
        begin < 0
          ? output
          : (() => {
              const end = output.indexOf("\x1b[?2026l", begin);
              return end < 0 ? output.slice(begin) : output.slice(begin, end);
            })();
      return stripAnsi(body)
        .replace(/[│╭╮╰╯─┌┐└┘═║]/g, " ")
        .replace(/\s+/g, " ");
    },
    key: (bytes) => stdin.key(bytes),
    resize: (columns, rows) => stdout.resize(columns, rows),
    // Predicates may be sync or async; both are awaited before polling.
    waitFor: async (predicate, label, attempts = 40) => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (await predicate()) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail(`timed out waiting for: ${label}`);
    },
    waitForFrame: async (phrase, label, attempts = 40) => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (harness.frameText().includes(phrase)) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail(`timed out waiting for frame: ${label}`);
    },
    registeredDispose: () => disposePromise.promise,
    async teardown() {
      const dispose = await disposePromise.promise;
      instance.unmount();
      await dispose();
      await instance.waitUntilExit?.();
    },
  };
  return harness;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("dist cli.js keeps its shebang for the bin entry", async () => {
  const cli = await readFile(path.join(import.meta.dirname, "..", "..", "dist", "cli.js"), "utf8");
  assert.ok(cli.startsWith("#!/usr/bin/env node"), "shebang preserved");
});
test("height budget keeps the dashboard inside the viewport; labels survive every width", { timeout: 20_000 }, async (t) => {
  const harness = await startHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));
  try {
    // These assertions pin the vertical sources list. The sleep FIRST
    // lets ink's kitty-probe reply land, so the keypress is not replayed
    // by the detection buffer's unshift (a harness-only timing artifact).
    await sleep(200);
    harness.key("\t");
    await sleep(150);
    // One unique account identity per source: the list carries provider
    // headers plus account rows, never quota usage.
    const identities = {
      githubCopilot: "ghuser",
      codex: "codex@example.com",
      antigravity: "ag@example.com",
      claude: "claude@example.com",
      kiro: "kiro@example.com",
      cursor: "cursor@example.com",
      omp: "Z.AI (GLM) · account 1",
      // Inside a source's block the agent prefix is stripped — the box
      // already names the source.
      opencode: "Z.AI Coding Plan · API key",
      fuelGauge: "Z.AI Coding Plan · API: abc..xyz",
    };
    const allIdentities = Object.values(identities);
    const lineCount = () => frameLineCount(harness.rawOutput());
    const fits = (rows) => lineCount() < rows;

    // 80x24 (default): the frame stays UNDER the viewport height — Ink
    // full-clears (ED2) every overflowing frame, which is the flicker bug.
    // Header + account rows only; the tail collapses behind the hint.
    await harness.waitForFrame("ghuser", "80x24 frame settles");
    assert.ok(fits(24), `80x24 frame fits (got ${lineCount()} lines)`);
    assert.ok(
      harness.frameText().includes("more providers"),
      "budgeted-out providers collapse into a hint",
    );
    assert.ok(
      harness.frameText().includes("GitHub Copilot"),
      "equal-count sources keep the canonical first block at 80x24",
    );

    // Narrow single column (56x24): the first block's identity renders
    // and the frame still fits behind the collapse hint.
    harness.resize(56, 24);
    await harness.waitFor(
      () =>
        harness.frameText().includes("ghuser") &&
        harness.frameText().includes("more providers") &&
        fits(24),
      "narrow 56x24 frame with identities and budget hint",
    );

    // Tall wide terminal (100x56): every source block returns — nine
    // bordered blocks need 44 list rows (measured minimum).
    harness.resize(100, 56);
    await harness.waitFor(
      () =>
        allIdentities.every((label) => harness.screen().includes(label)) &&
        fits(56),
      "all identities fit in the 100x56 frame",
    );

    // Short compact view (80x10): the budget admits only the selected
    // source's block, so cycling j shows exactly one source's accounts
    // at a time, inside 10 rows.
    harness.resize(80, 10);
    for (const provider of PROVIDER_ORDER) {
      await harness.waitFor(
        () =>
          harness.frameText().includes(identities[provider]) &&
          PROVIDER_ORDER.every(
            (other) =>
              other === provider ||
              !harness.frameText().includes(identities[other]),
          ) &&
          fits(10),
        `compact 80x10 view shows only ${provider} accounts and fits`,
      );
      if (provider !== PROVIDER_ORDER[PROVIDER_ORDER.length - 1]) {
        harness.key("j");
        await sleep(80);
      }
    }

    await harness.waitFor(
      () =>
        fits(24) && harness.frameText().includes(identities.fuelGauge),
      "the selected fuelGauge account returns in the 80x24 frame",
    );
  } finally {
    await harness.teardown();
  }
});

test("state updates at 80x24, 80x10, and 100x30 repaint incrementally — never full-clear; resize bursts settle", { timeout: 30_000 }, async (t) => {
  const harness = await startHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));
  const countClears = (mark) =>
    (harness.rawOutput().slice(mark).match(/\x1b\[2J/g) ?? []).length;
  const fits = (rows) => frameLineCount(harness.rawOutput()) < rows;
  try {
    // Let the startup refresh settle: its transitions belong to the
    // monitor suite, not this invariant. The v switch happens AFTER the
    // settle so it never races the terminal suspension around imports.
    await harness.waitFor(
      () => harness.calls.cursor.refreshAll >= 1,
      "startup silent refresh",
    );
    await sleep(300);
    // Sources-view keyboard model (j provider nav, Enter = details).
    harness.key("\t");
    await sleep(150);
    console.error("AFTER TAB:", JSON.stringify(harness.frameText().slice(0, 120)));

    // Selection change + live refresh at 80x24: both must repaint the
    // frame WITHOUT Ink's overflow full-clear (ED2 + whole rewrite). The
    // card grid sorts by account count and does NOT hoist the selection,
    // so the selection's movement is proven causally instead: the 23% is
    // unique to the Codex refresh below, which only runs because `r`
    // targeted Codex, which requires the `j` to have landed on it.
    // (Frame-slice label checks are not a stable observable here —
    // incremental rendering only rewrites changed lines.)
    let mark = harness.mark();
    harness.behavior.refreshAllImpl = (provider) =>
      provider === "codex" ? [codexSummary(23)] : SUMMARIES[provider]();
    const codexRefreshBase = harness.calls.codex.refreshAll;
    harness.key("j"); // GitHub Copilot -> Codex
    await sleep(80);
    harness.key("r");
    // The list carries no quota values, so the refresh is proven by the
    // call count (r only targets the selected source) plus the frame
    // settling back to a non-refreshing phase.
    await harness.waitFor(
      () => harness.calls.codex.refreshAll === codexRefreshBase + 1,
      "r refreshed the selected codex source",
    );
    await harness.waitFor(
      () => !harness.frameText().includes("refreshing"),
      "refresh phase settled in the list header",
    );
    assert.ok(fits(24), "80x24 frame fits during selection updates");
    assert.equal(
      countClears(mark),
      0,
      "80x24 selection + refresh updates are zero-clear",
    );

    // 80x10 (short layout, collapsed rail): the frame fits UNDER the
    // viewport and selection + refresh updates stay zero-clear.
    harness.resize(80, 10);
    await harness.waitFor(
      () =>
        harness.frameText().includes("codex@example.com") &&
        frameLineCount(harness.rawOutput()) < 10,
      "short 80x10 frame shows the selected source's accounts and fits",
    );
    mark = harness.mark();
    harness.key("k"); // Codex -> GitHub Copilot
    await harness.waitForFrame("ghuser", "short selection update");
    assert.ok(fits(10), "80x10 frame fits during selection updates");
    assert.equal(countClears(mark), 0, "80x10 selection update is zero-clear");
    // Refresh proof: baseline the provider's refresh counter, press r,
    // wait for the call AND the busy phase to clear (refresh completed),
    // then settle — only then assert the whole span was zero-clear.
    const ghRefreshBase = harness.calls.githubCopilot.refreshAll;
    harness.behavior.refreshAllImpl = (provider) =>
      provider === "githubCopilot" ? [copilotSummary()] : SUMMARIES[provider]();
    mark = harness.mark();
    harness.key("r");
    await harness.waitFor(
      () => harness.calls.githubCopilot.refreshAll === ghRefreshBase + 1,
      "80x10 r refresh actually ran",
    );
    // The settled state is proven by the LAST COMPLETE FRAME: with
    // incremental rendering a static frame produces no further output, so
    // the cumulative raw buffer can keep stale "refreshing" bytes in its
    // tail forever.
    await harness.waitFor(
      () => !harness.frameText().includes("refreshing"),
      "80x10 refresh settled",
    );
    await sleep(150);
    assert.ok(fits(10), "80x10 frame fits during refresh updates");
    assert.equal(countClears(mark), 0, "80x10 refresh update is zero-clear");

    // 100x30 wide layout: same fit + zero-clear invariant.
    harness.resize(100, 30);
    harness.key("j"); // GitHub Copilot -> Codex
    await harness.waitForFrame("❯ Codex", "100x30 selection update");
    assert.ok(fits(30), "100x30 frame fits");
    mark = harness.mark();
    harness.key("k");
    await harness.waitForFrame("❯ GitHub Copilot", "100x30 update");
    assert.equal(countClears(mark), 0, "100x30 update is zero-clear");

    // Resize burst: width churn at constant rows must not degenerate into
    // full-screen wipes, and output must settle once the burst ends.
    mark = harness.mark();
    const burst = [
      [90, 24],
      [70, 24],
      [100, 24],
      [80, 24],
      [95, 24],
      [80, 24],
      [100, 24],
      [72, 24],
      [90, 24],
      [80, 24],
      [100, 24],
    ];
    for (const [columns, rows] of burst) {
      harness.resize(columns, rows);
      await sleep(30);
    }
    await sleep(300);
    assert.ok(
      countClears(mark) <= 2,
      `resize burst produced at most 2 full-screen clears (got ${countClears(mark)})`,
    );
    const settledAt = harness.mark();
    await sleep(250);
    assert.equal(
      harness.rawOutput().length,
      settledAt,
      "output settles after the resize burst",
    );
    assert.ok(
      fits(24) && harness.screen().includes("Inline suggestions"),
      "dashboard intact and fitting after the burst",
    );
  } finally {
    await harness.teardown();
  }
});

test("every route fits the viewport and stable updates never full-clear", { timeout: 30_000 }, async (t) => {
  const harness = await startHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));
  // Incremental rendering writes only changed lines, so route presence
  // waits read the CUMULATIVE screen with route-unique phrases.
  const countClears = (mark) =>
    (harness.rawOutput().slice(mark).match(/\x1b\[2J/g) ?? []).length;
  const fits = (rows) => frameLineCount(harness.rawOutput()) < rows;
  let mark = 0;
  try {
    // Sources-view keyboard model (j provider nav, Enter = details).
    await sleep(200);
    harness.key("\t");
    await sleep(150);
    console.error("AFTER TAB:", JSON.stringify(harness.frameText().slice(0, 120)));
    await harness.waitFor(
      () => harness.calls.cursor.refreshAll >= 1,
      "startup silent refresh",
    );
    await sleep(200);
    assert.ok(fits(24), "dashboard fits at 80x24");

    // Settings: heading + rows fit; the auto-refresh toggle is a stable
    // state update and must not full-clear.
    harness.key("s");
    await harness.waitFor(
      () => harness.screen().includes("Auto refresh:") && fits(24),
      "settings route fits",
    );
    mark = harness.mark();
    harness.key("t");
    await sleep(300);
    assert.equal(countClears(mark), 0, "settings toggle is zero-clear");
    harness.key(ESC);
    await sleep(400);
    assert.ok(fits(24), `dashboard fits after settings (got ${frameLineCount(harness.rawOutput())})`);

    // Auth (merged key management): heading, hint, and rows fit;
    // navigation is zero-clear.
    harness.key("a");
    await harness.waitFor(
      () => harness.screen().includes("+ add account") && fits(24),
      "auth management route fits",
    );
    mark = harness.mark();
    harness.key("j");
    await sleep(300);
    assert.equal(countClears(mark), 0, "add navigation is zero-clear");
    harness.key(ESC);
    await sleep(400);
    assert.ok(fits(24), "dashboard fits after add");
    // Esc from Add returns to the Accounts tab; details need Sources.
    harness.key("\t");
    await sleep(150);
    console.error("AFTER TAB:", JSON.stringify(harness.frameText().slice(0, 120)));
    // Details: heading + account blocks fit; an on-route refresh is a
    // stable state update and must not full-clear.
    harness.key(ENTER);
    await harness.waitFor(
      () => harness.screen().includes("all accounts") && fits(24),
      "details route fits",
    );
    mark = harness.mark();
    harness.key("r");
    await sleep(400);
    assert.equal(countClears(mark), 0, "details refresh is zero-clear");
    harness.key(ESC);
    await sleep(400);
    assert.ok(fits(24), "dashboard fits after details");

    // Help: dense budgeted rows fit; the static route settles to zero
    // output (no repaint loop, no clears).
    harness.key("?");
    await harness.waitFor(
      () => harness.screen().includes("Help — keys") && fits(24),
      "help route fits",
    );
    mark = harness.mark();
    await sleep(300);
    assert.equal(
      harness.rawOutput().length,
      mark,
      "help route settles to zero output",
    );
    harness.key(ESC);
    await sleep(150);

    // Short-terminal routes (80x10): settings and add must fit UNDER the
    // viewport with zero-clear stable updates — the dense-gap budgets pay
    // one row per child here.
    harness.resize(80, 10);
    await sleep(200);
    harness.key("s");
    await harness.waitFor(
      () =>
        harness.screen().includes("Auto refresh:") &&
        frameLineCount(harness.rawOutput()) < 10,
      "settings fits at 80x10",
    );
    mark = harness.mark();
    harness.key("t");
    await sleep(300);
    assert.equal(countClears(mark), 0, "80x10 settings toggle is zero-clear");
    harness.key(ESC);
    await sleep(300);
    harness.key("a");
    await harness.waitFor(
      () =>
        harness.screen().includes("+ add account") &&
        frameLineCount(harness.rawOutput()) < 10,
      "auth management route fits at 80x10",
    );
    mark = harness.mark();
    harness.key("j");
    await sleep(300);
    assert.equal(
      countClears(mark),
      0,
      "80x10 auth management navigation is zero-clear",
    );
    harness.key(ESC);
    await sleep(150);
  } finally {
    await harness.teardown();
  }
});

test("r refreshes only the selected provider", { timeout: 20_000 }, async (t) => {
  const harness = await startHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));
  try {
    // The sleep FIRST lets ink's kitty-probe reply land, so the keypress
    // is not replayed by the detection buffer's unshift (a harness-only
    // timing artifact every other test here also settles around).
    await sleep(200);
    harness.key("\t");
    await sleep(150);
    console.error("AFTER TAB:", JSON.stringify(harness.frameText().slice(0, 120)));
    await harness.waitFor(
      () => harness.calls.codex.refreshAll >= 1,
      "startup silent refresh",
    );
    await sleep(100);
    // Deterministic tall-wide size so every source block stays rendered.
    harness.resize(100, 45);
    await sleep(200);
    const baseline = {};
    for (const provider of PROVIDER_ORDER) {
      baseline[provider] = harness.calls[provider].refreshAll;
    }
    // Two DISTINCTIVE codex values (23%, then 12% — unique across every
    // provider's percentages). The sources list carries no quota values,
    // so the rendered values are proven on the DETAILS route (which
    // keeps the full breakdown); the list itself only proves targeting.
    harness.behavior.refreshAllImpl = (provider) =>
      provider === "codex"
        ? [codexSummary(23)]
        : SUMMARIES[provider]();
    harness.key("j"); // select Codex
    await sleep(80);
    harness.key("r");
    await harness.waitFor(
      () => harness.calls.codex.refreshAll === baseline.codex + 1,
      "first codex r refresh",
    );
    // Let the refresh finish (the monitor lock releases) before the
    // second r — the value render used to provide this gap.
    await harness.waitFor(
      () => !harness.frameText().includes("refreshing"),
      "first refresh settled",
    );

    harness.behavior.refreshAllImpl = (provider) =>
      provider === "codex"
        ? [codexSummary(12)]
        : SUMMARIES[provider]();
    harness.key("r");
    await harness.waitFor(
      () => harness.calls.codex.refreshAll === baseline.codex + 2,
      "second codex r refresh",
    );
    // Details renders the refreshed value; the stale one is gone from
    // the CURRENT frame (incremental output never repeats it).
    harness.key(ENTER);
    await harness.waitForFrame("12%", "refreshed codex quota on details");
    assert.ok(
      !harness.frameText().includes("23%"),
      "stale codex quota left the details frame",
    );
    harness.key(ESC);
    await sleep(100);
    for (const provider of PROVIDER_ORDER) {
      if (provider !== "codex") {
        assert.equal(
          harness.calls[provider].refreshAll,
          baseline[provider],
          `${provider} untouched by r`,
        );
      }
    }
  } finally {
    await harness.teardown();
  }
});

test("R is globally locked and sequential in canonical order; duplicate shows exact notice", { timeout: 30_000 }, async (t) => {
  const harness = await startHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));
  try {
    // Sources-view keyboard model (j provider nav, Enter = details).
    await sleep(200);
    harness.key("\t");
    await sleep(150);
    console.error("AFTER TAB:", JSON.stringify(harness.frameText().slice(0, 120)));
    await harness.waitFor(
      () => harness.calls.codex.refreshAll >= 1,
      "startup silent refresh",
    );
    await sleep(100);
    const callOrder = [];
    const gates = [];
    harness.behavior.refreshAllImpl = (provider) =>
      new Promise((resolve) => {
        callOrder.push(provider);
        gates.push(() => resolve(SUMMARIES[provider]()));
      });
    const baseline = {};
    for (const provider of PROVIDER_ORDER) {
      baseline[provider] = harness.calls[provider].refreshAll;
    }
    harness.key("R");
    await harness.waitFor(() => callOrder.length === 1, "first provider started");
    // Duplicate manual refresh while the lock is held: the exact notice
    // renders on the selected provider's details route.
    harness.key("j");
    await sleep(80);
    harness.key("r");
    await sleep(120);
    harness.key(ENTER);
    await harness.waitForFrame(REFRESH_ALREADY_RUNNING, "exact duplicate notice");
    harness.key(ESC);
    await sleep(60);
    // Sequential: release one gate at a time; the next call starts only
    // after the previous resolves.
    const expected = PROVIDER_ORDER.filter(
      (provider) => baseline[provider] > 0 && provider !== "claude",
    );
    for (let index = 0; index < expected.length; index++) {
      assert.equal(callOrder[index], expected[index], `sequential order at ${index}`);
      gates[index]?.();
      if (index + 1 < expected.length) {
        await harness.waitFor(
          () => callOrder.length === index + 2,
          `next provider after releasing ${expected[index]}`,
        );
      }
    }
    await sleep(100);
    assert.deepEqual(callOrder, expected);
    // Current-frame proof that the sequence's successes cleared the notice:
    // open the same provider's details and require the rendered account
    // WITHOUT the duplicate-notice text.
    harness.key(ENTER);
    // Incremental rendering: unchanged rows are not rewritten, so presence
    // waits read the cumulative screen.
    await harness.waitFor(
      () => harness.screen().includes("codex@example.com"),
      "post-sequence details rendered",
    );
    assert.ok(
      !harness.frameText().includes(REFRESH_ALREADY_RUNNING),
      "duplicate notice cleared from the current details frame",
    );
  } finally {
    await harness.teardown();
  }
});

test("refresh failure keeps cached quota, redacts secrets, and shows reauth transition", { timeout: 20_000 }, async (t) => {
  const harness = await startHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));
  try {
    // Sources-view keyboard model (j provider nav, Enter = details).
    await harness.waitFor(
      () => harness.calls.codex.refreshAll >= 1,
      "startup refresh",
    );
    await sleep(200);
    harness.key("\t");
    await sleep(150);
    console.error("AFTER TAB:", JSON.stringify(harness.frameText().slice(0, 120)));
    const token = "ghp_" + "A".repeat(36);
    harness.behavior.refreshAllImpl = () => {
      throw new Error(`quota fetch rejected ${token}`);
    };
    harness.key("j"); // select Codex
    await sleep(80);
    harness.key("r");
    await sleep(120);
    harness.key(ENTER); // details route renders the record error
    await harness.waitForFrame("[REDACTED]", "redacted error text");
    const screen = harness.screen();
    assert.ok(!screen.includes(token), "token never rendered");
    await harness.waitForFrame("55%", "cached quota retained");
    assert.ok(
      harness.screen().includes("Primary usage (3h window)"),
      "cached label retained",
    );
    harness.key(ESC);
    await sleep(60);

    // Recovery returns a reauthentication-required summary.
    harness.behavior.refreshAllImpl = () => [
      codexSummary(55, "requiresReauthentication", "session expired"),
    ];
    harness.key("r");
    await harness.waitFor(
      () => harness.calls.codex.refreshAll >= 3,
      "second refresh",
    );
    await sleep(120);
    harness.key(ENTER); // details for the selected provider
    await harness.waitForFrame(
      "status: reauthentication required",
      "reauth status visible",
    );
    assert.ok(harness.frameText().includes("session expired"), "reason visible");
  } finally {
    await harness.teardown();
  }
});

test("claude stays network-silent until explicit acknowledgement, then refresh runs", { timeout: 20_000 }, async (t) => {
  const harness = await startHarness({ claudeDeclined: true });
  t.after(() => rm(harness.root, { recursive: true, force: true }));
  try {
    await harness.waitFor(
      () => harness.calls.codex.refreshAll >= 1,
      "startup refresh of others",
    );
    await sleep(100);
    const claudeTotal = Object.values(harness.calls.claude).reduce((a, b) => a + b, 0);
    assert.equal(claudeTotal, 0, "zero claude adapter calls pre-acceptance");

    // Explicit acknowledgement: Settings → c → confirm y.
    harness.key("s");
    await harness.waitForFrame("Claude policy", "settings open");
    await sleep(100);
    harness.key("c");
    await harness.waitForFrame("Anthropic Terms of Service", "warning text shown");
    await sleep(100);
    harness.key("y");
    await harness.waitForFrame("Claude policy: accepted", "policy accepted");
    const settingsRaw = await readFile(
      path.join(harness.root, "settings.json"),
      "utf8",
    );
    assert.ok(settingsRaw.includes('"claudePolicyAccepted": true'), "persisted");

    // Select Claude (third provider down from GitHub Copilot) and refresh.
    harness.key(ESC); // back to dashboard
    harness.key(ESC); // back from settings (to the accounts tab)
    await sleep(80);
    harness.key("\t"); // provider selection lives in the sources tab
    await sleep(80);
    for (let i = 0; i < 3; i += 1) {
      harness.key("j");
      await sleep(60);
    }
    harness.key("r");
    await harness.waitFor(
      () => harness.calls.claude.refreshAll >= 1,
      "claude refresh after acceptance",
    );
    await harness.waitFor(
      () => harness.screen().includes("5-hour usage"),
      "claude metrics after refresh",
    );
  } finally {
    await harness.teardown();
  }
});

test("auth start then Esc closes the fake listener and cancels exactly once", { timeout: 20_000 }, async (t) => {
  const harness = await startHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));
  try {
    await harness.waitFor(
      () => harness.calls.codex.refreshAll >= 1,
      "startup refresh",
    );
    await sleep(100);
    harness.key("a"); // the auth tab manages FuelGauge keys
    await harness.waitForFrame("+ add account", "management list mounted");
    // Enter opens the provider picker; "coding" filters to the Z.AI
    // Coding Plan vendor (its API-key flow starts from the fuelGauge
    // source).
    harness.key(ENTER);
    await harness.waitForFrame("choose a provider", "picker mounted");
    for (const char of "coding") {
      harness.key(char);
    }
    await sleep(120);
    harness.key(ENTER);
    // The management screen's title is also "Auth — FuelGauge", so the
    // flow-unique URL is the observable that the login actually started.
    await harness.waitFor(
      () => harness.screen().includes("https://auth.example/fuelGauge"),
      "auth route with its URL",
    );
    assert.equal(harness.authSession.listenerCloses, 0, "listener open while mounted");
    // The 1s expiry countdown repaints this route forever: every tick
    // must be an incremental update, never a full-screen clear.
    assert.ok(
      frameLineCount(harness.rawOutput()) < 24,
      "auth route fits at 80x24",
    );
    const tickMark = harness.mark();
    // The injected clock is frozen, so drive the countdown by advancing it
    // past the 1s poll twice.
    harness.clockState.now += 1000;
    await sleep(1100);
    harness.clockState.now += 1000;
    await sleep(1100);
    assert.ok(
      harness.rawOutput().length > tickMark,
      "countdown ticks produced output",
    );
    assert.equal(
      (harness.rawOutput().slice(tickMark).match(/\x1b\[2J/g) ?? []).length,
      0,
      "countdown ticks are zero-clear",
    );
    harness.key(ESC);
    await harness.waitFor(
      () => harness.authSession.cancels === 1,
      "flow cancelled once",
    );
    assert.equal(harness.authSession.listenerCloses, 1, "listener closed once");
    await sleep(150);
    assert.equal(harness.authSession.cancels, 1, "no double cancel while idle");
  } finally {
    await harness.teardown();
  }
  assert.equal(harness.authSession.cancels, 1, "still exactly one cancel after teardown");
  assert.equal(harness.authSession.listenerCloses, 1, "listener still closed once");
});


test("injected throw handled inline; exit restores timers, listeners, raw mode, and screen", { timeout: 30_000 }, async (t) => {
  // Persisted auto-refresh ON: the scheduler's interval must be alive
  // before exit so the post-cleanup zero is not vacuous.
  const harness = await startHarness({ autoRefreshSeconds: 60 });
  t.after(() => rm(harness.root, { recursive: true, force: true }));
  let exited = false;
  try {
    // These assertions pin the source-card layout. The tab press lands
    // AFTER the startup settle so the kitty probe cannot eat it.
    await harness.waitFor(
      () => harness.calls.codex.refreshAll >= 1,
      "startup refresh",
    );
    await sleep(200);
    harness.key("\t");
    await sleep(150);
    assert.ok(
      harness.clockState.activeIntervals > 0,
      "auto-refresh interval scheduled before exit",
    );
    harness.behavior.refreshAllImpl = () => {
      throw new Error("injected provider explosion ghp_" + "B".repeat(36));
    };
    harness.key("j");
    await sleep(80);
    harness.key("r");
    await harness.waitForFrame("· error", "error phase on the card");
    harness.key(ENTER);
    await harness.waitForFrame(
      "injected provider explosion",
      "inline error shown on details",
    );
    assert.ok(harness.frameText().includes("[REDACTED]"), "secret redacted");
    assert.ok(
      !harness.screen().includes("ghp_" + "B".repeat(36)),
      "raw token never rendered",
    );

    // Deterministic exit through the App's cleanup path.
    harness.stdin.key("q");
    await Promise.race([
      harness.instance.waitUntilExit().then(() => {
        exited = true;
      }),
      sleep(5000).then(() => {
        throw new Error("app did not exit after q");
      }),
    ]);
  } finally {
    const dispose = await harness.registeredDispose();
    await dispose();
    await sleep(50);
  }
  assert.ok(exited, "waitUntilExit resolved");
  assert.equal(harness.stdin.listenerCount("data"), 0, "no stdin listeners remain");
  assert.ok(
    harness.stdin.rawModeHistory.includes(true),
    "Ink entered raw mode at least once",
  );
  assert.equal(
    harness.stdin.rawModeHistory.at(-1),
    false,
    "Ink explicitly restored raw mode to false on exit",
  );
  const raw = harness.rawOutput();
  const enterAlt = raw.lastIndexOf("\x1b[?1049h");
  const leaveAlt = raw.lastIndexOf("\x1b[?1049l");
  assert.ok(leaveAlt > enterAlt, "alternate screen left on exit");
  assert.equal(harness.clockState.activeIntervals, 0, "no clock intervals remain");
  assert.equal(harness.callbackStarts.length, 0, "no callback server started");
  assert.equal(harness.fetchLog.length, 0, "fetch never called");
  assert.equal(harness.subprocessRuns.length, 0, "no subprocess spawned");
});
