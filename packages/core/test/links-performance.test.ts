import assert from "node:assert/strict";
import test from "node:test";
import { maskMarkdownCode } from "../src/links.js";

// Measure production code before mutation instrumentation adds coverage probes to its loops.
test("maskMarkdownCode stays linear on hostile backtick runs", () => {
  let hostile = "";
  for (let run = 1; run < 2000; run++) hostile += "`".repeat(run) + "x";
  const started = performance.now();
  maskMarkdownCode(hostile.repeat(4));
  assert.ok(performance.now() - started < 2000, "masking hostile backtick runs should be linear");
});
