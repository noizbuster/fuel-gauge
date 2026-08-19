#!/usr/bin/env node
/**
 * Fuel Gauge CLI entry point.
 *
 * Interactive terminals mount the Ink app; anything else (piped stdin or
 * stdout) gets a single token-free snapshot written once to stdout with no
 * raw mode, input listeners, network, auth, or refresh work.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { type Instance, render, renderToString } from "ink";
import { createRuntime } from "./runtime.js";
import { App } from "./ui/app.js";
import { NonInteractiveSnapshot } from "./ui/non-interactive-snapshot.js";

/** Minimal structural stand-ins so tests can drive `main` without a PTY. */
interface StdinLike {
  readonly isTTY?: boolean;
}

interface OutputLike {
  readonly isTTY?: boolean;
  write(text: string): boolean;
}

export interface MainOptions {
  readonly stdin?: StdinLike;
  readonly stdout?: OutputLike;
}

async function runInteractive(): Promise<void> {
  const runtime = createRuntime();
  // The App registers its deterministic cleanup (monitor dispose) so this
  // entry can AWAIT it after Ink settles — for both `q` and the
  // plan-mandated built-in Ctrl-C path (`exitOnCtrlC: true`).
  let appDispose: null | (() => Promise<void>) = null;
  // Ink's kitty-keyboard auto probe fires from its constructor — it writes
  // `ESC[?u` before any useInput effect has enabled raw mode, so kitty's
  // `ESC[?0u` reply arrives while stdin still has ECHO on and the kernel
  // prints it (`^[[?0u`) at the top-left of the first frame. Entering raw
  // mode first silences the echo; Ink's own lifecycle is unchanged (mount
  // re-arms raw mode, unmount leaves it off).
  process.stdin.setRawMode(true);
  let instance: Instance;
  try {
    instance = render(
      <App
        runtime={runtime}
        registerDispose={(dispose: () => Promise<void>) => {
          appDispose = dispose;
        }}
      />,
      {
        interactive: true,
        alternateScreen: true,
        kittyKeyboard: { mode: "auto" },
        exitOnCtrlC: true,
        // Per-line frame diffs: unchanged lines are never rewritten, so
        // refreshes repaint only what moved instead of the whole screen.
        incrementalRendering: true,
      },
    );
  } catch (error) {
    process.stdin.setRawMode(false);
    throw error;
  }
  // Watchers (`node --watch`) and terminal-relayed Ctrl-C arrive as
  // SIGTERM/SIGINT. The default disposition kills mid-frame, skipping
  // Ink's restore of raw mode, the kitty stack, and the alternate screen,
  // and stranding the shell in a raw tty. Route signals through Ink's
  // normal unmount so the terminal is handed back exactly like a `q`
  // quit; `waitUntilExit` below then completes the existing cleanup path.
  let terminating = false;
  const unmountOnSignal = () => {
    if (terminating) {
      return;
    }
    terminating = true;
    instance.unmount();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, unmountOnSignal);
  }
  await instance.waitUntilExit();
  // Ink's unmount already fired the App's effect cleanup; dispose is
  // idempotent, so awaiting it here guarantees timers/sockets/flows settle
  // before the process returns.
  const dispose = appDispose as null | (() => Promise<void>);
  await dispose?.();
}

async function runNonInteractive(stdout: OutputLike): Promise<void> {
  // Cached public summaries only: no refresh, auth, or provider I/O.
  const runtime = createRuntime();
  const summaries = await runtime.loadCachedSummaries();
  const text = renderToString(<NonInteractiveSnapshot summaries={summaries} />);
  stdout.write(`${text}\n`);
}

/**
 * Program entry. Interactive only when BOTH stdin and stdout are TTYs.
 * Never calls `process.exit()`; normal shutdown returns naturally.
 */
export async function main(options: MainOptions = {}): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (process.argv.includes("--clear-cache")) {
    // Manual cache wipe: drops every stored account (settings survive)
    // and exits; the next interactive start re-imports fresh copies of
    // whatever the local agents still hold.
    const runtime = createRuntime();
    const removed = await runtime.store.clearAccounts();
    stdout.write(`cleared ${removed} cached account(s)\n`);
    return;
  }
  if (stdin.isTTY === true && stdout.isTTY === true) {
    await runInteractive();
    return;
  }
  await runNonInteractive(stdout);
}

/** Long opaque runs (JWTs, base64 secrets) never reach stderr. */
const SECRET_LIKE = /[A-Za-z0-9_-]{24,}/g;
const MAX_ERROR_LENGTH = 400;

function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(SECRET_LIKE, "[redacted]");
  if (message === "") {
    return "unexpected error";
  }
  return message.length > MAX_ERROR_LENGTH
    ? `${message.slice(0, MAX_ERROR_LENGTH)}...`
    : message;
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry === "") {
    return false;
  }
  try {
    // import.meta.url is the real-path URL; follow symlinks so a link to
    // dist/cli.js still detects direct invocation.
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    await main();
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`fuel-gauge: ${sanitizeErrorMessage(error)}\n`);
  }
}
