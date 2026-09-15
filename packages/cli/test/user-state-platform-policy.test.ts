import { withTestPolicy } from "./support/host-policy.js";
import { currentPrivateStateHost } from "../src/runtime-context.js";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
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

function status(
  shape: "directory" | "file" | "link",
  mode: number,
  uid: number,
) {
  return {
    dev: 1,
    ino: 2,
    mode,
    nlink: 1,
    uid,
    size: 12,
    isDirectory: () => shape === "directory",
    isFile: () => shape === "file",
    isSymbolicLink: () => shape === "link",
  };
}

test(
  "hardening rejects a hard-linked file without changing the external target mode",
  {
    skip:
      process.platform === "win32" ? "POSIX descriptor hardening only" : false,
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "superbee-harden-hardlink-"));
    const foreign = join(home, "foreign.txt");
    try {
      const root = await ensureUserStateRoot(home);
      await writeFile(foreign, "foreign\n", { mode: 0o644 });
      await link(foreign, join(root, "catalog.json"));
      await chmod(root, 0o755);

      await assert.rejects(hardenUserState(home), /hard-linked regular file/);
      assert.equal((await lstat(foreign)).mode & 0o777, 0o644);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "hardening detects a hard link added after scanning before chmod reaches its inode",
  {
    skip:
      process.platform === "win32" ? "POSIX descriptor hardening only" : false,
  },
  async () => {
    const home = await mkdtemp(
      join(tmpdir(), "superbee-harden-hardlink-race-"),
    );
    const foreign = join(home, "foreign.txt");
    try {
      const root = await ensureUserStateRoot(home);
      const record = join(root, "catalog.json");
      await writeFile(record, "{}\n", { mode: 0o644 });
      await chmod(root, 0o755);

      await assert.rejects(
        hardenUserState(home, {
          afterInspect: async () => link(record, foreign),
        }),
        /changed during hardening/,
      );
      assert.equal((await lstat(foreign)).mode & 0o777, 0o644);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "hardening refuses a scanned file replaced by a symlink and does not chmod its target",
  {
    skip:
      process.platform === "win32" ? "POSIX descriptor hardening only" : false,
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "superbee-harden-race-"));
    const foreign = join(home, "foreign.txt");
    try {
      const root = await ensureUserStateRoot(home);
      const record = join(root, "catalog.json");
      await writeFile(record, "{}\n", { mode: 0o644 });
      await chmod(root, 0o755);
      await writeFile(foreign, "foreign\n", { mode: 0o644 });

      await assert.rejects(
        hardenUserState(home, {
          afterInspect: async () => {
            await unlink(record);
            await symlink(foreign, record);
          },
        }),
        /changed during hardening/,
      );
      assert.equal((await lstat(foreign)).mode & 0o777, 0o644);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "hardening refuses an ancestor replaced by a symlink and does not chmod the moved tree",
  {
    skip:
      process.platform === "win32" ? "POSIX descriptor hardening only" : false,
  },
  async () => {
    const home = await mkdtemp(
      join(tmpdir(), "superbee-harden-ancestor-race-"),
    );
    const movedRoot = join(home, "moved-state");
    try {
      const root = await ensureUserStateRoot(home);
      const record = join(root, "catalog.json");
      await writeFile(record, "{}\n", { mode: 0o644 });
      await chmod(root, 0o755);

      await assert.rejects(
        hardenUserState(home, {
          afterInspect: async () => {
            await rename(root, movedRoot);
            await symlink(movedRoot, root);
          },
        }),
        /changed during hardening/,
      );
      assert.equal(
        (await lstat(join(movedRoot, "catalog.json"))).mode & 0o777,
        0o644,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("POSIX policy preserves the released root and permission authority", () => {
  const environment: UserStateEnvironment = {
    platform: "darwin",
    home: "/Users/mike",
    env: {},
  };
  const policy = resolveUserStatePolicy(environment);
  assert.equal(policy.canonicalRoot, "/Users/mike/.superbee-state");
  assert.equal(policy.displayRoot, "~/.superbee-state");
  assert.equal(currentPrivateStateHost().enforcePrivateMode, true);
  assert.equal(
    privateStateEntryIsSafe(
      status("file", 0o600, process.getuid?.() ?? 0),
      "file",
      environment,
    ),
    true,
  );
  assert.equal(
    privateStateEntryIsSafe(
      status("file", 0o644, process.getuid?.() ?? 0),
      "file",
      environment,
    ),
    false,
  );
});

test("Host mode exemption retains exact private entry shape", () => {
  withTestPolicy({ privateState: { enforcePrivateMode: false } }, () => {
    assert.equal(
      privateStateEntryIsSafe(status("directory", 0o666, 99999), "directory"),
      true,
    );
    assert.equal(
      privateStateEntryIsSafe(status("file", 0o666, 99999), "file"),
      true,
    );
    assert.equal(
      privateStateEntryIsSafe(status("link", 0o600, 0), "file"),
      false,
    );
    assert.equal(
      privateStateEntryIsSafe(status("directory", 0o700, 0), "file"),
      false,
    );
  });
});
