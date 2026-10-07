import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertCommandParity, BUILT_COMMAND, commandEnv, decodeBatch, runCommandBatch } from "./support/command-batch.js";

function fixture(t: { after(fn: () => void): void }) {
  const cwd = mkdtempSync(join(tmpdir(), "superbee-command-batch-"));
  const home = join(cwd, "home");
  mkdirSync(home);
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, home };
}

test("batch protocol rejects missing, duplicate, unexpected and malformed rows", () => {
  const rows = [{ id: "one", argv: [] }, { id: "two", argv: [] }];
  const one = { id: "one", status: 2, stdout: "", stderr: "error" };
  const two = { ...one, id: "two" };
  assert.deepEqual([...decodeBatch(rows, JSON.stringify([two, one])).keys()], ["two", "one"]);
  assert.throws(() => decodeBatch(rows, JSON.stringify([one])), /missing response/);
  assert.throws(() => decodeBatch(rows, JSON.stringify([one, one])), /duplicate response/);
  assert.throws(() => decodeBatch(rows, JSON.stringify([one, { ...two, id: "other" }])), /unexpected response/);
  assert.throws(() => decodeBatch(rows, JSON.stringify([one, { ...two, status: null }])), /invalid response/);
  assert.throws(() => decodeBatch([rows[0]!, rows[0]!], "[]"), /duplicate requested/);
  assert.throws(() => decodeBatch(rows, "command output is not a result"), SyntaxError);
});

test("batch worker crashes, timeouts and uncaptured output fail closed", (t) => {
  const options = fixture(t);
  const worker = join(options.cwd, "broken.mjs");
  const rows = [{ id: "one", argv: [] }];
  for (const [source, expected] of [
    ['process.exit(7)', /batch worker failed/],
    ['process.kill(process.pid, "SIGKILL")', /batch worker signal/],
    ['setInterval(() => {}, 1000)', /ETIMEDOUT/],
    ['process.stdout.write("[]")', /uncaptured batch worker stdout/],
    ['process.stderr.write("[]")', /uncaptured batch worker stderr/],
    ['import { writeFileSync } from "node:fs"; writeFileSync(3, "[]")', /missing response/],
  ] as const) {
    writeFileSync(worker, source);
    assert.throws(() => runCommandBatch(rows, { ...options, worker, timeout: source.startsWith("setInterval") ? 1000 : 5000 }), expected);
  }
});

test("capture keeps byte channels separate, resets exit state and restores globals after throws", () => {
  // Stream patching must also be tested outside node:test's own stdout reporting protocol.
  const child = spawnSync(process.execPath, ["--import", new URL("./ts-loader.mjs", import.meta.url).pathname,
    new URL("./support/command-capture-probe.ts", import.meta.url).pathname], { encoding: "utf8", timeout: 5000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});

test("serial built runtime matches standalone bytes across error/help/error and raw channels", (t) => {
  const options = fixture(t);
  const rows = [
    { id: "error-before", argv: ["list", "--dir"] },
    { id: "help", argv: ["list", "--help"] },
    { id: "raw", argv: ["doc", "read", "probe", "surplus", "--out", "-"] },
    { id: "mcp", argv: ["mcp", "surplus"] },
    { id: "negative", argv: ["list", "--output"] },
    { id: "error-after", argv: ["list", "--dir"] },
  ];
  const results = runCommandBatch(rows, options);
  for (const row of rows) {
    const child = spawnSync(process.execPath, [BUILT_COMMAND, ...row.argv], { cwd: options.cwd, env: commandEnv(options.home), encoding: "utf8", timeout: 5000 });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    const actual = results.get(row.id)!;
    const expected = { status: child.status!, stdout: child.stdout, stderr: child.stderr };
    assertCommandParity(actual, expected, row.id);
    assert.throws(() => assertCommandParity({ ...actual, status: actual.status + 1 }, expected, row.id), /batch and executable differ/);
    assert.throws(() => assertCommandParity({ ...actual, stdout: `${actual.stdout}leaked bytes` }, expected, row.id), /batch and executable differ/);
    assert.throws(() => assertCommandParity({ ...actual, stderr: `${actual.stderr}leaked bytes` }, expected, row.id), /batch and executable differ/);
  }
  assert.deepEqual(results.get("error-before"), results.get("error-after"));
});
