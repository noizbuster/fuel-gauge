/**
 * Time normalization and the injectable clock used across Fuel Gauge.
 *
 * Every timestamp that crosses a provider boundary is an epoch value in
 * milliseconds. Reference clients disagree on wire units (epoch seconds,
 * epoch milliseconds, RFC 3339 strings, date-only strings), so all parsing
 * funnels through the helpers here before anything is stored or rendered.
 *
 * Grounding:
 * - `ref/quota/src-tauri/src/{claude,kiro,antigravity}.rs` treat a positive
 *   numeric timestamp greater than 10_000_000_000 as already-milliseconds and
 *   any smaller positive value as epoch seconds (`parse_reset_seconds`,
 *   `parse_reset_at`, the kiro millisecond conversions).
 * - `ref/quota/quota-vscode/src/kiroUsage.ts` (`parseKiroTimestamp`) and
 *   `githubCopilotUsage.ts` (`parseCopilotResetDate`) apply the same heuristic
 *   plus numeric-string, RFC 3339, and `YYYY-MM-DD` handling.
 */

/** Numeric values above this are treated as epoch milliseconds, below as seconds. */
export const EPOCH_MS_HEURISTIC_THRESHOLD = 10_000_000_000;

/** Opaque handle returned by {@link Clock.setInterval}. */
export interface ClockTimer {
  /** Stops the timer. Idempotent. */
  clear(): void;
}

/**
 * Injectable time source. Production code uses {@link systemClock}; tests use
 * {@link createManualClock} for deterministic advancement.
 */
export interface Clock {
  /** Current epoch time in milliseconds. */
  now(): number;
  /**
   * Resolves after `ms` milliseconds. Rejects with an `AbortError`-named error
   * when `signal` aborts (including when it is already aborted).
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Schedules a repeating callback; interval milliseconds are clamped to >= 1. */
  setInterval(callback: () => void, intervalMs: number): ClockTimer;
  /** Stops a timer obtained from {@link setInterval}. Idempotent. */
  clearInterval(timer: ClockTimer): void;
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function systemSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    if (!Number.isFinite(ms) || ms <= 0) {
      resolve();
      return;
    }
    const detach = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      detach();
      resolve();
    }, ms);
    const onAbort = () => {
      detach();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Clock backed by the real system time and Node timers. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => systemSleep(ms, signal),
  setInterval: (callback, intervalMs) => {
    const handle = setInterval(callback, intervalMs);
    let cleared = false;
    return {
      clear: () => {
        if (cleared) return;
        cleared = true;
        clearInterval(handle);
      },
    };
  },
  clearInterval: (timer) => timer.clear(),
};

interface ManualSleep {
  seq: number;
  deadline: number;
  settle(): void;
  discard(): void;
}

interface ManualInterval {
  seq: number;
  step: number;
  nextAt: number;
  fire(): void;
}

/** Safety bound so a pathological advance cannot loop forever. */
const MAX_MANUAL_FIRINGS = 1_000_000;

/** Deterministic test clock; sleep and interval callbacks fire inside {@link ManualClock.advance}. */
export interface ManualClock {
  readonly clock: Clock;
  now(): number;
  /** Moves time forward, firing due sleeps and interval ticks in deadline order. */
  advance(deltaMs: number): void;
  /** Number of live sleepers plus active intervals. */
  pending(): number;
}

export function createManualClock(startAtMs = 0): ManualClock {
  let current = startAtMs;
  let seq = 0;
  const sleeps: ManualSleep[] = [];
  const intervals: ManualInterval[] = [];

  const clock: Clock = {
    now: () => current,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const duration = Number.isFinite(ms) && ms > 0 ? ms : 0;
        const entry: ManualSleep = {
          seq: seq++,
          deadline: current + duration,
          settle: () => {
            removeSleep(entry);
            // Normal resolution must detach the abort listener; leaving it
            // registered leaks one listener per completed sleep.
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
          discard: () => {
            removeSleep(entry);
            signal?.removeEventListener("abort", onAbort);
            reject(abortError());
          },
        };
        const onAbort = () => {
          entry.discard();
        };
        sleeps.push(entry);
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    setInterval: (callback, intervalMs) => {
      const requested = Number.isFinite(intervalMs)
        ? Math.trunc(intervalMs)
        : 0;
      const step = Math.max(1, requested);
      const entry: ManualInterval = {
        seq: seq++,
        step,
        nextAt: current + step,
        fire: () => {
          entry.nextAt += entry.step;
          callback();
        },
      };
      intervals.push(entry);
      return {
        clear: () => {
          const index = intervals.indexOf(entry);
          if (index >= 0) intervals.splice(index, 1);
        },
      };
    },
    clearInterval: (timer) => timer.clear(),
  };

  function removeSleep(entry: ManualSleep): void {
    const index = sleeps.indexOf(entry);
    if (index >= 0) sleeps.splice(index, 1);
  }

  return {
    clock,
    now: () => current,
    advance: (deltaMs) => {
      const delta = Number.isFinite(deltaMs) ? deltaMs : 0;
      const target = current + delta;
      if (target <= current) {
        current = target;
        return;
      }
      let fired = 0;
      for (;;) {
        let dueAt = Number.POSITIVE_INFINITY;
        let dueSeq = 0;
        let run: (() => void) | undefined;
        for (const sleep of sleeps) {
          if (sleep.deadline <= target && sleep.deadline < dueAt) {
            dueAt = sleep.deadline;
            dueSeq = sleep.seq;
            run = sleep.settle;
          }
        }
        for (const interval of intervals) {
          if (
            interval.nextAt <= target &&
            (interval.nextAt < dueAt ||
              (interval.nextAt === dueAt && interval.seq < dueSeq))
          ) {
            dueAt = interval.nextAt;
            dueSeq = interval.seq;
            run = interval.fire;
          }
        }
        if (run === undefined) break;
        current = dueAt;
        run();
        if (++fired > MAX_MANUAL_FIRINGS) {
          throw new RangeError("Manual clock advance firing limit exceeded.");
        }
      }
      current = target;
    },
    pending: () => sleeps.length + intervals.length,
  };
}

/**
 * Normalizes a value already known to be epoch seconds into milliseconds.
 * Returns null for non-positive or non-finite input (the reference treats
 * missing/zero resets as unknown).
 */
export function epochSecondsToMs(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = Math.trunc(seconds * 1000);
  return Number.isSafeInteger(ms) ? ms : null;
}

/**
 * Applies the reference seconds/milliseconds heuristic: values above
 * {@link EPOCH_MS_HEURISTIC_THRESHOLD} are already milliseconds, smaller
 * positive values are epoch seconds. Returns null for non-positive input.
 */
export function heuristicEpochMs(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const ms = Math.trunc(
    value > EPOCH_MS_HEURISTIC_THRESHOLD ? value : value * 1000,
  );
  return Number.isSafeInteger(ms) ? ms : null;
}
const NUMERIC_STRING_PATTERN = /^\d+$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LEADING_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Rejects calendar-invalid dates: V8 normalizes out-of-range days (e.g.
 * `2026-02-31` becomes March 3). Validation checks the LEXICAL year-month-day
 * tuple against `Date.UTC` — comparing the parsed instant's UTC date would
 * wrongly reject valid RFC 3339 offsets that cross UTC midnight (e.g.
 * `2026-01-01T23:00:00-02:00`, which is January 2 in UTC).
 */
function calendarRoundTripValid(trimmed: string): boolean {
  const match = LEADING_DATE_PATTERN.exec(trimmed);
  if (match === null) {
    return true; // not a calendar date (e.g. bare number) — nothing to check
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const roundTrip = new Date(Date.UTC(year, monthIndex, day));
  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === monthIndex &&
    roundTrip.getUTCDate() === day
  );
}

/**
 * Parses an unknown wire value into epoch milliseconds. Accepts numbers,
 * numeric strings (same seconds/milliseconds heuristic), `YYYY-MM-DD` strings
 * (parsed as UTC midnight), and RFC 3339/date-time strings. Returns null when
 * the value is absent, unparsable, calendar-invalid, or non-positive.
 */
export function parseEpochMs(value: unknown): number | null {
  if (typeof value === "number") return heuristicEpochMs(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (NUMERIC_STRING_PATTERN.test(trimmed)) {
    return heuristicEpochMs(Number(trimmed));
  }
  const candidate = DATE_ONLY_PATTERN.test(trimmed)
    ? `${trimmed}T00:00:00Z`
    : trimmed;
  const parsed = Date.parse(candidate);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return null;
  }
  return calendarRoundTripValid(trimmed) ? parsed : null;
}

/**
 * Adds seconds to an epoch-millisecond base. NaN seconds leave the base
 * unchanged; results beyond the safe integer range saturate to
 * `Number.MAX_SAFE_INTEGER` / `Number.MIN_SAFE_INTEGER` — including finite
 * but precision-unsafe values, which would otherwise silently lose digits.
 */
export function addSeconds(baseMs: number, seconds: number): number {
  if (Number.isNaN(seconds)) return baseMs;
  const total = baseMs + seconds * 1000;
  if (Number.isNaN(total)) return baseMs;
  if (total >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  if (total <= Number.MIN_SAFE_INTEGER) return Number.MIN_SAFE_INTEGER;
  return total;
}

/**
 * Expiry check mirroring the reference token-refresh guards: an account is
 * stale when `expiresAtMs <= nowMs + skewMs` (Claude uses 300 000 ms, Google
 * OAuth uses 60 000 ms). Missing expiry never expires on its own.
 */
export function isExpired(
  expiresAtMs: number | null | undefined,
  nowMs: number,
  skewMs = 0,
): boolean {
  if (expiresAtMs == null) return false;
  return expiresAtMs <= nowMs + skewMs;
}
