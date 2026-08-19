import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  confirmFirstSource,
  DiscoveryError,
  type DiscoverySource,
  envOverride,
  readJsonCredentialFile,
} from "../../src/core/discovery.js";

function never(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

const signal = () => new AbortController().signal;

test("confirmFirstSource resolves with the first winning candidate", async () => {
  const sources: DiscoverySource<string>[] = [
    {
      candidate: {
        provider: "codex",
        source: "file",
        label: "missing",
        path: "/gone/auth.json",
      },
      load: () => {
        throw new DiscoveryError(
          "NoCredentialFound",
          "Credential file not found: /gone/auth.json",
        );
      },
    },
    {
      candidate: {
        provider: "codex",
        source: "file",
        label: "winner",
        path: "/here/auth.json",
      },
      load: async () => "token-material",
    },
    {
      candidate: {
        provider: "codex",
        source: "file",
        label: "later",
        path: "/later/auth.json",
      },
      load: async () => "should-not-run",
    },
  ];
  const confirmed = await confirmFirstSource(sources, signal());
  assert.equal(confirmed.value, "token-material");
  assert.equal(confirmed.candidate.label, "winner");
});

test("confirmFirstSource reports the first typed failure with every tried path", async () => {
  const sources: DiscoverySource<string>[] = [
    {
      candidate: {
        provider: "codex",
        source: "file",
        label: "a",
        path: "/a.json",
      },
      load: () => {
        throw new DiscoveryError(
          "NoCredentialFound",
          "Credential file not found: /a.json",
        );
      },
    },
    {
      candidate: {
        provider: "codex",
        source: "file",
        label: "b",
        path: "/b.json",
      },
      load: () => {
        throw new DiscoveryError(
          "CorruptCredential",
          "Credential file is not valid JSON: /b.json",
        );
      },
    },
    {
      candidate: {
        provider: "codex",
        source: "file",
        label: "c",
        path: "/c.json",
      },
      load: () => {
        throw new DiscoveryError("EmptyCredential", "blank secret");
      },
    },
  ];
  await assert.rejects(
    confirmFirstSource(sources, signal()),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.code, "CorruptCredential");
      assert.deepEqual(error.triedPaths, ["/a.json", "/b.json", "/c.json"]);
      assert.match(
        error.message,
        /Credential file is not valid JSON: \/b\.json/,
      );
      assert.match(error.message, /Tried: \/a\.json, \/b\.json, \/c\.json/);
      return true;
    },
  );
});

test("confirmFirstSource yields NoCredentialFound when nothing existed", async () => {
  const sources: DiscoverySource<string>[] = [
    {
      candidate: {
        provider: "codex",
        source: "env",
        label: "GH_TOKEN environment variable",
        path: null,
      },
      load: () => {
        throw new DiscoveryError(
          "NoCredentialFound",
          "GH_TOKEN environment variable is unset",
        );
      },
    },
    {
      candidate: {
        provider: "codex",
        source: "file",
        label: "f",
        path: "/f.json",
      },
      load: () => {
        throw new DiscoveryError(
          "NoCredentialFound",
          "Credential file not found: /f.json",
        );
      },
    },
  ];
  await assert.rejects(
    confirmFirstSource(sources, signal()),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.code, "NoCredentialFound");
      assert.deepEqual(error.triedPaths, ["/f.json"]);
      return true;
    },
  );
});

test("confirmFirstSource propagates HomeUnavailable immediately", async () => {
  const sources: DiscoverySource<string>[] = [
    {
      candidate: {
        provider: "cursor",
        source: "sqlite",
        label: "db",
        path: "/db.vscdb",
      },
      load: () => {
        throw new DiscoveryError(
          "HomeUnavailable",
          "Could not locate home directory",
        );
      },
    },
    {
      candidate: {
        provider: "cursor",
        source: "sqlite",
        label: "second",
        path: "/2.vscdb",
      },
      load: async () => "unreachable",
    },
  ];
  await assert.rejects(
    confirmFirstSource(sources, signal()),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.code, "HomeUnavailable");
      return true;
    },
  );
});

test("confirmFirstSource aborts the walk on unexpected errors", async () => {
  const sources: DiscoverySource<string>[] = [
    {
      candidate: {
        provider: "cursor",
        source: "sqlite",
        label: "boom",
        path: "/boom.vscdb",
      },
      load: () => Promise.reject(new TypeError("network fell over")),
    },
    {
      candidate: {
        provider: "cursor",
        source: "sqlite",
        label: "next",
        path: "/next.vscdb",
      },
      load: async () => "unreachable",
    },
  ];
  await assert.rejects(
    confirmFirstSource(sources, signal()),
    (error: unknown) => error instanceof TypeError,
  );
});

test("envOverride trims, unwraps quotes, and drops empties", () => {
  assert.equal(envOverride({ CODEX_HOME: ' "/x/y" ' }, "CODEX_HOME"), "/x/y");
  assert.equal(envOverride({ CODEX_HOME: "  " }, "CODEX_HOME"), undefined);
  assert.equal(envOverride({}, "CODEX_HOME"), undefined);
  assert.equal(
    envOverride({ GEMINI_CLI_HOME: "'/home/g'" }, "GEMINI_CLI_HOME"),
    "/home/g",
  );
});

test("typed filesystem classification on real files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fuel-gauge-discovery-"));
  const lockedDir = path.join(dir, "locked");
  try {
    const corrupt = path.join(dir, "corrupt.json");
    await writeFile(corrupt, "{not json", "utf8");
    const empty = path.join(dir, "empty.json");
    await writeFile(empty, "   \n ", "utf8");
    const locked = path.join(lockedDir, "creds.json");
    await mkdir(lockedDir);
    await writeFile(locked, "{}", { mode: 0o000 });

    const expectCode = async (
      file: string,
      code:
        | "NoCredentialFound"
        | "CorruptCredential"
        | "EmptyCredential"
        | "SourceProtected",
    ) => {
      await assert.rejects(
        readJsonCredentialFile(file, signal()),
        (error: unknown) => {
          assert.ok(
            error instanceof DiscoveryError,
            `${file}: expected DiscoveryError`,
          );
          assert.equal(error.code, code, `${file}: expected ${code}`);
          return true;
        },
      );
    };

    await expectCode(path.join(dir, "missing.json"), "NoCredentialFound");
    await expectCode(corrupt, "CorruptCredential");
    await expectCode(empty, "EmptyCredential");
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await expectCode(locked, "SourceProtected");
    }
  } finally {
    await chmod(lockedDir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("aborted signal rejects the walk before any load", async () => {
  const controller = new AbortController();
  controller.abort();
  const sources: DiscoverySource<string>[] = [
    {
      candidate: {
        provider: "codex",
        source: "file",
        label: "x",
        path: "/x.json",
      },
      load: (loadSignal) => never(loadSignal),
    },
  ];
  await assert.rejects(confirmFirstSource(sources, controller.signal));
});
