import assert from "node:assert/strict";
import { readdir, readFile, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FilesystemBackend, probeFilesystemPath } from "../src/backend.js";

test("N2: FilesystemBackend retains one required constructor argument, the contract prototype, and no statics", () => {
  assert.equal(FilesystemBackend.length, 1);
  // Qualified methods accept captured data (or no input), never a caller transaction callback.
  assert.deepEqual(Object.getOwnPropertyNames(FilesystemBackend.prototype).sort(), [
    "capabilities",
    "classifyChangedPath",
    "commitQualifiedGeneration",
    "constructor",
    "delete",
    "deleteBlob",
    "exists",
    "existsBlob",
    "inventoryGuard",
    "list",
    "listBlobs",
    "read",
    "readBlob",
    "readMany",
    "readQualifiedRecords",
    "readReserved",
    "snapshotQualified",
    "versions",
    "write",
    "writeBlob",
    "writeReserved",
  ]);
  assert.deepEqual(Object.getOwnPropertyNames(FilesystemBackend).sort(), ["length", "name", "prototype"]);
  assert.deepEqual(Object.getOwnPropertySymbols(FilesystemBackend), []);
  assert.deepEqual(Object.getOwnPropertySymbols(FilesystemBackend.prototype), []);
  assert.equal(Object.getPrototypeOf(FilesystemBackend), Function.prototype, "no base class carries hidden members");
  const instance = new FilesystemBackend("/nonexistent");
  assert.deepEqual(Object.getOwnPropertyNames(instance), [], "state is private, not an own property");
});

test("N1: metadata-only projection probe preserves absence, rejects unsafe keys and creates no paths", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "projection-probe-")), root = path.join(directory, "absent");
  try {
    const backend = new FilesystemBackend(root);
    assert.equal(await probeFilesystemPath(backend, "nested/a.bin"), "absent");
    await assert.rejects(probeFilesystemPath(backend, "../escape.bin"));
    assert.deepEqual(await readdir(directory), []);
    await mkdir(root); await writeFile(path.join(root, "a.bin"), "opaque bytes");
    assert.equal(await probeFilesystemPath(backend, "a.bin"), "exact");
    assert.equal(await readFile(path.join(root, "a.bin"), "utf8"), "opaque bytes");
    assert.deepEqual(await readdir(root), ["a.bin"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
