import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFilesystemRuntime, FilesystemBackend, type FilesystemHostPolicy } from "../src/filesystem.js";
import { ConcurrentReplacementError, InvalidInputError } from "../src/errors.js";
import { readDoc } from "../src/bundle.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { acquireFilesystemMutationLock, FilesystemMutationLockError } from "../src/filesystem-lock.js";
import { readRawFilesystemDocument, readRawFilesystemReserved, listFilesystemReservedObjects } from "../src/publication-filesystem.js";

function policy(runtimeParent: string, owner: string): FilesystemHostPolicy {
  return {
    runtimeLockParent: () => runtimeParent,
    runtimeOwnerKey: () => owner,
    enforcePrivateMode: true,
    isTransientOpenError: () => false,
    isReplacementConflict: () => false,
    isDirectoryContentionError: () => false,
  };
}

test("configured runtimes snapshot host members, retain initialized backends, and isolate direct lock namespaces", async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "sb-host-runtime-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = { ...policy(dir, "a"), owner: "a", runtimeOwnerKey() { return this.owner; } };
  const a = createFilesystemRuntime(source);
  const b = createFilesystemRuntime(policy(dir, "b"));
  source.runtimeOwnerKey = () => "changed";
  assert.equal(Object.isFrozen(source), false);
  const target = path.join(dir, "bundle", "x.md");
  assert.match(a.mutationLockPath(target), /mutation-locks-a/);
  assert.match(b.mutationLockPath(target), /mutation-locks-b/);
  const sameHost = createFilesystemRuntime(policy(dir, "a"));
  assert.equal(sameHost.mutationLockPath(target), a.mutationLockPath(target));
  const bundle = await a.initBundle(path.join(dir, "bundle"), { okfVersion: "0.1" });
  assert.ok(bundle.backend instanceof FilesystemBackend);
  await bundle.backend.write("x", { id: "x", frontmatter: { type: "Note" }, body: "kept" });
  assert.equal((await readDoc(bundle, "x")).body.trim(), "kept");
  await a.withMutationLock(target, async () => {
    await assert.rejects(
      sameHost.withMutationLock(target, async () => assert.fail("same-user runtime bypassed the held lock"), { waitMs: 0 }),
      FilesystemMutationLockError,
    );
  });
  await Promise.all([
    a.withMutationLock(target, async () => assert.equal((await fs.readdir(path.dirname(a.mutationLockPath(target)))).length, 1)),
    b.withMutationLock(target, async () => assert.equal((await fs.readdir(path.dirname(b.mutationLockPath(target)))).length, 1)),
  ]);
});

test("backend and publication raw observations retain their own captured open classification", async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "sb-host-read-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "bundle");
  const source = { ...policy(dir, "read"), isTransientOpenError: (error: unknown) => error === transient };
  const a = new FilesystemBackend(root, { hostPolicy: source });
  const b = new FilesystemBackend(root, { hostPolicy: policy(dir, "read") });
  const transient = new Error("synthetic uncertain open generation");
  await a.writeReserved("", "index.md", "---\nokf_version: '0.1'\n---\nindex\n");
  await a.write("x", { id: "x", frontmatter: { type: "Note" }, body: "bytes" });
  source.isTransientOpenError = () => false;
  const open = fs.open;
  let failNext = false;
  let failures = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (failNext) { failNext = false; failures++; throw transient; }
    return open(...args);
  });
  for (const read of [
    () => a.read("x"),
    () => a.readMany(["x"]),
    () => a.readReserved("", "index.md"),
    () => readRawFilesystemDocument(a, "x"),
    () => readRawFilesystemReserved(a, "", "index.md"),
  ]) {
    failNext = true;
    await read();
  }
  assert.equal(failures, 5);
  assert.deepEqual(await listFilesystemReservedObjects(a), [{ dir: "", name: "index.md" }]);
  failNext = true;
  await assert.rejects(b.read("x"), (error) => error === transient);
});

test("unsupported default filesystem calls refuse before creating target parents; explicit and memory stores remain usable", async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "sb-host-unsupported-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: "unsupported-test-host" });
  t.after(() => Object.defineProperty(process, "platform", original));
  const target = path.join(dir, "never-created", "x.md");
  assert.throws(() => new FilesystemBackend(path.dirname(target)), InvalidInputError);
  assert.throws(() => createFilesystemRuntime(), InvalidInputError);
  await assert.rejects(acquireFilesystemMutationLock(target, { lockRoot: path.join(dir, "explicit-locks") }), InvalidInputError);
  await assert.rejects(fs.stat(path.dirname(target)), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(dir, "explicit-locks")), { code: "ENOENT" });
  const memory = new MemoryBackend();
  await memory.write("x", { id: "x", frontmatter: { type: "Note" }, body: "memory" });
  assert.equal((await memory.read("x")).doc.body, "memory\n");
  await createFilesystemRuntime(policy(dir, "explicit")).initBundle(path.join(dir, "explicit"));
});


test("production replacement classification is captured and cannot leak between backends", async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "sb-host-replace-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "bundle");
  const conflict = new Error("synthetic replace conflict");
  const selected = { ...policy(dir, "replace"), isReplacementConflict: (error: unknown) => error === conflict };
  const a = new FilesystemBackend(root, { hostPolicy: selected });
  const b = new FilesystemBackend(root, { hostPolicy: policy(dir, "replace") });
  await a.write("x", { id: "x", frontmatter: { type: "Note" }, body: "old" });
  selected.isReplacementConflict = () => false;
  let renames = 0;
  const rename = fs.rename;
  // Only document replacement inside the bundle conflicts; runtime lock release also renames.
  t.mock.method(fs, "rename", async (from: string, to: string) => {
    if (!String(to).startsWith(root)) return rename(from, to);
    renames++;
    throw conflict;
  });
  const doc = { id: "x", frontmatter: { type: "Note" }, body: "new" };
  await assert.rejects(a.write("x", doc), ConcurrentReplacementError);
  await assert.rejects(b.write("x", doc), (error) => error === conflict);
  assert.equal(renames, 2, "each failed attempt calls rename once");
  assert.equal((await a.read("x")).doc.body.trim(), "old");
  assert.deepEqual(await fs.readdir(root), ["x.md"], "both attempts clean only their own temporary file");
});


test("a fresh unsupported-host process can import core and use memory without selecting filesystem defaults", () => {
  const code = `
    Object.defineProperty(process, "platform", { value: "unsupported-test-host" });
    const { MemoryBackend } = await import("@superbee/core");
    const store = new MemoryBackend();
    await store.write("x", { id: "x", frontmatter: { type: "Note" }, body: "memory" });
    if ((await store.read("x")).doc.body !== "memory\\n") throw new Error("memory roundtrip");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("composed policy methods and public data cannot move a runtime's held lock namespace", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "sb-host-compose-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = {
    ...policy(dir, "original"),
    data: { owner: "original" },
    runtimeOwnerKey() { return this.data.owner; },
    runtimeLockParent() { return path.join(dir, this.runtimeOwnerKey()); },
  };
  const runtime = createFilesystemRuntime(source);
  const target = path.join(dir, "bundle", "doc.md");
  const before = runtime.mutationLockPath(target);
  await runtime.withMutationLock(target, async () => {
    source.runtimeOwnerKey = () => "reassigned";
    source.data.owner = "mutated";
    assert.equal(Object.isFrozen(source), false);
    assert.equal(Object.isFrozen(source.data), false);
    assert.equal(runtime.mutationLockPath(target), before);
    await assert.rejects(runtime.withMutationLock(target, async () => {
      assert.fail("same runtime bypassed its held lock");
    }, { waitMs: 0 }), FilesystemMutationLockError);
  });
  await runtime.withMutationLock(target, async () => {});
});
