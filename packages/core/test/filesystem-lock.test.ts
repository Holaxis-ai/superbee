import { captureFilesystemHostPolicy, type FilesystemHostPolicy } from "../src/filesystem-host.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FilesystemBackend } from "../src/backend.js";
import { identityKey } from "../src/filesystem-identity.js";
import {
  acquireFilesystemIdentityLock,
  acquireFilesystemMutationLock,
  FilesystemMutationLockError,
  filesystemIdentityLockPath,
  filesystemMutationLockPath,
  filesystemMutationLockRoot,
  isPrivateFilesystemMutationLockRoot,
  parseFilesystemMutationLockOwner,
} from "../src/filesystem-lock.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(HERE, "ts-loader.mjs");
const CAS_CHILD = path.join(HERE, "fixtures", "filesystem-cas-child.ts");
const LOCK_HOLDER_CHILD = path.join(HERE, "fixtures", "filesystem-lock-holder-child.ts");

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), "aslite-fs-lock-"));
}

async function isolatedLockPaths(): Promise<{
  root: string;
  portableRoot: string;
  lockRoot: string;
  target: string;
}> {
  const root = await tempDir();
  const portableRoot = path.join(root, "bundle");
  const lockRoot = path.join(root, "runtime");
  await fs.mkdir(portableRoot);
  return { root, portableRoot, lockRoot, target: path.join(portableRoot, "doc.md") };
}

function replaceFsMethod(
  name: "lstat" | "mkdir" | "readFile" | "rename" | "rm" | "writeFile",
  replacement: (...args: unknown[]) => unknown,
): () => void {
  const mutable = fs as unknown as Record<string, unknown>;
  const original = mutable[name];
  Object.defineProperty(mutable, name, { configurable: true, writable: true, value: replacement });
  return () => Object.defineProperty(mutable, name, { configurable: true, writable: true, value: original });
}

async function lockPathInRoot(target: string, lockRoot: string): Promise<string> {
  const canonicalTarget = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
  return path.join(lockRoot, path.basename(filesystemMutationLockPath(canonicalTarget)));
}

async function eventually<T>(promise: Promise<T>, timeoutMs = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface ChildHarness {
  child: ChildProcess;
  attempting: Promise<void>;
  result: Promise<Record<string, unknown>>;
  hasResult: () => boolean;
}

function spawnCasChild(
  root: string,
  expectedVersion: string,
  body: string,
  tmpdirOverride?: string,
): ChildHarness {
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(LOADER).href, CAS_CHILD, root, expectedVersion, body],
    {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: tmpdirOverride
      ? { ...process.env, TMPDIR: tmpdirOverride, TMP: tmpdirOverride, TEMP: tmpdirOverride }
      : process.env,
    },
  );
  let resultSeen = false;
  let resolveAttempting!: () => void;
  let resolveResult!: (value: Record<string, unknown>) => void;
  let rejectAttempting!: (err: Error) => void;
  let rejectResult!: (err: Error) => void;
  const attempting = new Promise<void>((resolve, reject) => {
    resolveAttempting = resolve;
    rejectAttempting = reject;
  });
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    if (value.type === "attempting") resolveAttempting();
    if (value.type === "result") {
      resultSeen = true;
      resolveResult(value);
    }
  });
  child.on("error", (err) => {
    rejectAttempting(err);
    rejectResult(err);
  });
  child.on("exit", (code, signal) => {
    if (!resultSeen) {
      const err = new Error(
        `CAS child exited before a result (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
      );
      rejectAttempting(err);
      rejectResult(err);
    }
  });
  return { child, attempting, result, hasResult: () => resultSeen };
}

test("filesystem mutation lock uses private external runtime state and removes it on release", async () => {
  const root = await tempDir();
  try {
    const target = path.join(root, "nested", "doc.md");
    const release = await acquireFilesystemMutationLock(target);
    const canonicalTarget = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
    const lockPath = filesystemMutationLockPath(canonicalTarget);

    assert.equal(path.dirname(lockPath), filesystemMutationLockRoot());
    assert.ok(path.relative(root, lockPath).startsWith(".."), "runtime lock must be outside the bundle");
    assert.equal((await fs.stat(filesystemMutationLockRoot())).mode & 0o777, 0o700);
    assert.equal((await fs.stat(lockPath)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(lockPath, "owner.json"))).mode & 0o777, 0o600);
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as {
      pid: number;
      hostname: string;
      target: string;
      token: string;
    };
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.hostname, hostname());
    assert.equal(owner.target, canonicalTarget);
    assert.ok(owner.token.length > 0);

    await release();
    await assert.rejects(() => fs.stat(lockPath), (err: unknown) => {
      assert.equal((err as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("filesystem mutation lock waits, times out with its live owner, and never steals", async () => {
  const root = await tempDir();
  try {
    const target = path.join(root, "doc.md");
    const canonicalTarget = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
    const lockPath = filesystemMutationLockPath(canonicalTarget);
    const release = await acquireFilesystemMutationLock(target);

    await assert.rejects(
      () => acquireFilesystemMutationLock(target, { waitMs: 30, pollMs: 5 }),
      (err: unknown) => {
        assert.ok(err instanceof FilesystemMutationLockError);
        assert.equal(err.lockPath, lockPath);
        assert.equal(err.owner?.pid, process.pid);
        assert.equal(err.stale, false);
        assert.equal(err.malformed, false);
        return true;
      },
    );
    assert.equal((await fs.stat(lockPath)).isDirectory(), true);

    await release();
    const releaseAgain = await acquireFilesystemMutationLock(target, { waitMs: 30, pollMs: 5 });
    await releaseAgain();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("filesystem mutation lock canonicalizes symlinked parent paths to one physical lock", async () => {
  const root = await tempDir();
  try {
    const realDir = path.join(root, "real");
    const aliasDir = path.join(root, "alias");
    await fs.mkdir(realDir);
    await fs.symlink(realDir, aliasDir, "dir");
    const release = await acquireFilesystemMutationLock(path.join(realDir, "doc.md"));

    await assert.rejects(
      () => acquireFilesystemMutationLock(path.join(aliasDir, "doc.md"), { waitMs: 20, pollMs: 5 }),
      (err: unknown) => err instanceof FilesystemMutationLockError && err.owner?.pid === process.pid,
    );
    await release();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("filesystem mutation lock root stays outside an explicitly broad portable tree", async () => {
  const portableRoot = await fs.realpath(tmpdir());
  const lockRoot = filesystemMutationLockRoot(portableRoot);
  assert.ok(path.relative(portableRoot, lockRoot).startsWith(".."));
  assert.ok(
    path
      .relative(
        portableRoot,
        filesystemMutationLockPath(path.join(portableRoot, "doc.md"), portableRoot),
      )
      .startsWith(".."),
  );
});

test("filesystem mutation lock uses the real directory-entry spelling on insensitive filesystems", async (t) => {
  const root = await tempDir();
  try {
    const canonical = path.join(root, "Doc.md");
    const alias = path.join(root, "doc.md");
    await fs.writeFile(canonical, "x");
    try {
      await fs.lstat(alias);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        t.skip("filesystem is case-sensitive");
        return;
      }
      throw err;
    }

    const release = await acquireFilesystemMutationLock(canonical);
    await assert.rejects(
      () => acquireFilesystemMutationLock(alias, { waitMs: 20, pollMs: 5 }),
      (err: unknown) => err instanceof FilesystemMutationLockError && err.owner?.pid === process.pid,
    );
    await release();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("filesystem mutation lock quarantines a valid same-host dead owner and preserves its evidence", async () => {
  const harness = await isolatedLockPaths();
  try {
    const lockPath = await lockPathInRoot(harness.target, harness.lockRoot);
    const staleOwner = {
      pid: 999_999,
      hostname: hostname(),
      created_at_ms: Date.now() - 60_000,
      token: "dead-owner",
      target: harness.target,
    };
    await fs.mkdir(harness.lockRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(staleOwner));

    const release = await acquireFilesystemMutationLock(harness.target, {
      portableRoot: harness.portableRoot,
      lockRoot: harness.lockRoot,
      waitMs: 100,
      pollMs: 5,
    });
    const duringClaim = await fs.readdir(harness.lockRoot);
    const quarantineName = duringClaim.find((entry) => entry.startsWith(`${path.basename(lockPath)}.stale-`));
    assert.ok(quarantineName);
    assert.equal(duringClaim.includes(path.basename(lockPath)), true);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(harness.lockRoot, quarantineName, "owner.json"), "utf8")),
      staleOwner,
    );

    await release();
    assert.deepEqual(await fs.readdir(harness.lockRoot), [quarantineName]);

    const releaseAgain = await acquireFilesystemMutationLock(harness.target, {
      portableRoot: harness.portableRoot,
      lockRoot: harness.lockRoot,
      waitMs: 100,
      pollMs: 5,
    });
    await releaseAgain();
    assert.deepEqual(await fs.readdir(harness.lockRoot), [quarantineName]);
  } finally {
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("a process killed while holding a lock does not wedge the next cross-process mutation", async () => {
  const harness = await isolatedLockPaths();
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(LOADER).href,
      LOCK_HOLDER_CHILD,
      harness.target,
      harness.portableRoot,
      harness.lockRoot,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  try {
    const locked = eventually(
      new Promise<number>((resolve, reject) => {
        child.on("message", (message: unknown) => {
          if (!message || typeof message !== "object") return;
          const value = message as Record<string, unknown>;
          if (value.type === "locked" && typeof value.pid === "number") resolve(value.pid);
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          reject(new Error(`lock holder exited before readiness (${String(code)}/${String(signal)}): ${stderr}`));
        });
      }),
    );
    const deadPid = await locked;
    assert.equal(child.kill("SIGKILL"), true);
    await eventually(new Promise<void>((resolve) => child.once("exit", () => resolve())));

    const release = await acquireFilesystemMutationLock(harness.target, {
      portableRoot: harness.portableRoot,
      lockRoot: harness.lockRoot,
      waitMs: 1_000,
      pollMs: 10,
    });
    const entries = await fs.readdir(harness.lockRoot);
    const quarantineName = entries.find((entry) => entry.includes(".lock.stale-"));
    assert.ok(quarantineName);
    const staleOwner = JSON.parse(
      await fs.readFile(path.join(harness.lockRoot, quarantineName, "owner.json"), "utf8"),
    ) as { pid?: number };
    assert.equal(staleOwner.pid, deadPid);
    await release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("the retained token quarantine fences a delayed reclaimer away from the live replacement", async () => {
  const harness = await isolatedLockPaths();
  await fs.mkdir(harness.lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = await lockPathInRoot(harness.target, harness.lockRoot);
  const staleOwner = {
    pid: 999_999,
    hostname: hostname(),
    created_at_ms: Date.now() - 60_000,
    token: "shared-stale-snapshot",
    target: harness.target,
  };
  await fs.mkdir(lockPath, { mode: 0o700 });
  await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(staleOwner));

  const originalRename = fs.rename;
  let renameCalls = 0;
  let enterFirstRename!: () => void;
  let unblockFirstRename!: () => void;
  let finishFirstRename!: () => void;
  const firstRenameEntered = new Promise<void>((resolve) => (enterFirstRename = resolve));
  const firstRenameGate = new Promise<void>((resolve) => (unblockFirstRename = resolve));
  const firstRenameFinished = new Promise<void>((resolve) => (finishFirstRename = resolve));
  const restoreRename = replaceFsMethod("rename", async (...args) => {
    renameCalls += 1;
    if (renameCalls === 1) {
      enterFirstRename();
      await firstRenameGate;
      try {
        return await originalRename(...(args as Parameters<typeof fs.rename>));
      } finally {
        finishFirstRename();
      }
    }
    return originalRename(...(args as Parameters<typeof fs.rename>));
  });
  let firstRenameUnblocked = false;
  let delayedClaim: Promise<() => Promise<void>> | undefined;
  let releaseReplacement: (() => Promise<void>) | undefined;

  try {
    const options = {
      portableRoot: harness.portableRoot,
      lockRoot: harness.lockRoot,
      waitMs: 2_000,
      pollMs: 2,
    };

    delayedClaim = acquireFilesystemMutationLock(harness.target, options);
    await eventually(firstRenameEntered);

    releaseReplacement = await acquireFilesystemMutationLock(harness.target, options);
    const replacementOwner = await fs.readFile(path.join(lockPath, "owner.json"), "utf8");

    unblockFirstRename();
    firstRenameUnblocked = true;
    await eventually(firstRenameFinished);

    assert.equal(
      await fs.readFile(path.join(lockPath, "owner.json"), "utf8"),
      replacementOwner,
      "the delayed reclaimer must not move the replacement owner's live lock",
    );

    await releaseReplacement();
    releaseReplacement = undefined;
    const releaseDelayed = await eventually(delayedClaim);
    await releaseDelayed();
  } finally {
    if (!firstRenameUnblocked) unblockFirstRename();
    restoreRename();
    await releaseReplacement?.().catch(() => {});
    if (delayedClaim) {
      const releaseDelayed = await delayedClaim.catch(() => undefined);
      await releaseDelayed?.().catch(() => {});
    }
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("a zero-wait delayed reclaimer diagnoses the live replacement, not its stale snapshot", async () => {
  const harness = await isolatedLockPaths();
  await fs.mkdir(harness.lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = await lockPathInRoot(harness.target, harness.lockRoot);
  await fs.mkdir(lockPath, { mode: 0o700 });
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    JSON.stringify({
      pid: 999_999,
      hostname: hostname(),
      created_at_ms: Date.now() - 60_000,
      token: "zero-wait-stale-snapshot",
      target: harness.target,
    }),
  );

  const originalRename = fs.rename;
  let renameCalls = 0;
  let enterFirstRename!: () => void;
  let unblockFirstRename!: () => void;
  const firstRenameEntered = new Promise<void>((resolve) => (enterFirstRename = resolve));
  const firstRenameGate = new Promise<void>((resolve) => (unblockFirstRename = resolve));
  const restoreRename = replaceFsMethod("rename", async (...args) => {
    renameCalls += 1;
    if (renameCalls === 1) {
      enterFirstRename();
      await firstRenameGate;
    }
    return originalRename(...(args as Parameters<typeof fs.rename>));
  });
  let firstRenameUnblocked = false;
  let releaseReplacement: (() => Promise<void>) | undefined;

  try {
    const delayedClaim = acquireFilesystemMutationLock(harness.target, {
      portableRoot: harness.portableRoot,
      lockRoot: harness.lockRoot,
      waitMs: 0,
      pollMs: 2,
    });
    void delayedClaim.catch(() => {});
    await eventually(firstRenameEntered);

    releaseReplacement = await acquireFilesystemMutationLock(harness.target, {
      portableRoot: harness.portableRoot,
      lockRoot: harness.lockRoot,
      waitMs: 2_000,
      pollMs: 2,
    });
    const replacementOwner = parseFilesystemMutationLockOwner(
      JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")),
    );
    assert.ok(replacementOwner);

    unblockFirstRename();
    firstRenameUnblocked = true;
    await assert.rejects(delayedClaim, (err: unknown) => {
      assert.ok(err instanceof FilesystemMutationLockError);
      assert.equal(err.stale, false);
      assert.equal(err.malformed, false);
      assert.equal(err.owner?.token, replacementOwner.token);
      assert.doesNotMatch(err.message, /stale filesystem mutation lock|Inspect and remove/);
      return true;
    });
  } finally {
    if (!firstRenameUnblocked) unblockFirstRename();
    restoreRename();
    await releaseReplacement?.().catch(() => {});
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

/**
 * Seeds a same-host lock owned by a live `sleep` process and arranges that, right after the
 * claimer under test reads that owner's record for the `triggerRead`-th time, the owner releases
 * and exits and a replacement claimer in this process takes the free key.
 */
async function handOffAfterOwnerRead(triggerRead: number) {
  const harness = await isolatedLockPaths();
  await fs.mkdir(harness.lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = await lockPathInRoot(harness.target, harness.lockRoot);
  const ownerFile = path.join(lockPath, "owner.json");
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  const holderExited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
  const holderToken = "released-live-holder";
  await fs.mkdir(lockPath, { mode: 0o700 });
  await fs.writeFile(
    ownerFile,
    JSON.stringify({
      pid: holder.pid,
      hostname: hostname(),
      created_at_ms: Date.now(),
      token: holderToken,
      target: harness.target,
    }),
  );

  const options = { portableRoot: harness.portableRoot, lockRoot: harness.lockRoot, waitMs: 0, pollMs: 2 };
  const state: { releaseReplacement?: () => Promise<void>; replacementToken?: string } = {};
  const originalReadFile = fs.readFile;
  let reads = 0;
  const restoreReadFile = replaceFsMethod("readFile", async (...args) => {
    const content = await originalReadFile(...(args as Parameters<typeof fs.readFile>));
    if (String(args[0]) === ownerFile && ++reads === triggerRead) {
      await fs.rm(lockPath, { recursive: true, force: true });
      holder.kill("SIGKILL");
      await holderExited;
      state.releaseReplacement = await acquireFilesystemMutationLock(harness.target, options);
      state.replacementToken = parseFilesystemMutationLockOwner(
        JSON.parse(await originalReadFile(ownerFile, "utf8")),
      )?.token;
    }
    return content;
  });
  const cleanup = async () => {
    restoreReadFile();
    holder.kill("SIGKILL");
    await state.releaseReplacement?.().catch(() => {});
    await fs.rm(harness.root, { recursive: true, force: true });
  };
  return { harness, lockPath, ownerFile, holderToken, options, state, cleanup };
}

test("a reclaimer whose dead-owner snapshot changed hands never quarantines the new live lock", async () => {
  const { harness, ownerFile, options, state, cleanup } = await handOffAfterOwnerRead(1);
  let releaseReclaimer: (() => Promise<void>) | undefined;
  try {
    const reclaim = acquireFilesystemMutationLock(harness.target, options).then((release) => {
      releaseReclaimer = release;
      return release;
    });
    await assert.rejects(reclaim, (err: unknown) => {
      assert.ok(err instanceof FilesystemMutationLockError);
      assert.equal(err.stale, false);
      assert.equal(err.owner?.token, state.replacementToken);
      return true;
    });
    assert.ok(state.replacementToken);
    const current = parseFilesystemMutationLockOwner(JSON.parse(await fs.readFile(ownerFile, "utf8")));
    assert.equal(current?.token, state.replacementToken, "the replacement must still hold its lock");
    assert.deepEqual((await fs.readdir(harness.lockRoot)).filter((entry) => entry.includes(".stale-")), []);
  } finally {
    await releaseReclaimer?.().catch(() => {});
    await cleanup();
  }
});

test("a timeout reports stale only while the lock still carries the dead owner's record", async () => {
  const { harness, lockPath, options, state, cleanup } = await handOffAfterOwnerRead(2);
  try {
    await assert.rejects(acquireFilesystemMutationLock(harness.target, options), (err: unknown) => {
      assert.ok(err instanceof FilesystemMutationLockError);
      // The lock changed hands after the snapshot: the diagnosis names the holder there now, never
      // the released owner whose PID no longer holds anything.
      assert.ok(state.replacementToken);
      assert.equal(err.owner?.token, state.replacementToken);
      assert.equal(err.owner?.pid, process.pid);
      assert.equal(err.stale, false);
      assert.equal(err.malformed, false);
      assert.match(err.message, new RegExp(`held by PID ${process.pid} `));
      assert.doesNotMatch(err.message, /stale filesystem mutation lock|Inspect and remove/);
      return true;
    });
    assert.ok(state.replacementToken);
    assert.ok(await fs.lstat(lockPath));
  } finally {
    await cleanup();
  }
});

test("a reclaimer never quarantines an owner-less claim that replaced its dead-owner snapshot", async () => {
  const harness = await isolatedLockPaths();
  await fs.mkdir(harness.lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = await lockPathInRoot(harness.target, harness.lockRoot);
  const ownerFile = path.join(lockPath, "owner.json");
  await fs.mkdir(lockPath, { mode: 0o700 });
  await fs.writeFile(
    ownerFile,
    JSON.stringify({
      pid: 999_999,
      hostname: hostname(),
      created_at_ms: Date.now() - 60_000,
      token: "replaced-dead-owner",
      target: harness.target,
    }),
  );

  // After the claimer's first owner read, the dead lock is gone and a competitor has made the
  // directory but not yet written its owner record.
  const originalReadFile = fs.readFile;
  let reads = 0;
  const restoreReadFile = replaceFsMethod("readFile", async (...args) => {
    const content = await originalReadFile(...(args as Parameters<typeof fs.readFile>));
    if (String(args[0]) === ownerFile && ++reads === 1) {
      await fs.rm(lockPath, { recursive: true, force: true });
      await fs.mkdir(lockPath, { mode: 0o700 });
    }
    return content;
  });
  try {
    await assert.rejects(
      acquireFilesystemMutationLock(harness.target, {
        portableRoot: harness.portableRoot,
        lockRoot: harness.lockRoot,
        waitMs: 0,
        pollMs: 2,
      }),
      (err: unknown) => {
        assert.ok(err instanceof FilesystemMutationLockError);
        assert.equal(err.malformed, true);
        assert.equal(err.stale, false);
        return true;
      },
    );
    assert.equal((await fs.lstat(lockPath)).isDirectory(), true, "the in-progress claim must stay in place");
    assert.deepEqual((await fs.readdir(harness.lockRoot)).filter((entry) => entry.includes(".stale-")), []);
  } finally {
    restoreReadFile();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("competing stale-lock reclaimers serialize without stealing one another's live claim", async () => {
  const harness = await isolatedLockPaths();
  await fs.mkdir(harness.lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = await lockPathInRoot(harness.target, harness.lockRoot);
  await fs.mkdir(lockPath, { mode: 0o700 });
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    JSON.stringify({
      pid: 999_999,
      hostname: hostname(),
      created_at_ms: Date.now() - 60_000,
      token: "contended-stale-owner",
      target: harness.target,
    }),
  );

  try {
    const acquired: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const release = await acquireFilesystemMutationLock(harness.target, {
          portableRoot: harness.portableRoot,
          lockRoot: harness.lockRoot,
          waitMs: 3_000,
          pollMs: 2,
        });
        acquired.push(index);
        await new Promise((resolve) => setTimeout(resolve, 2));
        await release();
      }),
    );
    assert.equal(acquired.length, 8);
    const entries = await fs.readdir(harness.lockRoot);
    assert.equal(entries.length, 1);
    assert.match(entries[0]!, /\.lock\.stale-[a-f0-9]{64}$/);
  } finally {
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("filesystem mutation lock keeps malformed and foreign-host leftovers fail-closed", async (t) => {
  const cases = [
    {
      name: "foreign-host",
      owner: {
        pid: 999_999,
        hostname: "other-host",
        created_at_ms: Date.now() - 60_000,
        token: "foreign-owner",
        target: "unused",
      },
      stale: false,
      malformed: false,
    },
    { name: "malformed", owner: null, stale: false, malformed: true },
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await tempDir();
      try {
        const target = path.join(root, "doc.md");
        const canonicalTarget = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
        const lockPath = filesystemMutationLockPath(canonicalTarget);
        await fs.mkdir(filesystemMutationLockRoot(), { recursive: true, mode: 0o700 });
        await fs.mkdir(lockPath, { recursive: true });
        if (fixture.owner) {
          await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(fixture.owner));
        }

        await assert.rejects(
          () => acquireFilesystemMutationLock(target, { waitMs: 20, pollMs: 5 }),
          (err: unknown) => {
            assert.ok(err instanceof FilesystemMutationLockError);
            assert.equal(err.stale, fixture.stale);
            assert.equal(err.malformed, fixture.malformed);
            return true;
          },
        );
        assert.equal((await fs.stat(lockPath)).isDirectory(), true, "timeout must not move the lock");

        await fs.rm(lockPath, { recursive: true });
        const release = await acquireFilesystemMutationLock(target, { waitMs: 20, pollMs: 5 });
        await release();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});

// Timing-shaped (a fixed settle delay stands in for "no child completed"); not part of the
// identity proof, which lives in filesystem-identity-cross-process.test.ts. The parent holds the
// backend's own identity lock for `shared.md` through the pure-key entry point.
test("two independent processes with different POSIX TMPDIR values share one CAS lock", async () => {
  const root = await tempDir();
  const children: ChildHarness[] = [];
  try {
    const backend = new FilesystemBackend(root);
    const initialVersion = await backend.write("shared", {
      id: "shared",
      frontmatter: { type: "Concept", timestamp: "2026-07-16T00:00:00.000Z" },
      body: "initial",
    });
    const release = await acquireFilesystemIdentityLock(await identityKey(root, "shared.md"), "test-hold", {
      portableRoot: root,
    });
    const childTmpA = path.join(root, "session-tmp-a");
    const childTmpB = path.join(root, "session-tmp-b");
    await fs.mkdir(childTmpA);
    await fs.mkdir(childTmpB);
    children.push(
      spawnCasChild(
        root,
        initialVersion,
        "writer-a",
        childTmpA,
      ),
    );
    children.push(
      spawnCasChild(
        root,
        initialVersion,
        "writer-b",
        childTmpB,
      ),
    );

    await eventually(Promise.all(children.map((child) => child.attempting)).then(() => undefined));
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(children.some((child) => child.hasResult()), false, "children must honor the parent process's lock");

    await release();
    const results = await eventually(Promise.all(children.map((child) => child.result)));
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const conflicts = results.filter((result) => result.status === "conflict");
    assert.equal(fulfilled.length, 1);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.expected, initialVersion);
    assert.equal(conflicts[0]?.actual, fulfilled[0]?.version);

    const final = await backend.read("shared");
    assert.equal(final.version, fulfilled[0]?.version);
    assert.equal(final.doc.body.trimEnd(), fulfilled[0]?.body);
  } finally {
    for (const harness of children) {
      if (harness.child.exitCode === null && harness.child.signalCode === null) harness.child.kill();
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pure-key identity lock claims by key only: no target directory, no target realpath, descriptor recorded", async () => {
  const parent = await tempDir();
  const root = path.join(parent, "Bundle");
  try {
    const key = await identityKey(root, "concepts/doc.md");
    const release = await acquireFilesystemIdentityLock(key, `${root}:concepts/doc.md`, { portableRoot: root });
    try {
      const lockPath = filesystemIdentityLockPath(key, root);
      assert.equal(lockPath, path.join(filesystemMutationLockRoot(root), `${key}.lock`));
      assert.ok(path.relative(parent, lockPath).startsWith(".."), "runtime lock must be outside the bundle");
      const owner = parseFilesystemMutationLockOwner(
        JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")),
      );
      assert.equal(owner?.pid, process.pid);
      assert.equal(owner?.target, `${root}:concepts/doc.md`);
      await assert.rejects(() => fs.stat(root), (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT");
      await assert.rejects(
        () => acquireFilesystemIdentityLock(key, "second", { portableRoot: root, waitMs: 20, pollMs: 5 }),
        (err: unknown) => err instanceof FilesystemMutationLockError && err.owner?.token === owner?.token,
      );
    } finally {
      await release();
    }
    await assert.rejects(() => fs.stat(filesystemIdentityLockPath(key, root)));
    assert.deepEqual(await fs.readdir(parent), []);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("pure-key identity lock refuses a key that is not a sha256 digest", async () => {
  await assert.rejects(() => acquireFilesystemIdentityLock("../escape", "x"), TypeError);
  assert.throws(() => filesystemIdentityLockPath("not-hex"), TypeError);
});

// ── mutation-survivor pins (core-survivor-triage unit) ────────────────────────
// Each test pins behavior a Stryker survivor from the first full core mutation
// report (run 29628092134) proved unobserved. Every "kills:" line was red-proven:
// the exact mutant applied → test fails; real code → passes.

// kills: filesystem-lock.ts:50:36 BlockStatement #937
// kills: filesystem-lock.ts:52:7 ConditionalExpression #940
// kills: filesystem-lock.ts:52:7 EqualityOperator #941
// kills: filesystem-lock.ts:52:33 StringLiteral #942
// kills: filesystem-lock.ts:79:86 StringLiteral #970
// kills: filesystem-lock.ts:84:27 StringLiteral #973
// kills: filesystem-lock.ts:84:42 StringLiteral #974
// kills: filesystem-lock.ts:90:7 ConditionalExpression #980
// kills: filesystem-lock.ts:92:5 StringLiteral #982
// kills: filesystem-lock.ts:93:5 ObjectLiteral #983
// kills: filesystem-lock.ts:93:47 BooleanLiteral #984
// kills: filesystem-lock.ts:93:65 BooleanLiteral #985
test("pin: lock root is the exact system-sticky per-uid namespace, home fallback and impossible-root refusal included", async (t) => {
  if (process.getuid === undefined) {
    t.skip("POSIX-only path contract");
    return;
  }
  const { realpathSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const uid = process.getuid();

  // The default namespace: the SYSTEM-WIDE sticky dir (never a session TMPDIR), keyed by uid.
  const tmpReal = realpathSync("/tmp");
  assert.equal(
    filesystemMutationLockRoot(),
    path.join(tmpReal, `agentstate-lite-mutation-locks-uid-${uid}`),
  );

  // A portable root spanning /tmp forces the SECOND candidate: the exact home-dir namespace.
  const homeReal = realpathSync(homedir());
  assert.equal(
    filesystemMutationLockRoot(tmpReal),
    path.join(homeReal, ".agentstate", `mutation-locks-uid-${uid}`),
  );

  // A portable root containing EVERY candidate is refused with the typed, inspectable error.
  assert.throws(
    () => filesystemMutationLockRoot("/"),
    (err: unknown) => {
      assert.ok(err instanceof FilesystemMutationLockError);
      assert.equal(err.stale, false);
      assert.equal(err.malformed, true);
      assert.match(err.message, /cannot place filesystem mutation locks/);
      return true;
    },
  );
});

// kills: filesystem-lock.ts:279:13 ConditionalExpression #1187
// kills: filesystem-lock.ts:279:13 OptionalChaining #1189
// kills: filesystem-lock.ts:279:45 BlockStatement #1190
// kills: filesystem-lock.ts:281:13 StringLiteral #1191
// kills: filesystem-lock.ts:282:13 ObjectLiteral #1192
test("pin: release refuses a changed or malformed owner token and never removes the foreign lock", async () => {
  const root = await tempDir();
  try {
    const target = path.join(root, "doc.md");
    const release = await acquireFilesystemMutationLock(target);
    const canonicalTarget = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
    const lockPath = filesystemMutationLockPath(canonicalTarget);
    const ownerFile = path.join(lockPath, "owner.json");
    const original = await fs.readFile(ownerFile, "utf8");

    const foreign = { ...(JSON.parse(original) as Record<string, unknown>), token: "someone-else" };
    await fs.writeFile(ownerFile, JSON.stringify(foreign));
    await assert.rejects(
      () => release(),
      (err: unknown) => {
        assert.ok(err instanceof FilesystemMutationLockError);
        assert.match(err.message, /refusing to release/);
        assert.equal(err.owner?.token, "someone-else");
        assert.equal(err.stale, false);
        assert.equal(err.malformed, false);
        return true;
      },
    );
    assert.equal((await fs.stat(lockPath)).isDirectory(), true, "foreign lock must not be removed");

    // Malformed owner metadata is refused the SAME typed way (never a TypeError).
    await fs.writeFile(ownerFile, "not json");
    await assert.rejects(
      () => release(),
      (err: unknown) => err instanceof FilesystemMutationLockError && err.malformed === true,
    );
    assert.equal((await fs.stat(lockPath)).isDirectory(), true);

    // Restoring the token makes the SAME release closure succeed and clean up.
    await fs.writeFile(ownerFile, original);
    await release();
    await assert.rejects(() => fs.stat(lockPath));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// kills: filesystem-lock.ts:145:17 BlockStatement #1062
// kills: filesystem-lock.ts:146:12 ConditionalExpression #1064
test("pin: a live-but-unsignalable owner (PID 1, EPERM) is diagnosed HELD, never stale", async () => {
  const root = await tempDir();
  try {
    const target = path.join(root, "doc.md");
    const canonicalTarget = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
    const lockPath = filesystemMutationLockPath(canonicalTarget);
    await fs.mkdir(filesystemMutationLockRoot(), { recursive: true, mode: 0o700 });
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: 1, hostname: hostname(), created_at_ms: Date.now() - 60_000, token: "init", target: "unused" }),
    );

    await assert.rejects(
      () => acquireFilesystemMutationLock(target, { waitMs: 20, pollMs: 5 }),
      (err: unknown) => {
        assert.ok(err instanceof FilesystemMutationLockError);
        assert.equal(err.stale, false, "PID 1 exists (kill -0 → EPERM), so the lock is HELD, not stale");
        assert.equal(err.malformed, false);
        return true;
      },
    );
    await fs.rm(lockPath, { recursive: true, force: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// kills: filesystem-lock.ts:208:20 ConditionalExpression #1139
// kills: filesystem-lock.ts:209:17 LogicalOperator #1147
// kills: filesystem-lock.ts:211:7 ConditionalExpression #1151
// kills: filesystem-lock.ts:211:18 BlockStatement #1153
// kills: filesystem-lock.ts:213:7 StringLiteral #1154
// kills: filesystem-lock.ts:214:7 StringLiteral #1155
// kills: filesystem-lock.ts:215:14 ConditionalExpression #1156
// kills: filesystem-lock.ts:215:14 ConditionalExpression #1157
// kills: filesystem-lock.ts:215:21 BlockStatement #1158
// kills: filesystem-lock.ts:217:7 StringLiteral #1159
// kills: filesystem-lock.ts:218:7 StringLiteral #1160
// kills: filesystem-lock.ts:219:10 BlockStatement #1161
// kills: filesystem-lock.ts:221:7 StringLiteral #1162
test("pin: timeout diagnosis distinguishes held vs foreign-host vs malformed in flags AND operator guidance", async () => {
  // (a) live same-process owner → HELD message, stale flag false.
  {
    const root = await tempDir();
    try {
      const target = path.join(root, "doc.md");
      const release = await acquireFilesystemMutationLock(target);
      await assert.rejects(
        () => acquireFilesystemMutationLock(target, { waitMs: 20, pollMs: 5 }),
        (err: unknown) => {
          assert.ok(err instanceof FilesystemMutationLockError);
          assert.match(err.message, new RegExp(`held by PID ${process.pid} `));
          assert.doesNotMatch(err.message, /stale filesystem mutation lock/);
          return true;
        },
      );
      await release();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  // Helper: leave a crafted lock, collect the timeout error, clean up.
  const diagnose = async (owner: Record<string, unknown> | null) => {
    const root = await tempDir();
    try {
      const target = path.join(root, "doc.md");
      const canonicalTarget = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
      const lockPath = filesystemMutationLockPath(canonicalTarget);
      await fs.mkdir(filesystemMutationLockRoot(), { recursive: true, mode: 0o700 });
      await fs.mkdir(lockPath, { recursive: true });
      if (owner) await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner));
      let caught: unknown;
      try {
        await acquireFilesystemMutationLock(target, { waitMs: 20, pollMs: 5 });
      } catch (err) {
        caught = err;
      }
      await fs.rm(lockPath, { recursive: true, force: true });
      assert.ok(caught instanceof FilesystemMutationLockError);
      return caught;
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  };

  // (b) FOREIGN-host absent pid → NOT stale (we cannot probe another host's pids).
  const foreign = await diagnose({ pid: 999_999, hostname: "some-other-host", created_at_ms: Date.now() - 60_000, token: "far", target: "unused" });
  assert.equal(foreign.stale, false);
  assert.doesNotMatch(foreign.message, /stale filesystem mutation lock/);

  // (c) malformed owner metadata → malformed message with the confirm-first guidance.
  const malformed = await diagnose(null);
  assert.equal(malformed.malformed, true);
  assert.match(malformed.message, /owner metadata is missing or malformed/);
  assert.match(malformed.message, /only after confirming no process is mutating the target/);
});

/** A live process of this user that is not this one: a holder id that exists but did not claim the lock. */
function liveProcess(): { pid: number; stop(): Promise<void> } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return {
    pid: child.pid!,
    stop: async () => {
      child.kill("SIGKILL");
      await exited;
    },
  };
}

/** Plant a well-formed owner record in the harness target's lock, as a holder that never released it leaves it. */
async function plantLockOwner(
  harness: Awaited<ReturnType<typeof isolatedLockPaths>>,
  owner: { pid: number; hostname: string; created_at_ms: number; token: string },
): Promise<string> {
  const release = await acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot });
  const entry = (await fs.readdir(harness.lockRoot)).find((name) => name.endsWith(".lock"));
  await release();
  const lockPath = path.join(harness.lockRoot, entry!);
  await fs.mkdir(lockPath);
  await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ ...owner, target: harness.target }));
  return lockPath;
}

async function plantedToken(lockPath: string): Promise<string> {
  return (JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as { token: string }).token;
}

test("a same-host holder whose process id is live is diagnosed as possibly reused, naming the lock, and is never reclaimed", async () => {
  const harness = await isolatedLockPaths();
  const reuser = liveProcess();
  try {
    const lockPath = await plantLockOwner(harness, { pid: reuser.pid, hostname: hostname(), created_at_ms: Date.now() - 10 * 24 * 60 * 60 * 1000, token: "reused" });
    await assert.rejects(
      () => acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot, waitMs: 20, pollMs: 5 }),
      (err: unknown) => {
        assert.ok(err instanceof FilesystemMutationLockError);
        assert.equal(err.lockPath, lockPath);
        assert.equal(err.stale, false);
        assert.equal(err.malformed, false);
        assert.ok(err.message.includes(`'${lockPath}' held by PID ${reuser.pid} `), err.message);
        assert.match(err.message, new RegExp(`PID ${reuser.pid} may no longer be the process that claimed it`));
        assert.match(err.message, /remove the lock only after confirming no process is mutating the target/);
        return true;
      },
    );
    assert.equal(await plantedToken(lockPath), "reused");
  } finally {
    await reuser.stop();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("a holder recorded on another host is diagnosed as needing a person, naming the lock, and is never reclaimed", async () => {
  const harness = await isolatedLockPaths();
  try {
    const lockPath = await plantLockOwner(harness, { pid: 999_999, hostname: "renamed-host", created_at_ms: Date.now() - 60_000, token: "renamed" });
    await assert.rejects(
      () => acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot, waitMs: 20, pollMs: 5 }),
      (err: unknown) => {
        assert.ok(err instanceof FilesystemMutationLockError);
        assert.equal(err.lockPath, lockPath);
        assert.equal(err.stale, false);
        assert.equal(err.malformed, false);
        assert.ok(err.message.includes(`'${lockPath}' is held by PID 999999 on renamed-host, which is not this host (${hostname()})`), err.message);
        assert.match(err.message, /never reclaimed automatically\. A person must check it/);
        assert.doesNotMatch(err.message, /retry the mutation/);
        return true;
      },
    );
    assert.equal(await plantedToken(lockPath), "renamed");
  } finally {
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("a record naming this process's own id is reclaimed only when an earlier process wrote it", async () => {
  const harness = await isolatedLockPaths();
  const options = { lockRoot: harness.lockRoot, waitMs: 20, pollMs: 5 };
  const held = (err: unknown) => err instanceof FilesystemMutationLockError && !err.stale && !err.malformed && err.owner?.pid === process.pid;
  try {
    // Left by an earlier process that had this id (a container entry point after a restart): reclaimed.
    const lockPath = await plantLockOwner(harness, { pid: process.pid, hostname: hostname(), created_at_ms: Date.now() - 10 * 24 * 60 * 60 * 1000, token: "earlier-process" });
    const release = await acquireFilesystemMutationLock(harness.target, options);
    assert.ok((await fs.readdir(harness.lockRoot)).some((entry) => entry.startsWith(`${path.basename(lockPath)}.stale-`)), "the earlier process's lock is quarantined");
    assert.notEqual(await plantedToken(lockPath), "earlier-process");

    // This process's own claim stays held even when its record looks older than this process.
    const record = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as Record<string, unknown>;
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ ...record, created_at_ms: Date.now() - 10 * 24 * 60 * 60 * 1000 }));
    await assert.rejects(() => acquireFilesystemMutationLock(harness.target, options), held);
    await release();

    // A record this process did not write but that is younger than this process is not provably an
    // earlier process's, so it stays held.
    const younger = await plantLockOwner(harness, { pid: process.pid, hostname: hostname(), created_at_ms: Date.now(), token: "younger" });
    await assert.rejects(() => acquireFilesystemMutationLock(harness.target, options), held);
    assert.equal(await plantedToken(younger), "younger");
  } finally {
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("a claim by another copy of the lock module in this process stays held after the wall clock jumps past it", async () => {
  const harness = await isolatedLockPaths();
  const copy = (await import(new URL("../src/filesystem-lock.ts?second-copy", import.meta.url).href)) as typeof import("../src/filesystem-lock.js");
  assert.notEqual(copy.acquireFilesystemMutationLock, acquireFilesystemMutationLock);
  const realNow = Date.now;
  try {
    const release = await acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot });
    // A suspend or a forward clock step: the wall clock moves while this process's uptime does not.
    Date.now = () => realNow() + 60 * 60 * 1000;
    await assert.rejects(
      () => copy.acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot, waitMs: 20, pollMs: 5 }),
      (err: unknown) => err instanceof copy.FilesystemMutationLockError && !err.stale && err.owner?.pid === process.pid,
    );
    Date.now = realNow;
    await release();
  } finally {
    Date.now = realNow;
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("an explicit lock root isolates runtime state while preserving the portable-root boundary", async () => {
  const harness = await isolatedLockPaths();
  try {
    const release = await acquireFilesystemMutationLock(harness.target, {
      portableRoot: harness.portableRoot,
      lockRoot: harness.lockRoot,
    });
    const entries = await fs.readdir(harness.lockRoot);
    assert.equal(entries.length, 1);
    assert.match(entries[0]!, /^[a-f0-9]{64}\.lock$/);
    assert.equal((await fs.stat(harness.lockRoot)).mode & 0o777, 0o700);
    await release();
    assert.deepEqual(await fs.readdir(harness.lockRoot), []);

    const nestedLockRoot = path.join(harness.root, "missing-parent", "runtime");
    const releaseNested = await acquireFilesystemMutationLock(harness.target, {
      portableRoot: harness.portableRoot,
      lockRoot: nestedLockRoot,
    });
    assert.equal((await fs.stat(nestedLockRoot)).isDirectory(), true);
    await releaseNested();

    await assert.rejects(
      () =>
        acquireFilesystemMutationLock(harness.target, {
          portableRoot: path.join(harness.root, "not-created-yet"),
          lockRoot: path.join(harness.root, "not-created-yet", "locks"),
        }),
      (err: unknown) => {
        assert.ok(err instanceof FilesystemMutationLockError);
        assert.equal(err.stale, false);
        assert.equal(err.malformed, true);
        assert.match(err.message, /cannot place filesystem mutation locks/);
        return true;
      },
    );
  } finally {
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("private lock-root policy rejects each unsafe fact independently", () => {
  const valid = {
    directory: true,
    symbolicLink: false,
    ownerUid: 501,
    expectedUid: 501,
    mode: 0o40700,
    enforcePrivateMode: true,
  };
  assert.equal(isPrivateFilesystemMutationLockRoot(valid), true);

  const unsafe = [
    { name: "not a directory", facts: { ...valid, directory: false } },
    { name: "symbolic link", facts: { ...valid, symbolicLink: true } },
    { name: "foreign owner", facts: { ...valid, ownerUid: 502 } },
    { name: "group-readable", facts: { ...valid, mode: 0o40740 } },
  ];
  for (const fixture of unsafe) {
    assert.equal(isPrivateFilesystemMutationLockRoot(fixture.facts), false, fixture.name);
  }
  assert.equal(
    isPrivateFilesystemMutationLockRoot({ ...valid, expectedUid: undefined, ownerUid: 999 }),
    true,
    "platforms without numeric uid do not invent an ownership comparison",
  );
  assert.equal(
    isPrivateFilesystemMutationLockRoot({ ...valid, mode: 0o40777, enforcePrivateMode: false }),
    true,
    "platforms without POSIX modes do not enforce POSIX bits",
  );
});

test("an injected lock root exercises file, symlink, and mode refusals without shared state", async (t) => {
  const cases = ["file", "symlink", "mode"] as const;
  for (const kind of cases) {
    await t.test(kind, async () => {
      const harness = await isolatedLockPaths();
      try {
        if (kind === "file") await fs.writeFile(harness.lockRoot, "not a directory");
        if (kind === "symlink") {
          const realRoot = path.join(harness.root, "real-runtime");
          await fs.mkdir(realRoot, { mode: 0o700 });
          await fs.symlink(realRoot, harness.lockRoot, "dir");
        }
        if (kind === "mode") await fs.mkdir(harness.lockRoot, { mode: 0o755 });

        await assert.rejects(
          () =>
            acquireFilesystemMutationLock(harness.target, {
              portableRoot: harness.portableRoot,
              lockRoot: harness.lockRoot,
            }),
          (err: unknown) => {
            assert.ok(err instanceof FilesystemMutationLockError);
            assert.equal(err.lockPath, path.resolve(harness.lockRoot));
            assert.equal(err.owner, null);
            assert.equal(err.stale, false);
            assert.equal(err.malformed, true);
            assert.match(err.message, /refusing unsafe filesystem mutation lock root/);
            return true;
          },
        );
      } finally {
        await fs.rm(harness.root, { recursive: true, force: true });
      }
    });
  }
});

test("owner metadata is accepted only when every field has its exact safe shape", () => {
  const valid = {
    pid: process.pid,
    hostname: hostname(),
    created_at_ms: Date.now(),
    token: "token",
    target: "/tmp/doc.md",
  };
  assert.deepEqual(parseFilesystemMutationLockOwner(valid), valid);

  const invalid = [
    ["null", null],
    ["array", []],
    ["string", "owner"],
    ["missing fields", {}],
    ["pid string", { ...valid, pid: "1" }],
    ["pid fraction", { ...valid, pid: 1.5 }],
    ["pid zero", { ...valid, pid: 0 }],
    ["pid negative", { ...valid, pid: -1 }],
    ["pid unsafe", { ...valid, pid: Number.MAX_SAFE_INTEGER + 1 }],
    ["hostname number", { ...valid, hostname: 1 }],
    ["hostname empty", { ...valid, hostname: "" }],
    ["created_at_ms string", { ...valid, created_at_ms: "1" }],
    ["created_at_ms infinite", { ...valid, created_at_ms: Number.POSITIVE_INFINITY }],
    ["token number", { ...valid, token: 1 }],
    ["token empty", { ...valid, token: "" }],
    ["target number", { ...valid, target: 1 }],
    ["target empty", { ...valid, target: "" }],
  ] as const;
  for (const [name, value] of invalid) {
    assert.equal(parseFilesystemMutationLockOwner(value), null, name);
  }
});

test("wait and poll options accept zero and reject every non-safe-integer class", async () => {
  const harness = await isolatedLockPaths();
  try {
    const invalid = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
    for (const value of invalid) {
      await assert.rejects(
        () => acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot, waitMs: value }),
        (err: unknown) => err instanceof TypeError && /waitMs must be a non-negative safe integer/.test(err.message),
      );
      await assert.rejects(
        () => acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot, pollMs: value }),
        (err: unknown) => err instanceof TypeError && /pollMs must be a non-negative safe integer/.test(err.message),
      );
    }

    const release = await acquireFilesystemMutationLock(harness.target, {
      lockRoot: harness.lockRoot,
      waitMs: 0,
      pollMs: 0,
    });
    await release();
  } finally {
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("lock-root creation and lock claims propagate non-contention filesystem failures", async () => {
  const harness = await isolatedLockPaths();
  const originalMkdir = fs.mkdir;
  const rootFailure = Object.assign(new Error("root denied"), { code: "EACCES" });
  let restore = replaceFsMethod("mkdir", (...args) => {
    if (path.resolve(String(args[0])) === path.resolve(harness.lockRoot)) return Promise.reject(rootFailure);
    return Reflect.apply(originalMkdir, fs, args);
  });
  try {
    await assert.rejects(
      () => acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot }),
      (err: unknown) => err === rootFailure,
    );
  } finally {
    restore();
  }

  await fs.mkdir(harness.lockRoot, { mode: 0o700 });
  // Sharing-shaped Windows errors are covered below: when the exact claim path remains
  // observable they are contention, not terminal permission failures. Use an error class that
  // can never mean directory contention here so this row remains host-independent.
  const claimFailure = Object.assign(new Error("claim I/O failure"), { code: "EIO" });
  restore = replaceFsMethod("mkdir", (...args) => {
    if (String(args[0]).endsWith(".lock")) return Promise.reject(claimFailure);
    return Reflect.apply(originalMkdir, fs, args);
  });
  try {
    await assert.rejects(
      () => acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot, waitMs: 0 }),
      (err: unknown) => err === claimFailure,
    );
  } finally {
    restore();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

const contentionPolicy = {
  ...captureFilesystemHostPolicy(),
  isDirectoryContentionError: (error: unknown) => (error as { code?: string })?.code === "TEST_CONTENTION",
};

test("host-classified lock claims bound an unwitnessed sharing-error retry and propagate durable denial", async () => {
  const harness = await isolatedLockPaths();
  const originalMkdir = fs.mkdir;
  const originalLstat = fs.lstat;
  let restoreMkdir = () => {};
  let restoreLstat = () => {};
  try {
    const transient = Object.assign(new Error("transient claim collision"), { code: "TEST_CONTENTION" });
    let claimAttempts = 0;
    restoreMkdir = replaceFsMethod("mkdir", (...args) => {
      if (String(args[0]).endsWith(".lock") && claimAttempts++ === 0) return Promise.reject(transient);
      return Reflect.apply(originalMkdir, fs, args);
    });
    const release = await acquireFilesystemMutationLock(harness.target, {
      lockRoot: harness.lockRoot, hostPolicy: contentionPolicy,
      waitMs: 100,
      pollMs: 0,
    });
    assert.equal(claimAttempts, 2);
    await release();
    restoreMkdir();
    restoreMkdir = () => {};

    const absentDenial = Object.assign(new Error("durable create denial on an absent path"), { code: "TEST_CONTENTION" });
    let absentDenialAttempts = 0;
    restoreMkdir = replaceFsMethod("mkdir", (...args) => {
      if (String(args[0]).endsWith(".lock")) {
        absentDenialAttempts += 1;
        return Promise.reject(absentDenial);
      }
      return Reflect.apply(originalMkdir, fs, args);
    });
    await assert.rejects(
      () => acquireFilesystemMutationLock(harness.target, {
        lockRoot: harness.lockRoot, hostPolicy: contentionPolicy,
        waitMs: 0,
        pollMs: 0,
      }),
      (error: unknown) => error === absentDenial,
    );
    assert.equal(absentDenialAttempts, 2);
    restoreMkdir();
    restoreMkdir = () => {};

    const durable = Object.assign(new Error("claim path denied"), { code: "TEST_CONTENTION" });
    restoreMkdir = replaceFsMethod("mkdir", (...args) => {
      if (String(args[0]).endsWith(".lock")) return Promise.reject(durable);
      return Reflect.apply(originalMkdir, fs, args);
    });
    restoreLstat = replaceFsMethod("lstat", (...args) => {
      if (String(args[0]).endsWith(".lock")) return Promise.reject(durable);
      return Reflect.apply(originalLstat, fs, args);
    });
    await assert.rejects(
      () => acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot, hostPolicy: contentionPolicy }),
      (error: unknown) => error === durable,
    );
  } finally {
    restoreLstat();
    restoreMkdir();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("host-classified stale-lock quarantine retries transient sharing errors and leaves durable denial fail-closed", async (t) => {
  const originalRename = fs.rename;
  {
    await t.test("transient", async () => {
      const harness = await isolatedLockPaths();
      const lockPath = await lockPathInRoot(harness.target, harness.lockRoot);
      await fs.mkdir(harness.lockRoot, { recursive: true, mode: 0o700 });
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({
          pid: 999_999,
          hostname: hostname(),
          created_at_ms: Date.now() - 60_000,
          token: "host-transient",
          target: harness.target,
        }),
      );
      let renameAttempts = 0;
      const sharingError = Object.assign(new Error("transient rename contention"), { code: "TEST_CONTENTION" });
      const restore = replaceFsMethod("rename", (...args) => {
        if (path.resolve(String(args[0])) === path.resolve(lockPath) && renameAttempts++ === 0) {
          return Promise.reject(sharingError);
        }
        return Reflect.apply(originalRename, fs, args);
      });
      try {
        const release = await acquireFilesystemMutationLock(harness.target, {
          portableRoot: harness.portableRoot,
          lockRoot: harness.lockRoot, hostPolicy: contentionPolicy,
          waitMs: 100,
          pollMs: 0,
        });
        assert.equal(renameAttempts, 2);
        await release();
      } finally {
        restore();
        await fs.rm(harness.root, { recursive: true, force: true });
      }
    });

    await t.test("durable", async () => {
      const harness = await isolatedLockPaths();
      const lockPath = await lockPathInRoot(harness.target, harness.lockRoot);
      await fs.mkdir(harness.lockRoot, { recursive: true, mode: 0o700 });
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({
          pid: 999_999,
          hostname: hostname(),
          created_at_ms: Date.now() - 60_000,
          token: "host-durable",
          target: harness.target,
        }),
      );
      const sharingError = Object.assign(new Error("durable rename denial"), { code: "TEST_CONTENTION" });
      const restore = replaceFsMethod("rename", (...args) => {
        if (path.resolve(String(args[0])) === path.resolve(lockPath)) return Promise.reject(sharingError);
        return Reflect.apply(originalRename, fs, args);
      });
      try {
        await assert.rejects(
          () => acquireFilesystemMutationLock(harness.target, {
            portableRoot: harness.portableRoot,
            lockRoot: harness.lockRoot, hostPolicy: contentionPolicy,
            waitMs: 0,
            pollMs: 0,
          }),
          (err: unknown) => {
            assert.ok(err instanceof FilesystemMutationLockError);
            assert.equal(err.stale, true);
            assert.equal(err.owner?.token, "host-durable");
            return true;
          },
        );
        assert.equal((await fs.stat(lockPath)).isDirectory(), true);
      } finally {
        restore();
        await fs.rm(harness.root, { recursive: true, force: true });
      }
    });
  }
});

test("owner-record failure preserves exclusive-create flags and rolls back the claimed directory", async () => {
  const harness = await isolatedLockPaths();
  const originalWriteFile = fs.writeFile;
  const writeFailure = Object.assign(new Error("owner write failed"), { code: "EIO" });
  let observedOptions: unknown;
  const restore = replaceFsMethod("writeFile", (...args) => {
    if (path.basename(String(args[0])) === "owner.json") {
      observedOptions = args[2];
      return Promise.reject(writeFailure);
    }
    return Reflect.apply(originalWriteFile, fs, args);
  });
  try {
    await assert.rejects(
      () => acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot, hostPolicy: contentionPolicy }),
      (err: unknown) => err === writeFailure,
    );
    assert.deepEqual(observedOptions, { encoding: "utf8", flag: "wx", mode: 0o600 });
    assert.deepEqual(await fs.readdir(harness.lockRoot), []);
  } finally {
    restore();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("owner-record failure leaves a directory that is not the one this claim made", async () => {
  const harness = await isolatedLockPaths();
  const originalWriteFile = fs.writeFile;
  const writeFailure = Object.assign(new Error("owner write failed"), { code: "EIO" });
  let lockPath = "";
  // While this claimer is suspended, its directory is removed and another claim makes a new one.
  const restore = replaceFsMethod("writeFile", async (...args) => {
    if (path.basename(String(args[0])) === "owner.json") {
      lockPath = path.dirname(String(args[0]));
      await fs.rm(lockPath, { recursive: true });
      await fs.mkdir(lockPath);
      throw writeFailure;
    }
    return Reflect.apply(originalWriteFile, fs, args);
  });
  try {
    await assert.rejects(
      () => acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot }),
      (err: unknown) => err === writeFailure,
    );
    assert.deepEqual(await fs.readdir(harness.lockRoot), [path.basename(lockPath)]);
  } finally {
    restore();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("an owner write that meets another claimer's opened but unwritten record leaves the lock to that claimer", async () => {
  const harness = await isolatedLockPaths();
  const originalWriteFile = fs.writeFile;
  let other: import("node:fs/promises").FileHandle | undefined;
  let lockPath = "";
  // A resumed claimer has opened owner.json inside this claim's fresh directory but not yet written it.
  const restore = replaceFsMethod("writeFile", async (...args) => {
    if (path.basename(String(args[0])) === "owner.json" && other === undefined) {
      lockPath = path.dirname(String(args[0]));
      other = await fs.open(String(args[0]), "wx", 0o600);
    }
    return Reflect.apply(originalWriteFile, fs, args);
  });
  try {
    await assert.rejects(
      () => acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot, waitMs: 50, pollMs: 5 }),
      (err: unknown) => err instanceof FilesystemMutationLockError && err.malformed && err.lockPath === lockPath,
    );
    // The other claimer's directory, and its still-empty record, are where it left them.
    assert.equal(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"), "");
    assert.deepEqual(await fs.readdir(harness.lockRoot), [path.basename(lockPath)]);
  } finally {
    restore();
    await other?.close();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("owner-record host-classified sharing failures never re-enter claim contention", async () => {
  const harness = await isolatedLockPaths();
  const originalWriteFile = fs.writeFile;
  const originalRm = fs.rm;
  const writeFailure = Object.assign(new Error("owner write denied"), { code: "TEST_CONTENTION" });
  const rollbackFailure = Object.assign(new Error("rollback denied"), { code: "TEST_CONTENTION" });
  let restoreWriteFile = () => {};
  let restoreRm = () => {};
  let rollbackAttempted = false;
  try {
    restoreWriteFile = replaceFsMethod("writeFile", (...args) => {
      if (path.basename(String(args[0])) === "owner.json") return Promise.reject(writeFailure);
      return Reflect.apply(originalWriteFile, fs, args);
    });
    restoreRm = replaceFsMethod("rm", (...args) => {
      // Rollback moves the claimed directory to its token-derived remnant, then removes that.
      if (/\.lock\.released-[0-9a-f]{64}$/.test(String(args[0]))) {
        rollbackAttempted = true;
        return Promise.reject(rollbackFailure);
      }
      return Reflect.apply(originalRm, fs, args);
    });
    await assert.rejects(
      () => acquireFilesystemMutationLock(harness.target, {
        lockRoot: harness.lockRoot, hostPolicy: contentionPolicy,
        waitMs: 0,
        pollMs: 0,
      }),
      (error: unknown) => error === writeFailure,
    );
    assert.equal(rollbackAttempted, true);
  } finally {
    restoreRm();
    restoreWriteFile();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("release reports removal failures with complete typed details", async () => {
  const harness = await isolatedLockPaths();
  try {
    const release = await acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot });
    const [lockName] = await fs.readdir(harness.lockRoot);
    assert.ok(lockName);
    const lockPath = path.join(harness.lockRoot, lockName);
    const originalRm = fs.rm;
    // Release renames the verified directory to a token-derived remnant first, then removes that.
    const restore = replaceFsMethod("rm", (...args) => {
      if (String(args[0]).startsWith(`${lockPath}.released-`)) return Promise.reject(new Error("busy"));
      return Reflect.apply(originalRm, fs, args);
    });
    try {
      await assert.rejects(
        () => release(),
        (err: unknown) => {
          assert.ok(err instanceof FilesystemMutationLockError);
          assert.ok(err.lockPath.startsWith(`${lockPath}.released-`));
          assert.equal(err.owner?.pid, process.pid);
          assert.equal(err.stale, false);
          assert.equal(err.malformed, false);
          assert.match(err.message, /mutation completed but filesystem lock .* was released yet its remnant/);
          assert.match(err.message, /busy/);
          return true;
        },
      );
      // The lock key itself is free: the remnant, not the lock, is what leaked.
      assert.equal(await fs.lstat(lockPath).then(() => true, () => false), false);
    } finally {
      restore();
      await fs.rm(harness.root, { recursive: true, force: true });
    }
  } catch (err) {
    await fs.rm(harness.root, { recursive: true, force: true });
    throw err;
  }
});

test("canonical-target probing propagates errors and skips redundant scans for exact entries", async () => {
  const harness = await isolatedLockPaths();
  await fs.writeFile(harness.target, "x");
  const canonicalTarget = path.join(
    await fs.realpath(path.dirname(harness.target)),
    path.basename(harness.target),
  );
  const originalLstat = fs.lstat;
  const probeFailure = Object.assign(new Error("probe denied"), { code: "EACCES" });
  let restore = replaceFsMethod("lstat", (...args) => {
    if (path.resolve(String(args[0])) === canonicalTarget) return Promise.reject(probeFailure);
    return Reflect.apply(originalLstat, fs, args);
  });
  try {
    await assert.rejects(
      () => acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot }),
      (err: unknown) => err === probeFailure,
    );
  } finally {
    restore();
  }

  let targetProbes = 0;
  restore = replaceFsMethod("lstat", (...args) => {
    if (path.resolve(String(args[0])) === canonicalTarget) {
      targetProbes += 1;
      if (targetProbes > 1) return Promise.reject(new Error("redundant target scan"));
    }
    return Reflect.apply(originalLstat, fs, args);
  });
  try {
    const release = await acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot });
    assert.equal(targetProbes, 1);
    await release();
  } finally {
    restore();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

const releaseContention = Object.assign(new Error("owner record still open by a polling claimer"), { code: "TEST_CONTENTION" });

async function heldLock(options: { hostPolicy?: FilesystemHostPolicy; waitMs: number; pollMs: number }) {
  const harness = await isolatedLockPaths();
  const release = await acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot, ...options });
  const lockPath = await lockPathInRoot(harness.target, harness.lockRoot);
  assert.ok(await pathExists(lockPath));
  return { harness, release, lockPath, ownerFile: path.join(lockPath, "owner.json") };
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.lstat(candidate).then(() => true, () => false);
}

async function lockRootEntries(lockRoot: string): Promise<string[]> {
  return (await fs.readdir(lockRoot)).sort();
}

function interceptRename(lockPath: string, onLockRename: (attempt: number, args: unknown[]) => Promise<unknown>): () => void {
  const originalRename = fs.rename;
  let attempt = 0;
  return replaceFsMethod("rename", (...args) => {
    if (path.resolve(String(args[0])) !== path.resolve(lockPath)) return Reflect.apply(originalRename, fs, args);
    attempt += 1;
    return onLockRename(attempt, args).then(() => Reflect.apply(originalRename, fs, args));
  });
}

test("host-classified release retries a contended rename within the bounded budget and then frees the lock root", async () => {
  const { harness, release, lockPath } = await heldLock({ hostPolicy: contentionPolicy, waitMs: 2_000, pollMs: 1 });
  let attempts = 0;
  const restore = interceptRename(lockPath, async (attempt) => {
    attempts = attempt;
    if (attempt <= 2) throw releaseContention;
  });
  try {
    await release();
    assert.equal(attempts, 3);
    assert.deepEqual(await lockRootEntries(harness.lockRoot), [], "no lock and no remnant may remain");
    const releaseAgain = await acquireFilesystemMutationLock(harness.target, {
      lockRoot: harness.lockRoot, hostPolicy: contentionPolicy, waitMs: 0, pollMs: 0,
    });
    await releaseAgain();
  } finally {
    restore();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("host-classified release retries a contended remnant removal and reports a durable remnant denial", async () => {
  const { harness, release, lockPath } = await heldLock({ hostPolicy: contentionPolicy, waitMs: 2_000, pollMs: 1 });
  const originalRm = fs.rm;
  let attempts = 0;
  let restore = replaceFsMethod("rm", (...args) => {
    if (!String(args[0]).startsWith(`${lockPath}.released-`)) return Reflect.apply(originalRm, fs, args);
    attempts += 1;
    if (attempts <= 2) return Promise.reject(releaseContention);
    return Reflect.apply(originalRm, fs, args);
  });
  try {
    await release();
    assert.equal(attempts, 3);
    assert.deepEqual(await lockRootEntries(harness.lockRoot), []);
  } finally {
    restore();
  }

  const second = await acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot, hostPolicy: contentionPolicy, waitMs: 40, pollMs: 1 });
  attempts = 0;
  restore = replaceFsMethod("rm", (...args) => {
    if (!String(args[0]).startsWith(`${lockPath}.released-`)) return Reflect.apply(originalRm, fs, args);
    attempts += 1;
    return Promise.reject(releaseContention);
  });
  try {
    await assert.rejects(
      () => second(),
      (err: unknown) => {
        assert.ok(err instanceof FilesystemMutationLockError);
        assert.match(err.message, /was released yet its remnant .* could not be removed after \d+ bounded attempts/);
        assert.ok(err.lockPath.startsWith(`${lockPath}.released-`));
        return true;
      },
    );
    assert.ok(attempts >= 2);
    // The lock key is free even though the remnant leaked, so the next claim is not wedged.
    assert.equal(await pathExists(lockPath), false);
    const entries = await lockRootEntries(harness.lockRoot);
    assert.equal(entries.length, 1);
    assert.ok(entries[0]!.startsWith(`${path.basename(lockPath)}.released-`));
    const third = await acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot, hostPolicy: contentionPolicy, waitMs: 0, pollMs: 0 });
    restore();
    restore = () => {};
    await third();
  } finally {
    restore();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("host-classified release keeps a durable rename denial bounded, typed, and fail-closed", async () => {
  const { harness, release, lockPath, ownerFile } = await heldLock({ hostPolicy: contentionPolicy, waitMs: 40, pollMs: 1 });
  const record = await fs.readFile(ownerFile, "utf8");
  let attempts = 0;
  const restore = interceptRename(lockPath, async (attempt) => {
    attempts = attempt;
    throw releaseContention;
  });
  try {
    const started = Date.now();
    await assert.rejects(
      () => release(),
      (err: unknown) => {
        assert.ok(err instanceof FilesystemMutationLockError);
        assert.equal(err.lockPath, lockPath);
        assert.equal(err.owner?.pid, process.pid);
        assert.equal(err.stale, false);
        assert.equal(err.malformed, false);
        assert.match(err.message, /mutation completed but filesystem lock .* could not be removed after \d+ bounded attempts/);
        assert.match(err.message, /still open by a polling claimer/);
        return true;
      },
    );
    assert.ok(attempts >= 2, `expected bounded retries, saw ${attempts}`);
    assert.ok(Date.now() - started < 1_500, "a durable denial must not wait past the bounded budget");
    // The lock and its record are retained intact for inspection, never force-deleted.
    assert.equal(await fs.readFile(ownerFile, "utf8"), record);
  } finally {
    restore();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("release refuses when the directory changed hands or lost its record during rename retries", async (t) => {
  for (const shape of ["foreign-record", "record-less-claim"] as const) {
    await t.test(shape, async () => {
      const { harness, release, lockPath, ownerFile } = await heldLock({ hostPolicy: contentionPolicy, waitMs: 2_000, pollMs: 1 });
      const foreign = JSON.parse(await fs.readFile(ownerFile, "utf8")) as Record<string, unknown>;
      foreign.token = "foreign-live-replacement";
      let attempts = 0;
      const restore = interceptRename(lockPath, async (attempt) => {
        attempts = attempt;
        // Another actor removed this directory and a competitor claimed the key while this
        // rename was delayed; the competitor may not have written its record yet.
        await fs.rm(lockPath, { recursive: true, force: true });
        await fs.mkdir(lockPath, { mode: 0o700 });
        if (shape === "foreign-record") await fs.writeFile(ownerFile, `${JSON.stringify(foreign)}\n`, "utf8");
        throw releaseContention;
      });
      try {
        await assert.rejects(
          () => release(),
          (err: unknown) => {
            assert.ok(err instanceof FilesystemMutationLockError);
            assert.match(err.message, /refusing to release/);
            assert.equal(err.malformed, shape === "record-less-claim");
            if (shape === "foreign-record") assert.equal(err.owner?.token, "foreign-live-replacement");
            return true;
          },
        );
        assert.equal(attempts, 1);
        assert.equal(await pathExists(lockPath), true, "the competitor's claim directory must survive");
        if (shape === "foreign-record") assert.deepEqual(JSON.parse(await fs.readFile(ownerFile, "utf8")), foreign);
        else assert.deepEqual(await fs.readdir(lockPath), []);
      } finally {
        restore();
        await fs.rm(harness.root, { recursive: true, force: true });
      }
    });
  }
});

test("a lock directory that disappears during rename retries counts as released", async () => {
  const { harness, release, lockPath } = await heldLock({ hostPolicy: contentionPolicy, waitMs: 2_000, pollMs: 1 });
  let attempts = 0;
  const restore = interceptRename(lockPath, async (attempt) => {
    attempts = attempt;
    if (attempt === 1) {
      await fs.rm(lockPath, { recursive: true, force: true });
      throw releaseContention;
    }
  });
  try {
    await release();
    // The re-read before the retry already proves the directory is gone; no second rename runs.
    assert.equal(attempts, 1);
    assert.deepEqual(await lockRootEntries(harness.lockRoot), []);
  } finally {
    restore();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("a concurrently invoked release shares one in-flight removal and a later invocation refuses", async () => {
  const { harness, release, lockPath, ownerFile } = await heldLock({ hostPolicy: contentionPolicy, waitMs: 2_000, pollMs: 50 });
  let attempts = 0;
  const restoreRename = interceptRename(lockPath, async (attempt) => {
    attempts = attempt;
    if (attempt === 1) throw releaseContention;
  });
  const originalReadFile = fs.readFile;
  let ownerReads = 0;
  const restoreReadFile = replaceFsMethod("readFile", (...args) => {
    if (path.resolve(String(args[0])) === path.resolve(ownerFile)) ownerReads += 1;
    return Reflect.apply(originalReadFile, fs, args);
  });
  const restore = () => {
    restoreReadFile();
    restoreRename();
  };
  try {
    // The first invocation's rename is delayed by contention; the second arrives meanwhile and
    // must join it rather than race it with its own ownership check and rename.
    const first = release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = release();
    await Promise.all([first, second]);
    assert.equal(attempts, 2, "one contended rename plus one retry; the joined invocation renamed nothing");
    assert.equal(ownerReads, 2, "one verification plus one retry re-read; the joined invocation read nothing");
    assert.deepEqual(await lockRootEntries(harness.lockRoot), []);
    // A competitor's claim made after the release is untouched by anything the closure does later.
    const competitorRelease = await acquireFilesystemMutationLock(harness.target, {
      lockRoot: harness.lockRoot, hostPolicy: contentionPolicy, waitMs: 0, pollMs: 0,
    });
    const competitorRecord = await fs.readFile(path.join(lockPath, "owner.json"), "utf8");
    await assert.rejects(release(), (err: unknown) => err instanceof FilesystemMutationLockError && /refusing to release/.test(err.message));
    assert.equal(attempts, 2);
    assert.equal(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"), competitorRecord);
    await competitorRelease();
    assert.deepEqual(await lockRootEntries(harness.lockRoot), []);
  } finally {
    restore();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("a remnant that disappears during removal retries counts as released", async () => {
  const { harness, release, lockPath } = await heldLock({ hostPolicy: contentionPolicy, waitMs: 2_000, pollMs: 1 });
  const originalRm = fs.rm;
  let attempts = 0;
  const restore = replaceFsMethod("rm", async (...args) => {
    if (!String(args[0]).startsWith(`${lockPath}.released-`)) return Reflect.apply(originalRm, fs, args);
    attempts += 1;
    if (attempts === 1) {
      await Reflect.apply(originalRm, fs, [args[0], { recursive: true, force: true }]);
      throw releaseContention;
    }
    return Reflect.apply(originalRm, fs, args);
  });
  try {
    await release();
    assert.equal(attempts, 2);
    assert.deepEqual(await lockRootEntries(harness.lockRoot), []);
  } finally {
    restore();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("the supported default policy keeps release single-shot even for a sharing-shaped error", async () => {
  const { harness, release, lockPath, ownerFile } = await heldLock({ waitMs: 2_000, pollMs: 1 });
  let attempts = 0;
  const restore = interceptRename(lockPath, async (attempt) => {
    attempts = attempt;
    throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
  });
  try {
    await assert.rejects(
      () => release(),
      (err: unknown) => err instanceof FilesystemMutationLockError && /could not be removed \(resource busy\)/.test(err.message),
    );
    assert.equal(attempts, 1);
    assert.equal(await pathExists(ownerFile), true);
  } finally {
    restore();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

const unreadableRecord = Object.assign(new Error("owner record open denied by a scanner"), { code: "EBUSY" });

/** Let `skip` reads of this lock's owner record through, fail the next `failures`, then resume. */
function interceptOwnerRead(
  ownerFile: string,
  failures: number,
  options: { skip?: number; error?: unknown } = {},
): { restore: () => void; reads: () => number } {
  const skip = options.skip ?? 0;
  const error = options.error ?? unreadableRecord;
  const originalReadFile = fs.readFile;
  let reads = 0;
  const restore = replaceFsMethod("readFile", (...args) => {
    if (path.resolve(String(args[0])) !== path.resolve(ownerFile)) return Reflect.apply(originalReadFile, fs, args);
    reads += 1;
    return reads > skip && reads <= skip + failures
      ? Promise.reject(error)
      : Reflect.apply(originalReadFile, fs, args);
  });
  return { restore, reads: () => reads };
}

test("release polls out an unreadable owner record instead of abandoning a lock it still owns", async (t) => {
  await t.test("during the initial ownership check", async () => {
    const { harness, release, lockPath, ownerFile } = await heldLock({ waitMs: 2_000, pollMs: 1 });
    const record = await fs.readFile(ownerFile, "utf8");
    const reader = interceptOwnerRead(ownerFile, 3);
    try {
      await release();
      assert.equal(reader.reads(), 4, "three indeterminate reads, then the definitive one");
      assert.deepEqual(await lockRootEntries(harness.lockRoot), [], "the lock must actually be released");
    } finally {
      reader.restore();
      await fs.rm(harness.root, { recursive: true, force: true });
    }
    assert.ok(record.length > 0);
  });

  await t.test("during a contended rename retry", async () => {
    const { harness, release, lockPath, ownerFile } = await heldLock({ hostPolicy: contentionPolicy, waitMs: 2_000, pollMs: 1 });
    const before = await fs.readFile(ownerFile, "utf8");
    let renames = 0;
    const restoreRename = interceptRename(lockPath, async (attempt) => {
      renames = attempt;
      if (attempt === 1) throw releaseContention;
    });
    // The retry's re-read is the one that fails: the record is intact and still ours throughout.
    const reader = interceptOwnerRead(ownerFile, 2, { skip: 1 });
    try {
      await release();
      assert.equal(renames, 2, "the retry must still happen once the record reads definitively");
      assert.equal(reader.reads(), 4, "one initial check, two indeterminate retry reads, one definitive");
      assert.deepEqual(await lockRootEntries(harness.lockRoot), []);
    } finally {
      reader.restore();
      restoreRename();
      await fs.rm(harness.root, { recursive: true, force: true });
    }
    assert.match(before, /"token"/);
  });
});

test("a durably unreadable owner record refuses inside the budget and says so honestly", async () => {
  const { harness, release, lockPath, ownerFile } = await heldLock({ waitMs: 40, pollMs: 1 });
  const record = await fs.readFile(ownerFile, "utf8");
  const reader = interceptOwnerRead(ownerFile, Number.MAX_SAFE_INTEGER);
  try {
    const started = Date.now();
    await assert.rejects(
      () => release(),
      (err: unknown) => {
        assert.ok(err instanceof FilesystemMutationLockError);
        assert.equal(err.lockPath, lockPath);
        assert.equal(err.malformed, true);
        assert.equal(err.owner, null);
        assert.match(err.message, /refusing to release/);
        assert.match(err.message, /owner record could not be read within the wait budget/);
        assert.match(err.message, /open denied by a scanner/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 1_500, "an indeterminate read must not wait past the budget");
    assert.ok(reader.reads() > 1, "it must have been polled, not concluded from one read");
  } finally {
    reader.restore();
    // The lock and its record are retained intact: the state is unknown, not known-released.
    assert.equal(await fs.readFile(ownerFile, "utf8"), record);
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("an unreadable record during a rename retry never renames a directory that changed hands", async () => {
  const { harness, release, lockPath, ownerFile } = await heldLock({ hostPolicy: contentionPolicy, waitMs: 2_000, pollMs: 1 });
  const foreign = JSON.parse(await fs.readFile(ownerFile, "utf8")) as Record<string, unknown>;
  foreign.token = "foreign-live-replacement";
  let renames = 0;
  const restoreRename = interceptRename(lockPath, async (attempt) => {
    renames = attempt;
    // While this rename is delayed the directory is replaced by a competitor's live claim.
    await fs.rm(lockPath, { recursive: true, force: true });
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(ownerFile, `${JSON.stringify(foreign)}\n`, "utf8");
    throw releaseContention;
  });
  // The first re-reads are indeterminate; the competitor's record only becomes legible later.
  const reader = interceptOwnerRead(ownerFile, 2, { skip: 1 });
  try {
    await assert.rejects(
      () => release(),
      (err: unknown) => {
        assert.ok(err instanceof FilesystemMutationLockError);
        assert.match(err.message, /refusing to release/);
        assert.equal(err.owner?.token, "foreign-live-replacement");
        return true;
      },
    );
    assert.equal(renames, 1, "an indeterminate read must never authorize another rename");
    assert.deepEqual(JSON.parse(await fs.readFile(ownerFile, "utf8")), foreign, "the competitor's claim survives");
  } finally {
    reader.restore();
    restoreRename();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("a malformed owner record still refuses at once rather than being polled", async () => {
  const { harness, release, lockPath, ownerFile } = await heldLock({ waitMs: 2_000, pollMs: 1 });
  const originalReadFile = fs.readFile;
  let reads = 0;
  const restore = replaceFsMethod("readFile", (...args) => {
    if (path.resolve(String(args[0])) === path.resolve(ownerFile)) reads += 1;
    return Reflect.apply(originalReadFile, fs, args);
  });
  await fs.writeFile(ownerFile, "{ not a record", "utf8");
  try {
    const started = Date.now();
    await assert.rejects(
      () => release(),
      (err: unknown) => {
        assert.ok(err instanceof FilesystemMutationLockError);
        assert.match(err.message, /owner token changed/);
        assert.equal(err.malformed, true);
        return true;
      },
    );
    assert.equal(reads, 1, "readable-but-malformed is a definitive answer, not an indeterminate one");
    assert.ok(Date.now() - started < 1_000);
    assert.equal(await pathExists(lockPath), true);
  } finally {
    restore();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("a remnant already gone on the first removal attempt counts as released", async () => {
  const { harness, release, lockPath } = await heldLock({ hostPolicy: contentionPolicy, waitMs: 2_000, pollMs: 1 });
  const originalRm = fs.rm;
  let attempts = 0;
  const restore = replaceFsMethod("rm", async (...args) => {
    if (!String(args[0]).startsWith(`${lockPath}.released-`)) return Reflect.apply(originalRm, fs, args);
    attempts += 1;
    // An external actor removed the token-fenced remnant before this first removal reached it.
    await Reflect.apply(originalRm, fs, [args[0], { recursive: true, force: true }]);
    return Reflect.apply(originalRm, fs, args);
  });
  try {
    await release();
    assert.equal(attempts, 1, "the requested end state was already reached on the first attempt");
    assert.equal(await pathExists(lockPath), false);
    assert.deepEqual(await lockRootEntries(harness.lockRoot), []);
  } finally {
    restore();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

/** Freeze time so budget arithmetic is exact and the real scheduler decides nothing. */
function virtualClock(start = 1_000_000): { restore: () => void; advance: (ms: number) => void } {
  const realNow = Date.now;
  let now = start;
  Date.now = () => now;
  return {
    restore: () => {
      Date.now = realNow;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("the release budget is not restarted per step: removal inherits what ownership resolution left", async () => {
  const { harness, release, lockPath, ownerFile } = await heldLock({ hostPolicy: contentionPolicy, waitMs: 100, pollMs: 1 });
  // The lock is claimed on the real clock; only the release runs on the virtual one, so which
  // branch this exercises is decided by the injected sequence and never by scheduler latency.
  const clock = virtualClock();
  const originalReadFile = fs.readFile;
  let reads = 0;
  const restoreRead = replaceFsMethod("readFile", (...args) => {
    if (path.resolve(String(args[0])) !== path.resolve(ownerFile)) return Reflect.apply(originalReadFile, fs, args);
    reads += 1;
    if (reads === 1) return Promise.reject(unreadableRecord);
    // Ownership resolves definitively, but only after the whole budget has been spent.
    clock.advance(150);
    return Reflect.apply(originalReadFile, fs, args);
  });
  let renames = 0;
  const restoreRename = interceptRename(lockPath, async (attempt) => {
    renames = attempt;
    throw releaseContention;
  });
  try {
    await assert.rejects(
      () => release(),
      (err: unknown) => err instanceof FilesystemMutationLockError && /could not be removed/.test(err.message),
    );
    // A budget restarted at removal would grant a fresh round: another resolve and another rename.
    assert.equal(reads, 2, "one indeterminate read, then the definitive one");
    assert.equal(renames, 1, "the spent budget must leave the rename a single attempt");
    assert.equal(await pathExists(ownerFile), true, "a durable rename denial retains the lock and its record");
  } finally {
    restoreRead();
    restoreRename();
    clock.restore();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});

test("an ownership check that never resolves is bounded and never reaches the destructive step", async () => {
  const { harness, release, lockPath, ownerFile } = await heldLock({ hostPolicy: contentionPolicy, waitMs: 120, pollMs: 1 });
  const reader = interceptOwnerRead(ownerFile, Number.MAX_SAFE_INTEGER);
  let renames = 0;
  const restoreRename = interceptRename(lockPath, async (attempt) => {
    renames = attempt;
    throw releaseContention;
  });
  try {
    const started = Date.now();
    await assert.rejects(
      () => release(),
      (err: unknown) => err instanceof FilesystemMutationLockError && /could not be read within the wait budget/.test(err.message),
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_500, `the indeterminate poll must stay bounded, took ${elapsed}ms`);
    assert.equal(renames, 0, "an unresolved ownership check must never rename anything");
  } finally {
    reader.restore();
    restoreRename();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});
