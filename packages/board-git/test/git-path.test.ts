import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { probeRepoTopLevel, repoTopLevel } from "../src/index.js";
import { normalizeGitLexicalPath } from "../src/git-path.js";

test("Win32 drive spelling", () => {
  assert.equal(normalizeGitLexicalPath("C:/repo/path", path.win32), "C:\\repo\\path");
});

test("POSIX spelling preservation", () => {
  assert.equal(normalizeGitLexicalPath("/repo/path", path.posix), "/repo/path");
});

test("Windows UNC spelling preservation", () => {
  assert.equal(normalizeGitLexicalPath("//server/share/repo", path.win32), "\\\\server\\share\\repo");
});

test("probeRepoTopLevel returns host-native lexical spelling and repoTopLevel agrees", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-git-path-"));
  try {
    const repositoryRoot = await realpath(scratch);
    const nested = path.join(repositoryRoot, "nested", "directory");
    await mkdir(nested, { recursive: true });
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repositoryRoot, stdio: "ignore" });

    const probe = probeRepoTopLevel(nested);
    assert.deepEqual(probe, { kind: "repo", top: path.normalize(repositoryRoot) });
    assert.equal(repoTopLevel(nested), path.normalize(repositoryRoot));
    assert.equal(repoTopLevel(nested), probe.kind === "repo" ? probe.top : null);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
