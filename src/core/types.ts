/**
 * Core shared types for Fuel Gauge.
 *
 * Security invariant: raw credential values (access/refresh/id tokens, API
 * keys, raw provider JSON blobs) exist ONLY on the {@link StoredAccount}
 * family, which never leaves the private per-provider store files. The
 * {@link AccountSummary} family is the sole public projection of a stored
 * account and MUST NOT contain token-like fields; quota errors carried on
 * summaries are redacted strings produced by the HTTP layer.
 *
 * Every timestamp in these types is an epoch value in MILLISECONDS.
 * Adapters are responsible for normalizing second-precision or RFC 3339
 * inputs to milliseconds before constructing any of these values.
 */

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/** Canonical provider order used by lists, dashboards, and settings. */
export const PROVIDER_ORDER = [
  "githubCopilot",
  "codex",
  "antigravity",
  "claude",
  "kiro",
  "cursor",
  "omp",
  "opencode",
  "fuelGauge",
] as const;

export type ProviderId = (typeof PROVIDER_ORDER)[number];

/** Human-readable provider labels, exhaustive over {@link ProviderId}. */
export const PROVIDER_LABELS = {
  githubCopilot: "GitHub Copilot",
  codex: "Codex",
  antigravity: "Antigravity",
  claude: "Claude Code",
  kiro: "Kiro",
  cursor: "Cursor",
  omp: "Oh My Pi",
  opencode: "OpenCode",
  fuelGauge: "FuelGauge",
} as const satisfies Record<ProviderId, string>;

export function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === "string" &&
    (PROVIDER_ORDER as readonly unknown[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Normalized quota metrics
// ---------------------------------------------------------------------------

/**
 * Normalized quota metric rendered by the UI and consumed by alerts.
 *
 * All numeric quota slots are `null` when the provider did not report a
 * value; `resetAt` is epoch milliseconds.
 */
export interface QuotaMetric {
  /** Stable provider-scoped metric identifier, e.g. `"claude.fiveHour"`. */
  id: string;
  /** Human-readable label for dashboards and detail views. */
  label: string;
  remainingPercent: number | null;
  used: number | null;
  total: number | null;
  /** Epoch milliseconds; `null` when the provider reports no reset. */
  resetAt: number | null;
}

// ---------------------------------------------------------------------------
// Account status
// ---------------------------------------------------------------------------

/**
 * Normalized account status.
 *
 * `requiresReauthentication` replaces the reference's boolean flag;
 * `banned` maps Kiro `BANNED:<reason>` responses; `forbidden` maps
 * Antigravity permission denials.
 */
export type AccountStatus =
  | "active"
  | "requiresReauthentication"
  | "banned"
  | "forbidden";

// ---------------------------------------------------------------------------
// Provider-native quota snapshots (token-free)
// ---------------------------------------------------------------------------

/** GitHub Copilot usage snapshot (percent values are "used" percents). */
export interface GitHubCopilotUsageSummary {
  inlineSuggestionsUsedPercent: number | null;
  chatMessagesUsedPercent: number | null;
  premiumRequestsUsedPercent: number | null;
  inlineIncluded: boolean;
  chatIncluded: boolean;
  premiumIncluded: boolean;
  remainingCompletions: number | null;
  remainingChat: number | null;
  remainingPremiumRequests: number | null;
  totalCompletions: number | null;
  totalChat: number | null;
  totalPremiumRequests: number | null;
  usedPremiumRequests: number | null;
  /** Epoch milliseconds. */
  allowanceResetAt: number | null;
}

export interface CodexQuotaSummary {
  hourlyRemainingPercent: number | null;
  /** Epoch milliseconds. */
  hourlyResetAt: number | null;
  hourlyWindowMinutes: number | null;
  weeklyRemainingPercent: number | null;
  /** Epoch milliseconds. */
  weeklyResetAt: number | null;
  weeklyWindowMinutes: number | null;
}

export interface AntigravityQuotaWindow {
  remainingPercent: number | null;
  /** Epoch milliseconds. */
  resetAt: number | null;
}

export interface AntigravityQuotaSummary {
  geminiFiveHour: AntigravityQuotaWindow;
  geminiWeekly: AntigravityQuotaWindow;
  thirdPartyFiveHour: AntigravityQuotaWindow;
  thirdPartyWeekly: AntigravityQuotaWindow;
}

export interface AntigravityCreditInfo {
  creditType: string;
  creditAmount: string | null;
  minimumCreditAmountForUsage: string | null;
}

export interface ClaudeQuotaSummary {
  fiveHourRemainingPercent: number | null;
  /** Epoch milliseconds. */
  fiveHourResetAt: number | null;
  weeklyRemainingPercent: number | null;
  /** Epoch milliseconds. */
  weeklyResetAt: number | null;
  weeklySonnetRemainingPercent: number | null;
  /** Epoch milliseconds. */
  weeklySonnetResetAt: number | null;
  extraUsageRemainingPercent: number | null;
  /** Epoch milliseconds. */
  extraUsageResetAt: number | null;
  extraUsageUsedCents: number | null;
  extraUsageLimitCents: number | null;
}

// ---------------------------------------------------------------------------
// Stored accounts (private; the only family with raw credentials)
// ---------------------------------------------------------------------------

/** Fields shared by every stored account variant. Epoch milliseconds. */
export interface StoredAccountBase {
  /** Stable account ID (adapters preserve the reference MD5 seeds). */
  id: string;
  status: AccountStatus;
  statusReason: string | null;
  /** Last redacted quota error, if any. */
  quotaQueryLastError: string | null;
  /** Epoch milliseconds. */
  quotaQueryLastErrorAt: number | null;
  /** Epoch milliseconds. */
  usageUpdatedAt: number | null;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  lastUsed: number;
}

export interface StoredGitHubCopilotAccount extends StoredAccountBase {
  provider: "githubCopilot";
  githubLogin: string;
  githubId: number;
  githubName: string | null;
  githubEmail: string | null;
  /** Raw GitHub OAuth token used for re-exchange; never rotated on refresh. */
  githubAccessToken: string;
  githubTokenType: string | null;
  githubScope: string | null;
  /** Raw Copilot session token. */
  copilotToken: string;
  copilotPlan: string | null;
  copilotChatEnabled: boolean | null;
  /** Epoch milliseconds. */
  copilotExpiresAt: number | null;
  /** Seconds until the reference client would refresh the Copilot token. */
  copilotRefreshIn: number | null;
  /** Raw quota snapshot JSON retained for reset-fallback recomputation. */
  copilotQuotaSnapshots: unknown;
  copilotQuotaResetDate: string | null;
  copilotLimitedUserQuotas: unknown;
  /** Epoch milliseconds. */
  copilotLimitedUserResetAt: number | null;
}

/** Codex auth mode; `apikey` matches the reference summary spelling. */
export type CodexAuthMode = "oauth" | "apikey";

/** Codex OAuth token bundle; the id token is an identity JWT. */
export interface StoredCodexTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string | null;
}

export interface StoredCodexAccount extends StoredAccountBase {
  provider: "codex";
  email: string;
  authMode: CodexAuthMode;
  /** Raw OpenAI API key for `apikey` accounts. */
  openAIApiKey: string | null;
  apiBaseUrl: string | null;
  userId: string | null;
  plan: string | null;
  accountId: string | null;
  organizationId: string | null;
  /** Present for OAuth accounts; `null` for API-key accounts. */
  tokens: StoredCodexTokens | null;
  quota: CodexQuotaSummary;
}

export interface StoredAntigravityAccount extends StoredAccountBase {
  provider: "antigravity";
  email: string;
  /** Local import source identifier, e.g. `"local"`. */
  source: string;
  authId: string | null;
  name: string | null;
  accessToken: string;
  refreshToken: string | null;
  /** Google id token (identity JWT). */
  idToken: string | null;
  tokenType: string | null;
  scope: string | null;
  /** Epoch milliseconds. */
  expiryDate: number | null;
  selectedAuthType: string | null;
  projectId: string | null;
  tierId: string | null;
  planName: string | null;
  credits: AntigravityCreditInfo[];
  quota: AntigravityQuotaSummary;
}

/**
 * Claude auth mode. `oauth` covers every refreshable account (file,
 * Keychain, browser OAuth); `environmentToken` is the distinct
 * non-refreshable `CLAUDE_CODE_OAUTH_TOKEN` variant whose refresh endpoint
 * must never be called.
 */
export type ClaudeAuthMode = "oauth" | "environmentToken";

export interface StoredClaudeAccount extends StoredAccountBase {
  provider: "claude";
  email: string;
  authMode: ClaudeAuthMode;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string | null;
  scopes: string[];
  /** Epoch milliseconds. */
  expiresAt: number | null;
  accountUuid: string | null;
  organizationUuid: string | null;
  organizationName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  planType: string | null;
  quota: ClaudeQuotaSummary;
}

export interface StoredKiroAccount extends StoredAccountBase {
  provider: "kiro";
  email: string;
  loginProvider: string | null;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number | null;
  idcRegion: string | null;
  clientId: string | null;
  planName: string | null;
  planTier: string | null;
  creditsTotal: number | null;
  creditsUsed: number | null;
  bonusTotal: number | null;
  bonusUsed: number | null;
  /** Epoch milliseconds. */
  usageResetAt: number | null;
  bonusExpireDays: number | null;
  /** Raw kiro-auth-token.json contents (may embed tokens). */
  kiroAuthTokenRaw: unknown;
  /** Raw profile.json contents (may embed identifiers). */
  kiroProfileRaw: unknown;
}

export interface StoredCursorAccount extends StoredAccountBase {
  provider: "cursor";
  email: string | null;
  authId: string | null;
  signUpType: string | null;
  membershipType: string | null;
  subscriptionStatus: string | null;
  accessToken: string;
  refreshToken: string | null;
  source: string;
  totalPercent: number | null;
  autoPercent: number | null;
  apiPercent: number | null;
  /** Epoch milliseconds. */
  billingCycleEnd: number | null;
  planUsed: number | null;
  planLimit: number | null;
  onDemandEnabled: boolean | null;
  onDemandUsed: number | null;

  onDemandLimit: number | null;
}
/** One normalized usage window from `omp usage --json`. */
export interface OmpUsageLimit {
  /** Stable omp limit id, e.g. `"zai:tokens:5h"`. */
  id: string;
  /** Human-readable limit label, e.g. `"Usage (Google)"`. */
  label: string;
  /** Window label, e.g. `"5 Hours"` or `"Daily"`. */
  windowLabel: string;
  remainingPercent: number | null;
  used: number | null;
  total: number | null;
  /** Epoch milliseconds; `null` when omp reports no reset. */
  resetAt: number | null;
}

/**
 * omp (Oh My Pi) account. omp keeps every credential inside its own
 * vault, so this is the one stored variant that never carries tokens:
 * refresh always re-asks the local `omp` CLI.
 */
export interface StoredOmpAccount extends StoredAccountBase {
  provider: "omp";
  /** omp-internal provider id, e.g. `"zai"` or `"openai-codex"`. */
  ompProviderId: string;
  /**
   * Identity key inside the omp provider: the account email, the cloud
   * project id, or `account N` when omp exposes neither (the vault's
   * per-provider order is then the only discriminator).
   */
  accountKey: string;
  /** Display snapshot from import time, e.g. `"Z.AI (GLM) · me@x.y"`. */
  displayLabel: string;
  email: string | null;
  limits: OmpUsageLimit[];

  /** md5 of the api key for identity-less api-key accounts; else `null`. */
  keyFingerprint: string | null;
}

/**
 * opencode account. Like omp, credentials stay in the agent's own
 * `auth.json`; refresh reads that file transiently and never stores
 * token values.
 */
export interface StoredOpenCodeAccount extends StoredAccountBase {
  provider: "opencode";
  /** opencode-internal provider id, e.g. `"zai-coding-plan"`. */
  openCodeProviderId: string;
  /** Credential kind from opencode's auth store. */
  authType: "api" | "oauth";
  /**
   * md5 digest of the api key (api accounts only) — a non-secret
   * fingerprint that lets the dashboard merge the same key imported
   * through different agents. `null` for oauth accounts.
   */
  keyFingerprint: string | null;
  /**
   * Email decoded from the access token's JWT claims when present
   * (claims survive expiry); `null` for api keys and opaque tokens.
   */
  email: string | null;
  /** Epoch milliseconds from the auth store; `null` for api keys. */
  expiresAt: number | null;
  /** Display snapshot from import time, e.g. `"Z.AI Coding Plan · api key"`. */
  displayLabel: string;
  limits: OmpUsageLimit[];
}

/**
 * Vendor registry key for FuelGauge-source accounts. Each vendor has a
 * first-class usage API reachable with a plain API key (no agent login);
 * adding one means extending this union plus the adapter's registry.
 */
export type FuelGaugeVendorId = "zai-coding-plan";

/**
 * FuelGauge-source account: a credential the user added directly (pasted
 * API key) instead of importing another agent's file. The key is the only
 * credential family member without an upstream agent to re-read, so it
 * must persist here — same plaintext-store disclosure as every import.
 */
export interface StoredFuelGaugeAccount extends StoredAccountBase {
  provider: "fuelGauge";
  /** Registry key naming the vendor usage API, e.g. `"zai-coding-plan"`. */
  vendor: FuelGaugeVendorId;
  /** The pasted API key; never leaves the private store or summaries. */
  apiKey: string;
  /**
   * md5 of the API key — a non-secret fingerprint letting the dashboard
   * merge this account with the same key imported through agents.
   */
  keyFingerprint: string;
  /** Display snapshot from add time, e.g. `"Z.AI Coding Plan · API: abc..xyz"`. */
  displayLabel: string;
  limits: OmpUsageLimit[];
}

/**
 * Discriminated union of every stored account variant. This is the only
 * type family in the codebase that carries raw credential values.
 */
export type StoredAccount =
  | StoredGitHubCopilotAccount
  | StoredCodexAccount
  | StoredAntigravityAccount
  | StoredClaudeAccount
  | StoredKiroAccount
  | StoredCursorAccount
  | StoredOmpAccount
  | StoredOpenCodeAccount
  | StoredFuelGaugeAccount;

// ---------------------------------------------------------------------------
// Public account summaries (token-free)
// ---------------------------------------------------------------------------

/** Fields shared by every public account summary. Epoch milliseconds. */
export interface AccountSummaryBase extends StoredAccountBase {
  /** Normalized quota metrics for dashboard rendering and alerts. */
  metrics: QuotaMetric[];
}

export interface GitHubCopilotAccountSummary extends AccountSummaryBase {
  provider: "githubCopilot";
  githubLogin: string;
  githubName: string | null;
  githubEmail: string | null;
  plan: string | null;
  chatEnabled: boolean | null;
  usage: GitHubCopilotUsageSummary;
}

export interface CodexAccountSummary extends AccountSummaryBase {
  provider: "codex";
  email: string;
  authMode: CodexAuthMode;
  apiBaseUrl: string | null;
  userId: string | null;
  plan: string | null;
  accountId: string | null;
  organizationId: string | null;
  quota: CodexQuotaSummary;
}

export interface AntigravityAccountSummary extends AccountSummaryBase {
  provider: "antigravity";
  email: string;
  authId: string | null;
  name: string | null;
  source: string;
  selectedAuthType: string | null;
  projectId: string | null;
  tierId: string | null;
  planName: string | null;
  credits: AntigravityCreditInfo[];
  quota: AntigravityQuotaSummary;
}

export interface ClaudeAccountSummary extends AccountSummaryBase {
  provider: "claude";
  email: string;
  authMode: ClaudeAuthMode;
  accountUuid: string | null;
  organizationUuid: string | null;
  organizationName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  planType: string | null;
  quota: ClaudeQuotaSummary;
}

export interface KiroAccountSummary extends AccountSummaryBase {
  provider: "kiro";
  email: string;
  loginProvider: string | null;
  planName: string | null;
  planTier: string | null;
  creditsTotal: number | null;
  creditsUsed: number | null;
  bonusTotal: number | null;
  bonusUsed: number | null;
  /** Epoch milliseconds. */
  usageResetAt: number | null;
  bonusExpireDays: number | null;
}

export interface CursorAccountSummary extends AccountSummaryBase {
  provider: "cursor";
  email: string | null;
  authId: string | null;
  signUpType: string | null;
  membershipType: string | null;
  subscriptionStatus: string | null;
  source: string;
  totalPercent: number | null;
  autoPercent: number | null;
  apiPercent: number | null;
  /** Epoch milliseconds. */
  billingCycleEnd: number | null;
  planUsed: number | null;
  planLimit: number | null;
  onDemandEnabled: boolean | null;
  onDemandUsed: number | null;
  onDemandLimit: number | null;
}

export interface OmpAccountSummary extends AccountSummaryBase {
  provider: "omp";
  ompProviderId: string;
  /** Display snapshot from import time, e.g. `"Z.AI (GLM) · me@x.y"`. */
  displayLabel: string;
  email: string | null;
  /** md5 of the api key when the account is keyed that way; else `null`. */
  keyFingerprint: string | null;
}

export interface OpenCodeAccountSummary extends AccountSummaryBase {
  provider: "opencode";
  openCodeProviderId: string;
  authType: "api" | "oauth";
  /** md5 digest of the api key; `null` for oauth accounts. */
  keyFingerprint: string | null;
  /** Email decoded from the access-token JWT; `null` when unavailable. */
  email: string | null;
  /** Display snapshot from import time, e.g. `"Z.AI Coding Plan · api key"`. */
  displayLabel: string;
}

export interface FuelGaugeAccountSummary extends AccountSummaryBase {
  provider: "fuelGauge";
  /** Registry key naming the vendor usage API. */
  vendor: FuelGaugeVendorId;
  /** md5 of the pasted API key; `apiKey` itself never reaches summaries. */
  keyFingerprint: string;
  /** Display snapshot from add time, e.g. `"Z.AI Coding Plan · API: abc..xyz"`. */
  displayLabel: string;
}

/**
 * Discriminated union of public account summaries. Token-free by
 * construction; the storage layer's public conversion is the only producer.
 */
export type AccountSummary =
  | GitHubCopilotAccountSummary
  | CodexAccountSummary
  | AntigravityAccountSummary
  | ClaudeAccountSummary
  | KiroAccountSummary
  | CursorAccountSummary
  | OmpAccountSummary
  | OpenCodeAccountSummary
  | FuelGaugeAccountSummary;

// ---------------------------------------------------------------------------
// On-disk store file shapes
// ---------------------------------------------------------------------------

/** Per-provider account file: `providers/<provider>.json`. */
export interface StoredProviderFile {
  schemaVersion: 1;
  accounts: StoredAccount[];
}

// ---------------------------------------------------------------------------
// Settings (schema version 1)
// ---------------------------------------------------------------------------

export const SETTINGS_SCHEMA_VERSION = 1;

export interface AutoRefreshSettings {
  enabled: boolean;
  intervalSeconds: number;
}

export interface AlertSettings {
  enabled: boolean;
  thresholdPercent: number;
}

export interface Settings {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  autoRefresh: AutoRefreshSettings;
  alerts: AlertSettings;
  /** Permutation of {@link PROVIDER_ORDER}; invalid orders are rejected. */
  providerOrder: ProviderId[];
  /** Accounts toggled out of every dashboard view; still refreshed. */
  hiddenAccountIds: string[];
  pinnedAccountIds: string[];
  /** Manual import-path override per provider, when configured. */
  importPathOverrides: Partial<Record<ProviderId, string>>;
  /** Claude stays network-silent until the policy risk is acknowledged. */
  claudePolicyAccepted: boolean;
}

// ---------------------------------------------------------------------------

/** Where an import candidate comes from. */
export type ImportSourceKind =
  | "env"
  | "file"
  | "sqlite"
  | "keychain"
  | "subprocess";

/**
 * A discoverable local credential, listed BEFORE any secret content is
 * read. `label` and `path` are display strings and must never contain
 * secret values.
 */
export interface ImportCandidate {
  provider: ProviderId;
  source: ImportSourceKind;
  /** Human-readable, token-free description, e.g. `"GH_TOKEN environment variable"`. */
  label: string;
  /** Filesystem path when applicable; `null` for env/keychain/subprocess sources. */
  path: string | null;
}
