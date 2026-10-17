/**
 * `bundleKindFindings`, the one rule for the Kind problems a strict host write would refuse: the
 * scenarios of superbee-hosted's kind-conformance suite and the CLI publish preview's, at the
 * function level, on OKF v0.1 and v0.2.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  bundleKindFindings,
  bundleKindRegistry,
  documentKindFinding,
  isRegistryConvention,
} from "../src/bundle-health/index.js";
import { OkfActorError } from "../src/errors.js";
import { parseMarkdown } from "../src/frontmatter.js";
import type { OkfDocument } from "../src/types.js";

const task: OkfDocument = {
  id: "conventions/task",
  frontmatter: { type: "Convention", governs: "Task", fields: { required: ["owner"] } },
  body: "# Task\n",
};
const ready: OkfDocument = { id: "tasks/ready", frontmatter: { type: "Task", title: "Ready", owner: "ada" }, body: "x\n" };
const unowned: OkfDocument = { id: "tasks/unowned", frontmatter: { type: "Task", title: "Unowned" }, body: "x\n" };
const plain: OkfDocument = { id: "notes/plain", frontmatter: { title: "Plain" }, body: "" };

/** A document as a host stores it: written, then parsed back. */
function stored(id: string, text: string): OkfDocument {
  return { id, ...parseMarkdown(text, id) };
}

test("kind findings: a bundle checked in parts, against the registry its conventions alone build, finds what the whole-bundle check finds", () => {
  // The identity superbee-hosted's wrapper passes: the creating person, and the host as producer.
  const write = { actor: "person:ada", producer: "process:superbee-hosted" };
  for (const conventions of [[task], [task, { ...task, id: "conventions/task-again" }]]) {
    const documents = [...conventions, ready, unowned, plain];
    const whole = bundleKindFindings(documents, "0.2", write);
    const registry = bundleKindRegistry(conventions, "0.2");
    const found = [documents.slice(0, 2), documents.slice(2)].flatMap((part) =>
      part.flatMap((doc) => documentKindFinding(doc, registry, "0.2", write) ?? []),
    );
    assert.deepEqual({ conventions: registry.warnings, documents: found }, whole);
    assert.equal(whole.conventions.length, conventions.length - 1);
  }
  assert.deepEqual(bundleKindFindings([task, ready, unowned, plain], "0.2", write).documents.map((d) => d.id), ["tasks/unowned"]);
});

test("kind findings: a value of the wrong declared type is found, with core's sentence and the violation codes", () => {
  const convention = { ...task, frontmatter: { ...task.frontmatter, fields: { required: ["owner"], types: { owner: "number" } } } };
  const invalid = { ...ready, frontmatter: { ...ready.frontmatter, owner: "not a number" } };
  const write = { actor: "person:ada", producer: "process:superbee-hosted" };
  const { documents } = bundleKindFindings([convention, invalid], "0.2", write);
  assert.equal(documents.length, 1);
  assert.equal(documents[0]!.governs, "Task");
  assert.ok(documents[0]!.violations.some((warning) => warning.code === "KIND_FIELD_TYPE"));
  assert.match(documents[0]!.message, /^'tasks\/ready' does not satisfy the 'Task' kind: /);
  assert.deepEqual(bundleKindFindings([convention, { ...ready, frontmatter: { ...ready.frontmatter, owner: 4 } }], "0.2", write).documents, []);
});

test("kind findings: the publish preview scenario on v0.1 and v0.2 (a write supplies actor and timestamp; unowned and numeric-title documents are found; broken and duplicate conventions warn)", () => {
  const convention = "---\ntype: Convention\ngoverns: Task\nfields:\n  required:\n    - owner\n    - actor\n    - timestamp\n---\n# Task\n";
  const write = { actor: "person:publish-preview", producer: "process:superbee-hosted" };
  for (const okfVersion of ["0.1", "0.2"] as const) {
    const clean = bundleKindFindings(
      [stored("conventions/task", convention), stored("tasks/ready", "---\ntype: Task\ntitle: Ready\nowner: ada\n---\nx\n")],
      okfVersion,
      write,
    );
    assert.deepEqual(clean, { conventions: [], documents: [] }, `a ready document is clean on ${okfVersion}`);

    const documents = [
      stored("conventions/broken", "---\ntype: Convention\n---\n# No governs\n"),
      stored("conventions/task", convention),
      stored("conventions/task-again", convention),
      stored("tasks/numeric", "---\ntype: Task\ntitle: 5\n---\nx\n"),
      stored("tasks/ready", "---\ntype: Task\ntitle: Ready\nowner: ada\n---\nx\n"),
      stored("tasks/unowned", "---\ntype: Task\ntitle: Unowned\n---\nx\n"),
    ];
    const found = bundleKindFindings(documents, okfVersion, write);
    assert.deepEqual(found.conventions.map((warning) => [warning.code, warning.field]), [
      ["KIND_CONVENTION_MALFORMED", "conventions/broken"],
      ["KIND_DUPLICATE_GOVERNS", "Task"],
    ]);
    assert.deepEqual(found.documents.map((finding) => finding.id), ["tasks/numeric", "tasks/unowned"]);
    assert.match(found.documents[1]!.message, /'tasks\/unowned' does not satisfy the 'Task' kind: .*owner/);
  }
});

test("kind findings: only a Convention under conventions/ builds the registry", () => {
  assert.equal(isRegistryConvention(task), true);
  assert.equal(isRegistryConvention({ ...task, id: "notes/task" }), false);
  assert.equal(isRegistryConvention({ ...task, frontmatter: { ...task.frontmatter, type: "Note" } }), false);
  assert.deepEqual([...bundleKindRegistry([{ ...task, id: "notes/task" }, ready], "0.2").kinds.keys()], []);
});

test("kind findings: the producer defaults to the actor, and a producer that is not an OKF actor is refused, never hidden", () => {
  const withProducer = bundleKindFindings([task, ready, unowned], "0.2", { actor: "human:ada", producer: "process:host" });
  const withoutProducer = bundleKindFindings([task, ready, unowned], "0.2", { actor: "human:ada" });
  assert.deepEqual(withProducer, withoutProducer, "attribution never changes what a Kind refuses");
  assert.deepEqual(withoutProducer.documents.map((finding) => finding.id), ["tasks/unowned"]);
  // Without a producer the actor is the v0.2 producer, so an actor that cannot be one throws.
  assert.throws(() => bundleKindFindings([task, ready], "0.2", { actor: "person:ada" }), (error: unknown) => error instanceof OkfActorError);
});
