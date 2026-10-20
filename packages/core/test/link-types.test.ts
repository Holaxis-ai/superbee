import test from "node:test";
import assert from "node:assert/strict";
import { qualifiedEdgeViolation } from "../src/link-types.js";
import { QUALIFIED_EDGE_CASES } from "./fixtures/qualified-edge-cases.js";

for (const row of QUALIFIED_EDGE_CASES) test(`qualified typed edge: ${row.name}`, () => {
  const before = JSON.stringify(row);
  const result = qualifiedEdgeViolation(row.declared, row.source, row.alias, row.actual);
  assert.equal(result !== null, row.violation);
  if (result) assert.equal(result.governs, row.declared.find(d => d.governs === row.source)?.governs ?? row.declared[0].governs);
  assert.equal(JSON.stringify(row), before);
});


test("qualified typed edge: wrong-Kind regression kills target-check removal", async () => {
  const { readFile } = await import("node:fs/promises");
  const sourceUrl = new URL("../dist/link-types.js", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const before = "(actualTargetType === undefined || actualTargetType === target.kind)";
  assert.equal(source.split(before).length, 2, "one owning target check");
  const mutant = source.replace(before, "true").replace(/from (["'])(\.\.?\/[^"']+)\1/g,
    (_all, quote, specifier) => `from ${quote}${new URL(specifier, sourceUrl).href}${quote}`);
  const changed = await import("data:text/javascript;base64," + Buffer.from(mutant).toString("base64"));
  const row = QUALIFIED_EDGE_CASES.find(r => r.name === "wrong actual Kind")!;
  assert.notEqual(qualifiedEdgeViolation(row.declared, row.source, row.alias, row.actual), null);
  assert.equal(changed.qualifiedEdgeViolation(row.declared, row.source, row.alias, row.actual), null);
});
