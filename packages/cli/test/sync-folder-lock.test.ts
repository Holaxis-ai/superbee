// One Git sync at a time per board folder, and document writes ordered around the steps that move
// worktree files. Each "live sync" below is this process holding the folder lock while a rebase
// sync started is stopped in the checkout: the state a running sync is in while it resolves a stop.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { filesystemPushRoleLocks } from "@superbee/core/filesystem-push-role";
import {
  git,
  gitTry,
  isMidRebase,
  makeTwoCloneTopology,
  modifyBoardDoc,
  wedgeMidRebase,
  type TwoCloneTopology,
} from "../../board-git/test/git-harness.js";
import { sync } from "../src/commands/sync.js";
import { withSyncFolderLock, withSyncRootLock } from "../src/commands/sync/folder-lock.js";
import { CliError } from "../src/errors.js";
import { isolatedUserEnv, withIsolatedUserEnv } from "./support/user-env.js";

const CLI = path.resolve("../superbee/dist/superbee.mjs");

async function runSync(home: string, argv: string[], deadline?: number): Promise<{ out: string; err?: CliError }> {
  const chunks: string[] = [];
  try {
    await withIsolatedUserEnv(home, () =>
      sync([...argv, "--json"], { stdout: (s) => void chunks.push(s), hookInstalled: () => true, ...(deadline === undefined ? {} : { networkDeadline: deadline }) }),
    );
    return { out: chunks.join("") };
  } catch (err) {
    if (err instanceof CliError) return { out: chunks.join(""), err };
    throw err;
  }
}

/** Hold the board folder's sync lock (the name sync derives from the clone's git common-dir). */
async function holdingFolderLock<T>(topo: TwoCloneTopology, body: () => Promise<T>): Promise<T> {
  const raw = git(topo.b.root, ["rev-parse", "--git-common-dir"]).trim();
  const common = realpathSync(path.resolve(topo.b.root, raw));
  return filesystemPushRoleLocks().request(`superbee-git-sync:${common}`, {}, async () => body());
}

async function fixture(): Promise<{ topo: TwoCloneTopology; home: string; done: () => Promise<void> }> {
  const topo = await makeTwoCloneTopology();
  const home = await mkdtemp(path.join(tmpdir(), "sync-folder-lock-home-"));
  return { topo, home, done: async () => { await topo.cleanup(); await rm(home, { recursive: true, force: true }); } };
}

function note(id: string): string {
  return `---\ntype: Note\ntitle: ${id}\n---\n\n${id}\n`;
}

const head = (topo: TwoCloneTopology) => git(topo.b.board, ["rev-parse", "HEAD"]).trim();

test("a second sync never aborts the rebase a live sync is resolving: it skips and changes nothing", async () => {
  const { topo, home, done } = await fixture();
  try {
    await wedgeMidRebase(topo);
    const before = head(topo);
    const result = await holdingFolderLock(topo, () => runSync(home, ["--dir", topo.b.root], Date.now() + 20_000));
    assert.equal(result.err, undefined, "a skipped sync is not an error");
    const receipt = JSON.parse(result.out);
    assert.equal(receipt.status, "skipped");
    assert.equal(receipt.reason, "sync_busy");
    assert.equal(receipt.holder_pid, process.pid);
    assert.equal(receipt.sync, "Skipped: another superbee sync is running in this folder. Nothing changed.");
    assert.equal(isMidRebase(topo.b), true, "the live sync's rebase is untouched");
    assert.equal(head(topo), before);
  } finally {
    await done();
  }
});

test("a document written during a live sync's rebase stop is not erased by a second sync", async () => {
  const { topo, home, done } = await fixture();
  try {
    await wedgeMidRebase(topo);
    await modifyBoardDoc(topo.b, "tasks/seed-two", { frontmatter: { title: "WRITER EDIT" } });
    await holdingFolderLock(topo, () => runSync(home, ["--dir", topo.b.root], Date.now() + 20_000));
    assert.match(readFileSync(path.join(topo.b.board, "tasks/seed-two.md"), "utf8"), /WRITER EDIT/);
  } finally {
    await done();
  }
});

test("a second sync never stages or commits into a live sync's rebase stop", async () => {
  const { topo, home, done } = await fixture();
  try {
    await wedgeMidRebase(topo);
    writeFileSync(path.join(topo.b.board, "notes/y1.md"), note("y1"));
    const before = head(topo);
    await holdingFolderLock(topo, () => runSync(home, ["--dir", topo.b.root], Date.now() + 20_000));
    assert.equal(head(topo), before, "no commit landed on the stopped rebase");
    assert.equal(git(topo.b.board, ["ls-files", "notes/y1.md"]).trim(), "", "the new document stays unstaged");
    assert.equal(isMidRebase(topo.b), true);
  } finally {
    await done();
  }
});

test("a sync killed mid-rebase is healed by the next sync, and every document reaches origin", async () => {
  const { topo, home, done } = await fixture();
  try {
    await wedgeMidRebase(topo);
    writeFileSync(path.join(topo.b.board, "notes/y1.md"), note("y1"));
    const first = await runSync(home, ["--dir", topo.b.root]);
    assert.equal(first.err?.code, "CONFLICT", "the healed run converges the same-document conflict");
    assert.equal(isMidRebase(topo.b), false);
    const second = await runSync(home, ["--dir", topo.b.root]);
    assert.equal(second.err, undefined, second.out);
    assert.match(git(topo.origin, ["ls-tree", "-r", "--name-only", "board"]), /notes\/y1\.md/);
  } finally {
    await done();
  }
});

test("a rebase a person started is refused, never aborted", async () => {
  const { topo, home, done } = await fixture();
  try {
    await wedgeMidRebase(topo);
    const marker = path.resolve(topo.b.board, git(topo.b.board, ["rev-parse", "--git-path", "superbee-sync-rebase"]).trim());
    await rm(marker, { force: true });
    const result = await runSync(home, ["--dir", topo.b.root]);
    assert.equal(result.err?.code, "CONFLICT");
    assert.equal(result.err?.details?.reason, "rebase_in_progress");
    assert.match(result.err!.message, /a git rebase you started is in progress in .*; finish it with `git rebase --continue` or `git rebase --abort`, then run `.*sync`/);
    assert.equal(isMidRebase(topo.b), true);
  } finally {
    await done();
  }
});

test("under a deadline (the turn-end hook) a busy folder skips at once; an explicit sync waits its turn", async () => {
  const { topo, home, done } = await fixture();
  try {
    writeFileSync(path.join(topo.b.board, "notes/y1.md"), note("y1"));
    const skipped = await holdingFolderLock(topo, () => runSync(home, ["--dir", topo.b.root], Date.now() + 20_000));
    const receipt = JSON.parse(skipped.out);
    assert.equal(receipt.status, "skipped");
    assert.ok(receipt.waited_ms < 2_000, `waited ${receipt.waited_ms} ms`);
    assert.match(receipt.help, /Your documents are saved in the folder\. The next `.*sync` sends them\./);
    assert.equal(git(topo.b.board, ["ls-files", "notes/y1.md"]).trim(), "");

    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const holder = holdingFolderLock(topo, () => released);
    setTimeout(release, 1_000);
    const waited = await runSync(home, ["--dir", topo.b.root]);
    await holder;
    assert.equal(waited.err, undefined, waited.out);
    assert.notEqual(JSON.parse(waited.out).status, "skipped");
    assert.match(git(topo.origin, ["ls-tree", "-r", "--name-only", "board"]), /notes\/y1\.md/);
  } finally {
    await done();
  }
});

test("the root lock orders a document write after a sync's worktree step", async () => {
  const { topo, home, done } = await fixture();
  try {
    const target = path.join(topo.b.board, "notes/z1.md");
    let child!: Promise<number | null>;
    await withSyncRootLock(topo.b.board, async () => {
      child = new Promise((resolve) => {
        const c = spawn("node", [CLI, "doc", "write", "notes/z1", "--type", "Note", "--title", "z1", "--body", "z1\n", "--dir", topo.b.board], {
          env: isolatedUserEnv(home, { SUPERBEE_ACTOR: "process:test" }),
          stdio: "ignore",
        });
        c.on("close", resolve);
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      assert.equal(existsSync(target), false, "the write waits while the step holds the root lock");
    });
    assert.equal(await child, 0);
    assert.equal(existsSync(target), true);
  } finally {
    await done();
  }
});

test("nothing holding the root lock may ask for the folder lock", async () => {
  const { topo, done } = await fixture();
  try {
    await withSyncRootLock(topo.b.board, async () => {
      await assert.rejects(withSyncFolderLock(topo.b.root, 250, async () => undefined), /folder lock while holding the bundle root lock/);
    });
  } finally {
    await done();
  }
});

test("soak: one writer and two sync loops in one folder lose no document", { timeout: 240_000 }, async () => {
  const { topo, home, done } = await fixture();
  const homeA = await mkdtemp(path.join(tmpdir(), "sync-folder-lock-a-"));
  const run = (h: string, cwd: string, args: string[]) => new Promise<number | null>((resolve) => {
    const c = spawn("node", [CLI, ...args], { cwd, env: isolatedUserEnv(h, { SUPERBEE_ACTOR: "process:soak" }), stdio: "ignore" });
    c.on("close", resolve);
  });
  try {
    const n = 40;
    let writing = true;
    const writes: (number | null)[] = [];
    const writer = async () => {
      for (let i = 0; i < n; i++) writes.push(await run(home, topo.b.root, ["doc", "write", `notes/w${i}`, "--type", "Note", "--title", `w${i}`, "--body", `w${i}\n`, "--dir", topo.b.board]));
      writing = false;
    };
    const loop = async () => { while (writing) await run(home, topo.b.root, ["sync", "--dir", topo.b.root]); };
    const upstream = async () => {
      for (let i = 0; writing; i++) {
        await run(homeA, topo.a.root, ["doc", "write", `notes/up${i}`, "--type", "Note", "--title", `up${i}`, "--body", "up\n", "--dir", topo.a.board]);
        await run(homeA, topo.a.root, ["sync", "--dir", topo.a.root]);
      }
    };
    await Promise.all([writer(), loop(), loop(), upstream()]);
    assert.deepEqual(writes.filter((code) => code !== 0), [], "every write succeeded");
    for (let i = 0; i < 3 && (await run(home, topo.b.root, ["sync", "--dir", topo.b.root])) !== 0; i++);
    const onOrigin = new Set(git(topo.origin, ["ls-tree", "-r", "--name-only", "board"]).split("\n"));
    const missing = Array.from({ length: n }, (_, i) => `notes/w${i}.md`).filter((f) => !onOrigin.has(f));
    assert.deepEqual(missing, []);
    assert.equal(isMidRebase(topo.b), false);
    assert.equal(gitTry(topo.b.board, ["status", "--porcelain"]).stdout, "");
  } finally {
    await rm(homeA, { recursive: true, force: true });
    await done();
  }
});
