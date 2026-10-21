import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle, writeDoc, readDoc } from "@superbee/core";
import { newCommand } from "../src/commands/new.js";
import { doc } from "../src/commands/doc.js";
import { kinds } from "../src/commands/kinds.js";
import { status } from "../src/commands/status.js";
import { link } from "../src/commands/link.js";
import { CliError } from "../src/errors.js";
import { deprecationConvention, widget } from "../../core/test/fixtures/kind-deprecation-rows.js";

async function json(cmd: (args: string[], deps: { stdout: (s: string) => void }) => Promise<void>, args: string[]): Promise<any> {
  let output = ""; await cmd([...args, "--json"], { stdout: s => { output += s; } }); return JSON.parse(output);
}
const refuse = (action: Promise<unknown>) => assert.rejects(action, (e: unknown) => e instanceof CliError && /deprecated/.test(e.message));

test("CLI deprecation journey: metadata, new, lenient/strict writes, preserved legacy patch and links", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-deprecation-"));
  try {
    await initBundle(dir, { okfVersion: "0.2" }); const bundle = { root: dir };
    await writeDoc(bundle, deprecationConvention);
    await writeDoc(bundle, widget({ legacy: "old", category: "old" }, "[legacy_link](two.md)"));
    await writeDoc(bundle, { ...widget(), id: "widgets/two" });
    const metadata = await json(kinds, ["--dir", dir]);
    assert.deepEqual(metadata.kinds[0].deprecated.fields, ["legacy"]);
    await refuse(json(newCommand, ["Widget", "widgets/copy", "--title", "Copy", "--legacy", "old", "--dir", dir]));
    for (const strict of [false, true]) await refuse(json(doc, ["write", `widgets/new-${strict}`, "--type", "Widget", "--title", "New", "--body", "[legacy_link](two.md)", ...(strict ? ["--strict"] : []), "--dir", dir]));
    await json(doc, ["update", "widgets/one", "--title", "Edited", "--dir", dir]);
    assert.equal((await readDoc(bundle, "widgets/one")).frontmatter.legacy, "old");
    await refuse(json(doc, ["update", "widgets/one", "--legacy", "changed", "--dir", dir]));
    await refuse(json(link, ["add", "widgets/one", "widgets/three", "--text", "legacy_link", "--dir", dir]));
    await json(link, ["add", "widgets/one", "widgets/two", "--text", "active_link", "--dir", dir]);
    const health = await json(status, ["--dir", dir]);
    assert.equal(health.deprecated_usage, 3);
    assert.equal(health.kind_warnings, 0);
    assert.equal(health.conformance_debt, 0);
    await json(doc, ["update", "widgets/one", "--body", "[active_link](two.md)", "--replace-links", "--dir", dir]);
    assert.equal((await json(status, ["--dir", dir])).deprecated_usage, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
