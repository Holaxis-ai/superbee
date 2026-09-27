import test from "node:test";
import assert from "node:assert/strict";

import { escapeHostJson, stripHostControls, stripHostData, stripHostText } from "../src/index.js";

test("host text: control and format characters stripped, trimmed, cut only between whole characters", () => {
  assert.equal(stripHostText("\u001b[31mRed\u001b[0m name", 100), "[31mRed[0m name");
  assert.equal(stripHostText("admin‮gpj.exe", 100), "admingpj.exe");
  assert.equal(stripHostText("zero​width⁦", 100), "zerowidth");
  assert.equal(stripHostText("  spaced \t", 100), "spaced");
  assert.equal(stripHostText("ab😀cd", 3), "ab", "never half a surrogate pair");
  assert.equal(stripHostText("ab😀cd", 4), "ab😀");
  assert.equal(stripHostText("\u0007​", 10), "");
});

/** Host data with C0, C1, bidi, zero-width, line-separator and tag characters in keys and values. */
const HOSTILE = {
  "k\u202eey\u009b": "v\u202e\u009b31m\u200bz\u001b[0m\u2028",
  nested: [{ "\u{E0041}tag": "line\nkept\ttab" }, 7, null, true],
  ["__proto__"]: "own key",
};

test("host data: escapeHostJson leaves no raw control or format character and parses back to the host's data", () => {
  const data = JSON.parse(JSON.stringify(HOSTILE)) as unknown;
  const text = escapeHostJson(JSON.stringify(data));
  assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u);
  assert.deepEqual(JSON.parse(text), data);
  assert.match(text, /\\u202e/);
  assert.match(text, /\\udb40\\udc41/, "an astral format character is escaped as its two surrogates");
});

test("host data: stripHostData removes control and format characters from keys and strings, keeps tab and newline, and says so", () => {
  const data = JSON.parse(JSON.stringify(HOSTILE)) as unknown;
  const { value, removed } = stripHostData(data);
  assert.equal(removed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), { key: "v31mz[0m", nested: [{ tag: "line\nkept\ttab" }, 7, null, true], ["__proto__"]: "own key" });
  assert.equal(Object.getPrototypeOf(value), Object.prototype, "a __proto__ key stays an own key");
  assert.deepEqual(stripHostData({ a: ["plain"] }), { value: { a: ["plain"] }, removed: false });
  // Two keys that collide once stripped keep the first; the drop counts as removed.
  assert.deepEqual(stripHostData({ ab: 1, "a\u200bb": 2 }), { value: { ab: 1 }, removed: true });
  assert.equal(stripHostControls("a\u0007\tb\r\n"), "a\tb\r\n");
  // Deep nesting is walked without recursion.
  let deep: unknown = "\u202e";
  for (let level = 0; level < 100_000; level += 1) deep = [deep];
  assert.equal(stripHostData(deep).removed, true);
});
