/**
 * The leaf-read primitive that closes the check-then-read window: a path whose leaf is (or becomes)
 * a symlink never yields the link target's bytes, while an ordinary regular file reads unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
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

test("an absent path is missing and a directory is unsafe — neither throws", () => {
  const dir = workspace();
  try {
    assert.deepEqual(readRegularFileNoFollowSync(path.join(dir, "nope")), { state: "missing" });
    assert.deepEqual(readRegularFileNoFollowSync(dir), { state: "unsafe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
