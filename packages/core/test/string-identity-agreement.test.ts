import test from "node:test";
import assert from "node:assert/strict";
import { compareCodeUnits, foldPath } from "../src/index.js";
import { findEntryCollision } from "../src/portable-export.js";
import { compareByMeaningfulChange } from "../src/query-order.js";
import { sortHeads } from "../src/heads-digest.js";
import { CODE_UNIT_ORDER, PATH_COLLISION_ROWS, PATH_FOLD_ROWS } from "../src/string-identity-agreement.js";

const hex = (value: string) => [...value].map((char) => char.codePointAt(0)!.toString(16)).join(" ");

for (const row of PATH_FOLD_ROWS) {
  test(`foldPath: ${row.note}`, () => {
    assert.equal(hex(foldPath(row.input)), hex(row.fold));
    assert.equal(foldPath(row.fold), row.fold, "the fold is idempotent");
  });
}

test("foldPath agrees with the collision rows, and the export check refuses exactly the colliding pairs", () => {
  for (const { a, b, collide } of PATH_COLLISION_ROWS) {
    assert.equal(foldPath(a) === foldPath(b), collide, `${hex(a)} vs ${hex(b)}`);
    assert.equal(findEntryCollision([`notes/${a}.md`, `notes/${b}.md`]) !== null, collide, `export entries ${hex(a)} vs ${hex(b)}`);
    assert.equal(findEntryCollision([`${a}/x.md`, `${b}/y.md`]) !== null, collide, `export folders ${hex(a)} vs ${hex(b)}`);
  }
});

test("compareCodeUnits sorts the agreement rows into code unit order from any start", () => {
  const shuffled = [...CODE_UNIT_ORDER].reverse();
  assert.deepEqual(shuffled.sort(compareCodeUnits), CODE_UNIT_ORDER);
  for (let i = 0; i < CODE_UNIT_ORDER.length; i += 1) {
    for (let j = 0; j < CODE_UNIT_ORDER.length; j += 1) {
      assert.equal(Math.sign(compareCodeUnits(CODE_UNIT_ORDER[i]!, CODE_UNIT_ORDER[j]!)), Math.sign(i - j), `${hex(CODE_UNIT_ORDER[i]!)} vs ${hex(CODE_UNIT_ORDER[j]!)}`);
    }
  }
});

test("the newest-first tie break and the heads digest order use the same code unit order", () => {
  const untimed = [...CODE_UNIT_ORDER].reverse().map((id) => ({ id, timestamp: "", timestampMs: null }));
  assert.deepEqual(untimed.sort(compareByMeaningfulChange).map((key) => key.id), CODE_UNIT_ORDER);
  const heads = [...CODE_UNIT_ORDER].reverse().map((id) => ({ id, version: "v" }));
  assert.deepEqual(sortHeads(heads).map((head) => head.id), CODE_UNIT_ORDER);
});
