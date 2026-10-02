/**
 * The Node push role: exclusive within a process and across processes, released when the work
 * settles, reclaimed from a dead holder, and never mistaken for "held elsewhere" when the holder
 * cannot be identified. The request shape is the one `withPushRole` makes (`ifAvailable: true`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireFilesystemIdentityLock, FilesystemMutationLockError } from "../src/filesystem-lock.js";
import { filesystemPushRoleLocks, processStartedAtFromPs, psEnvironment, PushRoleStaleOwnerError, pushRoleLockKey, type PushRoleLockManager } from "../src/filesystem-push-role.js";
import { hostname } from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROLE = "superbee:push:checkout-under-test";

/** What `withPushRole` does with a manager, restated so the row runs the same call shape. */
async function withRole<T>(locks: PushRoleLockManager, name: string, fn: () => Promise<T>) {
  return locks.request(name, { ifAvailable: true }, async (lock) => (lock ? { held: true as const, result: await fn() } : { held: false as const, reason: "held-elsewhere" as const }));
}

async function lockRoot(): Promise<{ root: string; cleanup(): Promise<void> }> {
  const base = await fs.mkdtemp(path.join(tmpdir(), "superbee-push-role-"));
  return { root: path.join(base, "locks"), cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

test("the role is exclusive within a process and free again once the work settles, resolved or rejected", async () => {
  const { root, cleanup } = await lockRoot();
  try {
    const locks = filesystemPushRoleLocks({ lockRoot: root, contentionWaitMs: 0 });
    let inside!: () => void;
    const entered = new Promise<void>((resolve) => (inside = resolve));
    let finish!: () => void;
    const holding = withRole(locks, ROLE, () => { inside(); return new Promise<string>((resolve) => (finish = () => resolve("delivered"))); });
    await entered;
    assert.deepEqual(await withRole(locks, ROLE, async () => "second"), { held: false, reason: "held-elsewhere" });
    // Another working copy's role is independent.
    assert.deepEqual(await withRole(locks, `${ROLE}-other`, async () => "other"), { held: true, result: "other" });
    finish();
    assert.deepEqual(await holding, { held: true, result: "delivered" });
    await assert.rejects(withRole(locks, ROLE, async () => { throw new Error("push failed"); }), /push failed/);
    assert.deepEqual(await withRole(locks, ROLE, async () => "after"), { held: true, result: "after" });
  } finally {
    await cleanup();
  }
});

function holder(root: string): { child: ChildProcess; holding: Promise<string>; exited: Promise<void> } {
  const child = fork(path.join(HERE, "fixtures", "push-role-holder-child.ts"), [ROLE, root], {
    execArgv: ["--import", path.join(HERE, "ts-loader.mjs")],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  const holding = new Promise<string>((resolve, reject) => {
    child.once("message", (message: { type: string }) => resolve(message.type));
    child.once("exit", () => reject(new Error(`holder exited: ${stderr}`)));
  });
  return { child, holding, exited };
}

test("a role another process holds is held elsewhere; once that process dies it is reclaimed", { timeout: 30_000 }, async () => {
  const { root, cleanup } = await lockRoot();
  const { child, holding, exited } = holder(root);
  try {
    assert.equal(await holding, "holding");
    const locks = filesystemPushRoleLocks({ lockRoot: root });
    let ran = false;
    assert.deepEqual(await withRole(locks, ROLE, async () => (ran = true)), { held: false, reason: "held-elsewhere" });
    assert.equal(ran, false);
    child.kill("SIGKILL");
    await exited;
    assert.deepEqual(await withRole(locks, ROLE, async () => "reclaimed"), { held: true, result: "reclaimed" });
  } finally {
    child.kill("SIGKILL");
    await exited;
    await cleanup();
  }
});

/** Messages from a forked fixture, in order: `next()` answers the next one, or rejects if the child exits first. */
function messages(child: ChildProcess): { next(): Promise<Record<string, unknown>> } {
  const queue: Record<string, unknown>[] = [];
  const waiters: { resolve(message: Record<string, unknown>): void; reject(error: Error): void }[] = [];
  let stderr = "";
  let exited = false;
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  child.on("message", (message: Record<string, unknown>) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else queue.push(message);
  });
  child.on("exit", () => {
    exited = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`child exited: ${stderr}`));
  });
  return {
    next: () => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      if (exited) return Promise.reject(new Error(`child exited: ${stderr}`));
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}

test("a claimer that resumes after its orphaned lock was removed and claimed again never deletes the new holder's lock", { timeout: 30_000 }, async () => {
  const { root, cleanup } = await lockRoot();
  const lock = path.join(root, `${pushRoleLockKey(ROLE)}.lock`);
  const claimer = fork(path.join(HERE, "fixtures", "push-role-paused-claimer-child.ts"), [ROLE, root], {
    execArgv: ["--import", path.join(HERE, "ts-loader.mjs")],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const fromClaimer = messages(claimer);
  let second: ReturnType<typeof holder> | undefined;
  try {
    // The first process has made the lock directory and is suspended before its owner record.
    assert.deepEqual(await fromClaimer.next(), { type: "paused" });
    assert.deepEqual(await fs.readdir(lock), []);
    // A person, told the owner-less lock is orphaned, removes it; a second process claims the role.
    await fs.rm(lock, { recursive: true });
    second = holder(root);
    assert.equal(await second.holding, "holding");
    const holderRecord = JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")) as { pid: number; token: string };
    assert.equal(holderRecord.pid, second.child.pid);

    // The first process resumes: its owner record cannot be written into the second's lock.
    claimer.send({ type: "resume" });
    const outcome = await fromClaimer.next();

    // The second process's lock, record and all, is untouched, so the role stays exclusive.
    const after = await fs.readFile(path.join(lock, "owner.json"), "utf8").then((raw) => JSON.parse(raw) as unknown, (error: NodeJS.ErrnoException) => error.code);
    assert.deepEqual(after, holderRecord);
    // The first process lost its claim and reports the role held elsewhere, as any later claimer would.
    assert.deepEqual(outcome, { type: "held-elsewhere" });
    const locks = filesystemPushRoleLocks({ lockRoot: root, contentionWaitMs: 50, pollMs: 10 });
    assert.deepEqual(await withRole(locks, ROLE, async () => "never"), { held: false, reason: "held-elsewhere" });
  } finally {
    claimer.kill("SIGKILL");
    second?.child.kill("SIGKILL");
    await second?.exited;
    await cleanup();
  }
});

test("a role lock with no owner record past the claim grace is an unknown holder: the request rejects instead of reporting held elsewhere", async () => {
  const { root, cleanup } = await lockRoot();
  try {
    const locks = filesystemPushRoleLocks({ lockRoot: root, contentionWaitMs: 50, pollMs: 10, claimGraceMs: 0 });
    // Create the private root the way a claim does, then plant an ownerless lock directory.
    assert.deepEqual(await withRole(locks, `${ROLE}-seed`, async () => "seed"), { held: true, result: "seed" });
    await fs.mkdir(path.join(root, `${pushRoleLockKey(ROLE)}.lock`));
    await assert.rejects(withRole(locks, ROLE, async () => "never"), (error: unknown) => error instanceof FilesystemMutationLockError && error.malformed);
  } finally {
    await cleanup();
  }
});

/** Plant a well-formed owner record for `pid`, claimed at `claimedAt`, as a crashed holder leaves it. */
async function plantOwner(root: string, pid: number, claimedAt: number, host = hostname()): Promise<string> {
  const seed = filesystemPushRoleLocks({ lockRoot: root, contentionWaitMs: 0 });
  assert.deepEqual(await withRole(seed, `${ROLE}-seed`, async () => "seed"), { held: true, result: "seed" });
  const lock = path.join(root, `${pushRoleLockKey(ROLE)}.lock`);
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid, hostname: host, created_at_ms: claimedAt, token: "planted", target: ROLE }));
  return lock;
}

/** A live process of this user that is not this one, started now: a holder id that exists but did not claim the role. */
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

test("a holder whose process id now belongs to a younger process is reported as a stale owner, not held elsewhere", async () => {
  const { root, cleanup } = await lockRoot();
  const reuser = liveProcess();
  try {
    // The reusing process is live, and it started long after this planted claim: its id was reused.
    const claimedAt = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await plantOwner(root, reuser.pid, claimedAt);
    const locks = filesystemPushRoleLocks({ lockRoot: root, contentionWaitMs: 50, pollMs: 10 });
    let ran = false;
    await assert.rejects(withRole(locks, ROLE, async () => (ran = true)), (error: unknown) =>
      error instanceof PushRoleStaleOwnerError && error.owner.pid === reuser.pid && error.owner.created_at_ms === claimedAt && error.processStartedAt > claimedAt);
    assert.equal(ran, false);

    // A holder whose process started before its claim is the claimer: held elsewhere.
    const genuine = filesystemPushRoleLocks({ lockRoot: root, contentionWaitMs: 50, pollMs: 10, processStartedAt: async () => claimedAt - 5_000 });
    assert.deepEqual(await withRole(genuine, ROLE, async () => "never"), { held: false, reason: "held-elsewhere" });
    // A host that cannot say when the process started keeps the conservative answer.
    const silent = filesystemPushRoleLocks({ lockRoot: root, contentionWaitMs: 50, pollMs: 10, processStartedAt: async () => null });
    assert.deepEqual(await withRole(silent, ROLE, async () => "never"), { held: false, reason: "held-elsewhere" });
  } finally {
    await reuser.stop();
    await cleanup();
  }
});

test("this process's own held role is never reported as a stale owner, even when its start time reads younger than the claim", async () => {
  const { root, cleanup } = await lockRoot();
  try {
    const locks = filesystemPushRoleLocks({ lockRoot: root, waitMs: 40, contentionWaitMs: 40, pollMs: 5 });
    let releaseHold!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const holding = locks.request(ROLE, {}, async () => {
      entered();
      await new Promise<void>((resolve) => (releaseHold = resolve));
    });
    await inside;
    // What `ps` reports for this process after the wall clock steps forward an hour past its claim.
    const stepped = filesystemPushRoleLocks({ lockRoot: root, waitMs: 40, contentionWaitMs: 40, pollMs: 5, processStartedAt: async () => Date.now() + 60 * 60 * 1000 });
    await assert.rejects(stepped.request(ROLE, {}, async () => "never"), (error: unknown) =>
      error instanceof FilesystemMutationLockError && !(error instanceof PushRoleStaleOwnerError) && error.owner?.pid === process.pid);
    assert.deepEqual(await withRole(stepped, ROLE, async () => "never"), { held: false, reason: "held-elsewhere" });
    releaseHold();
    await holding;
  } finally {
    await cleanup();
  }
});

test("a waiting request whose holder's process id now belongs to a younger process rejects as a stale owner, not as held", async () => {
  const { root, cleanup } = await lockRoot();
  const reuser = liveProcess();
  try {
    const claimedAt = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const lock = await plantOwner(root, reuser.pid, claimedAt);
    let ran = false;
    const reused = filesystemPushRoleLocks({ lockRoot: root, waitMs: 50, pollMs: 10, processStartedAt: async () => claimedAt + 60_000 });
    await assert.rejects(reused.request(ROLE, {}, async () => (ran = true)), (error: unknown) =>
      error instanceof PushRoleStaleOwnerError && error.lockPath === lock && error.owner.pid === reuser.pid && error.processStartedAt === claimedAt + 60_000);
    // A holder whose process started before its claim is the claimer: the lock's own "held" error.
    const genuine = filesystemPushRoleLocks({ lockRoot: root, waitMs: 50, pollMs: 10, processStartedAt: async () => claimedAt - 5_000 });
    await assert.rejects(genuine.request(ROLE, {}, async () => (ran = true)), (error: unknown) =>
      error instanceof FilesystemMutationLockError && !(error instanceof PushRoleStaleOwnerError) && error.message.includes(`held by PID ${reuser.pid} `));
    assert.equal(ran, false);
  } finally {
    await reuser.stop();
    await cleanup();
  }
});

test("a role held under another host name rejects with the lock's error for a person to check, instead of reporting held elsewhere forever", async () => {
  const { root, cleanup } = await lockRoot();
  try {
    const lock = await plantOwner(root, 999_999, Date.now() - 60_000, "renamed-host");
    let asked = false;
    const locks = filesystemPushRoleLocks({ lockRoot: root, contentionWaitMs: 50, pollMs: 10, processStartedAt: async () => ((asked = true), null) });
    let ran = false;
    for (const request of [{ ifAvailable: true }, {}]) {
      await assert.rejects(locks.request(ROLE, request, async () => (ran = true)), (error: unknown) =>
        error instanceof FilesystemMutationLockError && error.lockPath === lock && error.owner?.hostname === "renamed-host" && /A person must check it/.test(error.message));
    }
    assert.equal(ran, false);
    assert.equal(asked, false, "another host's process ids are never looked up here");
    // The lock is left for the person: never reclaimed.
    assert.equal((JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")) as { token: string }).token, "planted");
  } finally {
    await cleanup();
  }
});

test("a holder that released and exited before the timeout is never judged in place of the live replacement", async () => {
  const { root, cleanup } = await lockRoot();
  const released = spawn("sleep", ["30"], { stdio: "ignore" });
  const releasedExited = new Promise<void>((resolve) => released.once("exit", () => resolve()));
  const releasedPid = released.pid!;
  let releaseReplacement: (() => Promise<void>) | undefined;
  const mutable = fs as unknown as Record<string, unknown>;
  const originalReadFile = fs.readFile;
  try {
    const key = pushRoleLockKey(ROLE);
    await plantOwner(root, releasedPid, Date.now());
    const lock = path.join(root, `${key}.lock`);
    const ownerFile = path.join(lock, "owner.json");
    // Right after the claimer's last owner read, the planted holder releases and exits and a live
    // replacement claims the role. The released holder's PID then belongs to a younger process.
    let reads = 0;
    mutable.readFile = async (...args: unknown[]) => {
      const content = await (originalReadFile as (...a: unknown[]) => Promise<unknown>)(...args);
      if (String(args[0]) === ownerFile && ++reads === 2) {
        await fs.rm(lock, { recursive: true, force: true });
        released.kill("SIGKILL");
        await releasedExited;
        releaseReplacement = await acquireFilesystemIdentityLock(key, ROLE, { lockRoot: root, waitMs: 0, pollMs: 2 });
      }
      return content;
    };
    const locks = filesystemPushRoleLocks({
      lockRoot: root,
      contentionWaitMs: 0,
      pollMs: 2,
      processStartedAt: async (pid) => (pid === releasedPid ? Date.now() + 60_000 : null),
    });
    assert.deepEqual(await withRole(locks, ROLE, async () => "never"), { held: false, reason: "held-elsewhere" });
    assert.ok(releaseReplacement, "the replacement claimed the role inside the window");
  } finally {
    mutable.readFile = originalReadFile;
    released.kill("SIGKILL");
    await releaseReplacement?.().catch(() => {});
    await cleanup();
  }
});

test("a holder that released while its process id stayed occupied is never judged in place of the live replacement", async () => {
  const { root, cleanup } = await lockRoot();
  // PID reuse leaves the released holder's id occupied when the timeout is diagnosed. Keeping the
  // released holder's process alive occupies it; the start-time seam reports a younger process.
  const released = spawn("sleep", ["30"], { stdio: "ignore" });
  const releasedPid = released.pid!;
  let releaseReplacement: (() => Promise<void>) | undefined;
  const mutable = fs as unknown as Record<string, unknown>;
  const originalReadFile = fs.readFile;
  try {
    const key = pushRoleLockKey(ROLE);
    await plantOwner(root, releasedPid, Date.now());
    const lock = path.join(root, `${key}.lock`);
    const ownerFile = path.join(lock, "owner.json");
    let reads = 0;
    mutable.readFile = async (...args: unknown[]) => {
      const content = await (originalReadFile as (...a: unknown[]) => Promise<unknown>)(...args);
      if (String(args[0]) === ownerFile && ++reads === 2) {
        await fs.rm(lock, { recursive: true, force: true });
        releaseReplacement = await acquireFilesystemIdentityLock(key, ROLE, { lockRoot: root, waitMs: 0, pollMs: 2 });
      }
      return content;
    };
    const locks = filesystemPushRoleLocks({
      lockRoot: root,
      contentionWaitMs: 0,
      pollMs: 2,
      processStartedAt: async (pid) => (pid === releasedPid ? Date.now() + 60_000 : null),
    });
    assert.deepEqual(await withRole(locks, ROLE, async () => "never"), { held: false, reason: "held-elsewhere" });
    assert.ok(releaseReplacement, "the replacement claimed the role inside the window");
  } finally {
    mutable.readFile = originalReadFile;
    released.kill("SIGKILL");
    await releaseReplacement?.().catch(() => {});
    await cleanup();
  }
});

test("the host reports this process's start time no later than now and no earlier than its uptime allows", async () => {
  const started = await processStartedAtFromPs(process.pid);
  assert.ok(started !== null);
  const expected = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(started - expected) < 5_000, `ps says ${new Date(started).toISOString()}, uptime says ${new Date(expected).toISOString()}`);
});

test("a process whose TZ differs from the system zone still reads its own start time correctly", () => {
  // `ps` formats the start time in its TZ and the caller parses it in its own; with TZ dropped
  // from the child environment the two disagree by the zones' offset.
  const systemOffset = new Date().getTimezoneOffset();
  const zone = systemOffset === -14 * 60 ? "Etc/GMT+12" : "Pacific/Kiritimati";
  const moduleUrl = new URL("../src/filesystem-push-role.ts", import.meta.url).href;
  const loader = new URL("./ts-loader.mjs", import.meta.url).href;
  const probe = `const { processStartedAtFromPs } = await import(${JSON.stringify(moduleUrl)});
const started = await processStartedAtFromPs(process.pid);
const expected = Date.now() - process.uptime() * 1000;
process.stdout.write(JSON.stringify({ started, expected }));`;
  const run = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", probe], {
    env: { ...process.env, TZ: zone },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const { started, expected } = JSON.parse(run.stdout) as { started: number | null; expected: number };
  assert.ok(started !== null);
  assert.ok(Math.abs(started - expected) < 5_000, `in TZ=${zone} ps says ${new Date(started).toISOString()}, uptime says ${new Date(expected).toISOString()}`);
  assert.equal(psEnvironment({ TZ: zone, LANG: "fr_FR.UTF-8" }).TZ, zone);
  assert.equal(psEnvironment({ TZ: zone, LANG: "fr_FR.UTF-8" }).LC_ALL, "C");
});

test("role names map to distinct fixed-length keys", () => {
  const keys = new Set([ROLE, `${ROLE}x`, "", "a/b", "a\0b"].map(pushRoleLockKey));
  assert.equal(keys.size, 5);
  for (const key of keys) assert.match(key, /^[0-9a-f]{64}$/);
});

test("an owner-less lock younger than the claim grace is a claim or release in progress, never an orphan", async () => {
  const { root, cleanup } = await lockRoot();
  try {
    const locks = filesystemPushRoleLocks({ lockRoot: root, contentionWaitMs: 50, waitMs: 50, pollMs: 10 });
    assert.deepEqual(await withRole(locks, `${ROLE}-seed`, async () => "seed"), { held: true, result: "seed" });
    const lock = path.join(root, `${pushRoleLockKey(ROLE)}.lock`);
    await fs.mkdir(lock);
    // ifAvailable: held elsewhere.
    assert.deepEqual(await withRole(locks, ROLE, async () => "never"), { held: false, reason: "held-elsewhere" });
    // A waiting request: busy (retryable), not malformed.
    await assert.rejects(
      locks.request(ROLE, {}, async () => "never"),
      (error: unknown) => error instanceof FilesystemMutationLockError && !error.malformed && error.owner === null,
    );
    // Once the grace has passed, the same lock is reported as the orphan it is.
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(lock, past, past);
    await assert.rejects(withRole(locks, ROLE, async () => "never"), (error: unknown) => error instanceof FilesystemMutationLockError && error.malformed);
  } finally {
    await cleanup();
  }
});
