/**
 * Filesystem-only rows for identity realization and entry classification. Other adapters do not
 * have directories, platform casing, or host I/O failures, so keeping these alongside the shared
 * storage contract makes that boundary explicit instead of faking cross-backend parity.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { InvalidInputError } from "../src/errors.js";
import type { StorageBackend } from "../src/types.js";

export interface FilesystemSemanticsFixture {
  backend: StorageBackend;
  root: string;
  cleanup(): Promise<void>;
}

export interface FilesystemSemanticsContractOptions {
  name: string;
  create(): Promise<FilesystemSemanticsFixture> | FilesystemSemanticsFixture;
}

const TIMESTAMP = "2026-07-01T00:00:00.000Z";

function document(id: string) {
  return { id, frontmatter: { type: "ContractFixture", timestamp: TIMESTAMP }, body: "body" };
}

function errno(code: "EACCES" | "EPERM") {
  return Object.assign(new Error(`injected ${code}`), { code });
}

async function aliases(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function withLstatFault(
  target: string,
  code: "EACCES" | "EPERM",
  run: () => Promise<void>,
): Promise<void> {
  const original = fs.lstat;
  Reflect.set(fs, "lstat", async (...args: unknown[]) => {
    if (path.resolve(String(args[0])) === path.resolve(target)) throw errno(code);
    return Reflect.apply(original, fs, args);
  });
  try {
    await run();
  } finally {
    Reflect.set(fs, "lstat", original);
  }
}

async function withReaddirFault(target: string, run: () => Promise<void>): Promise<void> {
  const original = fs.readdir;
  Reflect.set(fs, "readdir", async (...args: unknown[]) => {
    if (path.resolve(String(args[0])) === path.resolve(target)) throw errno("EACCES");
    return Reflect.apply(original, fs, args);
  });
  try {
    await run();
  } finally {
    Reflect.set(fs, "readdir", original);
  }
}

function rejectsCode(operation: () => Promise<unknown>, code: "EACCES" | "EPERM") {
  return assert.rejects(operation, (error: unknown) => (error as NodeJS.ErrnoException).code === code);
}

export function registerFilesystemSemanticsContract(options: FilesystemSemanticsContractOptions): void {
  const { name, create } = options;

  test(`${name} filesystem semantics: directories are invalid document and reserved-file shapes`, async () => {
    const fixture = await create();
    try {
      const { backend, root } = fixture;
      await mkdir(path.join(root, "docs", "directory.md"), { recursive: true });
      for (const operation of [
        () => backend.read("docs/directory"),
        () => backend.exists("docs/directory"),
        () => backend.versions("docs/directory"),
        () => backend.write("docs/directory", document("docs/directory")),
        () => backend.delete("docs/directory"),
      ]) {
        await assert.rejects(operation, InvalidInputError);
      }
      await assert.rejects(() => backend.list(), InvalidInputError);

      await mkdir(path.join(root, "index.md"));
      await assert.rejects(() => backend.readReserved("", "index.md"), InvalidInputError);
      await assert.rejects(() => backend.writeReserved("", "index.md", "replacement\n"), InvalidInputError);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${name} filesystem semantics: blob directory compatibility is explicit per operation`, async () => {
    const fixture = await create();
    try {
      const { backend, root } = fixture;
      await mkdir(path.join(root, "artifacts"));
      assert.equal(await backend.readBlob("artifacts"), null);
      assert.equal(await backend.existsBlob("artifacts"), false);
      assert.equal(await backend.deleteBlob("artifacts"), false);
      await assert.rejects(() => backend.writeBlob("artifacts", new Uint8Array([1])), InvalidInputError);
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${name} filesystem semantics: only ENOENT becomes absence; injected access failures propagate`, async () => {
    const fixture = await create();
    try {
      const { backend, root } = fixture;
      await backend.write("docs/live", document("docs/live"));
      const target = path.join(root, "docs", "live.md");
      await backend.writeReserved("", "log.md", "log\n");
      const reservedTarget = path.join(root, "log.md");
      await backend.writeBlob("artifacts/live.bin", new Uint8Array([1]));
      const blobTarget = path.join(root, "artifacts", "live.bin");
      for (const code of ["EACCES", "EPERM"] as const) {
        await withLstatFault(target, code, async () => {
          for (const operation of [
            () => backend.read("docs/live"),
            () => backend.exists("docs/live"),
            () => backend.versions("docs/live"),
            () => backend.write("docs/live", document("docs/live")),
            () => backend.delete("docs/live"),
          ]) {
            await rejectsCode(operation, code);
          }
        });
        await withLstatFault(reservedTarget, code, async () => {
          await rejectsCode(() => backend.readReserved("", "log.md"), code);
          await rejectsCode(() => backend.writeReserved("", "log.md", "replacement\n"), code);
        });
        await withLstatFault(blobTarget, code, async () => {
          for (const operation of [
            () => backend.readBlob("artifacts/live.bin"),
            () => backend.existsBlob("artifacts/live.bin"),
            () => backend.writeBlob("artifacts/live.bin", new Uint8Array([2])),
            () => backend.deleteBlob("artifacts/live.bin"),
          ]) {
            await rejectsCode(operation, code);
          }
        });
      }

      await withReaddirFault(root, async () => {
        await rejectsCode(() => backend.list(), "EACCES");
        await rejectsCode(() => backend.listBlobs(), "EACCES");
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${name} filesystem semantics: capability-gated case and normalization aliases are rejected`, async () => {
    const fixture = await create();
    try {
      const { backend, root } = fixture;
      await writeFile(path.join(root, "Case.md"), "---\ntype: ContractFixture\n---\nbody\n");
      if (await aliases(path.join(root, "case.md"))) {
        await assert.rejects(() => backend.read("case"), InvalidInputError);
        await assert.rejects(() => backend.write("case", document("case"), { expectedVersion: null }), InvalidInputError);
      }

      const decomposed = "cafe\u0301.md";
      const composed = "caf\u00e9.md";
      await writeFile(path.join(root, decomposed), "---\ntype: ContractFixture\n---\nbody\n");
      if (await aliases(path.join(root, composed))) {
        await assert.rejects(() => backend.read("caf\u00e9"), InvalidInputError);
        await assert.rejects(() => backend.write("caf\u00e9", document("caf\u00e9"), { expectedVersion: null }), InvalidInputError);
      }
    } finally {
      await fixture.cleanup();
    }
  });
}
