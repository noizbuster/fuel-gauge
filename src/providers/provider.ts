/**
 * The exhaustive provider adapter contract.
 *
 * Every provider (GitHub Copilot, Codex, Antigravity, Claude, Kiro,
 * Cursor) implements {@link ProviderAdapter}; the composition root
 * registers them as a `satisfies Record<ProviderId, ProviderAdapter>`
 * object so an omitted provider fails compilation.
 */

import type {
  AccountSummary,
  ImportCandidate,
  ProviderId,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Auth flows
// ---------------------------------------------------------------------------

/** Members shared by every auth flow variant. */
export interface AuthFlowBase {
  /** Provider that started this flow. */
  provider: ProviderId;
  /** Resolves with the imported account summaries when login completes. */
  result: Promise<AccountSummary[]>;
  /** Idempotent: repeated calls and calls after settlement are safe no-ops. */
  cancel(): Promise<void>;
}

/** GitHub device flow (user_code polling). */
export interface DeviceCodeAuthFlow extends AuthFlowBase {
  mode: "deviceCode";
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  intervalSeconds: number;
}

/**
 * Loopback browser OAuth (Codex, Antigravity, Kiro). Only Kiro also
 * accepts manual callback submission via `submit`.
 */
export interface BrowserCallbackAuthFlow extends AuthFlowBase {
  mode: "browserCallback";
  authUrl: string;
  callbackUrl: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Present only for providers that accept manual submission (Kiro). */
  submit?: (submission: AuthSubmission) => Promise<void>;
}

/**
 * Manual code/callback submission (Claude). The user pastes the redirect
 * URL or code; `submit` never echoes the submitted value.
 */
export interface ManualCodeAuthFlow extends AuthFlowBase {
  mode: "manualCode";
  authUrl: string;
  callbackUrl: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  submit: (submission: AuthSubmission) => Promise<void>;
}

/** Remote poll login (Cursor DeepControl). */
export interface RemotePollAuthFlow extends AuthFlowBase {
  mode: "remotePoll";
  verificationUri: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  intervalSeconds: number;
}

/**
 * Manual API-key entry (FuelGauge source). No browser round-trip: the
 * user pastes a vendor key, `submit` verifies it against the vendor's
 * usage API, and a rejected key throws without settling so the same
 * flow accepts a corrected paste.
 */
export interface ApiKeyAuthFlow extends AuthFlowBase {
  mode: "apiKey";
  /** What to paste, e.g. `"Z.AI coding plan API key"`. */
  hint: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  submit: (submission: AuthSubmission) => Promise<void>;
}

export type AuthFlow =
  | DeviceCodeAuthFlow
  | BrowserCallbackAuthFlow
  | ManualCodeAuthFlow
  | RemotePollAuthFlow
  | ApiKeyAuthFlow;

// ---------------------------------------------------------------------------
// Auth submissions
// ---------------------------------------------------------------------------

export type AuthSubmission =
  | { kind: "claude"; callbackOrCode: string; emailHint?: string }
  | { kind: "kiro"; callbackUrl: string }
  | { kind: "fuelGauge"; apiKey: string };
export type ClaudeAuthSubmission = Extract<AuthSubmission, { kind: "claude" }>;
export type KiroAuthSubmission = Extract<AuthSubmission, { kind: "kiro" }>;

export type FuelGaugeAuthSubmission = Extract<
  AuthSubmission,
  { kind: "fuelGauge" }
>;

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  /** All stored accounts of this provider as token-free summaries. */
  list(): Promise<AccountSummary[]>;
  /**
   * Local credential candidates for this provider WITHOUT reading secret
   * contents; the UI confirms with the user before `import` reads/copies.
   */
  discoverImports(signal: AbortSignal): Promise<ImportCandidate[]>;
  /** Reads and copies the chosen candidate into the private store. */
  import(
    candidate: ImportCandidate,
    signal: AbortSignal,
  ): Promise<AccountSummary[]>;
  /** Starts an interactive login flow; listeners live until result/cancel. */
  beginAuth(signal: AbortSignal): Promise<AuthFlow>;
  /** Refreshes one account, retaining its last safe quota on failure. */
  refresh(accountId: string, signal: AbortSignal): Promise<AccountSummary>;
  /** Sequential, order-preserving refresh of every stored account. */
  refreshAll(signal: AbortSignal): Promise<AccountSummary[]>;
  /** Deletes the Fuel Gauge copy only; never touches the source credential. */
  remove(accountId: string): Promise<void>;
}

/** Complete adapter registration; an omitted provider fails compilation. */
export type ProviderRegistry = Record<ProviderId, ProviderAdapter>;
