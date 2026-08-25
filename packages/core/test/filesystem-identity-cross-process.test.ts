/**
 * L3 cross-process witnessed coordination. The arrival witness is the lock's own owner token: a
 * child can report the parent's token only after its `mkdir(lockPath)` failed with EEXIST and it
 * read the owner record, so the witness is a consequence of the production `claim` binding and
 * lock placement, observed across a process boundary. Every await carries a named bound; a
 * fulfilled or refused result before both witnesses fails immediately (EARLY_FAIL).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { identityKey } from "../src/filesystem-identity.js";
import { acquireFilesystemIdentityLock, filesystemIdentityLockPath } from "../src/filesystem-lock.js";
import { detectHostAliasing, hostAliasesPair } from "./host-class.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(HERE, "ts-loader.mjs");
const CHILD = path.join(HERE, "fixtures", "filesystem-identity-child.ts");
const WITNESS_BOUND_MS = 30_000;
const SETTLE_BOUND_MS = 20_000;
const EXIT_BOUND_MS = 5_000;
const REL = "concepts/first-name.md";

type ChildMessage = Record<string, unknown> & { type: string };

class Mailbox {
  readonly messages: ChildMessage[] = [];
  readonly #waiters: Array<() => void> = [];
  #exited = false;
  #exitInfo = "";
  readonly child: ChildProcess;
  readonly exit: Promise<void>;
  readonly label: string;

  constructor(label: string, child: ChildProcess) {
    this.label = label;
    this.child = child;
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.on("message", (message: unknown) => {
      if (message && typeof message === "object" && typeof (message as ChildMessage).type === "string") {
        this.messages.push(message as ChildMessage);
        this.#wake();
      }
    });
    this.exit = new Promise<void>((resolve) => {
      child.on("exit", (code, signal) => {
        this.#exited = true;
        this.#exitInfo = `code=${String(code)} signal=${String(signal)} stderr=${stderr.trim()}`;
        this.#wake();
        resolve();
      });
      child.on("error", () => {
        this.#exited = true;
        this.#wake();
        resolve();
      });
    });
  }

  #wake(): void {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  results(): ChildMessage[] {
    return this.messages.filter((message) => ["fulfilled", "refused", "error"].includes(message.type));
  }

  /** Resolve with the first message satisfying `pick`; fail fast on a result or exit (EARLY_FAIL). */
  async next(pick: (message: ChildMessage) => boolean, boundMs: number, what: string, earlyFail = true): Promise<ChildMessage> {
    const deadline = Date.now() + boundMs;
    for (;;) {
      const found = this.messages.find(pick);
      if (found) return found;
      if (earlyFail && this.results().length > 0) {
        throw new Error(`${this.label}: ${what} expected before any result; got ${JSON.stringify(this.results())}`);
      }
      if (this.#exited) throw new Error(`${this.label}: exited before ${what} (${this.#exitInfo})`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`${this.label}: ${what} did not arrive within ${boundMs}ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async terminate(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    await withBound(this.exit, EXIT_BOUND_MS, `${this.label} exit`);
  }
}

function withBound<T>(promise: Promise<T>, boundMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not settle within ${boundMs}ms`)), boundMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function spawnWriter(label: string, root: string, id: string, tmp: string): Mailbox {
  const child = spawn(process.execPath, ["--import", LOADER, CHILD, root, id], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
  });
  return new Mailbox(label, child);
}

interface Arena {
  parent: string;
  root: string;
  symlinkedRoot: string;
  tmpA: string;
  tmpB: string;
}

/** An empty bundle root, reachable directly and through a symlinked ancestor, plus two TMPDIRs. */
async function arena(): Promise<Arena> {
  const parent = await fs.mkdtemp(path.join(tmpdir(), "superbee-identity-xproc-"));
  const real = path.join(parent, "real");
  const link = path.join(parent, "link");
  await fs.mkdir(real);
  await fs.symlink(real, link, "dir");
  const root = path.join(await fs.realpath(real), "bundle");
  await fs.mkdir(root);
  const tmpA = path.join(parent, "tmp-a");
  const tmpB = path.join(parent, "tmp-b");
  await fs.mkdir(tmpA);
  await fs.mkdir(tmpB);
  return { parent, root, symlinkedRoot: path.join(link, "bundle"), tmpA, tmpB };
}

async function ownerToken(lockPath: string): Promise<string> {
  const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as { token: string };
  return owner.token;
}

test("AC-10: witnessed first-creation exclusion across processes on the same leaf", async () => {
  // Branch on whether this host equates the two spellings this row writes, never on the
  // aggregate class: a case-sensitive, normalization-insensitive host is "aliasing" overall and
  // still treats these two case spellings as distinct ids.
  const aliasesPair = hostAliasesPair(await detectHostAliasing(), "concepts/first-name", "concepts/FIRST-NAME");
  const a = await arena();
  const children: Mailbox[] = [];
  let release: (() => Promise<void>) | undefined;
  try {
    const key = await identityKey(a.root, REL);
    assert.equal(await identityKey(a.symlinkedRoot, REL), key, "the symlinked ancestor derives the same key");
    release = await acquireFilesystemIdentityLock(key, "parent-hold", { portableRoot: a.root });
    const token = await ownerToken(filesystemIdentityLockPath(key, a.root));

    children.push(spawnWriter("child-A", a.root, "concepts/first-name", a.tmpA));
    children.push(spawnWriter("child-B", a.symlinkedRoot, "concepts/FIRST-NAME", a.tmpB));

    // (i) both children witness the parent's token; any result before that fails immediately.
    for (const child of children) {
      const blocked = await child.next((m) => m.type === "blocked", WITNESS_BOUND_MS, "blocked witness");
      assert.equal((blocked.owner as { token?: string } | null)?.token, token, `${child.label} saw a different owner`);
    }
    // (ii) nothing was realized while the lock was contended.
    assert.deepEqual(await fs.readdir(a.root), [], "no `concepts` entry while the parent holds the key");
    assert.deepEqual(children.flatMap((child) => child.results()), []);

    // (iii) release; both settle within the bound, order not asserted.
    await release();
    release = undefined;
    const results = await withBound(
      Promise.all(children.map((child) => child.next((m) => m.type !== "blocked" && m.type !== "attempting", SETTLE_BOUND_MS, "result", false))),
      SETTLE_BOUND_MS,
      "both results",
    );
    for (const result of results) assert.notEqual(result.type, "error", String(result.message));
    const fulfilled = results.filter((r) => r.type === "fulfilled").map((r) => String(r.id));
    const refused = results.filter((r) => r.type === "refused").map((r) => String(r.id));

    // (iv, cond) outcome set by host class.
    const files = await fs.readdir(path.join(a.root, "concepts"));
    if (!aliasesPair) {
      assert.deepEqual(fulfilled.sort(), ["concepts/FIRST-NAME", "concepts/first-name"]);
      assert.deepEqual(refused, []);
      assert.deepEqual(files.sort(), ["FIRST-NAME.md", "first-name.md"]);
    } else {
      assert.equal(fulfilled.length, 1, JSON.stringify(results));
      assert.equal(refused.length, 1, JSON.stringify(results));
      assert.deepEqual(files, [`${fulfilled[0]!.slice("concepts/".length)}.md`], "exactly one file, spelled as the winner's id");
    }
  } finally {
    for (const child of children) await child.terminate();
    if (release) await release().catch(() => {});
    await fs.rm(a.parent, { recursive: true, force: true });
  }
});

test("AC-12b: a child killed after its witness leaves no residue; the other completes and the key is re-claimable", async () => {
  const a = await arena();
  const children: Mailbox[] = [];
  let release: (() => Promise<void>) | undefined;
  try {
    const key = await identityKey(a.root, REL);
    release = await acquireFilesystemIdentityLock(key, "parent-hold", { portableRoot: a.root });
    const token = await ownerToken(filesystemIdentityLockPath(key, a.root));
    const childA = spawnWriter("child-A", a.root, "concepts/first-name", a.tmpA);
    const childB = spawnWriter("child-B", a.symlinkedRoot, "concepts/FIRST-NAME", a.tmpB);
    children.push(childA, childB);
    for (const child of children) {
      const blocked = await child.next((m) => m.type === "blocked", WITNESS_BOUND_MS, "blocked witness");
      assert.equal((blocked.owner as { token?: string } | null)?.token, token);
    }

    await childA.terminate();
    await release();
    release = undefined;

    const result = await childB.next((m) => m.type === "fulfilled" || m.type === "refused" || m.type === "error", SETTLE_BOUND_MS, "result", false);
    assert.equal(result.type, "fulfilled", JSON.stringify(result));
    assert.deepEqual(await fs.readdir(path.join(a.root, "concepts")), ["FIRST-NAME.md"]);

    const reclaim = await withBound(
      acquireFilesystemIdentityLock(key, "parent-reclaim", { portableRoot: a.root, waitMs: 2_000, pollMs: 10 }),
      SETTLE_BOUND_MS,
      "re-claim",
    );
    await reclaim();
    await assert.rejects(() => fs.stat(filesystemIdentityLockPath(key, a.root)));
  } finally {
    for (const child of children) await child.terminate();
    if (release) await release().catch(() => {});
    await fs.rm(a.parent, { recursive: true, force: true });
  }
});
