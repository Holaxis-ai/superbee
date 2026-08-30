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
  name: "lstat" | "mkdir" | "rm" | "writeFile",
  replacement: (...args: unknown[]) => unknown,
): () => void {
  const mutable = fs as unknown as Record<string, unknown>;
  const original = mutable[name];
  Object.defineProperty(mutable, name, { configurable: true, writable: true, value: replacement });
  return () => Object.defineProperty(mutable, name, { configurable: true, writable: true, value: original });
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
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(filesystemMutationLockRoot())).mode & 0o777, 0o700);
      assert.equal((await fs.stat(lockPath)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path.join(lockPath, "owner.json"))).mode & 0o777, 0o600);
    }
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

test("filesystem mutation lock diagnoses stale and malformed leftovers without removing them", async (t) => {
  const cases = [
    {
      name: "stale",
      owner: {
        pid: 999_999,
        hostname: hostname(),
        created_at_ms: Date.now() - 60_000,
        token: "dead-owner",
        target: "unused",
      },
      stale: true,
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
        assert.equal((await fs.stat(lockPath)).isDirectory(), true, "timeout must not steal the lock");

        // Recovery is deliberately explicit: after the caller verifies the diagnosis, removing
        // the leftover makes the next claim succeed. The lock primitive never does this itself.
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
        process.platform === "win32" ? undefined : childTmpA,
      ),
    );
    children.push(
      spawnCasChild(
        root,
        initialVersion,
        "writer-b",
        process.platform === "win32" ? undefined : childTmpB,
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
  if (process.platform === "win32" || process.getuid === undefined) {
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
test("pin: a live-but-unsignalable owner (PID 1, EPERM) is diagnosed HELD, never stale", async (t) => {
  if (process.platform === "win32") {
    t.skip("PID 1 EPERM semantics are POSIX");
    return;
  }
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
test("pin: timeout diagnosis distinguishes held vs stale vs foreign-host vs malformed in flags AND operator guidance", async () => {
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

  // (b) same-host ABSENT pid → stale message with the exact operator guidance.
  const stale = await diagnose({ pid: 999_999, hostname: hostname(), created_at_ms: Date.now() - 60_000, token: "dead", target: "unused" });
  assert.equal(stale.stale, true);
  assert.match(stale.message, /stale filesystem mutation lock/);
  assert.match(stale.message, /absent PID 999999/);
  assert.match(stale.message, /Inspect and remove the lock, then retry\./);

  // (c) FOREIGN-host absent pid → NOT stale (we cannot probe another host's pids).
  const foreign = await diagnose({ pid: 999_999, hostname: "some-other-host", created_at_ms: Date.now() - 60_000, token: "far", target: "unused" });
  assert.equal(foreign.stale, false);
  assert.doesNotMatch(foreign.message, /stale filesystem mutation lock/);

  // (d) malformed owner metadata → malformed message with the confirm-first guidance.
  const malformed = await diagnose(null);
  assert.equal(malformed.malformed, true);
  assert.match(malformed.message, /owner metadata is missing or malformed/);
  assert.match(malformed.message, /only after confirming no process is mutating the target/);
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
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(harness.lockRoot)).mode & 0o777, 0o700);
    }
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
    await t.test(kind, async (t) => {
      if (kind === "mode" && process.platform === "win32") {
        t.skip("POSIX mode contract");
        return;
      }
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

test("Windows lock claims retry only an observable transient EPERM", async () => {
  const harness = await isolatedLockPaths();
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform);
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const originalMkdir = fs.mkdir;
  const originalLstat = fs.lstat;
  let restoreMkdir = () => {};
  let restoreLstat = () => {};
  try {
    const transient = Object.assign(new Error("transient claim collision"), { code: "EPERM" });
    let claimAttempts = 0;
    restoreMkdir = replaceFsMethod("mkdir", (...args) => {
      if (String(args[0]).endsWith(".lock") && claimAttempts++ === 0) return Promise.reject(transient);
      return Reflect.apply(originalMkdir, fs, args);
    });
    const release = await acquireFilesystemMutationLock(harness.target, {
      lockRoot: harness.lockRoot,
      waitMs: 100,
      pollMs: 0,
    });
    assert.equal(claimAttempts, 2);
    await release();
    restoreMkdir();
    restoreMkdir = () => {};

    const durable = Object.assign(new Error("claim path denied"), { code: "EPERM" });
    restoreMkdir = replaceFsMethod("mkdir", (...args) => {
      if (String(args[0]).endsWith(".lock")) return Promise.reject(durable);
      return Reflect.apply(originalMkdir, fs, args);
    });
    restoreLstat = replaceFsMethod("lstat", (...args) => {
      if (String(args[0]).endsWith(".lock")) return Promise.reject(durable);
      return Reflect.apply(originalLstat, fs, args);
    });
    await assert.rejects(
      () => acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot }),
      (error: unknown) => error === durable,
    );
  } finally {
    restoreLstat();
    restoreMkdir();
    Object.defineProperty(process, "platform", platform);
    await fs.rm(harness.root, { recursive: true, force: true });
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
      () => acquireFilesystemMutationLock(harness.target, { lockRoot: harness.lockRoot }),
      (err: unknown) => err === writeFailure,
    );
    assert.deepEqual(observedOptions, { encoding: "utf8", flag: "wx", mode: 0o600 });
    assert.deepEqual(await fs.readdir(harness.lockRoot), []);
  } finally {
    restore();
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
    const restore = replaceFsMethod("rm", (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(lockPath)) return Promise.reject(new Error("busy"));
      return Reflect.apply(originalRm, fs, args);
    });
    try {
      await assert.rejects(
        () => release(),
        (err: unknown) => {
          assert.ok(err instanceof FilesystemMutationLockError);
          assert.equal(err.lockPath, lockPath);
          assert.equal(err.owner?.pid, process.pid);
          assert.equal(err.stale, false);
          assert.equal(err.malformed, false);
          assert.match(err.message, /mutation completed but filesystem lock/);
          assert.match(err.message, /busy/);
          return true;
        },
      );
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
