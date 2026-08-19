/**
 * Untrusted JWT payload decoding for identity and routing hints only.
 *
 * Signatures are never verified: claims extracted here seed account emails,
 * ids, and endpoint routing (Codex auth claims, Kiro email hints, Cursor
 * `sub` checks, Antigravity id-token identity). They must never be used for
 * authorization decisions.
 *
 * Grounding: the Rust reference splits on `.`, requires at least two segments,
 * base64url-decodes segment 1 without padding, and JSON-parses it
 * (`codex.rs` / `antigravity.rs` / `cursor.rs` / `kiro.rs`, where Kiro also
 * tolerates padded input). Node's `base64url` decoder is equally lenient, so
 * one tolerant implementation covers all four providers. Every failure path
 * returns `undefined` instead of throwing, matching the Kiro/Cursor/Antigravity
 * `.ok()`-style handling.
 */

/** Hard cap so a hostile blob cannot be decoded or parsed as a JWT. */
const MAX_JWT_LENGTH = 1_000_000;
const MAX_PAYLOAD_BYTES = 1_000_000;

/** Parsed JWT claims; untrusted, unverified JSON. */
export type JwtClaims = Record<string, unknown>;

/**
 * Decodes the payload segment of a compact JWT. Returns `undefined` for
 * non-strings, malformed segment layouts, oversized input, undecodable
 * base64url, invalid JSON, or non-object payloads.
 */
export function decodeJwtPayload(token: string): JwtClaims | undefined {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_JWT_LENGTH
  ) {
    return undefined;
  }
  const start = token.indexOf(".");
  if (start < 0) return undefined;
  const end = token.indexOf(".", start + 1);
  const encoded =
    end < 0 ? token.slice(start + 1) : token.slice(start + 1, end);
  if (encoded.length === 0) return undefined;
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length === 0 || bytes.length > MAX_PAYLOAD_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as JwtClaims;
}

/** First non-empty trimmed string claim among `keys`, mirroring `pickString`. */
export function claimString(
  claims: JwtClaims | undefined,
  keys: readonly string[],
): string | undefined {
  if (!claims) return undefined;
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/** Email hint from `email`/`upn`/`preferred_username`, kept only when it contains `@`. */
export function jwtEmailHint(
  claims: JwtClaims | undefined,
): string | undefined {
  const email = claimString(claims, ["email", "upn", "preferred_username"]);
  return email?.includes("@") ? email : undefined;
}
