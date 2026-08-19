import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as defer } from "node:timers/promises";
import {
  ConfirmInput,
  PasswordInput,
  Select,
  Spinner,
  TextInput,
} from "@inkjs/ui";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";

function CompanionControls() {
  return (
    <Box flexDirection="column">
      <Text>Text</Text>
      <TextInput placeholder="text placeholder" />
      <Text>Password</Text>
      <PasswordInput placeholder="password placeholder" />
      <Text>Select</Text>
      <Select options={[{ label: "First option", value: "first" }]} />
      <Text>Confirm</Text>
      <ConfirmInput onCancel={() => undefined} onConfirm={() => undefined} />
      <Spinner label="Loading quotas" />
    </Box>
  );
}
const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(
  `${ESCAPE}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${BELL}]*${BELL}|${BELL})`,
  "g",
);

/**
 * Removes ANSI styling. Focus lands asynchronously, so the captured
 * frame may or may not carry the TextInput cursor's reverse-video
 * escape around the first placeholder character — assertions must not
 * depend on which frame won the race. The pattern is built from char
 * codes because the linter rejects control-character literals.
 */
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
test("@inkjs/ui companion controls render with Ink 7 and React 19", async () => {
  const view = render(<CompanionControls />);

  try {
    await defer();
    const frame = stripAnsi(view.lastFrame() ?? "");

    assert.match(frame, /text placeholder/);
    assert.match(frame, /password placeholder/);
    assert.match(frame, /First option/);
    assert.match(frame, /Confirm/);
    assert.match(frame, /Loading quotas/);
  } finally {
    view.unmount();
  }
});
