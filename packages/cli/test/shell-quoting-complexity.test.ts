import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { renderWindowsToken } from "../src/shell-quoting.js";

// Enumerate small accepted inputs against the previous spelling contract. Keep this oracle
// bounded: its suffix expression is intentionally the historical implementation.
test("Windows token spelling preserves every short backslash placement", () => {
  const alphabet = ["a", "\\", " ", "'", "\u2028"];
  let values = [""];
  for (let length = 0; length <= 6; length++) {
    for (const value of values) {
      assert.equal(renderWindowsToken(value), `"${value.replace(/(\\+)$/, "$1$1")}"`);
    }
    values = values.flatMap(value => alphabet.map(character => value + character));
  }
});

// A separate process is necessary: a synchronous renderer blocks node:test's own timer.
// The input is large enough to expose repeated suffix rescans; the generous deadline includes
// process startup and avoids relying on a timing ratio or a particular machine's speed.
test("Windows token rendering completes for long internal and trailing backslash runs", () => {
  const source = new URL("../src/shell-quoting.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { renderWindowsToken } from ${JSON.stringify(source)};
    const run = "\\\\".repeat(250_000);
    for (const [value, expected] of [
      [run + "a", '"' + run + 'a"'],
      ["a" + run, '"a' + run + run + '"'],
      [run + "a" + run, '"' + run + 'a' + run + run + '"'],
    ]) assert.equal(renderWindowsToken(value), expected);
    assert.equal(renderWindowsToken(run + "%"), undefined);
  `], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});
