/**
 * HTTP primitives shared by all six provider adapters: exact percent encoding,
 * abort/timeout-aware fetch, a form POST helper, and safe error construction.
 *
 * Encoding parity:
 * - Query components match the Rust `urlencoding::encode` used to build every
 *   authorization URL: all bytes percent-encoded except `A-Z a-z 0-9 - _ . ~`,
 *   uppercase hex, spaces as `%20`.
 * - Form bodies match `reqwest`'s `.form()` (the `form_urlencoded` crate):
 *   spaces as `+`, everything percent-encoded except `A-Z a-z 0-9 * - . _`.
 *
 * Error safety: thrown/public errors carry status, body length, and a short
 * redacted preview only — never full bodies, authorization headers, tokens,
 * callback codes, or secrets.
 */

export type FetchLike = typeof fetch;

/** Form fields as an ordered pair list (order is preserved) or a flat record. */
export type FormFields =
  | Readonly<Record<string, string>>
  | ReadonlyArray<readonly [string, string]>;

/** Query parameters as an ordered pair list; order is preserved exactly. */
export type QueryParams = ReadonlyArray<readonly [string, string]>;

/** `RequestInit` with an optional timeout layered onto the abort signal. */
export interface HttpInit extends Omit<RequestInit, "signal"> {
  signal?: AbortSignal;
  /** Milliseconds until the request is aborted with a `TimeoutError`. */
  timeoutMs?: number;
}

function isQueryUnreserved(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x2d || // -
    code === 0x5f || // _
    code === 0x2e || // .
    code === 0x7e // ~
  );
}

function isFormUnreserved(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2a || // *
    code === 0x2d || // -
    code === 0x2e || // .
    code === 0x5f // _
  );
}

function encodeComponent(
  value: string,
  isUnreserved: (code: number) => boolean,
  spaceAsPlus: boolean,
): string {
  let safe = true;
  for (let index = 0; index < value.length; index++) {
    if (!isUnreserved(value.charCodeAt(index))) {
      safe = false;
      break;
    }
  }
  if (safe) return value;
  let encoded = "";
  for (const byte of new TextEncoder().encode(value)) {
    if (isUnreserved(byte)) encoded += String.fromCharCode(byte);
    else if (spaceAsPlus && byte === 0x20) encoded += "+";
    else encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/** Percent-encodes one query-component value (`urlencoding::encode` parity; space becomes `%20`). */
export function encodeQueryComponent(value: string): string {
  return encodeComponent(value, isQueryUnreserved, false);
}

/** Percent-encodes one form-component value (`form_urlencoded` parity; space becomes `+`). */
export function encodeFormComponent(value: string): string {
  return encodeComponent(value, isFormUnreserved, true);
}

/** Serializes fields as an `application/x-www-form-urlencoded` body. */
export function encodeFormBody(fields: FormFields): string {
  const pairs = Array.isArray(fields) ? fields : Object.entries(fields);
  let body = "";
  for (const [key, value] of pairs) {
    if (body.length > 0) body += "&";
    body += `${encodeFormComponent(key)}=${encodeFormComponent(value)}`;
  }
  return body;
}

/** Serializes ordered pairs as a query string (no leading `?`). */
export function buildQueryString(params: QueryParams): string {
  let query = "";
  for (const [key, value] of params) {
    if (query.length > 0) query += "&";
    query += `${encodeQueryComponent(key)}=${encodeQueryComponent(value)}`;
  }
  return query;
}

/**
 * `fetch` with an optional timeout. The caller signal and the timeout are
 * combined, so either aborts the request. Timeouts surface as a `DOMException`
 * whose `name` is `"TimeoutError"`; caller aborts keep their own reason.
 */
export async function fetchWithTimeout(
  url: string | URL,
  init: HttpInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const { signal, timeoutMs, ...rest } = init;
  const timeoutSignal =
    timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const combined =
    signal && timeoutSignal
      ? AbortSignal.any([signal, timeoutSignal])
      : (signal ?? timeoutSignal);
  return combined
    ? fetchImpl(url, { ...rest, signal: combined })
    : fetchImpl(url, rest);
}

/** Options for {@link postForm}. */
export interface PostFormOptions {
  /** Extra headers merged over the form content type. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

/** POSTs an `application/x-www-form-urlencoded` body (token endpoints, device flow). */
export async function postForm(
  url: string | URL,
  fields: FormFields,
  options: PostFormOptions = {},
): Promise<Response> {
  const { headers, signal, timeoutMs, fetchImpl } = options;
  return fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: encodeFormBody(fields),
      signal,
      timeoutMs,
    },
    fetchImpl ?? fetch,
  );
}

const REDACTED = "[REDACTED]";
const BEARER_PATTERN = /\b(bearer|token|basic)(\s+)[A-Za-z0-9+/_.=-]{8,}/gi;
const KEYED_SECRET_PATTERN =
  /\b(code|device_code|token|access_token|refresh_token|id_token|client_secret|secret|password|passcode|assertion|verifier|api[_-]?key|session[_-]?key)(["']?\s*[=:]\s*["']?)([^\s;&"'`,]+)/gi;
const OPAQUE_RUN_PATTERN = /[A-Za-z0-9+/_=-]{32,}/g;

/**
 * Masks secret-shaped content: authorization credentials, key/value pairs
 * named like secrets (including callback codes), and long opaque token runs.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(BEARER_PATTERN, `$1$2${REDACTED}`)
    .replace(KEYED_SECRET_PATTERN, `$1$2${REDACTED}`)
    .replace(OPAQUE_RUN_PATTERN, REDACTED);
}

function stripControlCharacters(text: string): string {
  let contains = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      contains = true;
      break;
    }
  }
  if (!contains) return text;
  let cleaned = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const control =
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f;
    cleaned += control ? " " : String.fromCharCode(code);
  }
  return cleaned;
}

const DEFAULT_PREVIEW_LENGTH = 120;
const DEFAULT_DETAIL_LENGTH = 200;

/** Collapses whitespace, strips control characters, and truncates with a marker. */
export function snippet(
  text: string,
  maxLength = DEFAULT_PREVIEW_LENGTH,
): string {
  const cleaned = stripControlCharacters(text).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength)}...[truncated]`;
}

const MAX_DETAIL_BODY_LENGTH = 65_536;

/** Extracts a JSON `error_description` or `message` string when the body is small, valid JSON. */
export function responseDetail(body: string): string | undefined {
  if (body.length === 0 || body.length > MAX_DETAIL_BODY_LENGTH) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  for (const key of ["error_description", "message"]) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

interface FailureParts {
  readonly message: string;
  readonly preview: string;
}

function failureParts(
  label: string,
  status: number,
  body: string,
): FailureParts {
  const detail = responseDetail(body);
  const length = detail ? DEFAULT_DETAIL_LENGTH : DEFAULT_PREVIEW_LENGTH;
  const preview = redactSecrets(snippet(detail ?? body, length));
  let message: string;
  if (detail) {
    message = `${label} failed: status=${status} ${preview}`;
  } else {
    message = `${label} failed: status=${status} body_length=${body.length}`;
    message += ` preview=${preview}`;
  }
  return { message, preview };
}

/**
 * Builds the safe failure text for a non-2xx response, following the
 * reference `format_response_failure` shape (`claude.rs`) extended with a
 * bounded, redacted preview.
 */
export function responseFailureMessage(
  label: string,
  status: number,
  body: string,
): string {
  return failureParts(label, status, body).message;
}

/** Non-2xx HTTP response as a safe, structured error. */
export class HttpError extends Error {
  readonly status: number;
  readonly bodyLength: number;
  /** Bounded, redacted preview of the response detail or body. */
  readonly preview: string;

  constructor(label: string, status: number, body: string) {
    const parts = failureParts(label, status, body);
    super(parts.message);
    this.name = "HttpError";
    this.status = status;
    this.bodyLength = body.length;
    this.preview = parts.preview;
  }
}
