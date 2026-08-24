import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FilesystemBackend } from "../src/backend.js";

// A self-referential symlink is an entry that exists (lstat succeeds, it is listed exactly) but
// cannot be opened (ELOOP). The expect-absent premise must treat that read failure as
// uncertainty, never as absence: nothing may be replaced, and the error must surface unchanged.
test("FilesystemBackend expect-absent observation propagates read uncertainty", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentstate-lite-expected-version-"));
  const target = path.join(root, "index.md");
  try {
    await symlink("index.md", target);
    await assert.rejects(
      () => new FilesystemBackend(root).writeReserved("", "index.md", "replacement\n", { expectedVersion: null }),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "ELOOP",
    );
    assert.equal(await readlink(target), "index.md");
    assert.deepEqual(await readdir(root), ["index.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
