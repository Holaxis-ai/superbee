import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FilesystemBackend } from "../src/backend.js";

// An unreadable target (EACCES) is an entry that exists, is listed exactly, and cannot be opened.
// The expect-absent premise must treat that read failure as uncertainty, never as absence:
// nothing may be replaced, and the error must surface unchanged.
test("FilesystemBackend expect-absent observation propagates read uncertainty", async (t) => {
  if (process.getuid?.() === 0) {
    t.diagnostic("running as root: EACCES cannot be provoked; this row is not exercised");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "agentstate-lite-expected-version-"));
  const target = path.join(root, "index.md");
  try {
    await writeFile(target, "foreign bytes\n");
    await chmod(target, 0o000);
    await assert.rejects(
      () => new FilesystemBackend(root).writeReserved("", "index.md", "replacement\n", { expectedVersion: null }),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "EACCES",
    );
    await chmod(target, 0o600);
    assert.equal(await readFile(target, "utf8"), "foreign bytes\n");
    assert.deepEqual(await readdir(root), ["index.md"]);
  } finally {
    await chmod(target, 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
