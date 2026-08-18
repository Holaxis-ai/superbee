import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LEGACY_USER_STATE_DIR_NAME,
  USER_STATE_DIR_NAME,
  legacyUserStateDir,
  readPrivateStateFile,
  readUserStateText,
  userStateDir,
  userStateDirForPackage,
  writeFileAtomic0600,
} from "../src/user-state.js";

test("Superbee owns ~/.superbee while the Aslite bridge retains its legacy user-state root", () => {
  const home = path.join(path.sep, "home", "person");
  assert.equal(USER_STATE_DIR_NAME, ".superbee");
  assert.equal(LEGACY_USER_STATE_DIR_NAME, ".agentstate");
  assert.equal(userStateDir(home), path.join(home, ".superbee"));
  assert.equal(userStateDirForPackage(home, "superbee"), path.join(home, ".superbee"));
  assert.equal(userStateDirForPackage(home, "@holaxis/aslite"), path.join(home, ".agentstate"));
  assert.equal(legacyUserStateDir(home), path.join(home, ".agentstate"));
});

test("a dangling canonical record does not revive legacy state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "superbee-user-state-read-"));
  const canonicalRoot = userStateDir(home);
  const legacyRoot = legacyUserStateDir(home);
  await mkdir(canonicalRoot);
  await mkdir(legacyRoot);
  const canonical = path.join(canonicalRoot, "state.json");
  const legacy = path.join(legacyRoot, "state.json");
  await symlink(path.join(home, "missing-target"), canonical);
  await writeFile(legacy, "legacy\n");

  await assert.rejects(readUserStateText(canonical, legacy));
});

test("private state reads reject symlinks and FIFOs without following or blocking", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX symlink and mkfifo semantics");
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), "superbee-user-state-hostile-read-"));
  const target = path.join(home, "target.json");
  const link = path.join(home, "link.json");
  const fifo = path.join(home, "fifo.json");
  await writeFile(target, "{}\n");
  await symlink(target, link);
  execFileSync("mkfifo", [fifo]);

  await assert.rejects(readPrivateStateFile(link));
  await assert.rejects(readPrivateStateFile(fifo), /not a regular file/);
});

test("canonical writes reject a symlinked root without modifying its legacy target", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "superbee-user-state-write-"));
  const canonicalRoot = userStateDir(home);
  const legacyRoot = legacyUserStateDir(home);
  await mkdir(legacyRoot, { mode: 0o755 });
  const legacyFile = path.join(legacyRoot, "state.json");
  await writeFile(legacyFile, "legacy\n", { mode: 0o644 });
  const legacyMode = (await stat(legacyRoot)).mode & 0o777;
  await symlink(legacyRoot, canonicalRoot);

  await assert.rejects(
    writeFileAtomic0600(canonicalRoot, "state.json", "canonical\n", { rootDir: canonicalRoot }),
    /not a real directory/,
  );
  assert.equal(await readFile(legacyFile, "utf8"), "legacy\n");
  assert.equal((await stat(legacyRoot)).mode & 0o777, legacyMode);
});
