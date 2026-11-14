import assert from "node:assert/strict";
import { test } from "node:test";

import {
  documentLinkReport,
  inspectDocumentLinks,
  linkTargetAbsentFinding,
  linkTypeFinding,
  type LinkTargetReader,
} from "../src/link-findings.js";
import { parseLinksFromDoc } from "../src/links.js";
import type { KindConvention, KindRegistry } from "../src/kinds.js";
import type { OkfDocument } from "../src/types.js";

const doc = (id: string, body: string, type = "Note"): OkfDocument => ({ id, frontmatter: { type, title: id }, body });
const store = (...docs: OkfDocument[]): LinkTargetReader => {
  const byId = new Map(docs.map((d) => [d.id, d]));
  return async (id) => byId.get(id);
};
const kindWithLinks = (governs: string, links: Record<string, string>): KindConvention => ({
  id: `conventions/${governs.toLowerCase()}`,
  title: governs,
  governs,
  fields: { required: [], optional: [], values: {}, terminal: {}, descriptions: {} },
  links,
});
const registryOf = (...kinds: KindConvention[]): KindRegistry => ({ kinds: new Map(kinds.map((k) => [k.governs, k])), warnings: [] });

test("inspectDocumentLinks returns exactly parseLinksFromDoc's edges and names what did not register", () => {
  const body = [
    "[ok](/notes/b.md) and [rel](./c.md) and [web](https://example.com/x) and [pdf](files/spec.pdf)",
    "[no ext](notes/b) and [[notes/b|the b note]] and [idx](/index.md) and [anchor](#top)",
    "`[[in code]]` and ![img](pic) and [bad](/a/../../.md)",
  ].join("\n");
  const source = doc("notes/a", body);
  const report = inspectDocumentLinks(source);
  assert.deepEqual(report.links, parseLinksFromDoc(source));
  assert.deepEqual(
    report.findings.map((f) => [f.code, (f.details as { reason?: string }).reason, (f.details as { href?: string }).href]),
    [
      ["LINK_NOT_RECOGNIZED", "missing-md-extension", "notes/b"],
      ["LINK_NOT_RECOGNIZED", "wikilink", "notes/b"],
      ["LINK_NOT_RECOGNIZED", "reserved-target", "/index.md"],
      ["LINK_NOT_RECOGNIZED", "invalid-target", "/a/../../.md"],
    ],
  );
  const [missing, wiki] = report.findings as Array<{ details: Record<string, unknown>; message: string; field?: string }>;
  assert.equal(missing!.details.suggestedHref, "notes/b.md");
  assert.equal(missing!.details.suggestedTo, "notes/notes/b", "a bare relative target resolves from the source folder");
  assert.equal(wiki!.details.text, "the b note");
  assert.equal(wiki!.details.suggestedHref, "/notes/b.md");
  assert.equal(wiki!.details.suggestedTo, "notes/b");
  assert.equal(body.slice(wiki!.details.start as number, wiki!.details.end as number), "[[notes/b|the b note]]");
  for (const finding of report.findings) {
    assert.equal(finding.field, "body");
    assert.equal(finding.severity, "warning");
    assert.doesNotMatch(finding.message, /notes\/b/, "messages are fixed per code; values live in details");
  }
});

test("documentLinkReport adds absent targets with a root-absolute suggestion for a bare relative href", async () => {
  const source = doc("notes/a", "[bare](notes/b.md) then [missing](/notes/zzz.md) then [no ext](notes/b)");
  const report = await documentLinkReport(source, { readTarget: store(doc("notes/b", "")) });
  assert.deepEqual(report.links.map((l) => l.to), ["notes/notes/b", "notes/zzz"]);
  assert.deepEqual(
    report.findings.map((f) => f.code),
    ["LINK_TARGET_ABSENT", "LINK_TARGET_ABSENT", "LINK_NOT_RECOGNIZED"],
  );
  const [bare, missing, noExt] = report.findings.map((f) => f.details as Record<string, unknown>);
  assert.equal(bare!.suggestedHref, "/notes/b.md");
  assert.equal(bare!.suggestedTo, "notes/b");
  assert.equal(missing!.suggestedHref, undefined, "a root-absolute href has no other reading");
  assert.equal(noExt!.suggestedHref, "/notes/b.md", "re-pointed at the reading that exists");
  assert.equal(noExt!.suggestedTo, "notes/b");
});

test("documentLinkReport reads each distinct target once and lints link types only with a registry", async () => {
  const reads: string[] = [];
  const target = doc("tasks/t", "", "Task");
  const readTarget: LinkTargetReader = async (id) => {
    reads.push(id);
    return id === target.id ? target : undefined;
  };
  const source = doc("epics/e", "[contains](/tasks/t.md) [contains](/tasks/t.md) [Contains](/tasks/t.md)", "Epic");
  const registry = registryOf(kindWithLinks("Epic", { contains: "Story" }));
  const without = await documentLinkReport(source, { readTarget });
  assert.deepEqual(without.findings, []);
  const report = await documentLinkReport(source, { readTarget, registry });
  assert.deepEqual(reads, ["tasks/t", "tasks/t"], "one read per report");
  assert.deepEqual(report.findings.map((f) => f.code), ["LINK_TYPE_VIOLATION", "LINK_TYPE_VIOLATION", "LINK_TYPE_CASE_VARIANT"]);
  assert.deepEqual(report.findings[0]!.details, {
    text: "contains", to: "tasks/t", start: 0, end: 23,
    declaredBy: "Epic", declaredTarget: "Story", sourceType: "Epic", targetType: "Task",
  });
  assert.deepEqual(report.findings[2]!.details, { text: "Contains", to: "tasks/t", start: 48, end: 71, declaredText: "contains" });
});

test("linkTypeFinding: unresolved targets check the source only; qualified declarations name the alias", async () => {
  const registry = registryOf(kindWithLinks("Epic", { contains: "Task" }), kindWithLinks("Pub", { pours: "beers:Beer" }));
  const none = store();
  assert.equal(await linkTypeFinding(registry, { sourceType: "Epic", text: "contains", to: "x" }, none), undefined);
  const wrongSource = await linkTypeFinding(registry, { sourceType: "Note", text: "contains", to: "x" }, none);
  assert.equal(wrongSource!.code, "LINK_TYPE_VIOLATION");
  assert.equal((wrongSource!.details as { targetType: unknown }).targetType, null);
  const qualified = await linkTypeFinding(registry, { sourceType: "Pub", text: "pours", to: "x" }, none);
  assert.equal((qualified!.details as { targetAlias?: string }).targetAlias, "beers");
  assert.equal(await linkTypeFinding(registry, { sourceType: "Epic", text: "relates", to: "x" }, async () => {
    throw new Error("untyped text must not read the target");
  }), undefined);
});

test("linkTargetAbsentFinding propagates read failures other than absence", async () => {
  assert.equal(await linkTargetAbsentFinding({ to: "a" }, store(doc("a", ""))), undefined);
  assert.deepEqual((await linkTargetAbsentFinding({ to: "b" }, store()))!.details, { to: "b" });
  await assert.rejects(linkTargetAbsentFinding({ to: "c" }, async () => {
    throw new Error("backend down");
  }), /backend down/);
});

test("suggestions are dropped when they still would not register, and lifted to the root when they climb above it", () => {
  const report = inspectDocumentLinks(doc("notes/a", "[[Some Page]] and [[ok-page]] and [up](../../../tasks/t)"));
  const details = report.findings.map((f) => f.details as Record<string, unknown>);
  assert.equal(details[0]!.reason, "wikilink");
  assert.equal(details[0]!.suggestedHref, undefined, "a target with a space cannot be a link target");
  assert.equal(details[1]!.suggestedHref, "/ok-page.md");
  assert.equal(details[2]!.reason, "missing-md-extension");
  assert.equal(details[2]!.suggestedHref, "/tasks/t.md");
  assert.equal(details[2]!.suggestedTo, "tasks/t");
});

test("link-shaped text inside code is not reported, while edges inside code stay edges", () => {
  const body = "```\n[x](notes/b)\n[y](/notes/c.md)\n```\n`[z](notes/d)` and [w](notes/e)\n";
  const source = doc("notes/a", body);
  const report = inspectDocumentLinks(source);
  assert.deepEqual(report.links, parseLinksFromDoc(source));
  assert.deepEqual(report.links.map((l) => l.to), ["notes/c"]);
  assert.deepEqual(report.findings.map((f) => (f.details as { href: string }).href), ["notes/e"]);
});

test("a stray [ before a link: edges agree with parseLinksFromDoc and a near miss after code is still reported", () => {
  const bodies = [
    "see `a[0]` and [Task](/tasks/x.md)",
    "see `a[` and [Task](/tasks/x.md)",
    "see `a[` and\n\n[Task](/tasks/x.md)",
    "```\nx = [\n```\n\n[Task](/tasks/x.md)",
    "an open [ bracket then [Task](/tasks/x.md)",
    "an open [ bracket\n\nlater [Task](/tasks/x.md)",
    "\\[ escaped then [Task](/tasks/x.md)",
    "![ stray then [Task](/tasks/x.md)",
    "[ stray then ![pic](/tasks/x.md)",
    "[a [b] c](/tasks/x.md)",
    "[see `x[` y](/tasks/x.md)",
    "`a[` then [see `x[` y](/tasks/x.md)",
    "an open [ bracket then `[a](/tasks/x.md)`",
    "item [3 of the list\n\n```\n[reviews](/tasks/x.md)\n```",
  ];
  for (const body of bodies) {
    const source = doc("notes/a", body);
    const report = inspectDocumentLinks(source);
    assert.deepEqual(report.links, parseLinksFromDoc(source), body);
  }
  const body = "see `a[` and [Task](tasks/x)";
  const [finding] = inspectDocumentLinks(doc("notes/a", body)).findings;
  assert.equal((finding?.details as { reason?: string } | undefined)?.reason, "missing-md-extension");
  const { start, end } = finding!.details as { start: number; end: number };
  assert.equal(body.slice(start, end), "[Task](tasks/x)");
  const inText = "[see `x[` y](tasks/x)";
  const [codeInText] = inspectDocumentLinks(doc("notes/a", inText)).findings;
  assert.equal((codeInText?.details as { reason?: string } | undefined)?.reason, "missing-md-extension");
  assert.equal((codeInText!.details as { text: string }).text, "see `x[` y");
});

test("offsets are UTF-16 code units", () => {
  const body = "é😀 [x](notes/b)";
  const [finding] = inspectDocumentLinks(doc("notes/a", body)).findings;
  assert.equal(body.slice(finding!.details.start!, finding!.details.end!), "[x](notes/b)");
  assert.equal(finding!.details.start, 4);
});
