import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addSeconds,
  createManualClock,
  heuristicEpochMs,
  parseEpochMs,
} from "../../src/core/time.js";

function countingSignal(): {
  controller: AbortController;
  signal: AbortSignal;
  live: () => number;
} {
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  let added = 0;
  let removed = 0;
  signal.addEventListener = ((...args: Parameters<typeof originalAdd>) => {
    added += 1;
    return originalAdd(...args);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((
    ...args: Parameters<typeof originalRemove>
  ) => {
    removed += 1;
    return originalRemove(...args);
  }) as typeof signal.removeEventListener;
  return { controller, signal, live: () => added - removed };
}

test("manual clock sleeps detach their abort listener on normal resolution", () => {
  const { controller, signal, live } = countingSignal();
  const manual = createManualClock();

  void manual.clock.sleep(1_000, signal);
  assert.equal(manual.pending(), 1);
  assert.equal(live(), 1, "listener attached while sleeping");

  manual.advance(1_000);
  assert.equal(manual.pending(), 0, "sleep settled");
  assert.equal(
    live(),
    0,
    "listener detached after normal resolution — no leak",
  );

  // Repeated sleeps on the same signal must not accumulate listeners.
  for (let i = 0; i < 25; i++) {
    void manual.clock.sleep(10, signal);
    manual.advance(10);
  }
  assert.equal(live(), 0);
  assert.equal(manual.pending(), 0);
  controller.abort();
});

test("manual clock sleeps detach their abort listener on abort", () => {
  const controller = new AbortController();
  const manual = createManualClock();
  const sleeping = manual.clock.sleep(1_000, controller.signal);
  controller.abort();
  assert.equal(manual.pending(), 0);
  assert.rejects(sleeping, /aborted/);
});

test("date-only strings round-trip: invalid calendar dates are rejected", () => {
  assert.equal(
    parseEpochMs("2026-02-31"),
    null,
    "February 31st does not exist",
  );
  assert.equal(parseEpochMs("2026-04-31"), null, "April 31st does not exist");
  assert.equal(parseEpochMs("2026-13-01"), null, "month 13 does not exist");
  assert.equal(parseEpochMs("2026-00-10"), null, "month 0 does not exist");

  const valid = parseEpochMs("2026-02-28");
  assert.equal(valid, Date.parse("2026-02-28T00:00:00Z"));
  assert.equal(parseEpochMs("2024-02-29"), Date.parse("2024-02-29T00:00:00Z"));
});

test("date-time strings reject normalized rollover too", () => {
  assert.equal(parseEpochMs("2026-02-31T10:00:00Z"), null);
  assert.equal(parseEpochMs("2026-02-30T23:59:59Z"), null);
  const valid = parseEpochMs("2026-02-28T10:30:00Z");
  assert.equal(valid, Date.parse("2026-02-28T10:30:00Z"));
});

test("valid RFC 3339 offsets crossing UTC midnight are accepted", () => {
  const west = parseEpochMs("2026-01-01T23:00:00-02:00");
  assert.equal(west, Date.parse("2026-01-01T23:00:00-02:00"));

  const east = parseEpochMs("2026-01-01T01:00:00+05:00");
  assert.equal(east, Date.parse("2026-01-01T01:00:00+05:00"));

  // Leap-day with offset remains valid.
  const leap = parseEpochMs("2024-02-29T23:30:00-03:00");
  assert.equal(leap, Date.parse("2024-02-29T23:30:00-03:00"));
});

test("addSeconds saturates at the safe integer range", () => {
  assert.equal(addSeconds(1_000, 60), 61_000);
  assert.equal(addSeconds(1_000, Number.NaN), 1_000);

  const hugePositive = addSeconds(9e15, 8e9);
  assert.equal(hugePositive, Number.MAX_SAFE_INTEGER);

  const hugeNegative = addSeconds(-9e15, -8e9);
  assert.equal(hugeNegative, Number.MIN_SAFE_INTEGER);

  // Finite but precision-unsafe sums must saturate, not silently lose digits.
  const unsafe = addSeconds(Number.MAX_SAFE_INTEGER - 1, 10);
  assert.equal(unsafe, Number.MAX_SAFE_INTEGER);

  const unsafeBelow = addSeconds(Number.MIN_SAFE_INTEGER + 1, -10);
  assert.equal(unsafeBelow, Number.MIN_SAFE_INTEGER);

  // The safe boundary itself is preserved exactly.
  assert.equal(addSeconds(0, 1), 1_000);
  assert.equal(
    addSeconds(Number.MAX_SAFE_INTEGER - 500, 0),
    Number.MAX_SAFE_INTEGER - 500,
  );
});

test("numeric and unparsable parseEpochMs inputs behave as before", () => {
  assert.equal(parseEpochMs(1_700_000_000), heuristicEpochMs(1_700_000_000));
  assert.equal(parseEpochMs("1700000000"), heuristicEpochMs(1_700_000_000));
  assert.equal(parseEpochMs(""), null);
  assert.equal(parseEpochMs("not a date"), null);
  assert.equal(parseEpochMs(null), null);
  assert.equal(parseEpochMs(true), null);
});
