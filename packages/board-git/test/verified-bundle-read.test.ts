import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertBundleBytesMatchCommit } from "../src/porcelain.js";

function fixture(body: (root: string, file: string, sha: string) => void) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "bundle-read-"));
  try {
    const file = path.join(root, "entry");
    fs.writeFileSync(file, Buffer.from([0, 255, 10, 13]));
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("init", "-q"); git("add", "entry");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
    body(root, file, git("rev-parse", "HEAD"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const races = ["symlink", "following-open", "original-inode-link", "regular", "after-open", "after-read", "read-error", "fstat-error", "close-error", "FIFO"];
for (const race of races) {
  test(`bundle verified read refuses ${race}`, () => {
    if (race === "FIFO" && process.env.BUNDLE_FIFO_CHILD !== "1") {
      const child = spawnSync(process.execPath, ["--import", fileURLToPath(new URL("./ts-loader.mjs", import.meta.url)), "--test", "--test-reporter=tap", "--test-name-pattern=refuses FIFO$", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NODE_TEST_CONTEXT: undefined, BUNDLE_FIFO_CHILD: "1" }, encoding: "utf8", timeout: 10_000,
      });
      assert.ifError(child.error); assert.equal(child.status, 0, child.stdout + child.stderr); assert.match(child.stdout, /# pass 1/); return;
    }
    fixture((root, file, sha) => {
      const originals = { lstatSync: fs.lstatSync, openSync: fs.openSync, fstatSync: fs.fstatSync, readFileSync: fs.readFileSync, closeSync: fs.closeSync };
      const target = path.join(root, "outside");
      const bytes = fs.readFileSync(file); fs.writeFileSync(target, bytes);
      let injected = false, opened = false, fd: number | undefined, closed = 0, reads = 0;
      const replace = () => {
        injected = true;
        fs.renameSync(file, path.join(root, "original"));
        if (race === "symlink" || race === "following-open") fs.symlinkSync(target, file);
        else if (race === "original-inode-link") fs.symlinkSync(path.join(root, "original"), file);
        else if (race === "FIFO") execFileSync("mkfifo", [file]);
        else fs.writeFileSync(file, bytes);
      };
      Object.assign(fs, { lstatSync: ((name: fs.PathLike, ...args: any[]) => {
        const stat = (originals.lstatSync as any)(name, ...args);
        if (name === file && !injected && ["symlink", "following-open", "original-inode-link", "regular", "FIFO"].includes(race)) replace();
        return stat;
      }) as typeof fs.lstatSync });
      fs.openSync = ((name: fs.PathLike, ...args: any[]) => {
        // Emulate a host whose open follows links; identity checks must still gate bytes.
        if (name === file && ["following-open", "original-inode-link"].includes(race) && typeof args[0] === "number") args[0] &= ~fs.constants.O_NOFOLLOW;
        const result = (originals.openSync as any)(name, ...args);
        if (name === file && typeof args[0] === "number" && (args[0] & 3) === 0) { fd = result; opened = true; if (race === "after-open") replace(); }
        return result;
      }) as typeof fs.openSync;
      fs.fstatSync = ((value: number, ...args: any[]) => {
        if (value === fd && race === "fstat-error") { injected = true; throw new Error("injected fstat failure"); }
        return (originals.fstatSync as any)(value, ...args);
      }) as typeof fs.fstatSync;
      fs.readFileSync = ((name: fs.PathOrFileDescriptor, ...args: any[]) => {
        if (name === fd || name === file) {
          reads += 1;
          if (race === "read-error") { injected = true; throw new Error("injected read failure"); }
          const result = (originals.readFileSync as any)(name, ...args);
          if (race === "after-read") replace();
          return result;
        }
        return (originals.readFileSync as any)(name, ...args);
      }) as typeof fs.readFileSync;
      fs.closeSync = (value: number) => {
        const target = value === fd;
        if (target) { closed += 1; fd = undefined; }
        originals.closeSync(value);
        if (target && race === "close-error") { injected = true; throw new Error("injected close failure"); }
      };
      syncBuiltinESMExports();
      try {
        assert.throws(() => assertBundleBytesMatchCommit(root, root, sha), /bundle bytes differ/);
        assert.equal(injected, true, "the requested interleaving must execute");
        if (opened) assert.equal(closed, 1, "opened descriptor must close on refusal");
        if (["symlink", "following-open", "regular", "FIFO", "fstat-error"].includes(race)) assert.equal(reads, 0, "uninspected object must not supply bytes");
        assert.deepEqual(originals.readFileSync(target), bytes);
      } finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
    });
  });
}

test("bundle verified read preserves binary files and legitimate Git symlinks", () => {
  fixture((root, file, sha) => {
    assert.doesNotThrow(() => assertBundleBytesMatchCommit(root, root, sha));
    fs.symlinkSync("missing-target", path.join(root, "link"));
    execFileSync("git", ["-C", root, "add", "link"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "link"]);
    const linked = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.doesNotThrow(() => assertBundleBytesMatchCommit(root, root, linked));
    fs.unlinkSync(path.join(root, "link")); fs.writeFileSync(path.join(root, "link"), "missing-target");
    assert.throws(() => assertBundleBytesMatchCommit(root, root, linked), /bundle bytes differ/);
    fs.writeFileSync(file, "wrong");
    assert.throws(() => assertBundleBytesMatchCommit(root, root, sha), /bundle bytes differ/);
    fs.unlinkSync(file);
    assert.throws(() => assertBundleBytesMatchCommit(root, root, sha), /bundle bytes differ/);
  });
});

test("bundle verified read refuses replacement during readlink", () => {
  fixture((root, file) => {
    fs.unlinkSync(file); fs.symlinkSync("missing-target", file);
    execFileSync("git", ["-C", root, "add", "entry"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "link"]);
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const original = fs.readlinkSync; let injected = false;
    fs.readlinkSync = ((name: fs.PathLike, ...args: any[]) => {
      const bytes = (original as any)(name, ...args);
      if (name === file) { injected = true; fs.renameSync(file, path.join(root, "old-link")); fs.symlinkSync("missing-target", file); }
      return bytes;
    }) as typeof fs.readlinkSync;
    syncBuiltinESMExports();
    try { assert.throws(() => assertBundleBytesMatchCommit(root, root, sha), /bundle bytes differ/); assert.equal(injected, true); }
    finally { fs.readlinkSync = original; syncBuiltinESMExports(); }
  });
});
