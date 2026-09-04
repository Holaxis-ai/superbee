/**
 * The leaf-read primitive that closes the check-then-read window: a path whose leaf is (or becomes)
 * a symlink never yields the link target's bytes, while an ordinary regular file reads unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readLeafSync,
  readRegularFileNoFollowSync,
  readRegularFileTextNoFollowSync,
} from "../src/nofollow-read.js";

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "superbee-nofollow-"));
}

test("a regular file reads its exact bytes, as text and as bytes", () => {
  const dir = workspace();
  try {
    const file = path.join(dir, "plugin.mjs");
    writeFileSync(file, "const command = \"superbee\";\n");
    assert.deepEqual(readRegularFileTextNoFollowSync(file), {
      state: "present",
      text: "const command = \"superbee\";\n",
    });
    const bytes = readRegularFileNoFollowSync(file);
    assert.equal(bytes.state, "present");
    assert.ok(bytes.state === "present" && bytes.bytes.equals(Buffer.from("const command = \"superbee\";\n")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlink AT the leaf is refused — the target's bytes never reach the caller", { skip: process.platform === "win32" ? "O_NOFOLLOW is POSIX-only" : false }, () => {
  const dir = workspace();
  try {
    const secret = path.join(dir, "secret.txt");
    writeFileSync(secret, "attacker-supplied\n");
    const leaf = path.join(dir, "manifest.json");
    symlinkSync(secret, leaf);
    assert.deepEqual(readRegularFileNoFollowSync(leaf), { state: "unsafe" });
    assert.deepEqual(readRegularFileTextNoFollowSync(leaf), { state: "unsafe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an ancestor symlink stays honored — the guard is leaf-only", { skip: process.platform === "win32" ? "O_NOFOLLOW is POSIX-only" : false }, () => {
  const dir = workspace();
  try {
    const real = path.join(dir, "real-home");
    mkdirSync(real);
    writeFileSync(path.join(real, "SKILL.md"), "# Skill\n");
    const stowed = path.join(dir, "stowed-home");
    symlinkSync(real, stowed);
    assert.deepEqual(readRegularFileTextNoFollowSync(path.join(stowed, "SKILL.md")), {
      state: "present",
      text: "# Skill\n",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a FIFO at the leaf is refused without blocking on a writer that never comes", { skip: process.platform === "win32" ? "mkfifo is POSIX-only" : false }, () => {
  const dir = workspace();
  try {
    const fifo = path.join(dir, "manifest.json");
    // `O_NONBLOCK`'s reason to exist: without it this open parks forever waiting for a writer, so
    // the test hangs instead of failing. Timing out IS the regression signal here.
    execFileSync("mkfifo", [fifo]);
    assert.deepEqual(readRegularFileNoFollowSync(fifo), { state: "unsafe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an absent path is missing and a directory is unsafe — neither throws", () => {
  const dir = workspace();
  try {
    assert.deepEqual(readRegularFileNoFollowSync(path.join(dir, "nope")), { state: "missing" });
    assert.deepEqual(readRegularFileNoFollowSync(dir), { state: "unsafe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The Windows shape of this read: `O_NOFOLLOW` does not exist there, so the flag term is 0 and the
// `lstat` identity guard is the only thing left rejecting a link. A POSIX runner reaches that path
// only through `readLeafSync`, which takes the two platform facts as arguments.

test("degraded (no O_NOFOLLOW): a leaf symlink is still refused, and a regular file still reads", () => {
  const dir = workspace();
  const degraded = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
  try {
    const secret = path.join(dir, "secret.txt");
    writeFileSync(secret, "attacker-supplied\n");
    const leaf = path.join(dir, "SKILL.md");
    symlinkSync(secret, leaf);
    // Without the guard this open follows the link and returns the target's bytes.
    assert.deepEqual(readLeafSync(leaf, degraded, false), { state: "unsafe" });

    const real = path.join(dir, "real.md");
    writeFileSync(real, "# Skill\n");
    const read = readLeafSync(real, degraded, false);
    assert.equal(read.state, "present");
    assert.ok(read.state === "present" && read.bytes.equals(Buffer.from("# Skill\n")));

    assert.deepEqual(readLeafSync(path.join(dir, "nope"), degraded, false), { state: "missing" });
    assert.deepEqual(readLeafSync(dir, degraded, false), { state: "unsafe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("degraded (no O_NOFOLLOW): an ancestor symlink is still honored — the guard stays leaf-only", () => {
  const dir = workspace();
  try {
    const real = path.join(dir, "real-home");
    mkdirSync(real);
    writeFileSync(path.join(real, "SKILL.md"), "# Skill\n");
    symlinkSync(real, path.join(dir, "stowed-home"));
    const read = readLeafSync(path.join(dir, "stowed-home", "SKILL.md"), constants.O_RDONLY, false);
    assert.equal(read.state, "present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
