import test from "node:test";
import assert from "node:assert/strict";

import { MemoryBackend, type Bundle } from "@superbee/core";
import { conceptIdFromCliArgument, resolveConceptIdCliArgument } from "../src/concept-id.js";

const T = "2026-08-01T00:00:00.000Z";

test("CLI concept-id ingress normalizes path-like aliases before the canonical seam", () => {
  for (const alias of ["./a/b.md", "a//b.md", "a\\b.md", "a/./b.md"]) {
    assert.equal(conceptIdFromCliArgument(alias), "a/b");
  }
  assert.equal(conceptIdFromCliArgument("a/b.md.md"), "a/b.md");
});

test("CLI .md resolution prefers a real canonical id, otherwise preserves the path alias", async () => {
  const backend = new MemoryBackend();
  const bundle: Bundle = { root: "mem://cli-id", backend };

  assert.equal(await resolveConceptIdCliArgument(bundle, "concepts/x.md"), "concepts/x");

  await backend.write("concepts/x", {
    id: "concepts/x",
    frontmatter: { type: "T", timestamp: T },
    body: "physical x.md",
  });
  assert.equal(await resolveConceptIdCliArgument(bundle, "concepts/x.md"), "concepts/x");

  await backend.write("concepts/x.md", {
    id: "concepts/x.md",
    frontmatter: { type: "T", timestamp: T },
    body: "physical x.md.md",
  });
  assert.equal(await resolveConceptIdCliArgument(bundle, "concepts/x.md"), "concepts/x.md");
  assert.equal(await resolveConceptIdCliArgument(bundle, "concepts/x.md.md"), "concepts/x.md");
});

test("leading ./ is an unambiguous physical-path escape across nested .md identities", async () => {
  const backend = new MemoryBackend();
  const bundle: Bundle = { root: "mem://physical-path", backend };

  await backend.write("concepts/x.md.md", {
    id: "concepts/x.md.md",
    frontmatter: { type: "T", timestamp: T },
    body: "physical concepts/x.md.md.md",
  });
  await backend.write("index.md.md", {
    id: "index.md.md",
    frontmatter: { type: "T", timestamp: T },
    body: "physical index.md.md.md",
  });

  assert.equal(await resolveConceptIdCliArgument(bundle, "concepts/x.md.md"), "concepts/x.md.md");
  assert.equal(await resolveConceptIdCliArgument(bundle, "./concepts/x.md.md"), "concepts/x.md");
  assert.equal(await resolveConceptIdCliArgument(bundle, "index.md.md"), "index.md.md");
  assert.equal(await resolveConceptIdCliArgument(bundle, "./index.md.md"), "index.md");
});

test("kind prefixes participate in .md ambiguity resolution", async () => {
  const backend = new MemoryBackend();
  const bundle: Bundle = { root: "mem://prefix", backend };
  await backend.write("tasks/x.md", {
    id: "tasks/x.md",
    frontmatter: { type: "T", timestamp: T },
    body: "physical tasks/x.md.md",
  });

  assert.equal(await resolveConceptIdCliArgument(bundle, "x.md", { prefix: "tasks/" }), "tasks/x.md");
  assert.equal(await resolveConceptIdCliArgument(bundle, "tasks/x.md", { prefix: "tasks/" }), "tasks/x.md");
  assert.equal(await resolveConceptIdCliArgument(bundle, "y.md", { prefix: "tasks/" }), "tasks/y");
});
