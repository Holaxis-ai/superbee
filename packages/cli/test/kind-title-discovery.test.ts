import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildKindRegistry, initBundle, readDoc, writeDoc } from "@superbee/core";
import { newCommand } from "../src/commands/new.js";
import { kinds } from "../src/commands/kinds.js";
import { list } from "../src/commands/list.js";
import { doc } from "../src/commands/doc.js";
import { CliError } from "../src/errors.js";
import { kindTitleCandidates } from "../src/kind-title-candidates.js";

const selectors = ["github.com/101/research/Decision", "github.com/202/home/Decision"];
const convention = (governs: string, i: number) => ({
  id: `conventions/decision-${i}`,
  frontmatter: { type: "Convention", governs, title: "Decision", fields: { required: ["title", "reason"] } },
  body: "",
});
async function fixture(bare = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "kind-title-discovery-"));
  await initBundle(dir, { okfVersion: "0.2" });
  for (const [i, selector] of selectors.entries()) await writeDoc({ root: dir }, convention(selector, i));
  if (bare) await writeDoc({ root: dir }, convention("Decision", 3));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
async function run(command: (argv: string[], deps: { stdout: (s: string) => void }) => Promise<void>, args: string[]) {
  let stdout = "";
  await command([...args, "--json"], { stdout: (s) => { stdout += s; } });
  return JSON.parse(stdout);
}

test("bare new refuses with exact candidates; discovery and explicit creation keep exact identity", async () => {
  const f = await fixture();
  try {
    await assert.rejects(run(newCommand, ["Decision", "decisions/refused", "--title", "No alias", "--dir", f.dir]), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "USAGE");
      const details = error.details?.kind_candidates as { candidates: { governs: string }[] };
      assert.deepEqual(details.candidates.map((row) => row.governs), selectors);
      return true;
    });
    await assert.rejects(readDoc({ root: f.dir }, "decisions/refused"));
    const empty = await run(list, ["--type", "Decision", "--dir", f.dir]);
    assert.equal(empty.count, 0);
    assert.equal(empty.kind_candidates.total, 2);
    const discovery = await run(kinds, ["--dir", f.dir]);
    assert.deepEqual(discovery.kinds.map((kind: { title: string; governs: string }) => [kind.title, kind.governs]), selectors.map((selector) => ["Decision", selector]));
    const receipt = await run(newCommand, [selectors[1]!, "decisions/exact", "--title", "Chosen", "--reason", "Exact selector", "--dir", f.dir]);
    assert.equal(receipt.type, selectors[1]);
    assert.equal((await readDoc({ root: f.dir }, "decisions/exact")).frontmatter.type, selectors[1]);
  } finally { await f.cleanup(); }
});

test("generic bare write stays ungoverned even with strict; list never broadens a bare type", async () => {
  const f = await fixture();
  try {
    await writeDoc({ root: f.dir }, { id: "decisions/qualified", frontmatter: { type: selectors[0]!, title: "Qualified", reason: "Required by schema" }, body: "" });
    const receipt = await run(doc, ["write", "decisions/legacy", "--type", "Decision", "--title", "Bare historical type", "--body", "Unchanged", "--strict", "--dir", f.dir]);
    assert.equal(receipt.type, "Decision");
    const warning = receipt.warnings.find((w: { code: string }) => w.code === "KIND_TYPE_UNDECLARED");
    assert.match(warning.message, /ungoverned.*schemas.*were not used/);
    assert.deepEqual(warning.details.kind_candidates.candidates.map((row: { governs: string }) => row.governs), selectors);
    const before = await readFile(path.join(f.dir, "decisions/legacy.md"));
    const result = await run(list, ["--type", "Decision", "--dir", f.dir]);
    assert.equal(result.count, 1);
    assert.equal(result.docs[0].id, "decisions/legacy");
    assert.deepEqual(result.kind_candidates.candidates.map((row: { governs: string }) => row.governs), selectors);
    assert.match(result.help.join(" "), /were not searched/);
    assert.deepEqual(await readFile(path.join(f.dir, "decisions/legacy.md")), before);
    const exact = await run(list, ["--type", selectors[0]!, "--dir", f.dir]);
    assert.equal(exact.count, 1);
    assert.equal(exact.docs[0].id, "decisions/qualified");
    assert.equal(exact.kind_candidates, undefined);
  } finally { await f.cleanup(); }
});

test("a declared bare Kind remains valid beside identical qualified titles", async () => {
  const f = await fixture(true);
  try {
    const receipt = await run(newCommand, ["Decision", "decisions/bare", "--title", "Bare", "--reason", "Declared", "--dir", f.dir]);
    assert.equal(receipt.type, "Decision");
    const listed = await run(list, ["--type", "Decision", "--dir", f.dir]);
    assert.equal(listed.count, 1);
    assert.equal(listed.kind_candidates, undefined);
    const written = await run(doc, ["write", "decisions/generic", "--type", "Decision", "--title", "Missing required reason", "--body", "", "--dir", f.dir]);
    assert.ok(written.warnings.some((w: { code: string }) => w.code === "KIND_FIELD_MISSING"));
    assert.ok(!written.warnings.some((w: { details?: { kind_candidates?: unknown } }) => w.details?.kind_candidates));
  } finally { await f.cleanup(); }
});

test("candidate disclosure is bounded, exact and deterministic without title aliases", () => {
  const docs = Array.from({ length: 25 }, (_, i) => convention(`github.com/${100 + i}/sample/Decision`, i));
  const registry = buildKindRegistry([...docs].reverse());
  const found = kindTitleCandidates(registry, "Decision")!;
  assert.equal(found.total, 25);
  assert.equal(found.shown, 20);
  assert.deepEqual(found.candidates.map((row) => row.governs), docs.slice(0, 20).map((doc) => doc.frontmatter.governs));
  assert.equal(kindTitleCandidates(buildKindRegistry([docs[0]!]), "Decision")?.total, 1);
  assert.equal(kindTitleCandidates(registry, "decision"), undefined);
  assert.equal(kindTitleCandidates(registry, " Decision "), undefined);
  assert.equal(kindTitleCandidates(registry, docs[0]!.frontmatter.governs), undefined);
  assert.equal(kindTitleCandidates(buildKindRegistry([...docs, convention("Decision", 30)]), "Decision"), undefined);
});
