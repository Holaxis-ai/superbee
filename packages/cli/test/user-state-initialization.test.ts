import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FilesystemMutationLockError, initBundle } from "@superbee/core";
import { catalogLockPath } from "../src/catalog.js";
import {
  canonicalUserStateDir,
  ensureUserStateRoot,
  ensureUserStateRootForTest,
  inspectCanonicalUserStateRoot,
  USER_STATE_MARKER_BYTES,
  USER_STATE_MARKER_FILE_NAME,
} from "../src/user-state.js";
import { isolatedUserEnv } from "./support/user-env.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(HERE, "ts-loader.mjs");
const CHILD = path.join(HERE, "fixtures", "user-state-initialization-child.ts");
const GITIGNORE_FILE_NAME = ".gitignore";

type ChildMessage = Record<string, unknown>;

interface ChildHarness {
  readonly child: ChildProcess;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  next(type: string, timeoutMs?: number): Promise<ChildMessage>;
  send(type: string): void;
  diagnostics(): string;
}

function spawnChild(role: "creator" | "observer" | "catalog", home: string, bundle?: string): ChildHarness {
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(LOADER).href, CHILD, role, home, ...(bundle ? [bundle] : [])],
    {
      env: isolatedUserEnv(home, { AGENTSTATE_LITE_NO_AUTOPULL: "1" }),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const queued: ChildMessage[] = [];
  const waiters = new Set<{
    type: string;
    resolve: (message: ChildMessage) => void;
    reject: (error: Error) => void;
  }>();
  let stdout = "";
  let stderr = "";
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const value = message as ChildMessage;
    const waiter = [...waiters].find((candidate) => candidate.type === value.type);
    if (waiter) {
      waiters.delete(waiter);
      waiter.resolve(value);
    } else {
      queued.push(value);
    }
  });
  child.on("error", (error) => {
    spawnError = error;
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      for (const waiter of waiters) {
        waiter.reject(new Error(
          `child exited before ${waiter.type} (code=${String(code)}, signal=${String(signal)}): stdout=${stdout}; stderr=${stderr}`,
        ));
      }
      waiters.clear();
      resolve(exited);
    });
  });

  return {
    child,
    exit,
    next(type, timeoutMs = 5_000) {
      const index = queued.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]!);
      if (spawnError) return Promise.reject(spawnError);
      if (exited) {
        return Promise.reject(new Error(
          `child already exited before ${type} (code=${String(exited.code)}, signal=${String(exited.signal)}): stdout=${stdout}; stderr=${stderr}`,
        ));
      }
      return new Promise<ChildMessage>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const waiter = {
          type,
          resolve: (message: ChildMessage) => {
            if (timer) clearTimeout(timer);
            resolve(message);
          },
          reject: (error: Error) => {
            if (timer) clearTimeout(timer);
            reject(error);
          },
        };
        timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`timed out waiting for child ${type}: stdout=${stdout}; stderr=${stderr}`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
    send(type) {
      child.send?.({ type });
    },
    diagnostics: () => `stdout=${stdout}; stderr=${stderr}`,
  };
}

async function scratchHome(prefix: string): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const home = path.join(root, "home");
  await mkdir(home);
  return { root, home };
}

async function assertAbsent(candidate: string): Promise<void> {
  await assert.rejects(() => stat(candidate), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`operation exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertCreatorOwnsLease(message: ChildMessage, creator: ChildHarness): Promise<string> {
  assert.equal(typeof message.lockPath, "string", creator.diagnostics());
  const lockPath = message.lockPath as string;
  const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as { pid?: number };
  assert.equal(owner.pid, creator.child.pid, creator.diagnostics());
  return lockPath;
}

async function cleanupLockEvidence(lockPath: string | undefined): Promise<void> {
  if (!lockPath) return;
  const lockRoot = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.stale-`;
  const entries = await readdir(lockRoot).catch(() => []);
  for (const entry of entries) {
    if (entry === path.basename(lockPath) || entry.startsWith(prefix)) {
      await rm(path.join(lockRoot, entry), { recursive: true, force: true });
    }
  }
}

async function stop(children: readonly ChildHarness[]): Promise<void> {
  for (const harness of children) {
    if (harness.child.exitCode === null && harness.child.signalCode === null) harness.child.kill("SIGKILL");
  }
  await Promise.all(children.map((harness) => harness.exit));
}

test("concurrent processes wait for the creator's marker publication", async () => {
  const { root: scratch, home } = await scratchHome("superbee-user-state-live-");
  const children: ChildHarness[] = [];
  let lockPath: string | undefined;
  try {
    const expectedRoot = canonicalUserStateDir(home);
    const creator = spawnChild("creator", home);
    children.push(creator);
    const preMarker = await creator.next("pre-marker");
    lockPath = await assertCreatorOwnsLease(preMarker, creator);
    assert.deepEqual(await readdir(expectedRoot), []);

    const observer = spawnChild("observer", home);
    children.push(observer);
    await observer.next("attempting");
    await assertCreatorOwnsLease(preMarker, creator);
    await assertAbsent(path.join(expectedRoot, USER_STATE_MARKER_FILE_NAME));

    creator.send("publish");
    const [created, observed] = await Promise.all([creator.next("result"), observer.next("result")]);
    assert.deepEqual([created.status, observed.status], ["fulfilled", "fulfilled"]);
    assert.equal(created.root, expectedRoot);
    assert.equal(observed.root, expectedRoot);
    assert.equal(await readFile(path.join(expectedRoot, USER_STATE_MARKER_FILE_NAME), "utf8"), USER_STATE_MARKER_BYTES);
    const entries = await readdir(expectedRoot);
    assert.equal(entries.filter((entry) => entry === USER_STATE_MARKER_FILE_NAME).length, 1);
    assert.equal(entries.some((entry) => entry.startsWith(`.${USER_STATE_MARKER_FILE_NAME}.`)), false);
  } finally {
    await stop(children);
    await cleanupLockEvidence(lockPath);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("killed creator leaves an unadopted byte-identical markerless root", async () => {
  const { root: scratch, home } = await scratchHome("superbee-user-state-killed-");
  const children: ChildHarness[] = [];
  let lockPath: string | undefined;
  try {
    const expectedRoot = canonicalUserStateDir(home);
    const creator = spawnChild("creator", home);
    children.push(creator);
    const preMarker = await creator.next("pre-marker");
    lockPath = await assertCreatorOwnsLease(preMarker, creator);
    assert.equal(creator.child.kill("SIGKILL"), true);
    const death = await creator.exit;
    assert.notEqual(death.signal, null, creator.diagnostics());

    const sentinel = path.join(expectedRoot, "sentinel.bin");
    const sentinelBytes = Buffer.from([0, 1, 2, 3, 254, 255]);
    await writeFile(sentinel, sentinelBytes);
    const entriesBefore = await readdir(expectedRoot);

    const observer = spawnChild("observer", home);
    children.push(observer);
    await observer.next("attempting");
    const result = await observer.next("result");
    assert.equal(result.status, "rejected", observer.diagnostics());
    assert.match(String(result.message), /not owned by this product/);
    assert.equal(await inspectCanonicalUserStateRoot(home), "conflict");
    assert.deepEqual(await readdir(expectedRoot), entriesBefore);
    assert.deepEqual(await readFile(sentinel), sentinelBytes);
    await assertAbsent(path.join(expectedRoot, USER_STATE_MARKER_FILE_NAME));
    await assertAbsent(path.join(expectedRoot, GITIGNORE_FILE_NAME));
  } finally {
    await stop(children);
    await cleanupLockEvidence(lockPath);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("persistent markerless root remains foreign after bounded initialization", async () => {
  const { root: scratch, home } = await scratchHome("superbee-user-state-persistent-");
  try {
    const stateRoot = canonicalUserStateDir(home);
    await mkdir(stateRoot);
    const sentinel = path.join(stateRoot, "sentinel.txt");
    await writeFile(sentinel, "preserve me\n");
    const before = await readdir(stateRoot);

    await assert.rejects(within(ensureUserStateRoot(home), 5_000), /not owned by this product/);
    assert.deepEqual(await readdir(stateRoot), before);
    assert.equal(await readFile(sentinel, "utf8"), "preserve me\n");
    await assertAbsent(path.join(stateRoot, USER_STATE_MARKER_FILE_NAME));
    await assertAbsent(path.join(stateRoot, GITIGNORE_FILE_NAME));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("initialization lock refuses a runtime namespace inside the canonical root before mutation", async () => {
  const { root: scratch, home } = await scratchHome("superbee-user-state-overlap-");
  try {
    const stateRoot = canonicalUserStateDir(home);
    await assert.rejects(
      () => ensureUserStateRootForTest(home, { lockRoot: path.join(stateRoot, "runtime-locks") }),
      (error: unknown) => error instanceof FilesystemMutationLockError && /cannot place/.test(error.message),
    );
    await assertAbsent(stateRoot);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("initialization lease releases before the catalog lock is acquired", async () => {
  const { root: scratch, home } = await scratchHome("superbee-user-state-catalog-order-");
  const children: ChildHarness[] = [];
  let lockPath: string | undefined;
  try {
    const bundle = path.join(scratch, "bundle");
    await initBundle(bundle);
    const canonicalBundle = await realpath(bundle);
    const creator = spawnChild("creator", home);
    children.push(creator);
    const preMarker = await creator.next("pre-marker");
    lockPath = await assertCreatorOwnsLease(preMarker, creator);

    const catalog = spawnChild("catalog", home, canonicalBundle);
    children.push(catalog);
    await catalog.next("attempting");
    await assertCreatorOwnsLease(preMarker, creator);
    await assertAbsent(catalogLockPath(home));

    creator.send("publish");
    const [created, registered] = await Promise.all([creator.next("result"), catalog.next("result")]);
    assert.deepEqual(
      [created.status, registered.status],
      ["fulfilled", "fulfilled"],
      `creator=${JSON.stringify(created)}; catalog=${JSON.stringify(registered)}; ${catalog.diagnostics()}`,
    );
    assert.equal(registered.label, "observed");
    await assertAbsent(catalogLockPath(home));
  } finally {
    await stop(children);
    await cleanupLockEvidence(lockPath);
    await rm(scratch, { recursive: true, force: true });
  }
});
