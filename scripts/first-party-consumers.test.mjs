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

test("maintained first-party surfaces teach the canonical Superbee identity", async () => {
  const cases = [
    ["examples/views/conventions/view.md", /`superbee ui`/, /`(?:agentstate-lite ui|aslite status)`/],
    ["packages/ui/index.html", /<title>Superbee<\/title>/, /<title>agentstate-lite<\/title>/],
    ["packages/ui-server/README.md", /@superbee\/ui-server/, /@agentstate-lite\/ui-server/],
    ["packages/board-git/README.md", /@superbee\/board-git/, /@agentstate-lite\/board-git/],
  ];
  for (const [relative, required, forbidden] of cases) {
    const content = await readFile(path.join(repoRoot, relative), "utf8");
    assert.match(content, required, relative);
    assert.doesNotMatch(content, forbidden, relative);
  }
});

test("development shims and the View demo resolve to the Superbee artifact", async () => {
  for (const shim of ["superbee", "aslite"]) {
    assert.match(
      await readFile(path.join(repoRoot, shim), "utf8"),
      /dist\/superbee\.mjs/,
      `${shim} must route to the current development artifact`,
    );
  }

  const demo = await readFile(path.join(repoRoot, "examples/views/demo.sh"), "utf8");
  assert.match(demo, /packages\/cli\/dist\/superbee\.mjs/);
  assert.match(demo, /superbee-views-demo/);
  assert.doesNotMatch(demo, /REPO\/\.agentstate-lite/);
});

test("project bindings stay machine-local across the compatibility window", async () => {
  const entries = new Set(
    (await readFile(path.join(repoRoot, ".gitignore"), "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  );

  assert.ok(entries.has(".superbee.json"), "preferred binding must be ignored");
  assert.ok(entries.has(".agentstate.json"), "legacy binding must remain ignored during compatibility");
});
