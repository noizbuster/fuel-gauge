/**
 * Typed credential-source discovery shared by every provider adapter.
 *
 * Two-phase model required by the plan:
 *
 * 1. `discoverImports` lists candidate sources (env var, file, sqlite,
 *    keychain, subprocess) WITHOUT reading secret contents — only
 *    existence/presence is probed, and labels/paths never contain values.
 * 2. After the user confirms one candidate, `import` reads it through the
 *    same deterministic precedence walk implemented here.
 *
 * The walk takes the first candidate that exists, is readable, parses, and
 * carries the required fields. Every other candidate is skipped with a
 * typed reason; if nothing wins, the typed reason of the first non-missing
 * failure plus every tried path is reported. Source credentials are never
 * modified, refreshed in place, or deleted — refreshed tokens live only in
 * the Fuel Gauge private store.
 */

import { access, constants, readFile } from "node:fs/promises";
import type { ImportCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// Typed failures
// ---------------------------------------------------------------------------

export type DiscoveryErrorCode =
  | "NoCredentialFound"
  | "SourceProtected"
  | "CorruptCredential"
  | "SourceBusy"
  | "EmptyCredential"
  | "HomeUnavailable";

/** Typed discovery failure; the message never contains credential values. */
export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode;
  /** Every candidate path inspected before failing, in walk order. */
  readonly triedPaths: readonly string[];

  constructor(
    code: DiscoveryErrorCode,
    message: string,
    triedPaths: readonly string[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DiscoveryError";
    this.code = code;
    this.triedPaths = triedPaths;
  }
}

// ---------------------------------------------------------------------------
// Candidate model
// ---------------------------------------------------------------------------

/**
 * One discoverable source. `candidate` is the token-free descriptor shown
 * to the user; `load` reads and validates the secret on confirmation and
 * throws a typed {@link DiscoveryError} when the candidate cannot win.
 * `HomeUnavailable` (or an abort, or an unexpected non-typed error)
 * propagates out of the walk immediately.
 */
export interface DiscoverySource<T> {
  readonly candidate: ImportCandidate;
  load(signal: AbortSignal): Promise<T>;
}

/** The winning candidate plus its parsed value. */
export interface ConfirmedSource<T> {
  readonly candidate: ImportCandidate;
  readonly value: T;
}

// ---------------------------------------------------------------------------
// The deterministic precedence walk
// ---------------------------------------------------------------------------

interface SkipRecord {
  readonly code: DiscoveryErrorCode;
  readonly message: string;
}

/**
 * Walks `sources` in order and resolves with the first candidate whose
 * `load` succeeds. Skippable failures move on to the next candidate; a
 * `HomeUnavailable` failure (or an abort) rejects immediately. When no
 * candidate wins, the first non-missing typed failure is reported together
 * with every tried path, or `NoCredentialFound` when nothing existed.
 */
export async function confirmFirstSource<T>(
  sources: readonly DiscoverySource<T>[],
  signal: AbortSignal,
): Promise<ConfirmedSource<T>> {
  const skipped: SkipRecord[] = [];
  const triedPaths: string[] = [];

  for (const source of sources) {
    if (signal.aborted) throwAbort();
    if (source.candidate.path != null) triedPaths.push(source.candidate.path);
    try {
      const value = await source.load(signal);
      return { candidate: source.candidate, value };
    } catch (error) {
      if (isAbort(error)) throw error;
      // Only the six typed codes describe a skippable candidate; anything
      // else (bug, infrastructure failure) aborts the walk.
      if (!(error instanceof DiscoveryError)) throw error;
      if (error.code === "HomeUnavailable") {
        throw new DiscoveryError(
          "HomeUnavailable",
          error.message,
          mergePaths(triedPaths, error.triedPaths),
          { cause: error },
        );
      }
      skipped.push({ code: error.code, message: error.message });
    }
  }

  const firstTyped = skipped.find(
    (record) => record.code !== "NoCredentialFound",
  );
  if (firstTyped == null) {
    const headline =
      skipped[0]?.message ?? "No importable credential source was found";
    throw new DiscoveryError(
      "NoCredentialFound",
      describeWalk(headline, skipped, triedPaths),
      triedPaths,
    );
  }
  throw new DiscoveryError(
    firstTyped.code,
    describeWalk(firstTyped.message, skipped, triedPaths),
    triedPaths,
  );
}

function describeWalk(
  headline: string,
  skipped: readonly SkipRecord[],
  triedPaths: readonly string[],
): string {
  const paths =
    triedPaths.length > 0 ? ` Tried: ${triedPaths.join(", ")}.` : "";
  if (skipped.length <= 1) return `${headline}.${paths}`;
  return `${headline} (after ${skipped.length} candidates).${paths}`;
}

function mergePaths(
  left: readonly string[],
  right: readonly string[],
): string[] {
  return [...left, ...right.filter((path) => !left.includes(path))];
}

function throwAbort(): never {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  throw error;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (error instanceof DOMException && error.name === "AbortError"))
  );
}

// ---------------------------------------------------------------------------
// Filesystem probes (no secret content)
// ---------------------------------------------------------------------------

/** True when `path` exists and is readable (permission checked). */
export async function pathReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a JSON credential file with typed classification:
 * `NoCredentialFound` when missing, `SourceProtected` when unreadable,
 * `CorruptCredential` when the content is not valid JSON, and
 * `EmptyCredential` when the file is blank. Callers raise
 * `EmptyCredential` themselves when required fields are present but blank.
 */
export async function readJsonCredentialFile(
  path: string,
  signal: AbortSignal,
): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw fileError(path, error);
  }
  if (signal.aborted) throwAbort();
  if (text.trim() === "") {
    throw new DiscoveryError(
      "EmptyCredential",
      `Credential file is empty: ${path}`,
      [path],
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DiscoveryError(
      "CorruptCredential",
      `Credential file is not valid JSON: ${path}`,
      [path],
      { cause: error },
    );
  }
}

function fileError(path: string, error: unknown): DiscoveryError {
  const code = nodeErrorCode(error);
  if (code === "ENOENT") {
    return new DiscoveryError(
      "NoCredentialFound",
      `Credential file not found: ${path}`,
      [path],
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return new DiscoveryError(
      "SourceProtected",
      `Credential file is not readable: ${path}`,
      [path],
    );
  }
  if (code === "EISDIR") {
    return new DiscoveryError(
      "CorruptCredential",
      `Credential path is a directory: ${path}`,
      [path],
    );
  }
  return new DiscoveryError(
    "SourceProtected",
    `Credential file could not be read: ${path}`,
    [path],
  );
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Shared shape helpers used by provider parsers
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Trimmed non-empty string field; `undefined` for anything else. */
export function recordString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** First non-empty trimmed string among `keys` on the same record. */
export function recordStringAny(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = recordString(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Requires an object field; throws `CorruptCredential` for anything else.
 * Used for credential sub-shapes the account build cannot proceed without.
 */
export function requireRecord(
  value: unknown,
  label: string,
  path: string,
): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) {
    throw new DiscoveryError(
      "CorruptCredential",
      `${label} must be an object in ${path}`,
      [path],
    );
  }
  return record;
}

/**
 * Trimmed environment override; matched quotes are unwrapped (the plan's
 * `$CODEX_HOME` "trim quoted overrides" rule, applied uniformly).
 */
export function envOverride(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  let trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed === "" ? undefined : trimmed;
}

/** Environment token presence probe; the secret value never leaves this. */
export function envTokenPresent(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  const raw = env[name];
  return typeof raw === "string" && raw.trim() !== "";
}
