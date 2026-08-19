/**
 * Stable account-ID seeding, ported from the canonical Rust reference so
 * stored IDs match `ref/quota` accounts byte-for-byte.
 *
 * Grounding:
 * - GitHub Copilot: `ref/quota/src-tauri/src/github_copilot.rs` `upsert_account`
 *   builds `ghcp_` + md5(`{login}:{github_id}`).
 * - Codex: `codex.rs` `build_oauth_account_id` joins trimmed email plus trimmed
 *   non-empty account/organization ids with `|` (and the API-key variant in
 *   `import_codex_api_key` uses `codex_apikey_` + md5 with an
 *   `api-key-{digest[..8]}` email).
 * - Antigravity: `antigravity.rs` `build_account_id` uses
 *   `{trimmed-lowercased-email}:{auth_id-or-empty}`.
 * - Claude: `claude.rs` `build_account_id` uses
 *   `{trimmed-ascii-lowercased-email}:{account-uuid}:{organization-uuid}`.
 * - Kiro: `kiro.rs` `build_account_id` uses
 *   `{trimmed-ascii-lowercased-email}:{profile-arn}`.
 * - Cursor: `cursor.rs` `build_account_id` hashes the email itself when it
 *   contains `@`, otherwise the `__tok__` + md5(access-token) fallback shared
 *   with Kiro (`kiro.rs` `build_and_save_account`).
 */

import { createHash } from "node:crypto";

/** Lowercase hex MD5 digest, matching Rust `format!("{:x}", md5::compute(...))`. */
export function md5Hex(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

/** Rust `to_ascii_lowercase`: only `A-Z` are folded. */
function asciiLowercase(value: string): string {
  let lowercased = false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0x41 && code <= 0x5a) {
      lowercased = true;
      break;
    }
  }
  if (!lowercased) return value;
  return value.replace(/[A-Z]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) + 0x20),
  );
}

/**
 * Fingerprint used when an account has no usable email, so two distinct OAuth
 * sessions never collide on the same empty-email bucket.
 */
export function tokenSeed(secret: string): string {
  return `__tok__${md5Hex(secret)}`;
}

/** Uses the email when it contains `@`, otherwise the token fingerprint. */
export function emailOrTokenSeed(email: string, secret: string): string {
  return email.includes("@") ? email : tokenSeed(secret);
}

/** `ghcp_` + md5(`{githubLogin}:{githubId}`); neither input is trimmed or case-folded. */
export function githubCopilotAccountId(
  githubLogin: string,
  githubId: string,
): string {
  return `ghcp_${md5Hex(`${githubLogin}:${githubId}`)}`;
}

/** `codex_` + md5 of trimmed email plus each trimmed non-empty id joined with `|`. */
export function codexOAuthAccountId(
  email: string,
  accountId?: string,
  organizationId?: string,
): string {
  let seed = email.trim();
  for (const part of [accountId, organizationId]) {
    const normalized = part?.trim();
    if (normalized) seed += `|${normalized}`;
  }
  return `codex_${md5Hex(seed)}`;
}

/** Identity derived from an `OPENAI_API_KEY` import. */
export interface CodexApiKeyIdentity {
  readonly id: string;
  readonly email: string;
}

/** `codex_apikey_` + md5(apiKey) with the reference `api-key-{digest[..8]}` label. */
export function codexApiKeyIdentity(apiKey: string): CodexApiKeyIdentity {
  const digest = md5Hex(apiKey);
  return {
    id: `codex_apikey_${digest}`,
    email: `api-key-${digest.slice(0, 8)}`,
  };
}

/** `antigravity_` + md5 of `{trimmed lowercased email}:{authId}` (authId used verbatim). */
export function antigravityAccountId(email: string, authId?: string): string {
  return `antigravity_${md5Hex(
    `${email.trim().toLowerCase()}:${authId ?? ""}`,
  )}`;
}

/** `claude_` + md5 of `{lowercased email}:{account uuid}:{organization uuid}`, each part trimmed. */
export function claudeAccountId(
  email: string,
  accountUuid?: string,
  organizationUuid?: string,
): string {
  const identity = [
    asciiLowercase(email.trim()),
    (accountUuid ?? "").trim(),
    (organizationUuid ?? "").trim(),
  ].join(":");
  return `claude_${md5Hex(identity)}`;
}

/** `kiro_` + md5 of `{lowercased email}:{profile arn}`, each part trimmed. */
export function kiroAccountId(email: string, profileArn?: string): string {
  return `kiro_${md5Hex(
    `${asciiLowercase(email.trim())}:${(profileArn ?? "").trim()}`,
  )}`;
}

/** `cursor_` + md5 of the email (when it contains `@`) or the token fingerprint. */
export function cursorAccountId(email: string, accessToken: string): string {
  return `cursor_${md5Hex(emailOrTokenSeed(email, accessToken))}`;
}

/** `omp_` + md5 of `{omp provider id}:{account key}`, each part trimmed. */
export function ompAccountId(
  ompProviderId: string,
  accountKey: string,
): string {
  return `omp_${md5Hex(`${ompProviderId.trim()}:${accountKey.trim()}`)}`;
}

/** `oc_` + md5 of the opencode provider id, trimmed. */
export function opencodeAccountId(openCodeProviderId: string): string {
  return `oc_${md5Hex(openCodeProviderId.trim())}`;
}

/**
 * `fg_` + md5 of `{vendor}:{apiKey}` (each trimmed). Vendor-scoped like
 * the codex apikey seed, so one physical key under two vendors stays two
 * accounts while re-adding the same pair is idempotent.
 */
export function fuelGaugeAccountId(vendor: string, apiKey: string): string {
  return `fg_${md5Hex(`${vendor.trim()}:${apiKey.trim()}`)}`;
}
