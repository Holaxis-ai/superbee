import assert from "node:assert/strict";
import test from "node:test";

import { MalformedDocumentError } from "../src/frontmatter-contract.js";
import { splitLeadingFrontmatter } from "../src/frontmatter-splitter.js";

test("splitLeadingFrontmatter normalizes one BOM and preserves a second", () => {
  assert.deepEqual(splitLeadingFrontmatter("plain\n"), { body: "plain\n" });
  assert.deepEqual(splitLeadingFrontmatter("\uFEFFplain\n"), { body: "plain\n" });
  assert.deepEqual(splitLeadingFrontmatter("\uFEFF\uFEFF---\ntype: Note\n---\nbody\n"), {
    body: "\uFEFF---\ntype: Note\n---\nbody\n",
  });
});

test("splitLeadingFrontmatter extracts exact LF, CRLF, mixed, and EOF delimiters", () => {
  const cases = [
    {
      name: "LF",
      raw: "---\ntype: Note\n---\nbody\n",
      expected: { yamlSource: "type: Note\n", body: "body\n" },
    },
    {
      name: "CRLF",
      raw: "---\r\ntype: Note\r\n---\r\nbody\r\n",
      expected: { yamlSource: "type: Note\r\n", body: "body\r\n" },
    },
    {
      name: "mixed line endings",
      raw: "---\r\ntype: Note\n---\r\n\nbody\r\n",
      expected: { yamlSource: "type: Note\n", body: "\nbody\r\n" },
    },
    {
      name: "closing delimiter at EOF",
      raw: "---\ntype: Note\n---",
      expected: { yamlSource: "type: Note\n", body: "" },
    },
    {
      name: "empty payload and body",
      raw: "---\n---",
      expected: { yamlSource: "", body: "" },
    },
  ] as const;

  for (const entry of cases) {
    assert.deepEqual(splitLeadingFrontmatter(entry.raw), entry.expected, entry.name);
  }
});

test("splitLeadingFrontmatter treats non-exact opening lines as body text", () => {
  const openings = [
    "---yaml\ntype: Note\n---\nbody",
    "--- \ntype: Note\n---\nbody",
    "---\t\ntype: Note\n---\nbody",
    "---\r",
    "---\u2028type: Note\n---\nbody",
  ];
  for (const raw of openings) {
    assert.deepEqual(splitLeadingFrontmatter(raw), { body: raw }, JSON.stringify(raw));
  }
});

test("splitLeadingFrontmatter ignores pseudo-closing lines until an exact close", () => {
  const pseudoClosers = ["---suffix\n", "--- \n", "---\t\n", "---\u2028suffix\n"];
  for (const pseudoClose of pseudoClosers) {
    const raw = `---\n${pseudoClose}---\nbody`;
    assert.deepEqual(
      splitLeadingFrontmatter(raw),
      { yamlSource: pseudoClose, body: "body" },
      JSON.stringify(pseudoClose),
    );
  }
});

test("splitLeadingFrontmatter rejects an opening delimiter without an exact close", () => {
  for (const raw of ["---", "---\n", "---\r\nvalue\n--- ", "---\nvalue\n---\r", "---\nvalue\n---\u2028"]) {
    assert.throws(
      () => splitLeadingFrontmatter(raw, "notes/missing.md"),
      (error: unknown) => {
        assert.ok(error instanceof MalformedDocumentError);
        assert.equal(error.context, "notes/missing.md");
        assert.match(error.detail, /unterminated YAML frontmatter delimiter/);
        assert.ok(error.cause instanceof Error);
        return true;
      },
      JSON.stringify(raw),
    );
  }
});
