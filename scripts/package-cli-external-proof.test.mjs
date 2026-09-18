import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { before } from "node:test";
import { embeddedEngineRecord } from "../packages/cli/scripts/embedded-engine.mjs";
import { embeddedEngineErrors, embeddedInventory, workspaceManifests, treeFacts, proveCliTarball } from "./cli-library-proof.mjs";
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const readJson = async file => JSON.parse(await readFile(file, "utf8"));

// The record describes the tree it was built from; build here so the record and HEAD agree.
before(async () => {
  const npm = process.env.npm_execpath;
  assert.ok(npm, "run through npm test:scripts or npm exec");
  await exec(process.execPath, [npm, "run", "build", "-w", "@superbee/cli"], { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
});

test("workspace directories and lock links follow package identities", async () => {
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  for (const [directory, name] of [["cli", "@superbee/cli"], ["superbee", "superbee"]]) {
    const packagePath = `packages/${directory}`;
    const pkg = JSON.parse(await readFile(path.join(root, packagePath, "package.json"), "utf8"));
    assert.equal(pkg.name, name);
    assert.equal(lock.packages[packagePath].version, pkg.version);
    assert.equal(lock.packages[`node_modules/${name}`].resolved, packagePath);
    assert.equal(lock.packages[`node_modules/${name}`].link, true);
  }
});

test("packed reusable CLI is closed, inert on import, and binds commands to its executable", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-cli-pack-"));
  try {
    const packed = await exec(process.execPath, [process.env.npm_execpath, "pack", "-w", "@superbee/cli", "--json", "--pack-destination", scratch], { cwd: root });
    const [receipt] = JSON.parse(packed.stdout);
    const tarball = path.join(scratch, receipt.filename);
    const execute = (command, args, options) => {
      if (args[0] === process.env.npm_execpath) assert.equal(args[1], "install", "retained proof must never build or pack");
      return exec(command, args, options);
    };
    const alias = path.join(scratch, "alias.tgz"); await symlink(tarball, alias);
    await assert.rejects(proveCliTarball(alias, { execute }), /regular file/);
    await assert.rejects(proveCliTarball(scratch, { execute }), /regular file/);
    await proveCliTarball(tarball, { execute });
    // The workspace remains good while a different retained artifact is submitted to the proof.
    const extracted = path.join(scratch, "extracted"); await mkdir(extracted);
    await exec("tar", ["-xzf", tarball, "-C", extracted]);
    const runtime = path.join(extracted, "package/dist/index.mjs");
    const original = await readFile(runtime);
    await writeFile(runtime, Buffer.concat([original, Buffer.from("\n// substituted retained runtime\n")]));
    const tampered = path.join(scratch, "tampered.tgz");
    await exec("tar", ["-czf", tampered, "-C", extracted, ...receipt.files.map(({ path: file }) => `package/${file}`)]);
    await assert.rejects(proveCliTarball(tampered, { execute }), /packed runtime differs/);
    await writeFile(runtime, original);
    const recordPath = path.join(extracted, "package/dist/embedded-engine.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.source.commit = "0".repeat(40); await writeFile(recordPath, JSON.stringify(record));
    await exec("tar", ["-czf", tampered, "-C", extracted, ...receipt.files.map(({ path: file }) => `package/${file}`)]);
    await assert.rejects(proveCliTarball(tampered, { execute }), /stale or fabricated/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
test("embedded engine check rejects an incomplete record, non-source engine inputs and foreign source facts", async () => {
  const manifestOf = await workspaceManifests();
  const head = treeFacts();
  const inventory = await embeddedInventory();
  const record = await readJson(path.join(root, "packages/cli/dist/embedded-engine.json"));
  assert.deepEqual(embeddedEngineErrors(record, inventory, manifestOf, head), []);
  assert.ok(inventory.assets.some(asset => asset.startsWith("packages/ui/dist/")) && record.packages.some(row => row.name === "@superbee/ui"));
  const withCore = patch => ({ ...record, packages: record.packages.map(row => row.name === "@superbee/core" ? { ...row, ...patch } : row) });
  const rerouted = target => ({ ...inventory, runtime: { inputs: Object.fromEntries(Object.entries(inventory.runtime.inputs).map(([input, value]) => [input === "../core/src/index.ts" ? target : input, value])) } });
  assert.ok("../core/src/index.ts" in inventory.runtime.inputs);
  for (const [label, candidate, inputs, expected] of [
    ["missing contributor", { ...record, packages: record.packages.filter(row => row.name !== "@superbee/server") }, inventory, /^packages: bundle contributor @superbee\/server is missing from the record$/],
    ["missing asset-only contributor", { ...record, packages: record.packages.filter(row => row.name !== "@superbee/ui") }, inventory, /^packages: bundle contributor @superbee\/ui is missing from the record$/],
    ["installed core", record, rerouted("../../node_modules/@superbee/core/dist/index.js"), /^input \S+: @superbee\/core resolves to an installed package, not workspace source$/],
    ["built core", record, rerouted("../core/dist/index.js"), /^input \S+: @superbee\/core resolves outside workspace source$/],
    ["core outside the repository", record, rerouted("../../../elsewhere/core/src/index.ts"), /^input \S+: resolves outside the repository$/],
    ["foreign asset", record, { ...inventory, assets: [...inventory.assets, "node_modules/@superbee/ui/dist/index.html"] }, /^asset \S+: not @superbee workspace content$/],
    ["uncontributing row", { ...record, packages: [...record.packages, { name: "@superbee/publication", version: "0.0.0", release_tag: null }] }, inventory, /^packages\[\d+\]: @superbee\/publication contributes no bundle input$/],
    ["foreign version", withCore({ version: "9.9.9", release_tag: "libraries/v9.9.9" }), inventory, /^packages\[\d+\]: version 9.9.9 is not the workspace manifest version$/],
    ["wrong release tag", withCore({ release_tag: null }), inventory, /^packages\[\d+\]: release_tag null; expected "libraries\/v[^"]+"$/],
    ["equality claim", withCore({ release_match: true }), inventory, /^record asserts equality with a release/],
    ["unexpected row field", withCore({ verified: true }), inventory, /^packages\[\d+\]: unexpected fields$/],
    ["unexpected top-level field", { ...record, matches_release: true }, inventory, /^record asserts equality|^record: unexpected top-level fields$/],
    ["malformed source", { ...record, source: { commit: "HEAD", dirty: false } }, inventory, /^source: expected/],
    ["foreign commit", { ...record, source: { ...record.source, commit: "0".repeat(40) } }, inventory, /^source: .* does not describe this tree \(stale or fabricated build\)/],
    ["flipped dirty flag", { ...record, source: { ...record.source, dirty: record.source.dirty === null ? true : !record.source.dirty } }, inventory, /^source: .* does not describe this tree \(stale or fabricated build\)/],
  ]) {
    const errors = embeddedEngineErrors(candidate, inputs, manifestOf, head);
    assert.ok(errors.some(error => expected.test(error)), `${label}: ${JSON.stringify(errors)}`);
  }
});

test("record rows name every embedded workspace and its release tag; source facts are null without git", () => {
  const inputs = ["packages/cli/src/index.ts", "packages/core/src/index.ts", "packages/server/src/index.ts", "packages/board-git/src/index.ts", "packages/ui/dist/index.html", "node_modules/pako/index.js", "packages/core/node_modules/nested/index.js"];
  const manifestOf = directory => ({ name: `@superbee/${directory}`, version: "1.2.3-pre.4" });
  const source = { commit: "a".repeat(40), dirty: false };
  const record = embeddedEngineRecord({ inputs, source, manifestOf });
  assert.deepEqual(record, { schema: "superbee.cli-embedded-engine.v2", source, packages: [
    { name: "@superbee/board-git", version: "1.2.3-pre.4", release_tag: null },
    { name: "@superbee/core", version: "1.2.3-pre.4", release_tag: "libraries/v1.2.3-pre.4" },
    { name: "@superbee/server", version: "1.2.3-pre.4", release_tag: "libraries/v1.2.3-pre.4" },
    { name: "@superbee/ui", version: "1.2.3-pre.4", release_tag: null },
  ] });
  assert.throws(() => embeddedEngineRecord({ inputs, source, manifestOf: () => ({ name: "superbee", version: "1.0.0" }) }), /not a versioned @superbee workspace/);
  // Unknown is represented explicitly: with no git on PATH the facts are null, never invented.
  const facts = execFileSync(process.execPath, ["--input-type=module", "-e", "import { currentSourceFacts } from './packages/cli/scripts/source-facts.mjs'; process.stdout.write(JSON.stringify(currentSourceFacts()));"], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.deepEqual(JSON.parse(facts), { commit: null, dirty: null });
});
