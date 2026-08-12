import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initBundle, parseLinks, readDoc, writeDoc } from "@superbee/core";
import { snapshotBundleCommit, stageAndCommit } from "@superbee/board-git";
import {
  acquireFilesystemMutationLock,
  filesystemMutationLockPath,
} from "../../core/src/filesystem-lock.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(HERE, "ts-loader.mjs");
const LINK_CHILD = path.join(HERE, "fixtures", "cross-process-link-child.ts");
const T = "2026-07-16T00:00:00.000Z";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function initGitRepo(root: string): Promise<void> {
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Cross Process Test"]);
  git(root, ["config", "user.email", "cross-process@example.invalid"]);
}

interface ChildHarness {
  child: ChildProcess;
  attempting: Promise<void>;
  result: Promise<Record<string, unknown>>;
  hasResult: () => boolean;
}

function spawnLinkChild(root: string, target: string): ChildHarness {
  const child = spawn(process.execPath, ["--import", LOADER, LINK_CHILD, root, target], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, AGENTSTATE_LITE_NO_AUTOPULL: "1" },
  });
  let resultSeen = false;
  let resolveAttempting!: () => void;
  let resolveResult!: (result: Record<string, unknown>) => void;
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
        `link child exited before a result (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
      );
      rejectAttempting(err);
      rejectResult(err);
    }
  });
  return { child, attempting, result, hasResult: () => resultSeen };
}

async function eventually<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
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

test("independent link-add processes converge losslessly through one filesystem mutation lock", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "aslite-link-processes-"));
  const children: ChildHarness[] = [];
  try {
    const bundle = await initBundle(root);
    await writeDoc(bundle, {
      id: "hub",
      frontmatter: { type: "Concept", title: "Hub", timestamp: T },
      body: "Hub.",
    });
    const targets = ["t1", "t2", "t3", "t4", "t5"];
    for (const target of targets) {
      await writeDoc(bundle, {
        id: target,
        frontmatter: { type: "Concept", title: target, timestamp: T },
        body: target,
      });
    }

    // Hold the source's physical lock before the independent processes begin. Their IPC
    // "attempting" signal proves they reached the mutation; no result may arrive until release.
    const release = await acquireFilesystemMutationLock(path.join(root, "hub.md"), {
      portableRoot: root,
    });
    for (const target of targets) children.push(spawnLinkChild(root, target));
    await eventually(Promise.all(children.map((child) => child.attempting)).then(() => undefined));
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(children.some((child) => child.hasResult()), false, "every process must honor the held lock");

    await release();
    const results = await eventually(Promise.all(children.map((child) => child.result)));
    for (const result of results) {
      assert.equal(result.status, "fulfilled", String(result.message ?? ""));
      assert.equal(result.changed, true);
    }

    const links = parseLinks(bundle, await readDoc(bundle, "hub"));
    assert.deepEqual(
      links.map((link) => link.to).sort(),
      targets,
    );
  } finally {
    for (const harness of children) {
      if (harness.child.exitCode === null && harness.child.signalCode === null) harness.child.kill();
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sync staging cannot capture an active filesystem mutation lock", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "aslite-lock-sync-"));
  try {
    await initGitRepo(root);
    await fs.writeFile(path.join(root, "index.md"), "# Index\n");
    await fs.writeFile(
      path.join(root, "doc.md"),
      "---\ntype: Doc\ntitle: Before\nactor: test\n---\n\nBefore.\n",
    );
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "initial"]);
    await fs.writeFile(
      path.join(root, "doc.md"),
      "---\ntype: Doc\ntitle: After\nactor: test\n---\n\nAfter.\n",
    );

    const target = path.join(root, "doc.md");
    const release = await acquireFilesystemMutationLock(target, { portableRoot: root });
    try {
      const canonicalTarget = path.join(await fs.realpath(root), "doc.md");
      const lockPath = filesystemMutationLockPath(canonicalTarget, root);
      assert.ok(path.relative(root, lockPath).startsWith(".."), "lock must not live in the board worktree");
      assert.equal(stageAndCommit(root).committed, true);
      assert.deepEqual(git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n"), ["doc.md", "index.md"]);
      assert.doesNotMatch(git(root, ["show", "--format=", "--name-only", "HEAD"]), /agentstate|owner\.json/);
    } finally {
      await release();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("greenfield establishment cannot capture an abandoned filesystem mutation lock", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "aslite-lock-establish-"));
  try {
    await initGitRepo(root);
    await fs.writeFile(path.join(root, "README.md"), "# Project\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "initial"]);
    const bundle = path.join(root, ".agentstate-lite");
    await fs.mkdir(bundle);
    await fs.writeFile(path.join(bundle, "index.md"), "# Index\n");
    await fs.writeFile(path.join(bundle, "doc.md"), "---\ntype: Doc\ntitle: One\n---\n\nOne.\n");

    const canonicalTarget = path.join(await fs.realpath(bundle), "doc.md");
    const release = await acquireFilesystemMutationLock(canonicalTarget, { portableRoot: bundle });
    const lockPath = filesystemMutationLockPath(canonicalTarget, bundle);
    try {
      const ownerPath = path.join(lockPath, "owner.json");
      const owner = JSON.parse(await fs.readFile(ownerPath, "utf8")) as Record<string, unknown>;
      owner.pid = 999_999;
      await fs.writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });

      const snapshot = snapshotBundleCommit(root, bundle);
      assert.deepEqual(git(root, ["ls-tree", "-r", "--name-only", snapshot.sha]).split("\n"), ["doc.md", "index.md"]);
      assert.ok(path.relative(bundle, lockPath).startsWith(".."), "abandoned lock must remain outside the snapshot root");
    } finally {
      await release();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
