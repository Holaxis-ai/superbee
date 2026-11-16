import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parseLinksFromDoc } from "../src/links.js";
import { compareRelationshipPositions, groupRelationshipOccurrences } from "../src/relationships.js";

test("indexed groups keep authored hrefs and ordinals and distinguish full labels", () => {
  const prefix = "A".repeat(256);
  const first = prefix + "a";
  const second = prefix + "b";
  const links = parseLinksFromDoc({
    id: "notes/source",
    frontmatter: {},
    body: `[${first}](target.md) [Self](source.md) [${first}](./target.md) [${second}](target.md) [Broken](missing.md)`,
  });
  const groups = groupRelationshipOccurrences(links);
  assert.deepEqual(groups.map(({ target, label, occurrences }) => ({ target, label, occurrences })), [
    { target: "notes/target", label: first, occurrences: [[0, "target.md"], [2, "./target.md"]] },
    { target: "notes/source", label: "Self", occurrences: [[1, "source.md"]] },
    { target: "notes/target", label: second, occurrences: [[3, "target.md"]] },
    { target: "notes/missing", label: "Broken", occurrences: [[4, "missing.md"]] },
  ]);
  assert.notEqual(groups[0]?.labelKey, groups[2]?.labelKey);
  assert.equal(groups[0]?.labelKey, `sha256:${createHash("sha256").update(first).digest("hex")}`);
});

test("relationship positions seek in direction, binary document ID, then label key order", () => {
  const incoming = { direction: "incoming" as const };
  const positions = [
    { direction: "outgoing" as const, documentId: "a", labelKey: "sha256:a" },
    { ...incoming, documentId: "notes/\u{1F600}", labelKey: "sha256:a" },
    { ...incoming, documentId: "notes/\uE000", labelKey: "sha256:b" },
    { ...incoming, documentId: "notes/\uE000", labelKey: "sha256:a" },
    { ...incoming, documentId: "notes", labelKey: "sha256:b" },
  ];
  assert.deepEqual([...positions].sort(compareRelationshipPositions), [...positions].reverse());
  assert.equal(compareRelationshipPositions(positions[1]!, { ...positions[1]! }), 0);
});
