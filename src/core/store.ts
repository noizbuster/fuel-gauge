/**
 * Private settings + credential store for Fuel Gauge.
 *
 * Layout under the resolved private root:
 *
 * - `settings.json`          schema-v1 user settings
 * - `providers/<id>.json`    `{ schemaVersion: 1, accounts: StoredAccount[] }`
 *
 * Security invariants enforced here:
 *
 * - Raw credential values exist only inside provider files. The public
 *   conversion ({@link storedAccountToSummary}) is the sole storage exit and
 *   copies fields by explicit allowlist, then recursively strips any field
 *   whose name looks token-like as defense in depth.
 * - Missing files are defaults/empty; corrupt content fails with a typed
 *   {@link StoreError} instead of being overwritten.
 * - All writes are serialized (one global settings queue, one queue per
 *   provider), staged through a same-directory temp file that is fsynced,
 *   closed, and atomically renamed over the target, with 0o700 directories
 *   and 0o600 files on POSIX.
 * - Error messages carry field names and paths only, never field values.
 */

import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  PROVIDERS_DIR_NAME,
  SETTINGS_FILE_NAME,
  USER_ADDED_FILE_NAME,
} from "./paths.js";
import type {
  AccountStatus,
  AccountSummary,
  AntigravityAccountSummary,
  AntigravityCreditInfo,
  AntigravityQuotaSummary,
  AntigravityQuotaWindow,
  ClaudeAccountSummary,
  ClaudeAuthMode,
  ClaudeQuotaSummary,
  CodexAccountSummary,
  CodexAuthMode,
  CodexQuotaSummary,
  CursorAccountSummary,
  FuelGaugeAccountSummary,
  FuelGaugeVendorId,
  GitHubCopilotAccountSummary,
  GitHubCopilotUsageSummary,
  KiroAccountSummary,
  OmpAccountSummary,
  OmpUsageLimit,
  OpenCodeAccountSummary,
  ProviderId,
  QuotaMetric,
  Settings,
  StoredAccount,
  StoredAccountBase,
  StoredAntigravityAccount,
  StoredClaudeAccount,
  StoredCodexAccount,
  StoredCodexTokens,
  StoredCursorAccount,
  StoredFuelGaugeAccount,
  StoredGitHubCopilotAccount,
  StoredKiroAccount,
  StoredOmpAccount,
  StoredOpenCodeAccount,
} from "./types.js";
import {
  isProviderId,
  PROVIDER_ORDER,
  SETTINGS_SCHEMA_VERSION,
} from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type StoreErrorCode =
  /** On-disk settings.json is unparseable or fails structural validation. */
  | "corrupt-settings"
  /** On-disk providers/<id>.json is unparseable or fails validation. */
  | "corrupt-provider-file"
  /** A saveSettings input failed structural validation. */
  | "invalid-settings"
  /** An upsert input failed structural validation. */
  | "invalid-account"
  /** The configuration root argument is unusable. */
  | "invalid-config-root"
  /** Filesystem failure while reading or writing the private store. */
  | "store-io";

/** Typed store failure; messages never contain credential values. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly path: string | null;

  constructor(
    code: StoreErrorCode,
    message: string,
    options?: { path?: string; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "StoreError";
    this.code = code;
    this.path = options?.path ?? null;
  }
}

// ---------------------------------------------------------------------------
// Default settings
// ---------------------------------------------------------------------------

/** Schema-v1 defaults applied when no settings file exists yet. */
export const DEFAULT_SETTINGS: Readonly<Settings> = deepFreeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  autoRefresh: { enabled: true, intervalSeconds: 600 },
  alerts: { enabled: false, thresholdPercent: 20 },
  providerOrder: [...PROVIDER_ORDER],
  hiddenAccountIds: [],
  pinnedAccountIds: [],
  importPathOverrides: {},
  claudePolicyAccepted: true,
});

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Structural validation primitives
// ---------------------------------------------------------------------------

/**
 * Internal sentinel for a value that does not match its declared shape.
 * Mapped to a typed {@link StoreError} (corrupt-* for on-disk data,
 * invalid-* for caller inputs) at the API boundary.
 */
class InvalidShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidShapeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new InvalidShapeError(`${where} must be an object`);
  }
  return value;
}

function expectArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new InvalidShapeError(`${where} must be an array`);
  }
  return value;
}

function expectString(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new InvalidShapeError(`${where} must be a string`);
  }
  return value;
}

function expectNonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidShapeError(`${where} must be a non-empty string`);
  }
  return value;
}

function expectNullableString(value: unknown, where: string): string | null {
  if (value == null) return null;
  return expectString(value, where);
}

function expectFiniteNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidShapeError(`${where} must be a finite number`);
  }
  return value;
}

function expectNullableNumber(value: unknown, where: string): number | null {
  if (value == null) return null;
  return expectFiniteNumber(value, where);
}

function expectBoolean(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") {
    throw new InvalidShapeError(`${where} must be a boolean`);
  }
  return value;
}

function expectNullableBoolean(value: unknown, where: string): boolean | null {
  if (value == null) return null;
  return expectBoolean(value, where);
}

function expectStringArray(value: unknown, where: string): string[] {
  return expectArray(value, where).map((entry, index) =>
    expectString(entry, `${where}[${index}]`),
  );
}

const ACCOUNT_STATUSES = {
  active: true,
  requiresReauthentication: true,
  banned: true,
  forbidden: true,
} as const satisfies Record<AccountStatus, true>;

function expectAccountStatus(value: unknown, where: string): AccountStatus {
  if (typeof value === "string" && value in ACCOUNT_STATUSES) {
    return value as AccountStatus;
  }
  throw new InvalidShapeError(`${where} must be a known account status`);
}

function expectCodexAuthMode(value: unknown, where: string): CodexAuthMode {
  if (value === "oauth" || value === "apikey") return value;
  throw new InvalidShapeError(`${where} must be "oauth" or "apikey"`);
}

function expectClaudeAuthMode(value: unknown, where: string): ClaudeAuthMode {
  if (value === "oauth" || value === "environmentToken") return value;
  throw new InvalidShapeError(`${where} must be "oauth" or "environmentToken"`);
}

function expectOpenCodeAuthType(
  value: unknown,
  where: string,
): "api" | "oauth" {
  if (value === "api" || value === "oauth") return value;
  throw new InvalidShapeError(`${where} must be "api" or "oauth"`);
}

function expectFuelGaugeVendor(
  value: unknown,
  where: string,
): FuelGaugeVendorId {
  if (value === "zai-coding-plan") return value;
  throw new InvalidShapeError(`${where} must be "zai-coding-plan"`);
}

// ---------------------------------------------------------------------------
// Settings validation
// ---------------------------------------------------------------------------

/**
 * Validates a settings value against schema v1 and returns a fresh object
 * containing only the known fields (unknown extras are ignored, matching
 * serde's default tolerance in the reference implementation).
 */
export function validateSettings(value: unknown): Settings {
  const root = expectRecord(value, "settings");
  if (root.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new InvalidShapeError(
      `settings.schemaVersion must be ${SETTINGS_SCHEMA_VERSION}`,
    );
  }

  const autoRefresh = expectRecord(root.autoRefresh, "settings.autoRefresh");
  const alerts = expectRecord(root.alerts, "settings.alerts");

  const providerOrder = expectStringArray(
    root.providerOrder,
    "settings.providerOrder",
  ).map((entry, index) => {
    if (!isProviderId(entry)) {
      throw new InvalidShapeError(
        `settings.providerOrder[${index}] must be a known provider id`,
      );
    }
    return entry;
  });
  if (new Set(providerOrder).size !== providerOrder.length) {
    throw new InvalidShapeError(
      "settings.providerOrder must not repeat a provider",
    );
  }
  // Schema v1 predates providers added after the original six (omp): a
  // saved order that is merely missing newer ids is repaired by appending
  // them in canonical position instead of failing the whole load, so a
  // fuel-gauge upgrade never bricks an existing install.
  const providerOrderWithAdditions = [
    ...providerOrder,
    ...PROVIDER_ORDER.filter((id) => !providerOrder.includes(id)),
  ];

  const overridesRecord = expectRecord(
    root.importPathOverrides,
    "settings.importPathOverrides",
  );
  const importPathOverrides: Partial<Record<ProviderId, string>> = {};
  for (const key of Object.keys(overridesRecord)) {
    if (!isProviderId(key)) {
      throw new InvalidShapeError(
        "settings.importPathOverrides keys must be known provider ids",
      );
    }
    importPathOverrides[key] = expectString(
      overridesRecord[key],
      `settings.importPathOverrides.${key}`,
    );
  }

  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    autoRefresh: {
      enabled: expectBoolean(
        autoRefresh.enabled,
        "settings.autoRefresh.enabled",
      ),
      intervalSeconds: expectFiniteNumber(
        autoRefresh.intervalSeconds,
        "settings.autoRefresh.intervalSeconds",
      ),
    },
    alerts: {
      enabled: expectBoolean(alerts.enabled, "settings.alerts.enabled"),
      thresholdPercent: expectFiniteNumber(
        alerts.thresholdPercent,
        "settings.alerts.thresholdPercent",
      ),
    },
    providerOrder: providerOrderWithAdditions,
    // Older schema-v1 files predate per-account hiding; missing = none.
    hiddenAccountIds:
      root.hiddenAccountIds === undefined
        ? []
        : expectStringArray(root.hiddenAccountIds, "settings.hiddenAccountIds"),
    pinnedAccountIds: expectStringArray(
      root.pinnedAccountIds,
      "settings.pinnedAccountIds",
    ),
    importPathOverrides,
    claudePolicyAccepted: expectBoolean(
      root.claudePolicyAccepted,
      "settings.claudePolicyAccepted",
    ),
  };
}

// ---------------------------------------------------------------------------
// Stored-account validation
// ---------------------------------------------------------------------------

function validateAccountBase(
  record: Record<string, unknown>,
  where: string,
): StoredAccountBase {
  return {
    id: expectNonEmptyString(record.id, `${where}.id`),
    status: expectAccountStatus(record.status, `${where}.status`),
    statusReason: expectNullableString(
      record.statusReason,
      `${where}.statusReason`,
    ),
    quotaQueryLastError: expectNullableString(
      record.quotaQueryLastError,
      `${where}.quotaQueryLastError`,
    ),
    quotaQueryLastErrorAt: expectNullableNumber(
      record.quotaQueryLastErrorAt,
      `${where}.quotaQueryLastErrorAt`,
    ),
    usageUpdatedAt: expectNullableNumber(
      record.usageUpdatedAt,
      `${where}.usageUpdatedAt`,
    ),
    createdAt: expectFiniteNumber(record.createdAt, `${where}.createdAt`),
    lastUsed: expectFiniteNumber(record.lastUsed, `${where}.lastUsed`),
  };
}

function validateCodexTokens(value: unknown, where: string): StoredCodexTokens {
  const record = expectRecord(value, where);
  return {
    idToken: expectString(record.idToken, `${where}.idToken`),
    accessToken: expectString(record.accessToken, `${where}.accessToken`),
    refreshToken: expectNullableString(
      record.refreshToken,
      `${where}.refreshToken`,
    ),
  };
}

function validateCodexQuota(value: unknown, where: string): CodexQuotaSummary {
  const record = expectRecord(value, where);
  return {
    hourlyRemainingPercent: expectNullableNumber(
      record.hourlyRemainingPercent,
      `${where}.hourlyRemainingPercent`,
    ),
    hourlyResetAt: expectNullableNumber(
      record.hourlyResetAt,
      `${where}.hourlyResetAt`,
    ),
    hourlyWindowMinutes: expectNullableNumber(
      record.hourlyWindowMinutes,
      `${where}.hourlyWindowMinutes`,
    ),
    weeklyRemainingPercent: expectNullableNumber(
      record.weeklyRemainingPercent,
      `${where}.weeklyRemainingPercent`,
    ),
    weeklyResetAt: expectNullableNumber(
      record.weeklyResetAt,
      `${where}.weeklyResetAt`,
    ),
    weeklyWindowMinutes: expectNullableNumber(
      record.weeklyWindowMinutes,
      `${where}.weeklyWindowMinutes`,
    ),
  };
}

function validateAntigravityWindow(
  value: unknown,
  where: string,
): AntigravityQuotaWindow {
  const record = expectRecord(value, where);
  return {
    remainingPercent: expectNullableNumber(
      record.remainingPercent,
      `${where}.remainingPercent`,
    ),
    resetAt: expectNullableNumber(record.resetAt, `${where}.resetAt`),
  };
}

function validateAntigravityQuota(
  value: unknown,
  where: string,
): AntigravityQuotaSummary {
  const record = expectRecord(value, where);
  return {
    geminiFiveHour: validateAntigravityWindow(
      record.geminiFiveHour,
      `${where}.geminiFiveHour`,
    ),
    geminiWeekly: validateAntigravityWindow(
      record.geminiWeekly,
      `${where}.geminiWeekly`,
    ),
    thirdPartyFiveHour: validateAntigravityWindow(
      record.thirdPartyFiveHour,
      `${where}.thirdPartyFiveHour`,
    ),
    thirdPartyWeekly: validateAntigravityWindow(
      record.thirdPartyWeekly,
      `${where}.thirdPartyWeekly`,
    ),
  };
}

function validateCredits(
  value: unknown,
  where: string,
): AntigravityCreditInfo[] {
  return expectArray(value, where).map((entry, index) => {
    const record = expectRecord(entry, `${where}[${index}]`);
    return {
      creditType: expectString(
        record.creditType,
        `${where}[${index}].creditType`,
      ),
      creditAmount: expectNullableString(
        record.creditAmount,
        `${where}[${index}].creditAmount`,
      ),
      minimumCreditAmountForUsage: expectNullableString(
        record.minimumCreditAmountForUsage,
        `${where}[${index}].minimumCreditAmountForUsage`,
      ),
    };
  });
}

function validateClaudeQuota(
  value: unknown,
  where: string,
): ClaudeQuotaSummary {
  const record = expectRecord(value, where);
  return {
    fiveHourRemainingPercent: expectNullableNumber(
      record.fiveHourRemainingPercent,
      `${where}.fiveHourRemainingPercent`,
    ),
    fiveHourResetAt: expectNullableNumber(
      record.fiveHourResetAt,
      `${where}.fiveHourResetAt`,
    ),
    weeklyRemainingPercent: expectNullableNumber(
      record.weeklyRemainingPercent,
      `${where}.weeklyRemainingPercent`,
    ),
    weeklyResetAt: expectNullableNumber(
      record.weeklyResetAt,
      `${where}.weeklyResetAt`,
    ),
    weeklySonnetRemainingPercent: expectNullableNumber(
      record.weeklySonnetRemainingPercent,
      `${where}.weeklySonnetRemainingPercent`,
    ),
    weeklySonnetResetAt: expectNullableNumber(
      record.weeklySonnetResetAt,
      `${where}.weeklySonnetResetAt`,
    ),
    extraUsageRemainingPercent: expectNullableNumber(
      record.extraUsageRemainingPercent,
      `${where}.extraUsageRemainingPercent`,
    ),
    extraUsageResetAt: expectNullableNumber(
      record.extraUsageResetAt,
      `${where}.extraUsageResetAt`,
    ),
    extraUsageUsedCents: expectNullableNumber(
      record.extraUsageUsedCents,
      `${where}.extraUsageUsedCents`,
    ),
    extraUsageLimitCents: expectNullableNumber(
      record.extraUsageLimitCents,
      `${where}.extraUsageLimitCents`,
    ),
  };
}

/**
 * Validates one stored account. The `provider` discriminant must match
 * `expectedProvider`, so provider files can never mix discriminants.
 * Raw JSON blob fields (`copilotQuotaSnapshots` and friends) accept any
 * JSON value; a missing value is normalized to `null`.
 */
export function validateStoredAccount(
  value: unknown,
  expectedProvider: ProviderId,
): StoredAccount {
  const record = expectRecord(value, "account");
  const provider = expectString(
    record.provider,
    "account.provider",
  ) as ProviderId;
  if (provider !== expectedProvider) {
    throw new InvalidShapeError(
      `account.provider must be "${expectedProvider}" for this provider store`,
    );
  }
  const base = validateAccountBase(record, "account");

  switch (provider) {
    case "githubCopilot":
      return {
        ...base,
        provider,
        githubLogin: expectString(record.githubLogin, "account.githubLogin"),
        githubId: expectFiniteNumber(record.githubId, "account.githubId"),
        githubName: expectNullableString(
          record.githubName,
          "account.githubName",
        ),
        githubEmail: expectNullableString(
          record.githubEmail,
          "account.githubEmail",
        ),
        githubAccessToken: expectString(
          record.githubAccessToken,
          "account.githubAccessToken",
        ),
        githubTokenType: expectNullableString(
          record.githubTokenType,
          "account.githubTokenType",
        ),
        githubScope: expectNullableString(
          record.githubScope,
          "account.githubScope",
        ),
        copilotToken: expectString(record.copilotToken, "account.copilotToken"),
        copilotPlan: expectNullableString(
          record.copilotPlan,
          "account.copilotPlan",
        ),
        copilotChatEnabled: expectNullableBoolean(
          record.copilotChatEnabled,
          "account.copilotChatEnabled",
        ),
        copilotExpiresAt: expectNullableNumber(
          record.copilotExpiresAt,
          "account.copilotExpiresAt",
        ),
        copilotRefreshIn: expectNullableNumber(
          record.copilotRefreshIn,
          "account.copilotRefreshIn",
        ),
        copilotQuotaSnapshots: record.copilotQuotaSnapshots ?? null,
        copilotQuotaResetDate: expectNullableString(
          record.copilotQuotaResetDate,
          "account.copilotQuotaResetDate",
        ),
        copilotLimitedUserQuotas: record.copilotLimitedUserQuotas ?? null,
        copilotLimitedUserResetAt: expectNullableNumber(
          record.copilotLimitedUserResetAt,
          "account.copilotLimitedUserResetAt",
        ),
      } satisfies StoredGitHubCopilotAccount;

    case "codex":
      return {
        ...base,
        provider,
        email: expectString(record.email, "account.email"),
        authMode: expectCodexAuthMode(record.authMode, "account.authMode"),
        openAIApiKey: expectNullableString(
          record.openAIApiKey,
          "account.openAIApiKey",
        ),
        apiBaseUrl: expectNullableString(
          record.apiBaseUrl,
          "account.apiBaseUrl",
        ),
        userId: expectNullableString(record.userId, "account.userId"),
        plan: expectNullableString(record.plan, "account.plan"),
        accountId: expectNullableString(record.accountId, "account.accountId"),
        organizationId: expectNullableString(
          record.organizationId,
          "account.organizationId",
        ),
        tokens:
          record.tokens == null
            ? null
            : validateCodexTokens(record.tokens, "account.tokens"),
        quota: validateCodexQuota(record.quota, "account.quota"),
      } satisfies StoredCodexAccount;

    case "antigravity":
      return {
        ...base,
        provider,
        email: expectString(record.email, "account.email"),
        source: expectString(record.source, "account.source"),
        authId: expectNullableString(record.authId, "account.authId"),
        name: expectNullableString(record.name, "account.name"),
        accessToken: expectString(record.accessToken, "account.accessToken"),
        refreshToken: expectNullableString(
          record.refreshToken,
          "account.refreshToken",
        ),
        idToken: expectNullableString(record.idToken, "account.idToken"),
        tokenType: expectNullableString(record.tokenType, "account.tokenType"),
        scope: expectNullableString(record.scope, "account.scope"),
        expiryDate: expectNullableNumber(
          record.expiryDate,
          "account.expiryDate",
        ),
        selectedAuthType: expectNullableString(
          record.selectedAuthType,
          "account.selectedAuthType",
        ),
        projectId: expectNullableString(record.projectId, "account.projectId"),
        tierId: expectNullableString(record.tierId, "account.tierId"),
        planName: expectNullableString(record.planName, "account.planName"),
        credits: validateCredits(record.credits, "account.credits"),
        quota: validateAntigravityQuota(record.quota, "account.quota"),
      } satisfies StoredAntigravityAccount;

    case "claude":
      return {
        ...base,
        provider,
        email: expectString(record.email, "account.email"),
        authMode: expectClaudeAuthMode(record.authMode, "account.authMode"),
        accessToken: expectString(record.accessToken, "account.accessToken"),
        refreshToken: expectNullableString(
          record.refreshToken,
          "account.refreshToken",
        ),
        tokenType: expectNullableString(record.tokenType, "account.tokenType"),
        scopes: expectStringArray(record.scopes, "account.scopes"),
        expiresAt: expectNullableNumber(record.expiresAt, "account.expiresAt"),
        accountUuid: expectNullableString(
          record.accountUuid,
          "account.accountUuid",
        ),
        organizationUuid: expectNullableString(
          record.organizationUuid,
          "account.organizationUuid",
        ),
        organizationName: expectNullableString(
          record.organizationName,
          "account.organizationName",
        ),
        displayName: expectNullableString(
          record.displayName,
          "account.displayName",
        ),
        avatarUrl: expectNullableString(record.avatarUrl, "account.avatarUrl"),
        planType: expectNullableString(record.planType, "account.planType"),
        quota: validateClaudeQuota(record.quota, "account.quota"),
      } satisfies StoredClaudeAccount;

    case "kiro":
      return {
        ...base,
        provider,
        email: expectString(record.email, "account.email"),
        loginProvider: expectNullableString(
          record.loginProvider,
          "account.loginProvider",
        ),
        accessToken: expectString(record.accessToken, "account.accessToken"),
        refreshToken: expectNullableString(
          record.refreshToken,
          "account.refreshToken",
        ),
        expiresAt: expectNullableNumber(record.expiresAt, "account.expiresAt"),
        idcRegion: expectNullableString(record.idcRegion, "account.idcRegion"),
        clientId: expectNullableString(record.clientId, "account.clientId"),
        planName: expectNullableString(record.planName, "account.planName"),
        planTier: expectNullableString(record.planTier, "account.planTier"),
        creditsTotal: expectNullableNumber(
          record.creditsTotal,
          "account.creditsTotal",
        ),
        creditsUsed: expectNullableNumber(
          record.creditsUsed,
          "account.creditsUsed",
        ),
        bonusTotal: expectNullableNumber(
          record.bonusTotal,
          "account.bonusTotal",
        ),
        bonusUsed: expectNullableNumber(record.bonusUsed, "account.bonusUsed"),
        usageResetAt: expectNullableNumber(
          record.usageResetAt,
          "account.usageResetAt",
        ),
        bonusExpireDays: expectNullableNumber(
          record.bonusExpireDays,
          "account.bonusExpireDays",
        ),
        kiroAuthTokenRaw: record.kiroAuthTokenRaw ?? null,
        kiroProfileRaw: record.kiroProfileRaw ?? null,
      } satisfies StoredKiroAccount;

    case "cursor":
      return {
        ...base,
        provider,
        email: expectNullableString(record.email, "account.email"),
        authId: expectNullableString(record.authId, "account.authId"),
        signUpType: expectNullableString(
          record.signUpType,
          "account.signUpType",
        ),
        membershipType: expectNullableString(
          record.membershipType,
          "account.membershipType",
        ),
        subscriptionStatus: expectNullableString(
          record.subscriptionStatus,
          "account.subscriptionStatus",
        ),
        accessToken: expectString(record.accessToken, "account.accessToken"),
        refreshToken: expectNullableString(
          record.refreshToken,
          "account.refreshToken",
        ),
        source: expectString(record.source, "account.source"),
        totalPercent: expectNullableNumber(
          record.totalPercent,
          "account.totalPercent",
        ),
        autoPercent: expectNullableNumber(
          record.autoPercent,
          "account.autoPercent",
        ),
        apiPercent: expectNullableNumber(
          record.apiPercent,
          "account.apiPercent",
        ),
        billingCycleEnd: expectNullableNumber(
          record.billingCycleEnd,
          "account.billingCycleEnd",
        ),
        planUsed: expectNullableNumber(record.planUsed, "account.planUsed"),
        planLimit: expectNullableNumber(record.planLimit, "account.planLimit"),
        onDemandEnabled: expectNullableBoolean(
          record.onDemandEnabled,
          "account.onDemandEnabled",
        ),
        onDemandUsed: expectNullableNumber(
          record.onDemandUsed,
          "account.onDemandUsed",
        ),
        onDemandLimit: expectNullableNumber(
          record.onDemandLimit,
          "account.onDemandLimit",
        ),
      } satisfies StoredCursorAccount;

    case "omp":
      return {
        ...base,
        provider,
        ompProviderId: expectString(
          record.ompProviderId,
          "account.ompProviderId",
        ),
        accountKey: expectString(record.accountKey, "account.accountKey"),
        displayLabel: expectString(record.displayLabel, "account.displayLabel"),
        email: expectNullableString(record.email, "account.email"),
        keyFingerprint: expectNullableString(
          record.keyFingerprint,
          "account.keyFingerprint",
        ),
        limits: validateOmpLimits(record.limits, "account.limits"),
      } satisfies StoredOmpAccount;

    case "opencode":
      return {
        ...base,
        provider,
        openCodeProviderId: expectString(
          record.openCodeProviderId,
          "account.openCodeProviderId",
        ),
        authType: expectOpenCodeAuthType(record.authType, "account.authType"),
        keyFingerprint: expectNullableString(
          record.keyFingerprint,
          "account.keyFingerprint",
        ),
        email: expectNullableString(record.email, "account.email"),
        expiresAt: expectNullableNumber(record.expiresAt, "account.expiresAt"),
        displayLabel: expectString(record.displayLabel, "account.displayLabel"),
        limits: validateOmpLimits(record.limits, "account.limits"),
      } satisfies StoredOpenCodeAccount;

    case "fuelGauge":
      return {
        ...base,
        provider,
        vendor: expectFuelGaugeVendor(record.vendor, "account.vendor"),
        apiKey: expectString(record.apiKey, "account.apiKey"),
        keyFingerprint: expectString(
          record.keyFingerprint,
          "account.keyFingerprint",
        ),
        displayLabel: expectString(record.displayLabel, "account.displayLabel"),
        limits: validateOmpLimits(record.limits, "account.limits"),
      } satisfies StoredFuelGaugeAccount;
  }
}

function validateOmpLimits(value: unknown, field: string): OmpUsageLimit[] {
  if (!Array.isArray(value)) {
    throw new InvalidShapeError(`${field} must be an array`);
  }
  return value.map((entry, index) => {
    const limit = expectRecord(entry, `${field}[${index}]`);
    return {
      id: expectString(limit.id, `${field}[${index}].id`),
      label: expectString(limit.label, `${field}[${index}].label`),
      windowLabel: expectString(
        limit.windowLabel,
        `${field}[${index}].windowLabel`,
      ),
      remainingPercent: expectNullableNumber(
        limit.remainingPercent,
        `${field}[${index}].remainingPercent`,
      ),
      used: expectNullableNumber(limit.used, `${field}[${index}].used`),
      total: expectNullableNumber(limit.total, `${field}[${index}].total`),
      resetAt: expectNullableNumber(
        limit.resetAt,
        `${field}[${index}].resetAt`,
      ),
    } satisfies OmpUsageLimit;
  });
}

/**
 * Validates a parsed `providers/<id>.json` document and returns its
 * accounts. A discriminant that does not match the file's provider fails
 * validation, so provider files can never mix discriminants.
 */
export function validateStoredProviderFile(
  provider: ProviderId,
  value: unknown,
): StoredAccount[] {
  const root = expectRecord(value, "provider file");
  if (root.schemaVersion !== 1) {
    throw new InvalidShapeError("provider file schemaVersion must be 1");
  }
  const accounts = expectArray(root.accounts, "provider file accounts");
  return accounts.map((entry, index) => {
    try {
      return validateStoredAccount(entry, provider);
    } catch (error) {
      if (error instanceof InvalidShapeError) {
        throw new InvalidShapeError(`accounts[${index}]: ${error.message}`);
      }
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// GitHub Copilot usage derivation (ported from the reference client)
// ---------------------------------------------------------------------------

function snapshotField(
  input: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isRecord(input)) return undefined;
  const entry = input[key];
  return isRecord(entry) ? entry : undefined;
}

function snapshotNumber(
  item: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  if (item == null) return undefined;
  return roundNumber(item[key]);
}

function roundNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return undefined;
}

function clampUsagePercent(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function copilotTokenValue(token: string, key: string): string | undefined {
  const prefix = token.split(":")[0] ?? token;
  for (const part of prefix.split(";")) {
    const [partKey, partValue] = part.split("=");
    if (partKey?.trim() === key) return partValue?.trim();
  }
  return undefined;
}

/** Copilot `rd` token claim is epoch seconds; output is milliseconds. */
function copilotResetFromToken(token: string): number | undefined {
  const value = copilotTokenValue(token, "rd");
  const head = value?.split(":")[0]?.trim();
  const parsed = head == null ? undefined : Number.parseInt(head, 10);
  return parsed != null && Number.isFinite(parsed) ? parsed * 1000 : undefined;
}

/**
 * Parses a Copilot quota reset date: `YYYY-MM-DD` is UTC midnight, other
 * values fall back to RFC 3339 parsing. Output is epoch milliseconds.
 */
export function parseCopilotResetDate(date: string): number | undefined {
  const trimmed = date.trim();
  if (!trimmed) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = Date.parse(`${trimmed}T00:00:00Z`);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function percentFromSnapshot(
  item: Record<string, unknown> | undefined,
): number | undefined {
  if (!item) return undefined;
  if (item.unlimited === true) return 0;
  const entitlement = snapshotNumber(item, "entitlement");
  if (entitlement != null && entitlement < 0) return 0;
  const percentRemaining = snapshotNumber(item, "percent_remaining");
  return percentRemaining == null
    ? undefined
    : Math.min(100, Math.max(0, 100 - percentRemaining));
}

function includedFromSnapshot(
  item: Record<string, unknown> | undefined,
): boolean {
  if (!item) return false;
  if (item.unlimited === true) return true;
  const entitlement = snapshotNumber(item, "entitlement");
  return entitlement != null && entitlement < 0;
}

function remainingFromSnapshot(
  item: Record<string, unknown> | undefined,
): number | undefined {
  if (!item) return undefined;
  const remaining = snapshotNumber(item, "remaining");
  if (remaining != null) return remaining;
  const entitlement = snapshotNumber(item, "entitlement");
  const percentRemaining = snapshotNumber(item, "percent_remaining");
  if (entitlement == null || percentRemaining == null || entitlement <= 0) {
    return undefined;
  }
  return Math.round((entitlement * percentRemaining) / 100);
}

function usedPercent(
  total: number | undefined,
  remaining: number | undefined,
): number | undefined {
  if (total == null || remaining == null || total <= 0) return undefined;
  return clampUsagePercent(((total - remaining) / total) * 100);
}

/**
 * Derives the public Copilot usage summary from a stored account's raw
 * quota snapshots, exactly following the reference client's fallback
 * chain. `copilotLimitedUserResetAt` is already epoch milliseconds.
 */
export function buildCopilotUsageSummary(
  account: StoredGitHubCopilotAccount,
): GitHubCopilotUsageSummary {
  const completions = snapshotField(
    account.copilotQuotaSnapshots,
    "completions",
  );
  const chat = snapshotField(account.copilotQuotaSnapshots, "chat");
  const premium =
    snapshotField(account.copilotQuotaSnapshots, "premium_interactions") ??
    snapshotField(account.copilotQuotaSnapshots, "premium_models");

  const limitedQuotas = isRecord(account.copilotLimitedUserQuotas)
    ? account.copilotLimitedUserQuotas
    : undefined;

  const remainingCompletions =
    remainingFromSnapshot(completions) ??
    (limitedQuotas == null
      ? undefined
      : roundNumber(limitedQuotas.completions));
  const remainingChat =
    remainingFromSnapshot(chat) ??
    (limitedQuotas == null ? undefined : roundNumber(limitedQuotas.chat));
  const remainingPremium = remainingFromSnapshot(premium);

  const totalCompletions =
    snapshotNumber(completions, "entitlement") ?? remainingCompletions;
  const totalChat = snapshotNumber(chat, "entitlement") ?? remainingChat;
  const totalPremium =
    snapshotNumber(premium, "entitlement") ?? remainingPremium;
  const exactRemainingPremium = snapshotNumber(premium, "remaining");

  const resetFromDate =
    account.copilotQuotaResetDate == null
      ? undefined
      : parseCopilotResetDate(account.copilotQuotaResetDate);

  return {
    inlineSuggestionsUsedPercent:
      percentFromSnapshot(completions) ??
      usedPercent(totalCompletions, remainingCompletions) ??
      null,
    chatMessagesUsedPercent:
      percentFromSnapshot(chat) ??
      usedPercent(totalChat, remainingChat) ??
      null,
    premiumRequestsUsedPercent:
      percentFromSnapshot(premium) ??
      usedPercent(totalPremium, remainingPremium) ??
      null,
    inlineIncluded: includedFromSnapshot(completions),
    chatIncluded: includedFromSnapshot(chat),
    premiumIncluded: includedFromSnapshot(premium),
    remainingCompletions: remainingCompletions ?? null,
    remainingChat: remainingChat ?? null,
    remainingPremiumRequests: exactRemainingPremium ?? remainingPremium ?? null,
    totalCompletions: totalCompletions ?? null,
    totalChat: totalChat ?? null,
    totalPremiumRequests: totalPremium ?? null,
    usedPremiumRequests:
      totalPremium != null && exactRemainingPremium != null
        ? Math.max(0, totalPremium - exactRemainingPremium)
        : null,
    allowanceResetAt:
      account.copilotLimitedUserResetAt ??
      resetFromDate ??
      copilotResetFromToken(account.copilotToken) ??
      null,
  };
}

// ---------------------------------------------------------------------------
// Normalized quota metrics
// ---------------------------------------------------------------------------

function clampMetricPercent(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function remainingFromUsedPercent(
  usedPercentValue: number | null,
): number | null {
  if (usedPercentValue == null) return null;
  return clampMetricPercent(100 - usedPercentValue);
}

function remainingFromCounts(
  used: number | null,
  total: number | null,
): number | null {
  if (used == null || total == null || total <= 0) return null;
  return clampMetricPercent(((total - used) / total) * 100);
}

function metric(
  id: string,
  label: string,
  remainingPercent: number | null,
  used: number | null,
  total: number | null,
  resetAt: number | null,
): QuotaMetric {
  return { id, label, remainingPercent, used, total, resetAt };
}

function codexPrimaryLabel(windowMinutes: number | null): string {
  if (windowMinutes == null || windowMinutes <= 0) return "Primary usage";
  const hours = windowMinutes / 60;
  const duration =
    hours >= 1 && Number.isInteger(hours) ? `${hours}h` : `${windowMinutes}m`;
  return `Primary usage (${duration} window)`;
}

/**
 * Derives the normalized metric set for a stored account. Every provider
 * always emits its full canonical slot list; unknown values stay `null` so
 * the UI and alerts see stable slots (alerts skip null percentages).
 */
export function deriveQuotaMetrics(account: StoredAccount): QuotaMetric[] {
  switch (account.provider) {
    case "githubCopilot": {
      const usage = buildCopilotUsageSummary(account);
      const resetAt = usage.allowanceResetAt;
      return [
        metric(
          "githubCopilot.inline",
          "Inline suggestions",
          remainingFromUsedPercent(usage.inlineSuggestionsUsedPercent),
          null,
          usage.totalCompletions,
          resetAt,
        ),
        metric(
          "githubCopilot.chat",
          "Chat messages",
          remainingFromUsedPercent(usage.chatMessagesUsedPercent),
          null,
          usage.totalChat,
          resetAt,
        ),
        metric(
          "githubCopilot.premium",
          "Premium requests",
          remainingFromUsedPercent(usage.premiumRequestsUsedPercent),
          usage.usedPremiumRequests,
          usage.totalPremiumRequests,
          resetAt,
        ),
      ];
    }
    case "codex":
      return [
        metric(
          "codex.primary",
          codexPrimaryLabel(account.quota.hourlyWindowMinutes),
          clampMetricPercent(account.quota.hourlyRemainingPercent),
          null,
          null,
          account.quota.hourlyResetAt,
        ),
        metric(
          "codex.weekly",
          "Weekly usage",
          clampMetricPercent(account.quota.weeklyRemainingPercent),
          null,
          null,
          account.quota.weeklyResetAt,
        ),
      ];
    case "antigravity":
      return [
        metric(
          "antigravity.geminiFiveHour",
          "Gemini 5-hour",
          clampMetricPercent(account.quota.geminiFiveHour.remainingPercent),
          null,
          null,
          account.quota.geminiFiveHour.resetAt,
        ),
        metric(
          "antigravity.geminiWeekly",
          "Gemini weekly",
          clampMetricPercent(account.quota.geminiWeekly.remainingPercent),
          null,
          null,
          account.quota.geminiWeekly.resetAt,
        ),
        metric(
          "antigravity.thirdPartyFiveHour",
          "Third-party 5-hour",
          clampMetricPercent(account.quota.thirdPartyFiveHour.remainingPercent),
          null,
          null,
          account.quota.thirdPartyFiveHour.resetAt,
        ),
        metric(
          "antigravity.thirdPartyWeekly",
          "Third-party weekly",
          clampMetricPercent(account.quota.thirdPartyWeekly.remainingPercent),
          null,
          null,
          account.quota.thirdPartyWeekly.resetAt,
        ),
      ];
    case "claude":
      return [
        metric(
          "claude.fiveHour",
          "5-hour usage",
          clampMetricPercent(account.quota.fiveHourRemainingPercent),
          null,
          null,
          account.quota.fiveHourResetAt,
        ),
        metric(
          "claude.weekly",
          "Weekly usage",
          clampMetricPercent(account.quota.weeklyRemainingPercent),
          null,
          null,
          account.quota.weeklyResetAt,
        ),
        metric(
          "claude.weeklySonnet",
          "Weekly Sonnet",
          clampMetricPercent(account.quota.weeklySonnetRemainingPercent),
          null,
          null,
          account.quota.weeklySonnetResetAt,
        ),
        metric(
          "claude.extraUsage",
          "Extra usage",
          clampMetricPercent(account.quota.extraUsageRemainingPercent),
          account.quota.extraUsageUsedCents,
          account.quota.extraUsageLimitCents,
          account.quota.extraUsageResetAt,
        ),
      ];
    case "kiro":
      return [
        metric(
          "kiro.credits",
          "Prompt credits",
          remainingFromCounts(account.creditsUsed, account.creditsTotal),
          account.creditsUsed,
          account.creditsTotal,
          account.usageResetAt,
        ),
        metric(
          "kiro.bonus",
          "Add-on credits",
          remainingFromCounts(account.bonusUsed, account.bonusTotal),
          account.bonusUsed,
          account.bonusTotal,
          null,
        ),
      ];
    case "cursor":
      return [
        metric(
          "cursor.total",
          "Total usage",
          remainingFromUsedPercent(account.totalPercent),
          account.planUsed,
          account.planLimit,
          account.billingCycleEnd,
        ),
        metric(
          "cursor.auto",
          "Auto + Composer",
          remainingFromUsedPercent(account.autoPercent),
          null,
          null,
          account.billingCycleEnd,
        ),
        metric(
          "cursor.api",
          "API usage",
          remainingFromUsedPercent(account.apiPercent),
          null,
          null,
          account.billingCycleEnd,
        ),
        metric(
          "cursor.onDemand",
          "On-demand usage",
          remainingFromCounts(account.onDemandUsed, account.onDemandLimit),
          account.onDemandUsed,
          account.onDemandLimit,
          null,
        ),
      ];
    case "omp":
      return account.limits.map((limit) =>
        metric(
          limit.id,
          ompMetricLabel(limit),
          clampMetricPercent(limit.remainingPercent),
          limit.used,
          limit.total,
          limit.resetAt,
        ),
      );
    case "opencode":
      return account.limits.map((limit) =>
        metric(
          limit.id,
          ompMetricLabel(limit),
          clampMetricPercent(limit.remainingPercent),
          limit.used,
          limit.total,
          limit.resetAt,
        ),
      );

    case "fuelGauge":
      return account.limits.map((limit) =>
        metric(
          limit.id,
          ompMetricLabel(limit),
          clampMetricPercent(limit.remainingPercent),
          limit.used,
          limit.total,
          limit.resetAt,
        ),
      );
  }
}

/**
 * omp limit labels already carry their model context ("Usage (Google)",
 * "ZAI 5 Hours Token Quota"); the window label is appended only when it
 * adds information, so "7 days · 7 days" never renders.
 */
function ompMetricLabel(limit: OmpUsageLimit): string {
  if (limit.windowLabel === "" || limit.label.includes(limit.windowLabel)) {
    return limit.label;
  }
  return `${limit.label} (${limit.windowLabel})`;
}

// ---------------------------------------------------------------------------
// Public (token-free) conversion
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERN = /token|secret|password|credential|api[_-]?key/i;

/**
 * Recursively removes every field whose name looks credential-like, together
 * with its value. Applied to public summaries as defense in depth on top of
 * the explicit allowlist conversion below.
 */
export function redactSensitiveFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveFields(entry)) as T;
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      result[key] = redactSensitiveFields(entry);
    }
    return result as T;
  }
  return value;
}

/** Shortest stored value treated as a scrub-worthy secret. */
const MIN_SECRET_VALUE_LENGTH = 8;

/** Marker substituted for leaked credential values in public strings. */
const SECRET_VALUE_MARKER = "[REDACTED]";

/**
 * Collects the raw credential VALUES of a stored account: any string under
 * a credential-like key. Values — unlike field names — can be copied into
 * safe fields such as `statusReason` or `quotaQueryLastError` when a
 * provider echoes them, so summaries scrub exact occurrences as well.
 */
function collectSecretValues(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSecretValues(entry, into);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (
        typeof entry === "string" &&
        SENSITIVE_KEY_PATTERN.test(key) &&
        entry.length >= MIN_SECRET_VALUE_LENGTH
      ) {
        into.push(entry);
      } else {
        collectSecretValues(entry, into);
      }
    }
  }
}

/** Replaces every exact occurrence of any collected secret with a marker. */
function scrubSecretValues(
  value: unknown,
  secrets: readonly string[],
): unknown {
  if (typeof value === "string") {
    let scrubbed = value;
    for (const secret of secrets) {
      scrubbed = scrubbed.replaceAll(secret, SECRET_VALUE_MARKER);
    }
    return scrubbed;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrubSecretValues(entry, secrets));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = scrubSecretValues(entry, secrets);
    }
    return result;
  }
  return value;
}

/**
 * The final public-summary barrier: drop credential-like field names, then
 * scrub exact credential VALUES out of every remaining string.
 */
function finalizeSummary<T>(summary: T, account: StoredAccount): T {
  const secrets: string[] = [];
  collectSecretValues(account, secrets);
  return scrubSecretValues(redactSensitiveFields(summary), secrets) as T;
}

/**
 * The sole storage exit: converts a stored account into its token-free
 * public summary by explicit field allowlist (credential fields are never
 * copied), derives the normalized metric set, and scrubs residual
 * credential-like field names and credential VALUES defensively.
 */
export function storedAccountToSummary(account: StoredAccount): AccountSummary {
  const base = {
    id: account.id,
    status: account.status,
    statusReason: account.statusReason,
    quotaQueryLastError: account.quotaQueryLastError,
    quotaQueryLastErrorAt: account.quotaQueryLastErrorAt,
    usageUpdatedAt: account.usageUpdatedAt,
    createdAt: account.createdAt,
    lastUsed: account.lastUsed,
    metrics: deriveQuotaMetrics(account),
  };

  switch (account.provider) {
    case "githubCopilot": {
      const summary: GitHubCopilotAccountSummary = {
        ...base,
        provider: "githubCopilot",
        githubLogin: account.githubLogin,
        githubName: account.githubName,
        githubEmail: account.githubEmail,
        plan: account.copilotPlan,
        chatEnabled: account.copilotChatEnabled,
        usage: buildCopilotUsageSummary(account),
      };
      return finalizeSummary(summary, account);
    }
    case "codex": {
      const summary: CodexAccountSummary = {
        ...base,
        provider: "codex",
        email: account.email,
        authMode: account.authMode,
        apiBaseUrl: account.apiBaseUrl,
        userId: account.userId,
        plan: account.plan,
        accountId: account.accountId,
        organizationId: account.organizationId,
        quota: account.quota,
      };
      return finalizeSummary(summary, account);
    }
    case "antigravity": {
      const summary: AntigravityAccountSummary = {
        ...base,
        provider: "antigravity",
        email: account.email,
        authId: account.authId,
        name: account.name,
        source: account.source,
        selectedAuthType: account.selectedAuthType,
        projectId: account.projectId,
        tierId: account.tierId,
        planName: account.planName,
        credits: account.credits,
        quota: account.quota,
      };
      return finalizeSummary(summary, account);
    }
    case "claude": {
      const summary: ClaudeAccountSummary = {
        ...base,
        provider: "claude",
        email: account.email,
        authMode: account.authMode,
        accountUuid: account.accountUuid,
        organizationUuid: account.organizationUuid,
        organizationName: account.organizationName,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
        planType: account.planType,
        quota: account.quota,
      };
      return finalizeSummary(summary, account);
    }
    case "kiro": {
      const summary: KiroAccountSummary = {
        ...base,
        provider: "kiro",
        email: account.email,
        loginProvider: account.loginProvider,
        planName: account.planName,
        planTier: account.planTier,
        creditsTotal: account.creditsTotal,
        creditsUsed: account.creditsUsed,
        bonusTotal: account.bonusTotal,
        bonusUsed: account.bonusUsed,
        usageResetAt: account.usageResetAt,
        bonusExpireDays: account.bonusExpireDays,
      };
      return finalizeSummary(summary, account);
    }
    case "cursor": {
      const summary: CursorAccountSummary = {
        ...base,
        provider: "cursor",
        email: account.email,
        authId: account.authId,
        signUpType: account.signUpType,
        membershipType: account.membershipType,
        subscriptionStatus: account.subscriptionStatus,
        source: account.source,
        totalPercent: account.totalPercent,
        autoPercent: account.autoPercent,
        apiPercent: account.apiPercent,
        billingCycleEnd: account.billingCycleEnd,
        planUsed: account.planUsed,
        planLimit: account.planLimit,
        onDemandEnabled: account.onDemandEnabled,
        onDemandUsed: account.onDemandUsed,
        onDemandLimit: account.onDemandLimit,
      };
      return finalizeSummary(summary, account);
    }
    case "omp": {
      const summary: OmpAccountSummary = {
        ...base,
        provider: "omp",
        ompProviderId: account.ompProviderId,
        displayLabel: account.displayLabel,
        email: account.email,
        keyFingerprint: account.keyFingerprint,
      };
      return finalizeSummary(summary, account);
    }
    case "opencode": {
      const summary: OpenCodeAccountSummary = {
        ...base,
        provider: "opencode",
        openCodeProviderId: account.openCodeProviderId,
        authType: account.authType,
        keyFingerprint: account.keyFingerprint,
        email: account.email,
        displayLabel: account.displayLabel,
      };
      return finalizeSummary(summary, account);
    }

    case "fuelGauge": {
      const summary: FuelGaugeAccountSummary = {
        ...base,
        provider: "fuelGauge",
        vendor: account.vendor,
        keyFingerprint: account.keyFingerprint,
        displayLabel: account.displayLabel,
      };
      return finalizeSummary(summary, account);
    }
  }
}

function codexQuotaIsEmpty(quota: CodexQuotaSummary): boolean {
  return (
    quota.hourlyRemainingPercent == null &&
    quota.hourlyResetAt == null &&
    quota.hourlyWindowMinutes == null &&
    quota.weeklyRemainingPercent == null &&
    quota.weeklyResetAt == null &&
    quota.weeklyWindowMinutes == null
  );
}

function antigravityQuotaIsEmpty(quota: AntigravityQuotaSummary): boolean {
  return (
    quota.geminiFiveHour.remainingPercent == null &&
    quota.geminiFiveHour.resetAt == null &&
    quota.geminiWeekly.remainingPercent == null &&
    quota.geminiWeekly.resetAt == null &&
    quota.thirdPartyFiveHour.remainingPercent == null &&
    quota.thirdPartyFiveHour.resetAt == null &&
    quota.thirdPartyWeekly.remainingPercent == null &&
    quota.thirdPartyWeekly.resetAt == null
  );
}

function claudeQuotaIsEmpty(quota: ClaudeQuotaSummary): boolean {
  return (
    quota.fiveHourRemainingPercent == null &&
    quota.fiveHourResetAt == null &&
    quota.weeklyRemainingPercent == null &&
    quota.weeklyResetAt == null &&
    quota.weeklySonnetRemainingPercent == null &&
    quota.weeklySonnetResetAt == null &&
    quota.extraUsageRemainingPercent == null &&
    quota.extraUsageResetAt == null &&
    quota.extraUsageUsedCents == null &&
    quota.extraUsageLimitCents == null
  );
}

/**
 * Merges an incoming account over its existing record.
 *
 * `createdAt` is always preserved. Every absent SAFE field falls back to its
 * prior value — independently, not all-or-nothing: a partial refresh must
 * never erase the other blocks it did not mention, and an empty provider
 * quota block falls back to the last safe quota together with its
 * `usageUpdatedAt` (mirroring the reference upsert rules).
 */
function mergeExistingAccount(
  existing: StoredAccount,
  incoming: StoredAccount,
): StoredAccount {
  const merged: StoredAccount = { ...incoming, createdAt: existing.createdAt };

  switch (merged.provider) {
    case "githubCopilot": {
      const prior = existing as StoredGitHubCopilotAccount;
      return {
        ...merged,
        copilotQuotaSnapshots:
          merged.copilotQuotaSnapshots ?? prior.copilotQuotaSnapshots,
        copilotQuotaResetDate:
          merged.copilotQuotaResetDate ?? prior.copilotQuotaResetDate,
        copilotLimitedUserQuotas:
          merged.copilotLimitedUserQuotas ?? prior.copilotLimitedUserQuotas,
        copilotLimitedUserResetAt:
          merged.copilotLimitedUserResetAt ?? prior.copilotLimitedUserResetAt,
        usageUpdatedAt: merged.usageUpdatedAt ?? prior.usageUpdatedAt,
      };
    }
    case "codex": {
      const prior = existing as StoredCodexAccount;
      return {
        ...merged,
        quota: codexQuotaIsEmpty(merged.quota) ? prior.quota : merged.quota,
        usageUpdatedAt: merged.usageUpdatedAt ?? prior.usageUpdatedAt,
      };
    }
    case "antigravity": {
      const prior = existing as StoredAntigravityAccount;
      return {
        ...merged,
        projectId: merged.projectId ?? prior.projectId,
        tierId: merged.tierId ?? prior.tierId,
        planName: merged.planName ?? prior.planName,
        credits: merged.credits.length > 0 ? merged.credits : prior.credits,
        quota: antigravityQuotaIsEmpty(merged.quota)
          ? prior.quota
          : merged.quota,
        usageUpdatedAt: merged.usageUpdatedAt ?? prior.usageUpdatedAt,
      };
    }
    case "claude": {
      const prior = existing as StoredClaudeAccount;
      return {
        ...merged,
        quota: claudeQuotaIsEmpty(merged.quota) ? prior.quota : merged.quota,
        usageUpdatedAt: merged.usageUpdatedAt ?? prior.usageUpdatedAt,
      };
    }
    case "kiro": {
      const prior = existing as StoredKiroAccount;
      return {
        ...merged,
        creditsTotal: merged.creditsTotal ?? prior.creditsTotal,
        creditsUsed: merged.creditsUsed ?? prior.creditsUsed,
        bonusTotal: merged.bonusTotal ?? prior.bonusTotal,
        bonusUsed: merged.bonusUsed ?? prior.bonusUsed,
        usageResetAt: merged.usageResetAt ?? prior.usageResetAt,
        bonusExpireDays: merged.bonusExpireDays ?? prior.bonusExpireDays,
        usageUpdatedAt: merged.usageUpdatedAt ?? prior.usageUpdatedAt,
      };
    }
    case "cursor": {
      const prior = existing as StoredCursorAccount;
      return {
        ...merged,
        totalPercent: merged.totalPercent ?? prior.totalPercent,
        autoPercent: merged.autoPercent ?? prior.autoPercent,
        apiPercent: merged.apiPercent ?? prior.apiPercent,
        billingCycleEnd: merged.billingCycleEnd ?? prior.billingCycleEnd,
        planUsed: merged.planUsed ?? prior.planUsed,
        planLimit: merged.planLimit ?? prior.planLimit,
        onDemandEnabled: merged.onDemandEnabled ?? prior.onDemandEnabled,
        onDemandUsed: merged.onDemandUsed ?? prior.onDemandUsed,
        onDemandLimit: merged.onDemandLimit ?? prior.onDemandLimit,
        usageUpdatedAt: merged.usageUpdatedAt ?? prior.usageUpdatedAt,
      };
    }
    case "omp": {
      const prior = existing as StoredOmpAccount;
      return {
        ...merged,
        limits: merged.limits.length > 0 ? merged.limits : prior.limits,
        usageUpdatedAt: merged.usageUpdatedAt ?? prior.usageUpdatedAt,
      };
    }
    case "opencode": {
      const prior = existing as StoredOpenCodeAccount;
      return {
        ...merged,
        limits: merged.limits.length > 0 ? merged.limits : prior.limits,
        usageUpdatedAt: merged.usageUpdatedAt ?? prior.usageUpdatedAt,
      };
    }

    case "fuelGauge": {
      const prior = existing as StoredFuelGaugeAccount;
      return {
        ...merged,
        limits: merged.limits.length > 0 ? merged.limits : prior.limits,
        usageUpdatedAt: merged.usageUpdatedAt ?? prior.usageUpdatedAt,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Serialized write queues
// ---------------------------------------------------------------------------

const noop = (): void => {};

/**
 * A promise chain that survives rejected operations: the tail never
 * rejects and the next operation runs regardless of the previous outcome.
 */
class WriteQueue {
  #tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation, operation);
    this.#tail = run.then(noop, noop);
    return run;
  }
}

// ---------------------------------------------------------------------------
// Atomic file writes
// ---------------------------------------------------------------------------

const POSIX = process.platform !== "win32";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  if (POSIX) {
    await chmod(directory, DIRECTORY_MODE);
  }
}

/**
 * Writes `text` to `targetPath` atomically: a same-directory temp file is
 * created with 0o600, written, fsynced, closed, then renamed over the
 * target. POSIX directory permissions are enforced at 0o700.
 */
async function writeTextFileAtomic(
  targetPath: string,
  text: string,
): Promise<void> {
  const directory = path.dirname(targetPath);
  await ensurePrivateDirectory(directory);

  const unique = randomBytes(6).toString("hex");
  const tempPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${unique}.tmp`,
  );

  let handle: FileHandle | null = null;
  try {
    // Exclusive create: never follow a symlink or clobber an existing file
    // at the temp path, even if another process guessed the same name.
    handle = await open(tempPath, "wx", FILE_MODE);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (POSIX) {
      await chmod(tempPath, FILE_MODE);
    }
    await rename(tempPath, targetPath);
  } catch (error) {
    if (handle != null) {
      try {
        await handle.close();
      } catch {
        // Best-effort cleanup; the original error is reported below.
      }
    }
    await rm(tempPath, { force: true }).catch(noop);
    throw new StoreError(
      "store-io",
      `Could not write ${path.basename(targetPath)} atomically`,
      { path: targetPath, cause: error },
    );
  }
}

/** Width of the first-run auto-import burst the backfill treats as not user-added. */
const FIRST_RUN_BURST_MS = 60_000;

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readTextFile(
  filePath: string,
  description: string,
): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isENOENT(error)) return null;
    throw new StoreError("store-io", `Could not read ${description}`, {
      path: filePath,
      cause: error,
    });
  }
}

function isENOENT(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Validates a parsed `user-added.json` document (see loadUserAddedAccountIds). */
function validateUserAddedDocument(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    throw new InvalidShapeError("user-added: document must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new InvalidShapeError("user-added: schemaVersion must be 1");
  }
  if (!Array.isArray(record.ids)) {
    throw new InvalidShapeError("user-added: ids must be an array");
  }
  return record.ids.map((id, index) => {
    if (typeof id !== "string" || id === "") {
      throw new InvalidShapeError(
        `user-added: ids[${index}] must be a non-empty string`,
      );
    }
    return id;
  });
}

function parseJsonText(text: string, description: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new StoreError(
      description === "settings" ? "corrupt-settings" : "corrupt-provider-file",
      `${description} file is not valid JSON`,
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// CredentialStore

/**
 * Serialized, atomic, token-safe storage for settings and imported
 * provider accounts under one private configuration root.
 */
export class CredentialStore {
  readonly #root: string;
  readonly #settingsFile: string;
  readonly #userAddedFile: string;
  readonly #providersDir: string;
  readonly #settingsQueue = new WriteQueue();
  readonly #providerQueues = new Map<ProviderId, WriteQueue>();

  constructor(configRoot: string) {
    if (typeof configRoot !== "string" || configRoot.trim() === "") {
      throw new StoreError(
        "invalid-config-root",
        "configRoot must be a non-empty directory path",
      );
    }
    this.#root = configRoot;
    this.#settingsFile = path.join(configRoot, SETTINGS_FILE_NAME);
    this.#providersDir = path.join(configRoot, PROVIDERS_DIR_NAME);
    this.#userAddedFile = path.join(configRoot, USER_ADDED_FILE_NAME);
  }

  /** The private configuration root this store owns. */
  get root(): string {
    return this.#root;
  }

  /** Absolute path of a provider's account file. */
  providerFile(provider: ProviderId): string {
    return path.join(this.#providersDir, `${provider}.json`);
  }

  /**
   * Loads settings. A missing (or empty) file yields a fresh copy of
   * {@link DEFAULT_SETTINGS}; corrupt content throws a typed error and is
   * never overwritten.
   */
  async loadSettings(): Promise<Settings> {
    const text = await readTextFile(this.#settingsFile, "settings");
    if (text == null || text.trim() === "") {
      return structuredClone(DEFAULT_SETTINGS) as Settings;
    }
    const parsed = parseJsonText(text, "settings");
    try {
      return validateSettings(parsed);
    } catch (error) {
      throw toCorruptError(
        error,
        "corrupt-settings",
        "settings",
        this.#settingsFile,
      );
    }
  }

  /**
   * Validates and persists settings. Writes are globally serialized and
   * atomic; a rejected write never poisons the queue.
   */
  async saveSettings(settings: Settings): Promise<void> {
    let normalized: Settings;
    try {
      normalized = validateSettings(settings);
    } catch (error) {
      throw toInvalidError(error, "invalid-settings", "settings");
    }
    const text = serializeJson(normalized);
    await this.#settingsQueue.enqueue(async () => {
      await ensurePrivateDirectory(this.#root);
      await writeTextFileAtomic(this.#settingsFile, text);
    });
  }

  /**
   * Loads the ids of accounts the USER added through Fuel Gauge itself
   * (picker logins, pasted API keys) — never auto-imported or
   * agent-imported credentials. A missing file is a legacy store: the
   * ids are backfilled once with the first-run burst heuristic
   * ({@link backfillUserAddedIds}) and persisted, so every later load is
   * exact.
   */
  async loadUserAddedAccountIds(): Promise<ReadonlySet<string>> {
    const text = await readTextFile(this.#userAddedFile, "user-added");
    if (text != null && text.trim() !== "") {
      return new Set(
        validateUserAddedDocument(parseJsonText(text, "user-added")),
      );
    }
    const ids = await this.#backfillUserAddedIds();
    await this.#writeUserAddedIds(ids);
    return new Set(ids);
  }

  /**
   * Marks accounts as user-added (auth-flow completion) and persists the
   * merged set atomically. Unknown ids are harmless: the set only ever
   * filters display.
   */
  async markUserAddedAccountIds(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.#settingsQueue.enqueue(async () => {
      const text = await readTextFile(this.#userAddedFile, "user-added");
      const current =
        text != null && text.trim() !== ""
          ? validateUserAddedDocument(parseJsonText(text, "user-added"))
          : [];
      const merged = [...new Set([...current, ...ids])];
      await ensurePrivateDirectory(this.#root);
      await writeTextFileAtomic(
        this.#userAddedFile,
        serializeJson({ schemaVersion: 1, ids: merged }),
      );
    });
  }

  /**
   * One-time legacy backfill: accounts created inside the first run's
   * startup burst (default-on auto-import sweeps every local credential
   * within seconds of the first launch) are NOT user-added; anything
   * created after that window came from an explicit add. The heuristic
   * runs exactly once — after it persists, exact writes take over.
   */
  async #backfillUserAddedIds(): Promise<string[]> {
    let earliest: number | null = null;
    const stamped: { id: string; createdAt: number }[] = [];
    for (const provider of PROVIDER_ORDER) {
      for (const account of await this.listStored(provider)) {
        stamped.push({ id: account.id, createdAt: account.createdAt });
        if (
          earliest === null ||
          (typeof account.createdAt === "number" &&
            account.createdAt < earliest)
        ) {
          earliest = account.createdAt;
        }
      }
    }
    if (earliest === null) {
      return [];
    }
    const burstEnd = earliest + FIRST_RUN_BURST_MS;
    return stamped
      .filter((entry) => entry.createdAt > burstEnd)
      .map((entry) => entry.id);
  }

  async #writeUserAddedIds(ids: readonly string[]): Promise<void> {
    await ensurePrivateDirectory(this.#root);
    await writeTextFileAtomic(
      this.#userAddedFile,
      serializeJson({ schemaVersion: 1, ids: [...ids] }),
    );
  }

  /**
   * Lists the raw stored accounts for one provider (private). Missing or
   * empty files yield `[]`; corrupt content throws a typed error.
   */
  async listStored(provider: ProviderId): Promise<StoredAccount[]> {
    return this.#readProviderAccounts(provider);
  }

  /**
   * Lists token-free public summaries for one provider, in stored order.
   */
  async list(provider: ProviderId): Promise<AccountSummary[]> {
    const accounts = await this.#readProviderAccounts(provider);
    return accounts.map((account) => storedAccountToSummary(account));
  }

  /**
   * Lists token-free public summaries for every provider, flattened in
   * canonical {@link PROVIDER_ORDER} order.
   */
  async listAll(): Promise<AccountSummary[]> {
    const summaries: AccountSummary[] = [];
    for (const provider of PROVIDER_ORDER) {
      const providerSummaries = await this.list(provider);
      summaries.push(...providerSummaries);
    }
    return summaries;
  }

  /**
   * Inserts or updates one account. Existing records keep their `createdAt`
   * and their last safe quota when the incoming quota block is empty.
   * Account writes are serialized per provider and atomic. New accounts are
   * prepended (the reference's dominant ordering); existing accounts keep
   * their position.
   */
  async upsert(provider: ProviderId, account: StoredAccount): Promise<void> {
    let validated: StoredAccount;
    try {
      validated = validateStoredAccount(account, provider);
    } catch (error) {
      throw toInvalidError(error, "invalid-account", "account");
    }
    await this.#queueFor(provider).enqueue(async () => {
      const accounts = await this.#readProviderAccounts(provider);
      const index = accounts.findIndex((entry) => entry.id === validated.id);
      if (index === -1) {
        accounts.unshift(validated);
      } else {
        accounts.splice(
          index,
          1,
          mergeExistingAccount(accounts[index] as StoredAccount, validated),
        );
      }
      await this.#writeProviderAccounts(provider, accounts);
    });
  }

  /**
   * Removes one account from a provider file. Removing an unknown id is
   * idempotent and performs no write; corrupt content still throws.
   */
  async remove(provider: ProviderId, accountId: string): Promise<void> {
    await this.#queueFor(provider).enqueue(async () => {
      const accounts = await this.#readProviderAccounts(provider);
      const remaining = accounts.filter((entry) => entry.id !== accountId);
      if (remaining.length === accounts.length) return;
      await this.#writeProviderAccounts(provider, remaining);
    });
  }

  /**
   * Deletes every stored account file (`providers/*.json`) and returns
   * how many accounts were dropped. Settings are untouched; the next
   * monitor start re-imports whatever the local agents still hold.
   */
  async clearAccounts(): Promise<number> {
    let removed = 0;
    for (const provider of PROVIDER_ORDER) {
      await this.#queueFor(provider).enqueue(async () => {
        const accounts = await this.#readProviderAccounts(provider);
        removed += accounts.length;
        await rm(this.providerFile(provider), { force: true });
      });
    }
    return removed;
  }

  #queueFor(provider: ProviderId): WriteQueue {
    let queue = this.#providerQueues.get(provider);
    if (queue == null) {
      queue = new WriteQueue();
      this.#providerQueues.set(provider, queue);
    }
    return queue;
  }

  async #readProviderAccounts(provider: ProviderId): Promise<StoredAccount[]> {
    const filePath = this.providerFile(provider);
    const text = await readTextFile(filePath, `${provider} provider store`);
    if (text == null || text.trim() === "") return [];
    const parsed = parseJsonText(text, "provider");
    try {
      return validateStoredProviderFile(provider, parsed);
    } catch (error) {
      throw toCorruptError(
        error,
        "corrupt-provider-file",
        `${provider} provider store`,
        filePath,
      );
    }
  }

  async #writeProviderAccounts(
    provider: ProviderId,
    accounts: StoredAccount[],
  ): Promise<void> {
    await ensurePrivateDirectory(this.#root);
    await ensurePrivateDirectory(this.#providersDir);
    const file = { schemaVersion: 1, accounts };
    await writeTextFileAtomic(this.providerFile(provider), serializeJson(file));
  }
}

function toCorruptError(
  error: unknown,
  code: StoreErrorCode,
  description: string,
  filePath: string,
): StoreError {
  if (error instanceof InvalidShapeError) {
    return new StoreError(code, `${description}: ${error.message}`, {
      path: filePath,
      cause: error,
    });
  }
  return new StoreError(code, `${description}: structure is invalid`, {
    path: filePath,
    cause: error,
  });
}

function toInvalidError(
  error: unknown,
  code: StoreErrorCode,
  description: string,
): StoreError {
  if (error instanceof InvalidShapeError) {
    return new StoreError(code, `${description}: ${error.message}`, {
      cause: error,
    });
  }
  return new StoreError(code, `${description}: structure is invalid`, {
    cause: error,
  });
}

/**
 * Creates the credential store for an already-resolved private
 * configuration root (see `resolveStoragePaths` in `./paths.js`).
 */
export function createCredentialStore(configRoot: string): CredentialStore {
  return new CredentialStore(configRoot);
}
