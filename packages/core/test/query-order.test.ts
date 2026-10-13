import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  compareByMeaningfulChange,
  meaningfulChangeOrderKey,
  sortByMeaningfulChange,
  type MeaningfulChangeOrderKey,
} from "../src/query-order.js";

const key = (id: string, timestampMs: number | null): MeaningfulChangeOrderKey => ({ id, timestamp: "", timestampMs });

test("newer parsed time sorts first; missing and invalid times follow every timed row", () => {
  assert.ok(compareByMeaningfulChange(key("a", 2), key("b", 1)) < 0);
  assert.ok(compareByMeaningfulChange(key("a", 1), key("b", 2)) > 0);
  assert.ok(compareByMeaningfulChange(key("z", 0), key("a", null)) < 0, "epoch zero is a real time");
  assert.ok(compareByMeaningfulChange(key("a", null), key("z", -1)) > 0, "pre-epoch times are real times");
});

test("ties break by canonical ID in code-unit order, not locale order", () => {
  for (const ms of [5, null]) {
    assert.ok(compareByMeaningfulChange(key("Zeta", ms), key("alpha", ms)) < 0, "uppercase precedes lowercase");
    assert.ok(compareByMeaningfulChange(key("a-b", ms), key("a_b", ms)) < 0, "'-' (0x2D) precedes '_' (0x5F)");
    assert.ok(compareByMeaningfulChange(key("f", ms), key("é", ms)) < 0, "U+00E9 follows ASCII");
    assert.equal(compareByMeaningfulChange(key("same", ms), key("same", ms)), 0);
  }
  assert.ok("alpha".localeCompare("Zeta") < 0, "the case this guards: locale order disagrees");
});

test("the order key reads generated.at, else timestamp, under the bundle edition", () => {
  assert.deepEqual(meaningfulChangeOrderKey("x", { generated: { at: "2026-09-08T10:00:00Z" }, timestamp: "2000-01-01T00:00:00Z" }, "0.2"),
    { id: "x", timestamp: "2026-09-08T10:00:00Z", timestampMs: Date.UTC(2026, 8, 8, 10) });
  assert.deepEqual(meaningfulChangeOrderKey("x", { timestamp: "2026-09-08T10:00:00Z" }), {
    id: "x", timestamp: "2026-09-08T10:00:00Z", timestampMs: Date.UTC(2026, 8, 8, 10),
  });
  assert.deepEqual(meaningfulChangeOrderKey("x", {}, "0.2"), { id: "x", timestamp: "", timestampMs: null });
  assert.deepEqual(meaningfulChangeOrderKey("x", { generated: { at: "bad" }, timestamp: "2026-09-08T10:00:00Z" }, "0.2"),
    { id: "x", timestamp: "bad", timestampMs: null }, "a present but invalid generated.at shadows the legacy clock");
  assert.equal(meaningfulChangeOrderKey("x", { timestamp: 1_000 }, "0.2").timestampMs, null, "v0.2 needs an ISO string");
  assert.equal(meaningfulChangeOrderKey("x", { timestamp: 1_000 }, "0.1").timestampMs, 1_000);
  assert.equal(meaningfulChangeOrderKey("x", { timestamp: 1_000 }, null).timestampMs, 1_000, "null edition is legacy");
  assert.equal(meaningfulChangeOrderKey("x", { timestamp: 1_000 }).timestamp, "", "non-string clocks expose no raw text");
});

test("sortByMeaningfulChange returns a new array and leaves its input alone", () => {
  const rows = [
    { id: "b", frontmatter: { timestamp: "2026-01-01T00:00:00Z" } },
    { id: "a", frontmatter: { timestamp: "2026-02-01T00:00:00Z" } },
  ];
  const sorted = sortByMeaningfulChange(rows, "0.2");
  assert.deepEqual(sorted.map((row) => row.id), ["a", "b"]);
  assert.deepEqual(rows.map((row) => row.id), ["b", "a"]);
  assert.equal(sorted[0], rows[1], "rows are returned by reference, not copied");
});

interface FixtureCase {
  name: string;
  okfVersion: string;
  rows: Array<{ id: string; frontmatter: Record<string, unknown> }>;
  expected: string[];
}

const fixture = JSON.parse(readFileSync(
  new URL("../../view-runtime/test/fixtures/query-newest-order.json", import.meta.url),
  "utf8",
)) as { cases: FixtureCase[] };

for (const row of fixture.cases) {
  test(`shared newest-order fixture: ${row.name}`, () => {
    assert.deepEqual(sortByMeaningfulChange(row.rows, row.okfVersion).map((r) => r.id), row.expected);
    assert.deepEqual(sortByMeaningfulChange([...row.rows].reverse(), row.okfVersion).map((r) => r.id), row.expected,
      "the order is total: input order never leaks through");
  });
}
