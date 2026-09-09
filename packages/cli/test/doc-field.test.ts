import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { decode } from "@toon-format/toon";
import { parseCommandLine } from "./support/rendered-command.js";
import { join } from "node:path";
import { initBundle, writeDoc, readDocVersioned } from "@superbee/core";
import { doc } from "../src/commands/doc.js";
import { CliError } from "../src/errors.js";

async function fixture(t: test.TestContext, edition: "0.1" | "0.2" = "0.2") {
  const root = await mkdtemp(join(tmpdir(), "superbee-fields-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "bundle");
  const bundle = await initBundle(dir, { okfVersion: edition });
  await writeDoc(bundle, { id: "notes/a", frontmatter: { type: "Note", title: "Original", tags: ["old"], sources: [{ resource: "report one", extra: "keep" }, { id: "two", resource: "report two" }] }, body: "Keep this body.\n" });
  const run = async (...args: string[]) => {
    let output = "";
    await doc(["field", ...args, "--dir", dir, "--json"], { stdout: text => { output += text; }, readStdin: async () => { throw new Error("field must never probe stdin"); } });
    return JSON.parse(output);
  };
  const file = async (text: string, name = "input.yaml") => { const p = join(root, name); await writeFile(p, text); return p; };
  return { run, file, bundle, dir };
}
const usage = (err: unknown) => err instanceof CliError && err.code === "USAGE";

test("doc field static family and leaf help requires no document or bundle", async () => {
  for (const action of [undefined, "set", "add", "remove", "edit", "replace-all"]) {
    let output = "";
    await doc(["field", ...(action ? [action] : []), "--help"], { stdout: text => { output += text; } });
    assert.match(output, action ? new RegExp(`doc field ${action}`) : /doc field/);
  }
});

test("doc field rejects malformed channels before bundle or file access", async () => {
  const rows = [
    ["set"], ["set", "notes/a", "title", "a", "b"],
    ["set", "notes/a", "title", "a", "--from-file", "/missing"],
    ["set", "notes/a", "title"], ["set", "notes/a", "title", "--from-file", ""],
    ["set", "notes/a", "title", "a", "--id", "x"],
    ["set", "notes/a", "title", "a", "--actor", "process:a", "--actor", "process:b"],
    ["edit", "notes/a", "sources", "--id", "x", "--from-file", "/missing"],
    ["edit", "notes/a", "sources", "--expected-version", "v", "--from-file", "/missing"],
    ["remove", "notes/a", "sources", "--id", "x", "--resource", "x"],
    ["replace-all", "notes/a", "tags", "--from-file", "/missing"],
    ["remove", "notes/a", "sources", "literal", "--id", "x"],
    ["set", "notes/a", "title", "a", "--expected-version", ""],
  ];
  for (const row of rows) await assert.rejects(doc(["field", ...row]), usage, row.join(" "));
});

test("doc field tag membership preserves body and siblings, no-op preserves version and clock", async t => {
  const f = await fixture(t);
  const added = await f.run("add", "notes/a", "tags", "a,b");
  assert.equal(added.changed, true);
  assert.equal(added.scope.outcome, "added");
  const before = await readDocVersioned(f.bundle, "notes/a");
  const repeat = await f.run("add", "notes/a", "tags", "a,b");
  assert.equal(repeat.changed, false);
  assert.equal(repeat.version, added.version);
  assert.deepEqual(await readDocVersioned(f.bundle, "notes/a"), before);
  await assert.rejects(f.run("add", "notes/a", "tags", "a,b", "--expected-version", "stale"), err => err instanceof CliError && err.code === "STALE_HEAD");
  const removed = await f.run("remove", "notes/a", "tags", "old");
  const empty = await f.file("[]");
  await f.run("replace-all", "notes/a", "tags", "--from-file", empty, "--expected-version", removed.version);
  const after = await readDocVersioned(f.bundle, "notes/a");
  assert.deepEqual(after.doc.frontmatter.tags, []);
  assert.deepEqual(after.doc.frontmatter.sources, before.doc.frontmatter.sources);
  assert.equal(after.doc.body, before.doc.body);
});

test("doc field sources support JSON/YAML add, first-ID edit, and exact empty-ID remove", async t => {
  const f = await fixture(t);
  const input = await f.file('{"id":"","resource":"empty id report"}', "source.json");
  const added = await f.run("add", "notes/a", "sources", "--from-file", input);
  const patch = await f.file("id: first\nresource: changed report\n");
  const edited = await f.run("edit", "notes/a", "sources", "--resource", "report one", "--from-file", patch, "--expected-version", added.version);
  assert.deepEqual(edited.scope.affectedSourceIds, ["first"]);
  await f.run("remove", "notes/a", "sources", "--id", "");
  const { doc: result } = await readDocVersioned(f.bundle, "notes/a");
  assert.deepEqual(result.frontmatter.sources, [{ id: "first", resource: "changed report", extra: "keep" }, { id: "two", resource: "report two" }]);
  assert.equal(result.body, "Keep this body.\n");
});

test("doc field validates complete file values and finite field surface", async t => {
  const f = await fixture(t);
  for (const contents of ["", "[", "---\na: 1\n---\nb: 2"]) {
    await assert.rejects(f.run("set", "notes/a", "title", "--from-file", await f.file(contents)), usage);
  }
  for (const field of ["unknown", "generated", "tags"]) {
    await assert.rejects(f.run("set", "notes/a", field, "x"), err => usage(err) && Boolean((err as CliError).help));
  }
  await assert.rejects(f.run("add", "notes/a", "arbitrary", "x"), usage);
  await f.run("set", "notes/a", "usage_window", "--from-file", await f.file("from: 2026-09-01T00:00:00Z"));
});

test("doc field redirects use exact quoted ID and ambiguity carries bounded candidates", async t => {
  const f = await fixture(t);
  const key = "owner's report $(literal)";
  await f.run("add", "notes/a", "sources", "--from-file", await f.file(JSON.stringify({ id: key, resource: "special report" })));
  let correction = "";
  await assert.rejects(f.run("remove", "notes/a", "sources", "--resource", "special report"), err => {
    assert.ok(err instanceof CliError);
    assert.equal(err.details?.reason, "source-has-id");
    assert.deepEqual(err.details?.recommendedSelector, { id: key });
    assert.ok(err.help?.includes("--id="));
    correction = err.help!;
    return true;
  });
  const corrected = parseCommandLine(correction);
  const docIndex = corrected.indexOf("doc");
  await doc(corrected.slice(docIndex + 1), { stdout: () => {} });
  const remaining = (await readDocVersioned(f.bundle, "notes/a")).doc.frontmatter.sources;
  assert.ok(Array.isArray(remaining));
  assert.ok(!remaining.some((row: { id?: string }) => row.id === key));
  for (let i = 0; i < 7; i++) await f.run("add", "notes/a", "sources", "--from-file", await f.file(JSON.stringify({ id: `duplicate-${i}`, resource: "same resource" })));
  await assert.rejects(f.run("remove", "notes/a", "sources", "--resource", "same resource"), err => {
    assert.ok(err instanceof CliError);
    assert.equal(err.details?.reason, "ambiguous-source");
    assert.equal(err.details?.total, 7);
    assert.equal((err.details?.candidates as unknown[]).length, 5);
    assert.doesNotMatch(err.help!, /position|index/);
    return true;
  });
});

test("doc field set preserves standard warning posture and strictly validates Kind fields", async t => {
  const f = await fixture(t);
  await writeDoc(f.bundle, { id: "conventions/note", frontmatter: { type: "Convention", governs: "Note", fields: { required: ["summary"], optional: ["priority"], values: { priority: ["low", "high"] } } }, body: "" });
  assert.equal((await f.run("set", "notes/a", "title", "changed")).changed, true);
  await assert.rejects(f.run("set", "notes/a", "priority", "wrong"), usage);
  await f.run("set", "notes/a", "summary", "complete");
  await f.run("set", "notes/a", "priority", "high");
});

test("built field leaves have static help and bounded arity outside a bundle", async t => {
  const root = await mkdtemp(join(tmpdir(), "superbee-fields-help-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(import.meta.dirname, "../dist/superbee.mjs");
  for (const action of ["set", "add", "remove", "edit", "replace-all"]) {
    const help = spawnSync(process.execPath, [cli, "doc", "field", action, "--help"], { cwd: root, encoding: "utf8" });
    assert.equal(help.status, 0, help.stdout + help.stderr);
    assert.match(help.stdout, new RegExp(`doc field ${action}`));
    const surplus = spawnSync(process.execPath, [cli, "doc", "field", action, "notes/a", "tags", "one", "surplus"], { cwd: root, encoding: "utf8" });
    assert.equal(surplus.status, 2, surplus.stdout + surplus.stderr);
    assert.equal((decode(surplus.stdout) as { error: { code: string } }).error.code, "USAGE");
  }
});

test("doc field accepts dash-leading literals after the option terminator", async t => {
  const f = await fixture(t);
  let result = "";
  await doc(["field", "add", "notes/a", "tags", "--dir", f.dir, "--json", "--", "--literal"], { stdout: text => { result += text; } });
  assert.equal(JSON.parse(result).changed, true);
  assert.deepEqual((await readDocVersioned(f.bundle, "notes/a")).doc.frontmatter.tags, ["old", "--literal"]);
});

test("doc field unsupported names expose current edition and Kind fields from core", async t => {
  const f = await fixture(t);
  await writeDoc(f.bundle, { id: "conventions/note", frontmatter: { type: "Convention", governs: "Note", fields: { required: [], optional: ["summary", "generated", "tags"] } }, body: "" });
  await assert.rejects(f.run("set", "notes/a", "unknown", "value"), err => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "USAGE");
    assert.equal(err.details?.reason, "unsupported-set-field");
    const supported = err.details?.supportedFields;
    assert.ok(Array.isArray(supported));
    for (const field of ["title", "resource", "status", "usage_window", "summary"]) assert.ok(supported.includes(field), field);
    for (const field of ["generated", "tags", "sources"]) assert.ok(!supported.includes(field), field);
    assert.ok(err.help?.endsWith("doc field set --help"));
    return true;
  });
  const legacy = await fixture(t, "0.1");
  await assert.rejects(legacy.run("set", "notes/a", "unknown", "value"), err => {
    assert.ok(err instanceof CliError);
    const supported = err.details?.supportedFields;
    assert.ok(Array.isArray(supported));
    assert.ok(supported.includes("resource"));
    assert.ok(!supported.includes("usage_window"));
    assert.ok(!supported.includes("stale_after"));
    return true;
  });
});

test("doc field read hints retain an explicit local route when executed outside the bundle", async t => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "superbee-field-hint-cwd-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const hints: string[] = [];
  const added = await f.run("add", "notes/a", "tags", "new");
  hints.push(added.help[0]);
  await assert.rejects(f.run("add", "notes/a", "tags", "new", "--expected-version", "stale"), err => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "STALE_HEAD");
    hints.push(err.help!);
    return true;
  });
  await f.run("add", "notes/a", "sources", "--from-file", await f.file(JSON.stringify({ id: "duplicate", resource: "report one" })));
  await assert.rejects(f.run("remove", "notes/a", "sources", "--resource", "report one"), err => {
    assert.ok(err instanceof CliError);
    assert.equal(err.details?.reason, "ambiguous-source");
    hints.push(err.help!);
    return true;
  });
  for (const hint of hints) {
    const argv = parseCommandLine(hint);
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "../dist/superbee.mjs"), ...argv.slice(argv.indexOf("doc"))], { cwd: outside, encoding: "utf8" });
    assert.equal(result.status, 0, `${hint}\n${result.stdout}${result.stderr}`);
    assert.ok(argv.includes(`--dir=${f.dir}`), hint);
    assert.match(result.stdout, /report one/);
  }
});

test("doc field read hints share the explicit remote option shape", async t => {
  const { serve } = await import("@superbee/server");
  const f = await fixture(t);
  const server = await serve({ bundle: f.bundle, port: 0 });
  t.after(() => server.close());
  const remote = `http://${server.host}:${server.port}`;
  let output = "";
  await doc(["field", "add", "notes/a", "tags", "remote-tag", "--remote", remote, "--json"], { stdout: text => { output += text; } });
  const receipt = JSON.parse(output);
  const argv = parseCommandLine(receipt.help[0]);
  assert.ok(argv.includes(`--remote=${remote}`));
  assert.ok(!argv.some(arg => arg.startsWith("--dir")));
  let read = "";
  await doc(argv.slice(argv.indexOf("doc") + 1), { stdout: text => { read += text; } });
  assert.match(read, /remote-tag/);
});
