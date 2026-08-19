import assert from "node:assert/strict";
import { test } from "node:test";

import { Box, Text, useStdout } from "ink";
import { render } from "ink-testing-library";

import {
  chooseLayout,
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  SHORT_MAX_ROWS,
  useViewport,
  WIDE_MIN_COLUMNS,
} from "../../src/ui/viewport.js";

test("wide layout at and beyond the column threshold", () => {
  const wide = chooseLayout({ columns: WIDE_MIN_COLUMNS, rows: 40 });
  assert.equal(wide.kind, "wide");
  assert.equal(wide.columns, 2);
  assert.equal(wide.compact, false);

  const wider = chooseLayout({ columns: 240, rows: 60 });
  assert.deepEqual(wider, {
    kind: "wide",
    columns: 2,
    compact: false,
    width: 240,
    height: 60,
  });
});

test("narrow layout below the column threshold keeps full decoration", () => {
  const narrow = chooseLayout({
    columns: WIDE_MIN_COLUMNS - 1,
    rows: DEFAULT_ROWS,
  });
  assert.equal(narrow.kind, "narrow");
  assert.equal(narrow.columns, 1);
  assert.equal(narrow.compact, false);

  const tiny = chooseLayout({ columns: 40, rows: 30 });
  assert.deepEqual(tiny, {
    kind: "narrow",
    columns: 1,
    compact: false,
    width: 40,
    height: 30,
  });
});

test("short layout collapses to one compact column regardless of width", () => {
  const short = chooseLayout({
    columns: DEFAULT_COLUMNS,
    rows: SHORT_MAX_ROWS,
  });
  assert.equal(short.kind, "short");
  assert.equal(short.columns, 1);
  assert.equal(short.compact, true);

  const shortAndWide = chooseLayout({ columns: 200, rows: SHORT_MAX_ROWS });
  assert.equal(shortAndWide.kind, "short");
  assert.equal(shortAndWide.columns, 1);
  assert.equal(shortAndWide.compact, true);

  const oneRowShort = chooseLayout({ columns: 120, rows: 1 });
  assert.equal(oneRowShort.kind, "short");

  const tall = chooseLayout({
    columns: DEFAULT_COLUMNS,
    rows: SHORT_MAX_ROWS + 1,
  });
  assert.notEqual(tall.kind, "short");
});

test("non-positive and non-finite sizes fall back to the deterministic default", () => {
  for (const size of [
    { columns: 0, rows: 0 },
    { columns: -10, rows: -5 },
    { columns: Number.NaN, rows: Number.POSITIVE_INFINITY },
    { columns: 80, rows: 0 },
  ] as const) {
    const layout = chooseLayout(size);
    if (size.columns === 80) {
      assert.equal(layout.width, 80);
      assert.equal(layout.height, DEFAULT_ROWS);
    } else {
      assert.equal(layout.width, DEFAULT_COLUMNS);
      assert.equal(layout.height, DEFAULT_ROWS);
    }
    assert.equal(layout.kind, "narrow");
    assert.equal(layout.columns, 1);
  }
});

test("fractional sizes are floored, and thresholds sit on exact boundaries", () => {
  assert.equal(chooseLayout({ columns: 100.9, rows: 24.9 }).width, 100);
  assert.equal(chooseLayout({ columns: 100.9, rows: 24.9 }).kind, "wide");
  assert.equal(chooseLayout({ columns: 99.9, rows: 21 }).kind, "narrow");
  assert.equal(chooseLayout({ columns: 80, rows: 20.9 }).kind, "short");
  assert.equal(chooseLayout({ columns: 80, rows: 21 }).kind, "narrow");
});

function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 25);
  return promise;
}

test("useViewport renders the current terminal size through chooseLayout", async () => {
  const observed: string[] = [];
  const captured: {
    stdout: { emit(event: string): boolean } | undefined;
  } = { stdout: undefined };

  function StdoutCapture() {
    const { stdout } = useStdout();
    captured.stdout = stdout as unknown as {
      emit(event: string): boolean;
    };
    return null;
  }

  function ViewportProbe() {
    const layout = useViewport();
    const current = `${layout.kind}:${layout.columns}:${layout.compact}`;
    if (observed.at(-1) !== current) {
      observed.push(current);
    }
    return (
      <Box>
        <Text>{observed.at(-1)}</Text>
      </Box>
    );
  }

  const view = render(
    <Box>
      <StdoutCapture />
      <ViewportProbe />
    </Box>,
  );
  try {
    // Pin the size before sampling: ink-testing-library's mock stdout
    // has no rows property, so ink falls back to the REAL terminal
    // (COLUMNS/LINES included) and the "initial" layout would depend
    // on whatever terminal ran the suite.
    if (captured.stdout === undefined) {
      throw new Error("mock stdout was not captured");
    }
    const stdout = captured.stdout;
    const resizeTo = (columns: number, rows: number): void => {
      Object.defineProperty(stdout, "columns", {
        value: columns,
        configurable: true,
      });
      Object.defineProperty(stdout, "rows", {
        value: rows,
        configurable: true,
      });
      stdout.emit("resize");
    };
    // A single resize emit can be LOST while the useWindowSize effect
    // is still subscribing, so re-emit until the probe observed the
    // expected layout string.
    const resizeUntil = async (
      columns: number,
      rows: number,
      expected: string,
    ): Promise<void> => {
      for (let attempt = 0; attempt < 50; attempt++) {
        resizeTo(columns, rows);
        if (observed.at(-1) === expected) {
          return;
        }
        await tick();
      }
      throw new Error(
        `viewport never settled at ${expected} (last: ${observed.at(-1)})`,
      );
    };
    await resizeUntil(100, 24, "wide:2:false");
    assert.ok(observed.length >= 1, "hook produced at least one layout");
    const initial = observed.at(-1);
    assert.ok(initial !== undefined);
    assert.match(initial, /^(wide|narrow|short):[12]:(true|false)$/);
    assert.ok(view.lastFrame()?.includes(initial));
    const initialLayout = chooseLayout({ columns: 100, rows: 24 });
    assert.equal(initialLayout.kind, "wide");
    assert.equal(observed.at(-1), "wide:2:false");

    await resizeUntil(WIDE_MIN_COLUMNS - 20, 24, "narrow:1:false");
    assert.equal(
      observed.at(-1),
      "narrow:1:false",
      "shrinking the terminal transitions the live layout to narrow",
    );
    assert.ok(view.lastFrame()?.includes("narrow:1:false"));
    // Back up: the layout must follow the terminal again.
    await resizeUntil(WIDE_MIN_COLUMNS, 24, "wide:2:false");
    assert.equal(observed.at(-1), "wide:2:false");

    // Tall-but-short terminals must also transition live.
    await resizeUntil(WIDE_MIN_COLUMNS, SHORT_MAX_ROWS, "short:1:true");
    assert.equal(observed.at(-1), "short:1:true");
  } finally {
    view.unmount();
  }
});
