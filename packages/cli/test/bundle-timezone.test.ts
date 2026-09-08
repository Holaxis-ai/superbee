import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { initBundle, writeDoc } from "@superbee/core";
import { bundleCommand } from "../src/commands/bundle.js";
import { classifyBundleError } from "../src/errors.js";

async function run(argv: string[]): Promise<Record<string, unknown>> {
  let output = "";
  await bundleCommand([...argv, "--json"], { stdout: (s) => { output += s; } });
  return JSON.parse(output);
}

test("bundle timezone: inspect, guarded set, no-op, stale no-op, reset preserve concepts", async () => {
  const root = await mkdtemp(join(tmpdir(), "superbee-timezone-cli-"));
  try {
    const bundle = await initBundle(root);
    await writeDoc(bundle, { id: "notes/a", frontmatter: { type: "Note", title: "Unchanged" }, body: "Body\n" });
    const doc = await readFile(join(root, "notes/a.md"), "utf8");
    const originalRoot = await readFile(join(root, "index.md"), "utf8");
    const dir = ["--dir", root];
    const initial = await run(["timezone", ...dir]);
    assert.equal(initial.timeZone, "Etc/GMT");
    assert.equal(initial.source, "default");
    assert.equal(await readFile(join(root, "index.md"), "utf8"), originalRoot);
    const changed = await run(["timezone", "set", "America/New_York", ...dir, "--expected-version", String(initial.version), "--actor", "process:timezone-test"]);
    assert.equal(changed.timeZone, "America/New_York");
    assert.equal(changed.source, "configured");
    assert.equal(changed.changed, true);
    const same = await run(["timezone", "set", "America/New_York", ...dir, "--expected-version", String(changed.version)]);
    assert.equal(same.changed, false);
    assert.equal(same.version, changed.version);
    await assert.rejects(run(["timezone", "set", "America/New_York", ...dir, "--expected-version", String(initial.version)]),
      (err: unknown) => classifyBundleError(err).code === "STALE_HEAD");
    const reset = await run(["timezone", "reset", ...dir, "--expected-version", String(changed.version)]);
    assert.equal(reset.timeZone, "Etc/GMT");
    assert.equal(reset.source, "default");
    assert.equal(reset.changed, true);
    assert.equal((await run(["timezone", "reset", ...dir])).changed, false);
    assert.equal(await readFile(join(root, "notes/a.md"), "utf8"), doc);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bundle timezone: invalid options and values perform no writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "superbee-timezone-cli-invalid-"));
  try {
    await initBundle(root);
    const original = await readFile(join(root, "index.md"), "utf8");
    const rows = [
      ["timezone", "set"], ["timezone", "set", "America/New_York", "extra"],
      ["timezone", "reset", "extra"], ["timezone", "typo"],
      ["timezone", "set", "Nonsense/Zone"], ["timezone", "set", "+05:00"],
      ["timezone", "set", "EST"], ["timezone", "set", ""],
      ["timezone", "set", "UTC", "--expected-version", " "],
      ["timezone", "set", "UTC", "--actor", " "],
      ["timezone", "--actor", "process:test"], ["timezone", "--expected-version", "unused"],
      ["timezone", "--remote", "http://127.0.0.1:1"],
      ["locate", "--remote", "http://127.0.0.1:1"],
    ];
    for (const row of rows) {
      await assert.rejects(run([...row, "--dir", root]), (err: unknown) => classifyBundleError(err).code === "USAGE", row.join(" "));
      assert.equal(await readFile(join(root, "index.md"), "utf8"), original);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("bundle timezone: built inspection agrees across host time zones without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "superbee-timezone-host-"));
  try {
    await initBundle(root);
    const original = await readFile(join(root, "index.md"), "utf8");
    const cli = new URL("../dist/superbee.mjs", import.meta.url);
    const receipts = ["Pacific/Honolulu", "Asia/Tokyo", "America/New_York"].map((TZ) => {
      const result = spawnSync(process.execPath, [fileURLToPath(cli), "bundle", "timezone", "--dir", root, "--json"], {
        encoding: "utf8", env: { ...process.env, TZ, SUPERBEE_NO_UPDATE_CHECK: "1", SUPERBEE_NO_AUTOPULL: "1" },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    });
    assert.equal(receipts[0].timeZone, "Etc/GMT");
    assert.deepEqual(receipts[0], receipts[1]);
    assert.deepEqual(receipts[1], receipts[2]);
    assert.equal(await readFile(join(root, "index.md"), "utf8"), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
