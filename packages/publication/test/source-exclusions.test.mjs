import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicationSourceExclusions, PublicationError } from "../dist/index.js";

const policy = { directories: ["agent-notes"], types: ["Agent Note"] };
const source = (documents = [], reserved = [], blobs = []) => ({ documents, reserved, blobs });

test("source exclusions inspect normalized paths, types and nested lists without redaction", () => {
  const rows = [
    source([{ id: "Agent-Notes/secret", frontmatter: { type: "Note" } }]),
    source([{ id: "ＡＧＥＮＴ－ＮＯＴＥＳ/secret", frontmatter: { type: "Note" } }]),
    source([{ id: "notes/secret", frontmatter: { type: " agent   NOTE " } }]),
    source([{ id: "notes/secret", frontmatter: { type: [["Note"], ["Agent Note"]] } }]),
    source([], [{ dir: "Agent-Notes", name: "index.md" }]),
    source([], [], [{ key: "Agent-Notes/secret.bin" }]),
  ];
  for (const row of rows) {
    const before = structuredClone(row);
    assert.throws(() => assertPublicationSourceExclusions(row, policy), (error) => error instanceof PublicationError && error.code === "INVALID_BUNDLE" && error.details.excludedEntries === 1 && error.subject === undefined);
    assert.deepEqual(row, before);
  }
});

test("root names, conventions and unrelated nested paths remain eligible", () => {
  const eligible = source([
    { id: "agent-notes", frontmatter: { type: "Note" } },
    { id: "conventions/agent-note", frontmatter: { type: "Convention", governs: "Agent Note" } },
    { id: "notes/agent-notes/one", frontmatter: { type: ["Note"] } },
  ], [{ dir: "", name: "index.md" }], [{ key: "assets/photo.png" }]);
  assert.doesNotThrow(() => assertPublicationSourceExclusions(eligible, policy));
  assert.doesNotThrow(() => assertPublicationSourceExclusions(eligible, {}));
  assert.throws(() => assertPublicationSourceExclusions(eligible, { directories: ["a/b"] }), PublicationError);
});
