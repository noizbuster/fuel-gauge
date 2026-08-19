import type { CallbackServerFactory } from "../../src/core/callback-server.js";
import { createCredentialStore } from "../../src/core/store.js";
import type { SubprocessPort } from "../../src/core/subprocess.js";
import type { Clock } from "../../src/core/time.js";
import type { RuntimeDependencies } from "../../src/runtime.js";

export const FIXED_NOW_MS = 1_700_000_000_000;

/**
 * Deterministic clock pinned at {@link FIXED_NOW_MS}; `sleep` resolves
 * immediately so polling loops advance without wall-clock waits.
 */
export function fixedClock(): Clock {
  return {
    now: () => FIXED_NOW_MS,
    sleep: () => Promise.resolve(),
    setInterval: () => ({ clear() {} }),
    clearInterval() {},
  };
}

/**
 * Clock whose `sleep` records every requested duration and resolves
 * immediately; used to assert poll cadence and backoff timing exactly.
 */
export function countingClock(sleepLog: number[]): Clock {
  return {
    now: () => FIXED_NOW_MS,
    sleep: (ms) => {
      sleepLog.push(ms);
      return Promise.resolve();
    },
    setInterval: () => ({ clear() {} }),
    clearInterval() {},
  };
}

export interface TestRuntimeOptions {
  root: string;
  clock?: Clock;
  subprocess?: SubprocessPort;
  callbackServer?: CallbackServerFactory;
}

/** Runtime dependencies around a fresh private store and injected fetch. */
export function makeTestRuntime(
  fetchImpl: typeof fetch,
  options: TestRuntimeOptions,
): RuntimeDependencies {
  return {
    configRoot: options.root,
    store: createCredentialStore(options.root),
    fetch: fetchImpl,
    clock: options.clock ?? fixedClock(),
    browser: {
      async open() {
        return { url: "", launched: false };
      },
    },
    subprocess:
      options.subprocess ??
      ({
        async run() {
          throw new Error("subprocess not expected in provider tests");
        },
      } satisfies SubprocessPort),
    callbackServer:
      options.callbackServer ??
      ({
        async start() {
          throw new Error("callback server not expected in provider tests");
        },
      } satisfies CallbackServerFactory),
  };
}

export const noNetwork: typeof fetch = async () => {
  throw new Error("no network expected in this test");
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function jwtWith(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.${encode({})}`;
}

export const signal = (): AbortSignal => new AbortController().signal;

/** Asserts a header on a fetch RequestInit, failing loudly when absent. */
export function headerOf(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers;
  if (headers == null) throw new Error("request had no headers");
  return (headers as Record<string, string>)[name] ?? "";
}

/** Serialized summary text for token-leak assertions. */
export function summaryJson(value: unknown): string {
  return JSON.stringify(value);
}
