import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("the shipped sample bundle teaches Superbee while retaining its interoperable OKF shape", async () => {
  const sources = [
    "examples/sample-bundle/concepts/index.md",
    "examples/sample-bundle/concepts/okf-alignment.md",
    "examples/sample-bundle/context-notes/index.md",
    "examples/sample-bundle/context-notes/cycle-okf-lite-vision.md",
    "examples/sample-bundle/index.md",
    "examples/sample-bundle/references/index.md",
    "examples/sample-bundle/references/okf-spec.md",
  ];
  for (const source of sources) {
    const sourceText = await readFile(path.join(repoRoot, source), "utf8");
    assert.doesNotMatch(sourceText, /agentstate-lite|\baslite\b/i, source);
    assert.equal(
      await readFile(path.join(repoRoot, "packages/cli/references/sample-bundle", path.relative("examples/sample-bundle", source)), "utf8"),
      sourceText,
      `${source} must match the generated npm projection`,
    );
  }
  assert.match(
    await readFile(path.join(repoRoot, "examples/sample-bundle/concepts/okf-alignment.md"), "utf8"),
    /Superbee is an OKF-native store/,
  );
});
