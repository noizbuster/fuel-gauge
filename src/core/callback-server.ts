import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { redactSecrets } from "./http.js";

/** Longest attacker-controlled error text kept in failure messages. */
const MAX_ERROR_DETAIL_LENGTH = 200;
const HOST = "127.0.0.1";
const CODEX_CALLBACK_PORT = 1455;
/** Exact route Codex redirects to; anything else keeps waiting. */
const CODEX_CALLBACK_PATH = "/auth/callback";
const ANTIGRAVITY_CALLBACK_PATH = "/oauth-callback";
const KIRO_CALLBACK_PORT_CANDIDATES: readonly number[] = [
  3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153,
];
const DEFAULT_TIMEOUT_MS = 300_000;
const KIRO_DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TARGET_LENGTH = 2048;
const MAX_BODY_BYTES = 8192;
/** Force-destroy lingering sockets this long after a graceful close begins. */
const FORCE_CLOSE_DELAY_MS = 1500;
/** How long the listener keeps answering after settlement. */
const POST_SETTLE_LISTEN_GRACE_MS = 500;

/** Which provider protocol the loopback server speaks. */
export type CallbackServerKind = "codex" | "antigravity" | "kiro";

export interface CallbackServerOptions {
  readonly kind: CallbackServerKind;
  /** Generated OAuth state; callbacks carrying anything else are rejected or ignored. */
  readonly expectedState: string;
  /** Deadline for the whole flow. Defaults to 5 minutes (10 for Kiro). */
  readonly timeoutMs?: number;
  /** Aborts the wait, settles `result` with code "aborted", and releases the port. */
  readonly signal?: AbortSignal;
  /**
   * Overrides the fixed Codex callback port; `0` binds an ephemeral
   * port. Tests inject this to stay hermetic — a machine running the
   * Codex CLI holds 1455, and production callers never pass it, so
   * they always get the registered redirect port.
   */
  readonly port?: number;
}

/** Successful callback capture. `params` holds every decoded query parameter. */
export interface CallbackSuccess {
  readonly code: string;
  readonly state: string;
  /** Raw request path (not decoded); Kiro rebuilds its redirect_uri from it. */
  readonly path: string;
  readonly params: Record<string, string>;
}

export type CallbackErrorCode =
  | "bind"
  | "timeout"
  | "cancelled"
  | "aborted"
  | "rejected";

/** Token-free failure of a loopback OAuth callback wait. */
export class CallbackError extends Error {
  readonly code: CallbackErrorCode;

  constructor(code: CallbackErrorCode, message: string) {
    super(message);
    this.name = "CallbackError";
    this.code = code;
  }
}

export interface CallbackServer {
  readonly host: "127.0.0.1";
  readonly port: number;
  /**
   * Origin the provider redirects back to (no path): `http://localhost:1455`
   * for Codex, `http://127.0.0.1:<ephemeral>` for Antigravity,
   * `http://localhost:<candidate>` for Kiro.
   */
  readonly baseUrl: string;
  /** Resolves exactly once with the validated callback; rejects with CallbackError. */
  readonly result: Promise<CallbackSuccess>;
  /** Idempotent: settles `result` as cancelled and releases the port. Never throws. */
  cancel(): Promise<void>;
  /** Idempotent shutdown; never throws. Settles a still-pending result as cancelled. */
  close(): Promise<void>;
}

/**
 * Injectable boundary around retained loopback OAuth listeners. The production
 * factory binds the real listener once per port and keeps it — no probe/rebind
 * race for Kiro's candidate ports.
 */
export interface CallbackServerFactory {
  start(options: CallbackServerOptions): Promise<CallbackServer>;
}

interface KindBinding {
  readonly label: string;
  readonly defaultTimeoutMs: number;
  readonly baseUrlHost: string;
}

const KIND_BINDINGS: Record<CallbackServerKind, KindBinding> = {
  codex: {
    label: "Codex",
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    baseUrlHost: "localhost",
  },
  antigravity: {
    label: "Antigravity",
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    baseUrlHost: "127.0.0.1",
  },
  kiro: {
    label: "Kiro",
    defaultTimeoutMs: KIRO_DEFAULT_TIMEOUT_MS,
    baseUrlHost: "localhost",
  },
};

type CallbackDecision =
  | { readonly action: "resolve"; readonly success: CallbackSuccess }
  | {
      readonly action: "reject";
      readonly message: string;
      readonly page: "authFailed" | "stateMismatch";
      readonly errorText: string;
    }
  | { readonly action: "cancel" }
  | { readonly action: "wait" };

interface CallbackRuntime {
  readonly kind: CallbackServerKind;
  readonly expectedState: string;
  readonly label: string;
  server: Server | null;
  timeoutId: NodeJS.Timeout | null;
  abortSignal: AbortSignal | null;
  abortListener: (() => void) | null;
  settled: boolean;
  closedPromise: Promise<void> | null;
  resolveResult: (success: CallbackSuccess) => void;
  rejectResult: (error: CallbackError) => void;
}

/** Production callback server factory backed by `node:http`. */
export function createCallbackServerFactory(): CallbackServerFactory {
  return {
    async start(options: CallbackServerOptions): Promise<CallbackServer> {
      const binding = KIND_BINDINGS[options.kind];
      if (
        typeof options.expectedState !== "string" ||
        options.expectedState === ""
      ) {
        throw new CallbackError(
          "bind",
          `${binding.label} OAuth requires a non-empty expected state.`,
        );
      }
      if (options.signal?.aborted) {
        throw new CallbackError(
          "aborted",
          `${binding.label} OAuth login was aborted.`,
        );
      }

      const {
        promise: result,
        resolve: resolveResult,
        reject: rejectResult,
      } = Promise.withResolvers<CallbackSuccess>();
      // Mark rejection as handled so cancel()/close() cannot crash a
      // caller that dropped interest without awaiting `result`.
      result.catch(() => {});
      const runtime: CallbackRuntime = {
        kind: options.kind,
        expectedState: options.expectedState,
        label: binding.label,
        server: null,
        timeoutId: null,
        abortSignal: options.signal ?? null,
        abortListener: null,
        settled: false,
        closedPromise: null,
        resolveResult,
        rejectResult,
      };

      // Attach the abort listener BEFORE binding: an abort that lands while
      // the listener is being installed must still settle and release the
      // port instead of leaking a bound listener nobody owns.
      if (options.signal) {
        runtime.abortListener = () => {
          settleFailure(
            runtime,
            "aborted",
            `${binding.label} OAuth login was aborted.`,
          );
        };
        options.signal.addEventListener("abort", runtime.abortListener, {
          once: true,
        });
      }

      let bound: { server: Server; port: number };
      try {
        bound = await bindListener(runtime, options);
      } catch (error) {
        if (runtime.settled) {
          // An abort raced the bind and already settled `result` as
          // aborted; surface that, not the collateral bind failure.
          if (
            runtime.abortSignal?.aborted === true &&
            error instanceof CallbackError &&
            error.code === "bind"
          ) {
            throw new CallbackError(
              "aborted",
              `${binding.label} OAuth login was aborted.`,
            );
          }
          throw error;
        }
        // Bind failed cleanly: release the caller's triggers and surface
        // the same failure through `result`.
        clearRuntimeTriggers(runtime);
        runtime.settled = true;
        runtime.rejectResult(
          error instanceof CallbackError
            ? error
            : new CallbackError("bind", describeBindFailure(error)),
        );
        throw error;
      }
      if (runtime.settled) {
        // Aborted while binding: the listener already settled `result` and
        // raced `runtime.server`; discard the orphaned listener ourselves.
        runtime.server = null;
        await discardServer(bound.server);
        throw new CallbackError(
          "aborted",
          `${binding.label} OAuth login was aborted.`,
        );
      }

      const { server, port } = bound;
      runtime.server = server;
      runtime.timeoutId = setTimeout(() => {
        settleFailure(
          runtime,
          "timeout",
          `${binding.label} OAuth login timed out. Start again.`,
        );
      }, options.timeoutMs ?? binding.defaultTimeoutMs);

      return {
        host: HOST,
        port,
        baseUrl: `http://${binding.baseUrlHost}:${port}`,
        result,
        cancel: () => {
          settleFailure(
            runtime,
            "cancelled",
            `${binding.label} OAuth login was cancelled.`,
          );
          return shutdownServer(runtime);
        },
        close: () => {
          settleFailure(
            runtime,
            "cancelled",
            `${binding.label} OAuth login was cancelled.`,
          );
          return shutdownServer(runtime);
        },
      };
    },
  };
}

async function bindListener(
  runtime: CallbackRuntime,
  options: CallbackServerOptions,
): Promise<{ server: Server; port: number }> {
  if (options.kind === "codex") {
    const port = options.port ?? CODEX_CALLBACK_PORT;
    const server = prepareServer(runtime);
    runtime.server = server;
    try {
      await listenOnce(server, port);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("callback port could not be read");
      }
      return { server, port: address.port };
    } catch (error) {
      runtime.server = null;
      void discardServer(server);
      throw new CallbackError(
        "bind",
        `Could not start Codex OAuth callback on port ${port}: ${describeBindFailure(error)}`,
      );
    }
  }
  if (options.kind === "antigravity") {
    const server = prepareServer(runtime);
    runtime.server = server;
    try {
      await listenOnce(server, 0);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("callback port could not be read");
      }
      return { server, port: address.port };
    } catch (error) {
      runtime.server = null;
      void discardServer(server);
      throw new CallbackError(
        "bind",
        `Could not start Antigravity OAuth callback: ${describeBindFailure(error)}`,
      );
    }
  }
  for (const candidate of KIRO_CALLBACK_PORT_CANDIDATES) {
    const attempt = prepareServer(runtime);
    runtime.server = attempt;
    try {
      await listenOnce(attempt, candidate);
      return { server: attempt, port: candidate };
    } catch {
      runtime.server = null;
      void discardServer(attempt);
    }
  }
  throw new CallbackError(
    "bind",
    "No available callback port found. Close other applications and try again.",
  );
}

function prepareServer(runtime: CallbackRuntime): Server {
  const server = createServer((request, response) => {
    handleRequest(runtime, request, response);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    } else {
      socket.destroy();
    }
  });
  return server;
}

function listenOnce(server: Server, port: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const cleanup = (): void => {
    server.off("error", onError);
    server.off("listening", onListening);
    server.off("close", onClose);
  };
  const onError = (error: Error): void => {
    cleanup();
    reject(error);
  };
  const onListening = (): void => {
    cleanup();
    resolve();
  };
  const onClose = (): void => {
    // An abort may close the server between bind and listen; the awaiter
    // must not hang waiting for a listening event that will never come.
    cleanup();
    reject(new Error("callback server closed before listening"));
  };
  server.on("error", onError);
  server.on("listening", onListening);
  server.on("close", onClose);
  server.listen(port, HOST);
  return promise;
}

function discardServer(server: Server): Promise<void> {
  server.closeAllConnections();
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
}

function describeBindFailure(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code !== ""
  ) {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

async function handleRequest(
  runtime: CallbackRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  request.on("error", () => {});
  response.on("error", () => {});

  if (runtime.settled) {
    respondPlain(response, 200, "Login already completed.");
    request.resume();
    return;
  }
  // OAuth redirects are GETs (HEAD tolerated for probes). Anything else —
  // including POST smuggling — is refused without evaluating the callback.
  if (request.method !== "GET" && request.method !== "HEAD") {
    respondPlain(response, 405, "Method not allowed.");
    destroyAfterFlush(response, request);
    return;
  }
  const target = request.url ?? "/";
  if (target.length > MAX_TARGET_LENGTH) {
    respondPlain(response, 414, "Request target too large.");
    destroyAfterFlush(response, request);
    return;
  }
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    respondPlain(response, 413, "Request body too large.");
    destroyAfterFlush(response, request);
    return;
  }

  // Consume the FULL body (bounded) before evaluating the callback: a
  // streamed oversize body — declared or chunked — is refused with 413 and
  // can never settle the auth flow. Normal OAuth GETs carry empty bodies,
  // so this resolves immediately for them.
  const body = await readBoundedBody(request, response);
  if (body !== "complete") {
    return; // oversize already answered with 413; error already tore down
  }

  const querySeparator = target.indexOf("?");
  const path = querySeparator === -1 ? target : target.slice(0, querySeparator);
  const query = querySeparator === -1 ? "" : target.slice(querySeparator + 1);
  const params = parseQueryParams(query);
  const decision = evaluateCallback(runtime, path, params);

  respondForDecision(runtime, decision, response);

  switch (decision.action) {
    case "resolve":
      settleSuccess(runtime, decision.success);
      break;
    case "reject":
      settleFailure(runtime, "rejected", decision.message);
      break;
    case "cancel":
      settleFailure(
        runtime,
        "cancelled",
        `${runtime.label} OAuth login was cancelled.`,
      );
      break;
    case "wait":
      break;
  }
}

type BodyOutcome = "complete" | "oversize" | "error";

/** Reads the request body, enforcing {@link MAX_BODY_BYTES} streamed. */
function readBoundedBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<BodyOutcome> {
  const { promise, resolve } = Promise.withResolvers<BodyOutcome>();
  let settled = false;
  let seen = 0;
  const finish = (outcome: BodyOutcome): void => {
    if (settled) {
      return;
    }
    settled = true;
    request.off("data", onData);
    request.off("end", onEnd);
    request.off("error", onError);
    resolve(outcome);
  };
  const onData = (chunk: Buffer): void => {
    seen += chunk.length;
    if (seen > MAX_BODY_BYTES) {
      respondPlain(response, 413, "Request body too large.");
      destroyAfterFlush(response, request);
      finish("oversize");
    }
  };
  const onEnd = (): void => {
    finish("complete");
  };
  const onError = (): void => {
    finish("error");
  };
  request.on("data", onData);
  request.on("end", onEnd);
  request.on("error", onError);
  return promise;
}

/** Destroys the request once its response has been flushed to the OS. */
function destroyAfterFlush(
  response: ServerResponse,
  request: IncomingMessage,
): void {
  if (response.writableEnded) {
    request.destroy();
    return;
  }
  response.on("finish", () => {
    request.destroy();
  });
}

function evaluateCallback(
  runtime: CallbackRuntime,
  path: string,
  params: Record<string, string>,
): CallbackDecision {
  if (runtime.kind === "kiro") {
    // Kiro redirects from different login-provider paths, so any path that
    // carries code/error is accepted (preflights keep waiting); state is
    // still validated exactly.
    if (path === "/cancel") {
      return { action: "cancel" };
    }
    const code = params.code ?? "";
    const hasError = params.error !== undefined;
    if (code === "" && !hasError) {
      // Browser preflight or favicon: harmless waiting page, keep listening.
      return { action: "wait" };
    }
    if (hasError) {
      const mismatch = stateMismatchDecision(
        params,
        runtime.expectedState,
        "State mismatch in OAuth callback.",
      );
      if (mismatch !== null) {
        // A supplied state always wins over attacker-chosen error text.
        return mismatch;
      }
      return {
        action: "reject",
        message: sanitizedFailureMessage("Authorization failed", params),
        page: "authFailed",
        errorText: sanitizeDetail(params.error ?? ""),
      };
    }
    const state = params.state ?? "";
    if (state === "" || state !== runtime.expectedState) {
      return {
        action: "reject",
        message: "State mismatch in OAuth callback.",
        page: "stateMismatch",
        errorText: "",
      };
    }
    return {
      action: "resolve",
      success: { code, state, path, params },
    };
  }

  if (path === "/cancel") {
    return { action: "cancel" };
  }
  const expectedPath =
    runtime.kind === "codex" ? CODEX_CALLBACK_PATH : ANTIGRAVITY_CALLBACK_PATH;
  // Exact route match only: prefix cousins keep waiting, never resolve.
  if (path !== expectedPath) {
    return { action: "wait" };
  }
  if (params.error !== undefined) {
    const mismatch = stateMismatchDecision(
      params,
      runtime.expectedState,
      "State mismatch in OAuth callback.",
    );
    if (mismatch !== null) {
      // A supplied state always wins over attacker-chosen error text.
      return mismatch;
    }
    return {
      action: "reject",
      message: sanitizedFailureMessage(
        `${runtime.label} OAuth returned error`,
        params,
      ),
      page: "authFailed",
      errorText: sanitizeDetail(params.error ?? ""),
    };
  }
  const code = params.code ?? "";
  const state = params.state ?? "";
  if (code === "" || state === "") {
    return { action: "wait" };
  }
  if (state !== runtime.expectedState) {
    // A wrong state on the exact route is a typed rejection, not a silent
    // wait: the caller must learn the flow is unusable.
    return {
      action: "reject",
      message: "State mismatch in OAuth callback.",
      page: "stateMismatch",
      errorText: "",
    };
  }
  return { action: "resolve", success: { code, state, path, params } };
}

/**
 * When a callback supplies `state`, that state must match before any
 * attacker-chosen `error`/`error_description` is honored; returns the
 * mismatch rejection, or `null` when no state was supplied.
 */
function stateMismatchDecision(
  params: Record<string, string>,
  expectedState: string,
  message: string,
): CallbackDecision | null {
  const supplied = params.state;
  if (supplied === undefined || supplied === expectedState) {
    return null;
  }
  return {
    action: "reject",
    message,
    page: "stateMismatch",
    errorText: "",
  };
}

/** Bounds, collapses, and redacts attacker-controlled error text. */
function sanitizeDetail(raw: string): string {
  const collapsed = raw.replaceAll(/\s+/g, " ").trim();
  if (collapsed === "") {
    return "";
  }
  return redactSecrets(collapsed).slice(0, MAX_ERROR_DETAIL_LENGTH);
}

/** Composes a bounded, redacted failure message from callback params. */
function sanitizedFailureMessage(
  prefix: string,
  params: Record<string, string>,
): string {
  const error = sanitizeDetail(params.error ?? "");
  const description = sanitizeDetail(params.error_description ?? "");
  if (error === "" && description === "") {
    return `${prefix}.`;
  }
  if (description === "") {
    return `${prefix}: ${error}`;
  }
  return `${prefix}: ${error} (${description})`;
}

function respondForDecision(
  runtime: CallbackRuntime,
  decision: CallbackDecision,
  response: ServerResponse,
): void {
  if (runtime.kind === "kiro") {
    switch (decision.action) {
      case "resolve":
        respondKiroPage(
          response,
          200,
          "<h2>&#10003; Connected</h2><p>You can close this tab and return to Fuel Gauge.</p><script>window.close();</script>",
        );
        return;
      case "wait":
        respondKiroPage(response, 200, "<p>Waiting for Kiro login…</p>");
        return;
      case "cancel":
        respondKiroPage(
          response,
          200,
          "<h2>Cancelled</h2><p>Return to Fuel Gauge.</p>",
        );
        return;
      case "reject":
        if (decision.page === "stateMismatch") {
          respondKiroPage(
            response,
            400,
            "<h2>State mismatch</h2><p>Close this tab and try connecting again from Fuel Gauge.</p>",
          );
          return;
        }
        respondKiroPage(
          response,
          400,
          `<h2>Authorization failed</h2><p>${escapeHtml(decision.errorText)}</p><p>Close this tab and return to Fuel Gauge to try again.</p>`,
        );
        return;
    }
  }
  switch (decision.action) {
    case "resolve":
      respondPlain(
        response,
        200,
        `${runtime.label} connected. You can return to Fuel Gauge.`,
      );
      return;
    case "wait":
      respondPlain(
        response,
        200,
        `${runtime.label} OAuth is still waiting for the login redirect.`,
      );
      return;
    case "reject":
      respondPlain(
        response,
        400,
        decision.page === "stateMismatch"
          ? "State mismatch. Close this tab and connect again from Fuel Gauge."
          : `${runtime.label} connection failed. Return to Fuel Gauge and try again.`,
      );
      return;
    case "cancel":
      respondPlain(response, 200, "Login cancelled. Return to Fuel Gauge.");
      return;
  }
}

function settleSuccess(
  runtime: CallbackRuntime,
  success: CallbackSuccess,
): void {
  if (runtime.settled) {
    return;
  }
  runtime.settled = true;
  clearRuntimeTriggers(runtime);
  runtime.resolveResult(success);
  void shutdownServer(runtime, { listenGrace: true });
}

function settleFailure(
  runtime: CallbackRuntime,
  code: CallbackErrorCode,
  message: string,
): void {
  if (runtime.settled) {
    return;
  }
  runtime.settled = true;
  clearRuntimeTriggers(runtime);
  runtime.rejectResult(new CallbackError(code, message));
  void shutdownServer(runtime, { listenGrace: true });
}

function clearRuntimeTriggers(runtime: CallbackRuntime): void {
  if (runtime.timeoutId !== null) {
    clearTimeout(runtime.timeoutId);
    runtime.timeoutId = null;
  }
  if (runtime.abortListener !== null) {
    runtime.abortSignal?.removeEventListener("abort", runtime.abortListener);
    runtime.abortListener = null;
  }
}

function shutdownServer(
  runtime: CallbackRuntime,
  options: { listenGrace?: boolean } = {},
): Promise<void> {
  if (runtime.closedPromise !== null) {
    return runtime.closedPromise;
  }
  const { promise: closedPromise, resolve: resolveClosed } =
    Promise.withResolvers<void>();
  runtime.closedPromise = closedPromise;
  const server = runtime.server;
  if (server === null) {
    resolveClosed();
    return closedPromise;
  }
  let finished = false;
  const finish = (): void => {
    if (finished) {
      return;
    }
    finished = true;
    if (graceCloseId !== null) {
      clearTimeout(graceCloseId);
    }
    clearTimeout(forceCloseId);
    resolveClosed();
  };
  // After a RESOLUTION the listener keeps accepting for a short grace
  // window so a second browser tab receives the documented "Login already
  // completed." notice instead of a connection reset; user-initiated
  // cancel/close still release the port immediately.
  const graceMs =
    options.listenGrace === true ? POST_SETTLE_LISTEN_GRACE_MS : 0;
  const graceCloseId =
    options.listenGrace === true
      ? setTimeout(() => {
          server.close(() => {
            finish();
          });
        }, graceMs)
      : null;
  if (graceCloseId !== null) {
    graceCloseId.unref();
  }
  const forceCloseId = setTimeout(() => {
    server.closeAllConnections();
    server.close(() => {
      finish();
    });
  }, FORCE_CLOSE_DELAY_MS);
  forceCloseId.unref();
  if (graceCloseId === null) {
    server.close(() => {
      finish();
    });
  }
  return closedPromise;
}

function parseQueryParams(query: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (query === "") {
    return params;
  }
  for (const pair of query.split("&")) {
    if (pair === "") {
      continue;
    }
    const separator = pair.indexOf("=");
    const rawKey = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? "" : pair.slice(separator + 1);
    const key = decodeQueryComponent(rawKey);
    const value = decodeQueryComponent(rawValue);
    if (key === undefined || value === undefined) {
      continue;
    }
    params[key] = value;
  }
  return params;
}

function decodeQueryComponent(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

function respondPlain(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  if (response.destroyed || response.headersSent) {
    return;
  }
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    Connection: "close",
  });
  response.end(body);
}

function respondKiroPage(
  response: ServerResponse,
  status: number,
  bodyFragment: string,
): void {
  const body = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fuel Gauge – Kiro</title><style>body{font-family:sans-serif;background:#111;color:#eee;text-align:center;padding:60px}h2{margin-bottom:8px}p{color:#aaa}</style></head><body>${bodyFragment}</body></html>`;
  if (response.destroyed || response.headersSent) {
    return;
  }
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    Connection: "close",
  });
  response.end(body);
}

/** Escapes untrusted query values before they are embedded in a local page. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
