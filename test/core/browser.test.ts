import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrowserPort } from "../../src/core/browser.js";

const SECRET_URL =
  "https://example.com/oauth?code=SUPERSECRET&state=xyz&token=leak-me";

function failingOpener(url: string): Promise<never> {
  // Mimics open@11, whose rejections echo the offending URL verbatim.
  return Promise.reject(new Error(`Failed to open: ${url}`));
}

test("empty and blank URLs are refused without touching the OS", async () => {
  const port = createBrowserPort(failingOpener);
  const empty = await port.open("");
  assert.equal(empty.launched, false);
  assert.equal(empty.error, "No URL to open.");

  const blank = await port.open("   ");
  assert.equal(blank.launched, false);
  assert.equal(blank.error, "No URL to open.");
});

test("launch failures carry constant, token-free text", async () => {
  const port = createBrowserPort(failingOpener);
  const result = await port.open(SECRET_URL);

  assert.equal(result.launched, false);
  assert.equal(result.error, "Browser could not be launched.");
  assert.ok(!result.error.includes("SUPERSECRET"));
  assert.ok(!result.error.includes("leak-me"));
  assert.ok(!result.error.includes("example.com"));
  // The secret-bearing URL survives only in `url` for the manual fallback.
  assert.equal(result.url, SECRET_URL);
});

test("non-Error rejections collapse to the same constant text", async () => {
  const port = createBrowserPort(() => Promise.reject("nope" as never));
  const result = await port.open(SECRET_URL);
  assert.equal(result.launched, false);
  assert.equal(result.error, "Browser could not be launched.");
});

test("a successful launch reports launched without any error field", async () => {
  const port = createBrowserPort(async () => undefined);
  const result = await port.open("https://example.com/");
  assert.equal(result.launched, true);
  assert.equal(result.error, undefined);
});
