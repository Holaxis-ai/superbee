// A refused lock root is not a session lock, whether the refusal comes from initializing the user
// state root or from the session lock's own claim. This file binds a distribution with its own
// lock parent, which is why it runs in its own process.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, utimesSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FilesystemMutationLockError, filesystemMutationLockPath } from "@superbee/core";
import { CliError } from "../src/errors.js";
import { resolveHostedTarget } from "../src/hosted-auth/discovery.js";
import { defaultHostedAuthDeps, sessionAccount, sessionDirFor, withSessionLock } from "../src/hosted-auth/session.js";
import { CREDENTIAL_STORE_ENV } from "../src/hosted-auth/secret-store.js";
import { createPosixHostCommands, createPosixPrivateStateHost } from "../src/posix-host.js";
import { runWithRuntime, snapshotRuntimeOptions } from "../src/runtime-context.js";
import type { CliRuntimeOptions } from "../src/runtime-types.js";

const HOST = "http://127.0.0.1:1";

test("a refused lock root passes through unchanged, never as an orphaned session lock to remove", async () => {
  const lockParent = await realpath(await mkdtemp(path.join(tmpdir(), "sb-session-lock-root-")));
  const home = await mkdtemp(path.join(tmpdir(), "sb-session-lock-home-"));
  const filesystemHost = {
    runtimeLockParent: () => lockParent,
    runtimeOwnerKey: () => `uid-${process.getuid!()}`,
    enforcePrivateMode: true,
    isTransientOpenError: () => false,
    isReplacementConflict: () => false,
    isDirectoryContentionError: () => false,
  };
  const context = snapshotRuntimeOptions({
    distribution: {
      identity: {
        schema: "superbee.build-identity.v1",
        package: { name: "superbee", version: "unknown" },
        source: { commit: null, dirty: null },
        artifact: { channel: "local-dev" },
        compatibility_contracts: { skill: 1, hook: 1, mcp: 1 },
      },
      executablePath: fileURLToPath(import.meta.url),
      assetRoot: path.dirname(fileURLToPath(import.meta.url)),
      install: { packageName: "superbee", entryRelativePath: "dist/superbee.mjs", bins: ["superbee"] },
      ownedSkillPackages: ["superbee"],
      updatesEnabled: false,
    },
    host: createPosixHostCommands(),
    privateState: createPosixPrivateStateHost(),
    filesystemHost,
    boardHost: { sameResolvedPath: (a, b) => a === b, moveAsideHelp: () => "move it aside" },
  } as CliRuntimeOptions);
  const target = resolveHostedTarget(HOST);
  // withSessionLock reads `home` to initialize the root, then again to find the session directory.
  // That second read is the only seam between the initialization lock and the session claim.
  let afterInitialization: (() => void) | undefined;
  let homeReads = 0;
  const deps = {
    ...defaultHostedAuthDeps(home, { env: { [CREDENTIAL_STORE_ENV]: "file" } }),
    lockWaitMs: 100,
    get home() {
      homeReads += 1;
      if (homeReads === 2) afterInitialization?.();
      return home;
    },
  };
  const attempt = () => {
    homeReads = 0;
    return runWithRuntime(context, () => withSessionLock(target, deps, async () => "ran"));
  };
  const old = new Date(Date.now() - 60_000);
  try {
    assert.equal(await attempt(), "ran");
    const lock = filesystemMutationLockPath(path.join(await realpath(sessionDirFor(home, sessionAccount(target))), "session"), undefined, filesystemHost);
    const root = path.dirname(lock);

    // The session lock itself, left with an unusable owner record, is still the orphaned lock.
    await mkdir(lock);
    await writeFile(path.join(lock, "owner.json"), "{");
    await utimes(lock, old, old);
    const orphaned = await attempt().then(() => assert.fail("expected refusal"), (error: unknown) => error);
    assert.ok(orphaned instanceof CliError);
    assert.equal(orphaned.details?.reason, "session_lock_orphaned");
    assert.equal(orphaned.details?.lock, lock);
    await rm(lock, { recursive: true });

    // A root that is not private to this user is refused before any claim: that refusal, as is.
    await chmod(root, 0o755);
    await utimes(root, old, old);
    const refused = await attempt().then(() => assert.fail("expected refusal"), (error: unknown) => error);
    assert.ok(refused instanceof FilesystemMutationLockError, `expected the root refusal, got ${String(refused)}`);
    assert.equal(refused.lockPath, root);
    assert.match(refused.message, /refusing unsafe filesystem mutation lock root/);

    // A root that turns unsafe after initialization is refused by the session lock's own claim.
    await chmod(root, 0o700);
    assert.equal(await attempt(), "ran");
    afterInitialization = () => {
      chmodSync(root, 0o755);
      utimesSync(root, old, old);
    };
    const refusedAtClaim = await attempt().then(() => assert.fail("expected refusal"), (error: unknown) => error);
    afterInitialization = undefined;
    assert.ok(refusedAtClaim instanceof FilesystemMutationLockError, `expected the root refusal, got ${String(refusedAtClaim)}`);
    assert.equal(refusedAtClaim.lockPath, root);
    assert.match(refusedAtClaim.message, /refusing unsafe filesystem mutation lock root/);
  } finally {
    await chmod(path.join(lockParent, `agentstate-lite-mutation-locks-uid-${process.getuid!()}`), 0o700).catch(() => {});
    await rm(lockParent, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
