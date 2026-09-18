import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FilesystemBackend } from "../src/backend.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { contentVersion, versionOfBytes } from "../src/versioning.js";

/**
 * The promise that travels between backends is bytes, never the version token (decision of
 * 2026-09-17, "bytes win"). A hand-authored file keeps its bytes on the filesystem backend
 * exactly as written, and its token there is the hash of those bytes; the in-memory backend
 * hashes a re-serialization, which may differ for content Superbee did not author. This test
 * states both halves so neither is mistaken for a defect or for a cross-backend guarantee.
 */
const authored = `---
title: Hand authored
tags: [alpha, beta]
timestamp: 2026-07-01T12:05:00Z
---
A body Superbee did not write.
`;

test("a hand-authored file keeps its bytes on the filesystem backend and its token is the hash of those bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-byte-portability-"));
  try {
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, "notes", "authored.md"), authored);
    const backend = new FilesystemBackend(root);
    const read = await backend.read("notes/authored");
    assert.equal(await readFile(path.join(root, "notes", "authored.md"), "utf8"), authored, "bytes untouched by a read");
    assert.equal(read.version, versionOfBytes(authored), "the filesystem token is the hash of the stored bytes");
    // The same parsed content re-serialized by the engine may hash differently: the token is
    // the backend's, and no promise rests on it matching another backend's.
    const memory = new MemoryBackend();
    await memory.write("notes/authored", read.doc, { expectedVersion: null });
    const inMemory = await memory.read("notes/authored");
    assert.equal(inMemory.version, contentVersion(read.doc), "the memory token is the hash of the re-serialization");
    assert.deepEqual(inMemory.doc.frontmatter, read.doc.frontmatter, "the parsed content agrees");
    assert.equal(inMemory.doc.body, read.doc.body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an engine-written document carries the same token on both backends", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-byte-portability-"));
  try {
    const doc = { frontmatter: { title: "Engine written", type: "Note" }, body: "Written by the engine.\n" } as Parameters<
      FilesystemBackend["write"]
    >[1];
    const fs = new FilesystemBackend(root);
    const memory = new MemoryBackend();
    const [onDisk, inMemory] = await Promise.all([
      fs.write("notes/engine", doc, { expectedVersion: null }),
      memory.write("notes/engine", doc, { expectedVersion: null }),
    ]);
    assert.equal(onDisk, inMemory, "canonical bytes hash the same everywhere");
    assert.equal(onDisk, contentVersion(doc));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
