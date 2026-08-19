import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accountDisplayLabel,
  BEL,
  bellOutput,
  clampBellThreshold,
  DEFAULT_BELL_THRESHOLD,
  EMPTY_ALERTS,
  MAX_ACTIVE_ALERTS,
  updateAlerts,
  VISUAL_LOW_PERCENT,
} from "../../src/core/alerts.js";
import type {
  AccountSummary,
  AlertSettings,
  ClaudeAccountSummary,
  CodexAccountSummary,
  GitHubCopilotAccountSummary,
  KiroAccountSummary,
} from "../../src/core/types.js";

const SETTINGS: AlertSettings = { enabled: true, thresholdPercent: 20 };

function metric(
  id: string,
  label: string,
  remainingPercent: number | null,
): {
  id: string;
  label: string;
  remainingPercent: number | null;
  used: number | null;
  total: number | null;
  resetAt: number | null;
} {
  return {
    id,
    label,
    remainingPercent,
    used: null,
    total: null,
    resetAt: null,
  };
}

function copilotAccount(
  id: string,
  metrics: AccountSummary["metrics"],
  status: AccountSummary["status"] = "active",
): GitHubCopilotAccountSummary {
  return {
    provider: "githubCopilot",
    id,
    status,
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: Date.now(),
    createdAt: 0,
    lastUsed: 0,
    metrics,
    githubLogin: `login-${id}`,
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
}

function claudeAccount(
  id: string,
  metrics: AccountSummary["metrics"],
): ClaudeAccountSummary {
  return {
    provider: "claude",
    id,
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: Date.now(),
    createdAt: 0,
    lastUsed: 0,
    metrics,
    email: `user-${id}@example.com`,
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
}

function codexAccount(
  id: string,
  metrics: AccountSummary["metrics"],
): CodexAccountSummary {
  return {
    provider: "codex",
    id,
    status: "active",
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: Date.now(),
    createdAt: 0,
    lastUsed: 0,
    metrics,
    email: `codex-${id}@example.com`,
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
}

function kiroAccount(
  id: string,
  metrics: AccountSummary["metrics"],
  status: AccountSummary["status"] = "active",
): KiroAccountSummary {
  return {
    provider: "kiro",
    id,
    status,
    statusReason: null,
    quotaQueryLastError: null,
    quotaQueryLastErrorAt: null,
    usageUpdatedAt: Date.now(),
    createdAt: 0,
    lastUsed: 0,
    metrics,
    email: `kiro-${id}@example.com`,
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
}

test("metric at or below threshold fires once per drop", () => {
  const account = copilotAccount("gh1", [
    metric("githubCopilot.premium", "Premium requests", 20),
  ]);

  const first = updateAlerts(EMPTY_ALERTS, [account], SETTINGS, 1_000);
  assert.equal(first.newlyFired.length, 1);
  assert.equal(first.state.active.length, 1);
  assert.equal(
    first.state.active[0]?.key,
    "githubCopilot:gh1:githubCopilot.premium",
  );
  assert.equal(first.state.active[0]?.remainingPercent, 20);
  assert.equal(first.state.active[0]?.firedAt, 1_000);

  const second = updateAlerts(first.state, [account], SETTINGS, 2_000);
  assert.equal(second.newlyFired.length, 0);
  assert.equal(second.state.active.length, 1);
  assert.equal(second.state.active[0]?.firedAt, 1_000);
});

test("recovery above threshold re-arms the alert", () => {
  const low = copilotAccount("gh1", [
    metric("githubCopilot.premium", "Premium requests", 5),
  ]);
  const fired = updateAlerts(EMPTY_ALERTS, [low], SETTINGS, 1_000);
  assert.equal(fired.newlyFired.length, 1);

  const recovered = updateAlerts(
    fired.state,
    [
      copilotAccount("gh1", [
        metric("githubCopilot.premium", "Premium requests", 80),
      ]),
    ],
    SETTINGS,
    2_000,
  );
  assert.equal(recovered.state.active.length, 0);
  assert.equal(recovered.state.fired.size, 0);

  const droppedAgain = updateAlerts(
    recovered.state,
    [
      copilotAccount("gh1", [
        metric("githubCopilot.premium", "Premium requests", 3),
      ]),
    ],
    SETTINGS,
    3_000,
  );
  assert.equal(droppedAgain.newlyFired.length, 1);
  assert.equal(droppedAgain.newlyFired[0]?.firedAt, 3_000);
});

test("unreported null percent is never low and holds suppression without recovering", () => {
  const low = copilotAccount("gh1", [
    metric("githubCopilot.chat", "Chat messages", 10),
  ]);
  const fired = updateAlerts(EMPTY_ALERTS, [low], SETTINGS, 1_000);
  assert.equal(fired.newlyFired.length, 1);

  const unreported = updateAlerts(
    fired.state,
    [
      copilotAccount("gh1", [
        metric("githubCopilot.chat", "Chat messages", null),
      ]),
    ],
    SETTINGS,
    2_000,
  );
  assert.equal(unreported.state.active.length, 0);
  assert.equal(unreported.state.fired.size, 1, "null keeps the key suppressed");

  const flappingBack = updateAlerts(
    unreported.state,
    [
      copilotAccount("gh1", [
        metric("githubCopilot.chat", "Chat messages", 12),
      ]),
    ],
    SETTINGS,
    3_000,
  );
  assert.equal(
    flappingBack.newlyFired.length,
    0,
    "still-low after null gap must not re-bell",
  );
  assert.equal(flappingBack.state.active.length, 1);
});

test("non-active accounts never raise or keep alerts", () => {
  const low = copilotAccount("gh1", [
    metric("githubCopilot.premium", "Premium requests", 5),
  ]);
  const fired = updateAlerts(EMPTY_ALERTS, [low], SETTINGS, 1_000);
  assert.equal(fired.newlyFired.length, 1);

  const reauth = updateAlerts(
    fired.state,
    [
      copilotAccount(
        "gh1",
        [metric("githubCopilot.premium", "Premium requests", 5)],
        "requiresReauthentication",
      ),
    ],
    SETTINGS,
    2_000,
  );
  assert.equal(reauth.state.active.length, 0);
  assert.equal(
    reauth.state.fired.size,
    1,
    "stale value on a reauth account stays suppressed, not re-armed",
  );

  const banned = updateAlerts(
    reauth.state,
    [
      copilotAccount(
        "gh1",
        [metric("githubCopilot.premium", "Premium requests", 5)],
        "banned",
      ),
    ],
    SETTINGS,
    3_000,
  );
  assert.equal(banned.state.active.length, 0);
  assert.equal(banned.newlyFired.length, 0);
});

test("disappearance never re-arms; only observed recovery does", () => {
  const low = [
    copilotAccount("gh1", [
      metric("githubCopilot.premium", "Premium requests", 5),
    ]),
  ];
  const fired = updateAlerts(EMPTY_ALERTS, low, SETTINGS, 1_000);
  assert.equal(fired.state.fired.size, 1);

  // Account vanishes entirely: suppression must persist.
  const afterRemoval = updateAlerts(fired.state, [], SETTINGS, 2_000);
  assert.equal(afterRemoval.state.fired.size, 1, "key stays suppressed");
  assert.equal(afterRemoval.state.active.length, 0);

  // Returning still-low must not ring again.
  const returned = updateAlerts(afterRemoval.state, low, SETTINGS, 3_000);
  assert.equal(returned.newlyFired.length, 0);
  assert.equal(returned.state.active.length, 1);

  // An observed recovery above the threshold is the only re-arm.
  const recovered = updateAlerts(
    returned.state,
    [
      copilotAccount("gh1", [
        metric("githubCopilot.premium", "Premium requests", 80),
      ]),
    ],
    SETTINGS,
    4_000,
  );
  assert.equal(recovered.state.fired.size, 0, "recovery re-arms the key");

  const droppedAgain = updateAlerts(recovered.state, low, SETTINGS, 5_000);
  assert.equal(droppedAgain.newlyFired.length, 1);
});

test("active list caps at MAX_ACTIVE_ALERTS but suppression tracks every key", () => {
  const providers = ["githubCopilot", "codex", "claude", "kiro"] as const;
  const accounts: AccountSummary[] = [];
  let n = 0;
  for (const provider of providers) {
    for (let i = 0; i < 6; i++) {
      n++;
      const metrics = [metric(`${provider}.m${i}`, `metric ${n}`, 5)];
      if (provider === "githubCopilot")
        accounts.push(copilotAccount(`a${i}`, metrics));
      else if (provider === "codex")
        accounts.push(codexAccount(`a${i}`, metrics));
      else if (provider === "claude")
        accounts.push(claudeAccount(`a${i}`, metrics));
      else accounts.push(kiroAccount(`a${i}`, metrics));
    }
  }
  assert.equal(n, 24);

  const fired = updateAlerts(EMPTY_ALERTS, accounts, SETTINGS, 1_000);
  assert.equal(fired.state.active.length, MAX_ACTIVE_ALERTS);
  assert.equal(
    fired.newlyFired.length,
    24,
    "every crossing is new exactly once",
  );
  assert.equal(fired.state.fired.size, 24);

  const again = updateAlerts(fired.state, accounts, SETTINGS, 2_000);
  assert.equal(again.newlyFired.length, 0);
  assert.equal(again.state.active.length, MAX_ACTIVE_ALERTS);
  assert.equal(again.state.fired.size, 24, "suppression is not truncated");
});

test("order is canonical provider order then account id, independent of input order", () => {
  const low = (
    provider: "claude" | "codex" | "kiro",
    id: string,
    metricId: string,
  ) => {
    const metrics = [metric(metricId, "m", 10)];
    if (provider === "claude") return claudeAccount(id, metrics);
    if (provider === "codex") return codexAccount(id, metrics);
    return kiroAccount(id, metrics);
  };
  const shuffled = [
    low("kiro", "k1", "kiro.b"),
    low("claude", "c2", "claude.x"),
    low("codex", "d1", "codex.y"),
    low("claude", "c1", "claude.z"),
    low("kiro", "k0", "kiro.a"),
  ];

  const { state } = updateAlerts(EMPTY_ALERTS, shuffled, SETTINGS, 1);
  assert.deepEqual(
    state.active.map((alert) => alert.key),
    [
      "codex:d1:codex.y",
      "claude:c1:claude.z",
      "claude:c2:claude.x",
      "kiro:k0:kiro.a",
      "kiro:k1:kiro.b",
    ],
  );
});

test("threshold boundary is inclusive on the low side", () => {
  const at = updateAlerts(
    EMPTY_ALERTS,
    [copilotAccount("gh1", [metric("m", "m", 20)])],
    SETTINGS,
    1,
  );
  assert.equal(at.state.active.length, 1);

  const above = updateAlerts(
    EMPTY_ALERTS,
    [copilotAccount("gh1", [metric("m", "m", 20.0001)])],
    SETTINGS,
    1,
  );
  assert.equal(above.state.active.length, 0);
});

test("negative and non-finite percents are ignored", () => {
  const weird = updateAlerts(
    EMPTY_ALERTS,
    [
      copilotAccount("gh1", [
        metric("a", "a", -1),
        metric("b", "b", Number.POSITIVE_INFINITY),
        metric("c", "c", Number.NaN),
      ]),
    ],
    SETTINGS,
    1,
  );
  assert.equal(weird.state.active.length, 0);
  assert.equal(weird.state.fired.size, 0);
});

test("bell rings once per batch only when enabled", () => {
  const one = updateAlerts(
    EMPTY_ALERTS,
    [copilotAccount("gh1", [metric("m", "m", 5)])],
    SETTINGS,
    1,
  );
  const many = updateAlerts(
    EMPTY_ALERTS,
    [
      copilotAccount("gh1", [metric("m1", "m1", 5), metric("m2", "m2", 6)]),
      claudeAccount("c1", [metric("m3", "m3", 7)]),
    ],
    SETTINGS,
    1,
  );

  const ring = bellOutput(one.newlyFired, true);
  assert.equal(ring.length, 1, "exactly one character");
  assert.equal(ring.charCodeAt(0), 7, "that character is the BEL byte \\u0007");
  assert.equal(ring, BEL);
  assert.equal(
    bellOutput(many.newlyFired, true),
    BEL,
    "single BEL even for a flood",
  );
  assert.equal(
    bellOutput(one.newlyFired, false),
    "",
    "bell off by default via settings",
  );
  assert.equal(bellOutput([], true), "");
});

test("accountDisplayLabel prefers the human name fields per provider", () => {
  const gh = copilotAccount("gh1", []);
  assert.equal(
    accountDisplayLabel({ ...gh, githubName: "Ada Lovelace" }),
    "Ada Lovelace",
  );
  assert.equal(accountDisplayLabel(gh), "login-gh1");

  const claude = claudeAccount("c1", []);
  assert.equal(accountDisplayLabel(claude), "user-c1@example.com");
  assert.equal(
    accountDisplayLabel({ ...claude, displayName: "Grace Hopper" }),
    "Grace Hopper",
  );

  const kiro = kiroAccount("k1", []);
  assert.equal(accountDisplayLabel(kiro), "kiro-k1@example.com");
});

test("visual list uses the fixed 20% threshold, independent of the configured one", () => {
  const highBell: AlertSettings = { enabled: true, thresholdPercent: 99 };
  const mid = updateAlerts(
    EMPTY_ALERTS,
    [copilotAccount("gh1", [metric("m", "m", 50)])],
    highBell,
    1,
  );
  assert.equal(mid.newlyFired.length, 1, "50% crosses the 99% bell threshold");
  assert.equal(mid.state.active.length, 0, "50% is not visually low");

  const lowBell: AlertSettings = { enabled: true, thresholdPercent: 5 };
  const aboveBell = updateAlerts(
    EMPTY_ALERTS,
    [copilotAccount("gh1", [metric("m", "m", 15)])],
    lowBell,
    1,
  );
  assert.equal(aboveBell.newlyFired.length, 0, "15% never crosses the 5% bell");
  assert.equal(aboveBell.state.active.length, 1, "15% is visually low");
  assert.equal(aboveBell.state.active[0]?.remainingPercent, 15);

  const boundary = updateAlerts(
    EMPTY_ALERTS,
    [copilotAccount("gh1", [metric("m", "m", VISUAL_LOW_PERCENT + 0.001)])],
    lowBell,
    1,
  );
  assert.equal(boundary.state.active.length, 0);
});

test("bell threshold clamps into 1-99 and non-finite falls back to 20", () => {
  assert.equal(clampBellThreshold(0), 1);
  assert.equal(clampBellThreshold(-40), 1);
  assert.equal(clampBellThreshold(100), 99);
  assert.equal(clampBellThreshold(150), 99);
  assert.equal(clampBellThreshold(50.5), 50.5);
  assert.equal(clampBellThreshold(Number.NaN), DEFAULT_BELL_THRESHOLD);
  assert.equal(
    clampBellThreshold(Number.POSITIVE_INFINITY),
    DEFAULT_BELL_THRESHOLD,
  );

  // Clamping changes crossing behavior, not just the returned number.
  const clampedHigh: AlertSettings = { enabled: true, thresholdPercent: 150 };
  const stillFires = updateAlerts(
    EMPTY_ALERTS,
    [copilotAccount("gh1", [metric("m", "m", 60)])],
    clampedHigh,
    1,
  );
  assert.equal(stillFires.newlyFired.length, 1, "150 clamps to 99");

  const clampedLow: AlertSettings = { enabled: true, thresholdPercent: 0 };
  const onePercent = updateAlerts(
    EMPTY_ALERTS,
    [copilotAccount("gh1", [metric("m", "m", 1)])],
    clampedLow,
    1,
  );
  assert.equal(onePercent.newlyFired.length, 1, "0 clamps to 1");
  const halfPercent = updateAlerts(
    EMPTY_ALERTS,
    [copilotAccount("gh1", [metric("m", "m", 0.5)])],
    clampedLow,
    1,
  );
  assert.equal(
    halfPercent.newlyFired.length,
    1,
    "0.5 still crosses the 1 floor",
  );
});

test("visual episode timestamps persist across refreshes and gaps", () => {
  const low = [copilotAccount("gh1", [metric("m", "m", 10)])];
  const first = updateAlerts(EMPTY_ALERTS, low, SETTINGS, 1_000);
  assert.equal(first.state.active[0]?.firedAt, 1_000);

  const second = updateAlerts(first.state, low, SETTINGS, 2_000);
  assert.equal(
    second.state.active[0]?.firedAt,
    1_000,
    "episode start persists",
  );

  const gapped = updateAlerts(second.state, [], SETTINGS, 3_000);
  const third = updateAlerts(gapped.state, low, SETTINGS, 4_000);
  assert.equal(
    third.state.active[0]?.firedAt,
    1_000,
    "gap does not restart the episode",
  );
});
