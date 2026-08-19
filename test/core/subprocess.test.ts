import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSubprocessPort,
  SubprocessError,
} from "../../src/core/subprocess.js";

const port = createSubprocessPort();
const NODE = process.execPath;

function runFailure(promise: Promise<unknown>): Promise<SubprocessError> {
  return promise.then(
    () => assert.fail("expected the run to fail"),
    (error: unknown) => {
      assert.ok(
        error instanceof SubprocessError,
        "rejects with SubprocessError",
      );
      return error;
    },
  );
}

test("successful runs return raw stdout and stderr", async () => {
  const result = await port.run(NODE, [
    "-e",
    "process.stdout.write('out-part'); process.stderr.write('err-part')",
  ]);
  assert.equal(result.stdout, "out-part");
  assert.equal(result.stderr, "err-part");
});

test("failure messages never include stdout material", async () => {
  const error = await runFailure(
    port.run(NODE, [
      "-e",
      "console.log('SECRET-STDOUT-VALUE'); process.exit(3)",
    ]),
  );
  assert.equal(error.code, "failed");
  assert.equal(error.exitCode, 3);
  assert.ok(!error.message.includes("SECRET-STDOUT-VALUE"));
  assert.ok(!error.stderrPreview.includes("SECRET-STDOUT-VALUE"));
});

test("stderr previews redact bearer and keyed secret values", async () => {
  const error = await runFailure(
    port.run(NODE, [
      "-e",
      "console.error('token Bearer eyJhbGciOiJIUzI1Ni.paid.payload leaked'); process.exit(1)",
    ]),
  );
  assert.equal(error.code, "failed");
  assert.ok(error.message.includes("[REDACTED]"), "token replaced");
  assert.ok(!error.message.includes("eyJhbGciOiJIUzI1Ni"));
  assert.ok(!error.stderrPreview.includes("paid.payload"));
});

test("stderr previews are bounded", async () => {
  const error = await runFailure(
    port.run(NODE, ["-e", "console.error('e'.repeat(2_000)); process.exit(1)"]),
  );
  assert.ok(
    error.stderrPreview.length <= 400,
    `got ${error.stderrPreview.length}`,
  );
});

test("oversize stdout is classified outputTooLarge", async () => {
  const error = await runFailure(
    port.run(NODE, ["-e", "process.stdout.write('x'.repeat(50_000))"], {
      maxOutputBytes: 4_096,
    }),
  );
  assert.equal(error.code, "outputTooLarge");
  assert.ok(error.message.includes("4"), "mentions the cap");
});

test("oversize stderr is classified outputTooLarge", async () => {
  const error = await runFailure(
    port.run(NODE, ["-e", "process.stderr.write('y'.repeat(50_000))"], {
      maxOutputBytes: 4_096,
    }),
  );
  assert.equal(error.code, "outputTooLarge");
});

test("running a missing binary is classified spawn", async () => {
  const error = await runFailure(
    port.run("definitely-not-a-real-binary-xyz", ["--version"]),
  );
  assert.equal(error.code, "spawn");
});

test("timeouts are classified timeout and kill the child", async () => {
  const error = await runFailure(
    port.run(NODE, ["-e", "setTimeout(() => {}, 60_000)"], {
      timeoutMs: 100,
    }),
  );
  assert.equal(error.code, "timeout");
  assert.ok(error.message.includes("100 ms"));
});

test("negative or NaN timeouts are ignored instead of firing immediately", async () => {
  const result = await port.run(NODE, ["-e", "process.stdout.write('ok')"], {
    timeoutMs: -1,
  });
  assert.equal(result.stdout, "ok");

  const nanResult = await port.run(
    NODE,
    ["-e", "process.stdout.write('ok2')"],
    {
      timeoutMs: Number.NaN,
    },
  );
  assert.equal(nanResult.stdout, "ok2");
});

test("non-positive or NaN maxOutputBytes falls back to the default cap", async () => {
  const zero = await port.run(NODE, ["-e", "process.stdout.write('fine')"], {
    maxOutputBytes: 0,
  });
  assert.equal(zero.stdout, "fine");

  const nan = await port.run(NODE, ["-e", "process.stdout.write('fine2')"], {
    maxOutputBytes: Number.NaN,
  });
  assert.equal(nan.stdout, "fine2");

  const negative = await port.run(
    NODE,
    ["-e", "process.stdout.write('fine3')"],
    {
      maxOutputBytes: -5,
    },
  );
  assert.equal(negative.stdout, "fine3");
});

test("a pre-aborted signal rejects before spawning", async () => {
  const controller = new AbortController();
  controller.abort();
  const error = await runFailure(
    port.run(NODE, ["-e", "process.stdout.write('never')"], {
      signal: controller.signal,
    }),
  );
  assert.equal(error.code, "aborted");
});

test("envRemove strips keys from the inherited environment", async () => {
  const result = await port.run(
    NODE,
    ["-e", "process.stdout.write(process.env.FUEL_TEST_LEAK ?? 'missing')"],
    {
      envRemove: ["FUEL_TEST_LEAK"],
      env: { ...process.env, FUEL_TEST_LEAK: "zzz" },
    },
  );
  assert.equal(result.stdout, "missing");
});
