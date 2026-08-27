import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalUserStateDir,
  ensureUserStateRoot,
  hardenUserState,
  inspectCanonicalUserStateRootDetail,
  privateStateEntryIsSafe,
  quarantineUserState,
  resolveUserStatePolicy,
  supersededUserStateDirs,
  userStatePathDisplay,
  writeUserStateFileAtomic0600,
  readUserStateFile,
  type UserStateEnvironment,
} from "../src/user-state.js";
import { migrationSourceRoots } from "../src/user-state-migration.js";

function windows(overrides: NodeJS.ProcessEnv = {}): UserStateEnvironment {
  return {
    platform: "win32",
    home: "C:\\Users\\mike",
    env: { USERPROFILE: "C:\\Users\\mike", LOCALAPPDATA: "C:\\Users\\mike\\AppData\\Local", ...overrides },
  };
}

function status(shape: "directory" | "file" | "link", mode: number, uid: number) {
  return {
    dev: 1,
    ino: 2,
    mode,
    uid,
    size: 12,
    isDirectory: () => shape === "directory",
    isFile: () => shape === "file",
    isSymbolicLink: () => shape === "link",
  };
}

test("Windows policy uses the absolute user-local known folder and guards every prerelease source", () => {
  const environment = windows();
  const policy = resolveUserStatePolicy(environment);
  assert.equal(policy.state, "ready");
  assert.equal(policy.canonicalRoot, "C:\\Users\\mike\\AppData\\Local\\Superbee");
  assert.equal(policy.displayRoot, "%LOCALAPPDATA%\\Superbee");
  assert.deepEqual(policy.guardedRoots, [
    "C:\\Users\\mike\\AppData\\Local\\Superbee",
    "C:\\Users\\mike\\.superbee-state",
    "C:\\Users\\mike\\.config\\superbee",
    "C:\\Users\\mike\\.agentstate",
  ]);
  assert.deepEqual(supersededUserStateDirs(environment), [
    "C:\\Users\\mike\\.superbee-state",
    "C:\\Users\\mike\\.config\\superbee",
  ]);
  assert.deepEqual(migrationSourceRoots(environment), [
    "C:\\Users\\mike\\.superbee-state",
    "C:\\Users\\mike\\.config\\superbee",
    "C:\\Users\\mike\\.agentstate",
  ]);
  assert.equal(userStatePathDisplay(environment, canonicalUserStateDir(environment)), "%LOCALAPPDATA%\\Superbee");
  assert.equal(
    userStatePathDisplay(environment, "C:\\Users\\mike\\AppData\\Local\\Superbee\\catalog.json"),
    "%LOCALAPPDATA%\\Superbee\\catalog.json",
  );
});

test("Windows policy blocks missing, blank, and relative LOCALAPPDATA without inventing a cwd root", () => {
  for (const localAppData of [undefined, "", "relative\\state"]) {
    const environment = windows({ LOCALAPPDATA: localAppData });
    const policy = resolveUserStatePolicy(environment);
    assert.equal(policy.state, "blocked");
    assert.equal(policy.canonicalRoot, null);
    assert.match(policy.reason ?? "", /LOCALAPPDATA/);
    assert.throws(() => canonicalUserStateDir(environment), /LOCALAPPDATA/);
    assert.equal(policy.guardedRoots.some((root) => root.includes("relative")), false);
  }
});

test("Windows containment ignores synthetic POSIX modes but still requires exact entry shape", () => {
  const environment = windows();
  assert.equal(privateStateEntryIsSafe(status("directory", 0o666, 99999), "directory", environment), true);
  assert.equal(privateStateEntryIsSafe(status("file", 0o666, 99999), "file", environment), true);
  assert.equal(privateStateEntryIsSafe(status("link", 0o600, 0), "file", environment), false);
  assert.equal(privateStateEntryIsSafe(status("directory", 0o700, 0), "file", environment), false);
});

test("POSIX policy preserves the released root and permission authority", () => {
  const environment: UserStateEnvironment = { platform: "darwin", home: "/Users/mike", env: {} };
  const policy = resolveUserStatePolicy(environment);
  assert.equal(policy.canonicalRoot, "/Users/mike/.superbee-state");
  assert.equal(policy.displayRoot, "~/.superbee-state");
  assert.equal(policy.containment, "posix-owner-mode");
  assert.equal(privateStateEntryIsSafe(status("file", 0o600, process.getuid?.() ?? 0), "file", environment), true);
  assert.equal(privateStateEntryIsSafe(status("file", 0o644, process.getuid?.() ?? 0), "file", environment), false);
});

test("native Windows state agreement ignores synthetic modes and remains readable", {
  skip: process.platform === "win32" ? false : "requires native Windows filesystem semantics",
}, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "superbee-windows-state-"));
  const environment: UserStateEnvironment = {
    platform: "win32",
    home: join(scratch, "profile"),
    env: {
      USERPROFILE: join(scratch, "profile"),
      LOCALAPPDATA: join(scratch, "profile", "AppData", "Local"),
    },
  };
  try {
    const root = await ensureUserStateRoot(environment);
    const record = join(root, "catalog.json");
    await writeUserStateFileAtomic0600(environment, root, "catalog.json", "{}\n");
    assert.deepEqual(await inspectCanonicalUserStateRootDetail(environment), { state: "ready", hardening: "hardened" });
    assert.equal(await readUserStateFile(environment, record, 64), "{}\n");
    assert.deepEqual(await hardenUserState(environment), {
      schema_version: 1,
      operation: "harden-state",
      status: "already_hardened",
      changed: false,
      root: "%LOCALAPPDATA%\\Superbee",
      next: { command: "superbee setup" },
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("native Windows refuses root, marker, and child junctions without consuming their targets", {
  skip: process.platform === "win32" ? false : "requires native Windows junction semantics",
}, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "superbee-windows-junction-"));
  const profile = join(scratch, "profile");
  const environment: UserStateEnvironment = {
    platform: "win32",
    home: profile,
    env: { USERPROFILE: profile, LOCALAPPDATA: join(profile, "AppData", "Local") },
  };
  const root = canonicalUserStateDir(environment);
  const foreign = join(scratch, "foreign");
  try {
    await mkdir(join(profile, "AppData", "Local"), { recursive: true });
    await mkdir(foreign);
    await writeFile(join(foreign, "untouched.txt"), "foreign\n");
    await symlink(foreign, root, "junction");
    await assert.rejects(ensureUserStateRoot(environment), /not a real directory/);
    const quarantine = await quarantineUserState(environment);
    assert.equal(quarantine.status, "quarantined");
    assert.equal(await readFile(join(foreign, "untouched.txt"), "utf8"), "foreign\n");

    await ensureUserStateRoot(environment);
    const marker = join(root, "state.json");
    const savedMarker = join(root, "state.saved.json");
    await rename(marker, savedMarker);
    await symlink(foreign, marker, "junction");
    assert.equal((await inspectCanonicalUserStateRootDetail(environment)).state, "conflict");
    await unlink(marker);
    await rename(savedMarker, marker);

    const foreignRecord = join(foreign, "approval.json");
    await writeFile(foreignRecord, "{}\n");
    const child = join(root, "view-authorizations");
    await symlink(foreign, child, "junction");
    await assert.rejects(
      readUserStateFile(environment, join(child, "approval.json"), 64),
      /unsafe containing directory/,
    );
    assert.equal(await readFile(foreignRecord, "utf8"), "{}\n");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
