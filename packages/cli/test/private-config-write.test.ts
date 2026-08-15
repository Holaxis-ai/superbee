import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFileSync } from "../src/private-config-write.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("host installers source shared private-config writing from a neutral module", async () => {
  const [writer, hook, skill] = await Promise.all([
    readFile(path.join(PACKAGE_ROOT, "src/private-config-write.ts"), "utf8"),
    readFile(path.join(PACKAGE_ROOT, "src/commands/hook.ts"), "utf8"),
    readFile(path.join(PACKAGE_ROOT, "src/commands/skill.ts"), "utf8"),
  ]);

  assert.doesNotMatch(writer, /from ["'][^"']*commands\//, "neutral infrastructure must not depend on feature commands");
  assert.match(hook, /from ["']\.\.\/private-config-write\.js["']/);
  assert.match(skill, /from ["']\.\.\/private-config-write\.js["']/);
  assert.doesNotMatch(skill, /from ["']\.\/hook\.js["']/);
});

test("atomicWriteFileSync creates and replaces through same-directory rename without residue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-atomic-write-"));
  const target = path.join(dir, "nested", "settings.json");
  try {
    atomicWriteFileSync(target, "first\n");
    assert.equal(await readFile(target, "utf8"), "first\n");
    atomicWriteFileSync(target, "second\n");
    assert.equal(await readFile(target, "utf8"), "second\n");
    assert.deepEqual(await readdir(path.dirname(target)), ["settings.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomicWriteFileSync preserves the mode of an existing private file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-atomic-mode-"));
  const target = path.join(dir, "settings.json");
  try {
    await writeFile(target, "private\n");
    await chmod(target, 0o600);
    atomicWriteFileSync(target, "replaced\n");
    assert.equal(await readFile(target, "utf8"), "replaced\n");
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomicWriteFileSync can refuse a final symlink without changing either entry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-atomic-symlink-"));
  const target = path.join(dir, "managed-target.js");
  const link = path.join(dir, "axi-superbee.js");
  try {
    await writeFile(target, "user-owned\n");
    await symlink(path.basename(target), link);

    assert.throws(
      () => atomicWriteFileSync(link, "generated\n", { followFinalSymlink: false }),
      /symlink .*refusing to replace a generated plugin through a link/,
    );

    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await realpath(link), await realpath(target));
    assert.equal(await readFile(target, "utf8"), "user-owned\n");
    assert.deepEqual((await readdir(dir)).sort(), ["axi-superbee.js", "managed-target.js"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomicWriteFileSync cleans its temporary file after a failed rename", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-atomic-fail-"));
  const target = path.join(dir, "settings.json");
  try {
    await mkdir(target);
    await writeFile(path.join(target, "occupant"), "x\n");
    assert.throws(() => atomicWriteFileSync(target, "doomed\n"));
    assert.deepEqual(await readdir(dir), ["settings.json"]);
    assert.equal(await readFile(path.join(target, "occupant"), "utf8"), "x\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
