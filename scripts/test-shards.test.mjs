import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { partitionFiles, timing } from "../packages/cli/scripts/test-shards.mjs";

const cli = fileURLToPath(new URL("../packages/cli/", import.meta.url));
test("weighted CLI partition is deterministic, disjoint and exhaustive, including new files", () => {
  const discovered = readdirSync(path.join(cli, "test")).filter(file => file.endsWith(".test.ts"));
  assert.deepEqual(Object.keys(timing.weights).filter(file => !discovered.includes(file)), [], "timing weights must name existing test files");
  const files = [...discovered, "new-undocumented.test.ts"];
  const shards = partitionFiles(files, 4);
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), files.sort());
  assert.deepEqual(partitionFiles([...files].reverse(), 4), shards);
  assert.ok(shards.every(shard => shard.files.length > 0 && shard.seconds > 0));
  assert.ok(Math.max(...shards.map(s => s.seconds)) - Math.min(...shards.map(s => s.seconds)) <= timing.fallback_seconds);
  const subset = discovered.filter(file => file.startsWith("hosted-sync"));
  assert.deepEqual(partitionFiles(subset, 4).flatMap(s => s.files).sort(), subset.sort());
  for (const args of [[[], 1], [["a", "a"], 1], [["a"], 2], [["a"], 1, { a: 0 }]]) {
    assert.throws(() => partitionFiles(...args));
  }
  assert.deepEqual(partitionFiles(["a", "b", "c", "d"], 2, { a: 10, b: 8, c: 3, d: 1 }).map(s => s.seconds), [11, 11]);
});

test("runner executes only the selected input subset and propagates child failure", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "cli-shard-probe-"));
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const wrapper = path.join(cli, "scripts/run-test-command.mjs");
  const run = (shard, files) => spawnSync(process.execPath, [wrapper, "node", "--test", "--test-reporter=tap", ...files], {
    cwd: scratch, encoding: "utf8", env: { ...env, SUPERBEE_TEST_SHARD: shard },
  });
  try {
    for (const name of ["a", "b", "excluded"]) await writeFile(path.join(scratch, `${name}.test.mjs`), `import test from 'node:test';test('${name}',()=>{});`);
    await writeFile(path.join(scratch, "bad.test.mjs"), "import test from 'node:test';test('bad',()=>{throw Error('red sentinel')});");
    const observed = [];
    for (const shard of ["1/2", "2/2"]) {
      const result = run(shard, ["a.test.mjs", "b.test.mjs"]);
      assert.equal(result.status, 0, result.stderr);
      observed.push(...[...result.stdout.matchAll(/^ok \d+ - (\w+)$/gm)].map(m => m[1]));
    }
    assert.deepEqual(observed.sort(), ["a", "b"]);
    const bad = run("1/1", ["bad.test.mjs"]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout, /red sentinel/);
    for (const shard of ["", "0/4", "5/4", "1/2junk", "1/9007199254740992", "1/3"]) {
      assert.notEqual(run(shard, ["a.test.mjs", "b.test.mjs"]).status, 0, shard);
    }
    assert.notEqual(run("1/1", []).status, 0);
    assert.notEqual(run("1/1", ["a.test.mjs", "a.test.mjs"]).status, 0);
    assert.notEqual(run("1/1", ["missing.test.mjs"]).status, 0);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
