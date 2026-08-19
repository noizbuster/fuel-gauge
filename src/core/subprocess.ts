import { execFile } from "node:child_process";

import { redactSecrets } from "./http.js";

/** Default cap on stdout/stderr captured from a child process (1 MiB). */
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

/** Maximum length of the stderr excerpt embedded in error messages. */
const STDERR_PREVIEW_LIMIT = 400;

export interface SubprocessRunOptions {
  /** Working directory for the child process. */
  readonly cwd?: string;
  /** Kill the child after this many milliseconds. */
  readonly timeoutMs?: number;
  /** AbortSignal; when fired the child is killed and the run fails with code "aborted". */
  readonly signal?: AbortSignal;
  /** Cap on captured stdout/stderr. Defaults to 1 MiB. */
  readonly maxOutputBytes?: number;
  /**
   * Full replacement environment for the child. When omitted the current
   * process environment is inherited.
   */
  readonly env?: Record<string, string>;
  /** Environment keys removed from the (possibly replaced) environment. */
  readonly envRemove?: readonly string[];
}

export interface SubprocessResult {
  /** Raw stdout of the child, decoded as UTF-8. May hold secrets; never log blindly. */
  readonly stdout: string;
  /** Raw stderr of the child, decoded as UTF-8. */
  readonly stderr: string;
}

export type SubprocessErrorCode =
  | "spawn"
  | "failed"
  | "timeout"
  | "aborted"
  | "outputTooLarge";

/**
 * Failure running a child process. Never includes stdout: commands such as
 * `security find-generic-password -w` print secrets there. Only a bounded,
 * sanitized stderr excerpt is carried for diagnostics.
 */
export class SubprocessError extends Error {
  readonly code: SubprocessErrorCode;
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderrPreview: string;

  constructor(details: {
    code: SubprocessErrorCode;
    command: string;
    args: readonly string[];
    exitCode: number | null;
    signal: string | null;
    message: string;
    stderr?: string;
  }) {
    super(details.message);
    this.name = "SubprocessError";
    this.code = details.code;
    this.command = details.command;
    this.args = details.args;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.stderrPreview = sanitizeStderr(details.stderr ?? "");
  }
}

/**
 * Injectable boundary around running external CLI tools (`gh`, macOS
 * `security`). Uses `execFile` only: no shell, bounded output, timeout and
 * AbortSignal support, and a sanitized-environment option so rejected
 * environment tokens cannot shadow CLI credentials.
 */
export interface SubprocessPort {
  run(
    command: string,
    args: readonly string[],
    options?: SubprocessRunOptions,
  ): Promise<SubprocessResult>;
}

/** Production subprocess port backed by `node:child_process` `execFile`. */
export function createSubprocessPort(): SubprocessPort {
  return {
    run(
      command: string,
      args: readonly string[],
      options: SubprocessRunOptions = {},
    ): Promise<SubprocessResult> {
      const { promise, resolve, reject } =
        Promise.withResolvers<SubprocessResult>();
      if (options.signal?.aborted) {
        reject(
          new SubprocessError({
            code: "aborted",
            command,
            args,
            exitCode: null,
            signal: null,
            message: `Command "${command}" was aborted before it started.`,
          }),
        );
        return promise;
      }
      // Validate knobs before they reach execFile: a negative or NaN
      // timeout would fire immediately (spurious "timeout") and a
      // non-positive maxBuffer would reject every byte.
      const requestedTimeout = options.timeoutMs;
      const timeoutMs =
        requestedTimeout !== undefined &&
        Number.isFinite(requestedTimeout) &&
        requestedTimeout > 0
          ? requestedTimeout
          : undefined;
      const requestedMax = options.maxOutputBytes;
      const maxOutputBytes =
        requestedMax !== undefined &&
        Number.isFinite(requestedMax) &&
        requestedMax > 0
          ? requestedMax
          : DEFAULT_MAX_OUTPUT_BYTES;
      let timedOut = false;
      const timeoutId =
        timeoutMs === undefined
          ? null
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
            }, timeoutMs);

      const child = execFile(
        command,
        [...args],
        {
          cwd: options.cwd,
          killSignal: "SIGTERM",
          maxBuffer: maxOutputBytes,
          signal: options.signal,
          env: buildEnv(options),
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          if (error === null || error === undefined) {
            resolve({ stdout, stderr });
            return;
          }
          reject(
            toSubprocessError(command, args, error, stderr, {
              timedOut,
              timeoutMs,
              maxOutputBytes,
            }),
          );
        },
      );
      return promise;
    },
  };
}

function buildEnv(options: SubprocessRunOptions): NodeJS.ProcessEnv {
  const remove = options.envRemove;
  const source: NodeJS.ProcessEnv = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (remove?.includes(key) || value === undefined) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

type ExecFailure = Error & {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals;
};

function toSubprocessError(
  command: string,
  args: readonly string[],
  error: ExecFailure,
  stderr: string,
  context: {
    timedOut: boolean;
    timeoutMs: number | undefined;
    maxOutputBytes: number;
  },
): SubprocessError {
  const exitCode = typeof error.code === "number" ? error.code : null;
  const signal = error.signal ?? null;
  const base = { command, args, exitCode, signal, stderr };

  if (error.name === "AbortError") {
    return new SubprocessError({
      ...base,
      code: "aborted",
      message: `Command "${command}" was aborted.`,
    });
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new SubprocessError({
      ...base,
      code: "outputTooLarge",
      message: `Command "${command}" produced more than ${context.maxOutputBytes} bytes of output.`,
    });
  }
  if (context.timedOut) {
    return new SubprocessError({
      ...base,
      code: "timeout",
      message: `Command "${command}" timed out after ${context.timeoutMs} ms.`,
    });
  }
  if (typeof error.code === "string") {
    return new SubprocessError({
      ...base,
      code: "spawn",
      message: `Could not run "${command}": ${error.code}.`,
    });
  }
  const suffix = stderr.trim() === "" ? "" : ` ${sanitizeStderr(stderr)}`;
  return new SubprocessError({
    ...base,
    code: "failed",
    message: `Command "${command}" failed with exit code ${exitCode ?? "unknown"}.${suffix}`,
  });
}

/**
 * Collapses whitespace, redacts secret VALUES (bearer tokens, keyed
 * secrets — stderr can echo credential material), and bounds the excerpt.
 * Redaction happens before bounding so a truncation cannot split a
 * redaction marker and leak a fragment.
 */
function sanitizeStderr(stderr: string): string {
  const flattened = redactSecrets(stderr.replaceAll(/\s+/g, " ").trim());
  if (flattened === "") {
    return "";
  }
  return flattened.slice(0, STDERR_PREVIEW_LIMIT);
}
