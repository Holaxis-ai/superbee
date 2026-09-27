import test from "node:test";
import assert from "node:assert/strict";

import { stripHostText } from "../src/index.js";

test("host text: control and format characters stripped, trimmed, cut only between whole characters", () => {
  assert.equal(stripHostText("\u001b[31mRed\u001b[0m name", 100), "[31mRed[0m name");
  assert.equal(stripHostText("admin‮gpj.exe", 100), "admingpj.exe");
  assert.equal(stripHostText("zero​width⁦", 100), "zerowidth");
  assert.equal(stripHostText("  spaced \t", 100), "spaced");
  assert.equal(stripHostText("ab😀cd", 3), "ab", "never half a surrogate pair");
  assert.equal(stripHostText("ab😀cd", 4), "ab😀");
  assert.equal(stripHostText("\u0007​", 10), "");
});
