import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initBundle } from "@superbee/core";
import { list } from "../src/commands/list.js";

const BUILT_CLI = fileURLToPath(new URL("../dist/superbee.mjs", import.meta.url));
const ZONES = ["UTC", "Asia/Kolkata", "America/Los_Angeles"] as const;

for (const edition of ["0.1", "0.2"] as const) {
  for (const zone of ZONES) {
    test(`list and home clock order respects ${edition} in ${zone}`, async () => {
      const scratch = await mkdtemp(path.join(tmpdir(), "superbee-clock-order-"));
      const dir = path.join(scratch, "bundle");
      const userDir = path.join(scratch, "user");
      try {
        await initBundle(dir, { okfVersion: edition });
        await mkdir(userDir);
        const clocks = {
          "valid": 'timestamp: "2026-09-08T08:00:00Z"',
          "z-zoneless": 'timestamp: "2026-09-08T12:00:00"',
          "a-invalid": 'timestamp: "not-a-clock"',
          "b-shadowed": 'timestamp: "2099-01-01T00:00:00Z"\ngenerated: {at: null}',
          "c-invalid": 'timestamp: "also-not-a-clock"',
        };
        for (const [id, clock] of Object.entries(clocks)) {
          // Raw fixtures retain the ambiguous legacy clock for edition-specific decode and sorting.
          await writeFile(path.join(dir, `${id}.md`), `---\ntype: Note\n${clock}\n---\n`);
        }
        const expected = edition === "0.2"
          ? ["valid", "a-invalid", "b-shadowed", "c-invalid", "z-zoneless"]
          : ["z-zoneless", "valid", "a-invalid", "b-shadowed", "c-invalid"];
        const observed: Record<string, string[]> = {};
        for (const command of ["list", "home"] as const) {
          const result = spawnSync(process.execPath, [BUILT_CLI, command, "--dir", dir, "--json"], {
            cwd: scratch,
            env: { ...process.env, TZ: zone, HOME: userDir, USERPROFILE: userDir,
              LOCALAPPDATA: path.join(userDir, "AppData", "Local"), APPDATA: path.join(userDir, "AppData", "Roaming"),
              SUPERBEE_NO_UPDATE_CHECK: "1", AGENTSTATE_LITE_NO_AUTOPULL: "1" },
            encoding: "utf8", timeout: 15_000, windowsHide: true,
          });
          assert.ifError(result.error);
          assert.equal(result.status, 0, result.stderr);
          const output = JSON.parse(result.stdout);
          const rows: Array<{ id: string }> = command === "list" ? output.docs : output.bundle.recent.rows;
          observed[command] = rows.map((row) => row.id);
        }
        assert.deepEqual(observed, { list: expected, home: expected });
      } finally { await rm(scratch, { recursive: true, force: true }); }
    });
  }
}

test("plain list preserves malformed-root legacy fallback for ordering", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-clock-order-malformed-"));
  try {
    await writeFile(path.join(dir, "index.md"), "---\nokf_version: [\n---\n");
    await writeFile(path.join(dir, "note.md"), '---\ntype: Note\ntimestamp: "2026-09-08T12:00:00"\n---\n');
    let output = "";
    await list(["--dir", dir, "--json"], { stdout: (s) => { output += s; }, autoPull: async () => {} });
    assert.deepEqual(JSON.parse(output).docs.map((row: { id: string }) => row.id), ["note"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
