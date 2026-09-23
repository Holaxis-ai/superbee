/**
 * The Node push role: exclusive within a process and across processes, released when the work
 * settles, reclaimed from a dead holder, and never mistaken for "held elsewhere" when the holder
 * cannot be identified. The request shape is the one `withPushRole` makes (`ifAvailable: true`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FilesystemMutationLockError } from "../src/filesystem-lock.js";
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

test("a role lock with no owner record is an unknown holder: the request rejects instead of reporting held elsewhere", async () => {
  const { root, cleanup } = await lockRoot();
  try {
    const locks = filesystemPushRoleLocks({ lockRoot: root, contentionWaitMs: 50, pollMs: 10 });
    // Create the private root the way a claim does, then plant an ownerless lock directory.
    assert.deepEqual(await withRole(locks, `${ROLE}-seed`, async () => "seed"), { held: true, result: "seed" });
    await fs.mkdir(path.join(root, `${pushRoleLockKey(ROLE)}.lock`));
    await assert.rejects(withRole(locks, ROLE, async () => "never"), (error: unknown) => error instanceof FilesystemMutationLockError && error.malformed);
  } finally {
    await cleanup();
  }
});

/** Plant a well-formed owner record for `pid`, claimed at `claimedAt`, as a crashed holder leaves it. */
async function plantOwner(root: string, pid: number, claimedAt: number): Promise<void> {
  const seed = filesystemPushRoleLocks({ lockRoot: root, contentionWaitMs: 0 });
  assert.deepEqual(await withRole(seed, `${ROLE}-seed`, async () => "seed"), { held: true, result: "seed" });
  const lock = path.join(root, `${pushRoleLockKey(ROLE)}.lock`);
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid, hostname: hostname(), created_at_ms: claimedAt, token: "planted", target: ROLE }));
}

test("a holder whose process id now belongs to a younger process is reported as a stale owner, not held elsewhere", async () => {
  const { root, cleanup } = await lockRoot();
  try {
    // This test process is live, and it started long after this planted claim: its id was reused.
    const claimedAt = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await plantOwner(root, process.pid, claimedAt);
    const locks = filesystemPushRoleLocks({ lockRoot: root, contentionWaitMs: 50, pollMs: 10 });
    let ran = false;
    await assert.rejects(withRole(locks, ROLE, async () => (ran = true)), (error: unknown) =>
      error instanceof PushRoleStaleOwnerError && error.owner.pid === process.pid && error.owner.created_at_ms === claimedAt && error.processStartedAt > claimedAt);
    assert.equal(ran, false);

    // A holder whose process started before its claim is the claimer: held elsewhere.
    const genuine = filesystemPushRoleLocks({ lockRoot: root, contentionWaitMs: 50, pollMs: 10, processStartedAt: async () => claimedAt - 5_000 });
    assert.deepEqual(await withRole(genuine, ROLE, async () => "never"), { held: false, reason: "held-elsewhere" });
    // A host that cannot say when the process started keeps the conservative answer.
    const silent = filesystemPushRoleLocks({ lockRoot: root, contentionWaitMs: 50, pollMs: 10, processStartedAt: async () => null });
    assert.deepEqual(await withRole(silent, ROLE, async () => "never"), { held: false, reason: "held-elsewhere" });
  } finally {
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
