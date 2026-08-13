import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("first-party View demo seeds a self-contained Superbee bundle", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-first-party-consumers-"));
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["examples/views/demo.sh"], {
      cwd: repoRoot,
      env: { ...process.env, TMPDIR: scratch },
      maxBuffer: 1024 * 1024,
    });
    assert.equal(stderr, "");
    assert.match(stdout, /Seeded 3 views \(pulse, roadmap, about\)/);
    assert.match(stdout, /packages\/cli\/dist\/superbee\.mjs ui/);
    assert.match(stdout, /tasks\/open-the-view/);
    assert.doesNotMatch(stdout, /dist\/agentstate-lite\.mjs|aslite-views-demo/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
