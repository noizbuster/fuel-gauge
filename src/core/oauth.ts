/**
 * OAuth crypto helpers: random tokens, PKCE S256 challenges, and base64url
 * encoding, matching the reference implementations exactly.
 *
 * Grounding: every Rust provider generates 32 random bytes for state/verifier
 * values (`generate_base64url_token`, Kiro `generate_token`) except GitHub
 * Copilot which uses 24 (`generate_login_id`); all encode with
 * `URL_SAFE_NO_PAD`. PKCE challenges are SHA-256 of the verifier encoded the
 * same way (`codex.rs`/`claude.rs`/`kiro.rs` `pkce_challenge`,
 * `cursor.rs` `generate_code_challenge`). The TypeScript seams
 * (`claudeProvider.ts` etc.) use `crypto.randomBytes(32).toString("base64url")`
 * and `createHash("sha256").update(verifier).digest("base64url")`, which are
 * byte-identical.
 */

import { createHash, randomBytes } from "node:crypto";

/**
 * Random URL-safe base64 token without padding. `byteLength` defaults to the
 * reference 32; pass 24 for GitHub Copilot login ids.
 */
export function randomToken(byteLength = 32): string {
  const length = Math.max(
    1,
    Math.trunc(Number.isFinite(byteLength) ? byteLength : 32),
  );
  return randomBytes(length).toString("base64url");
}

/** PKCE S256 challenge: base64url(SHA-256(verifier)) with no padding. */
export function pkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
}

/** A freshly generated verifier plus its S256 challenge. */
export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

/** Generates a PKCE pair ready for an authorization request. */
export function newPkcePair(byteLength = 32): PkcePair {
  const codeVerifier = randomToken(byteLength);
  return { codeVerifier, codeChallenge: pkceChallenge(codeVerifier) };
}
