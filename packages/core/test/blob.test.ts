/**
 * Contract tests for blob storage on the {@link StorageBackend} seam (Stage-1 Unit 2a
 * Part A — core + seam): opaque bytes + a content-type, addressed by a bundle-relative
 * key DISJOINT from the concept-document namespace, versioned by a RAW-BYTES content
 * hash (never the doc-shaped `contentVersion`/`versionOfBytes`), CAS-able via the same
 * `WriteOptions` concept documents use, guarded against traversal / `.md` collision /
 * dot-prefixed segments at every op.
 *
 * Universal backend semantics live in `storage-backend-contract.ts` and run against
 * FilesystemBackend, MemoryBackend, and RemoteBackend. This file owns the pure blob
 * primitives plus adapter- and engine-specific behavior.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeDoc, list, readBlob, writeBlob, existsBlob, listBlobs, deleteBlob } from "../src/bundle.js";
import { FilesystemBackend } from "../src/backend.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { blobVersion, VersionConflict } from "../src/versioning.js";
import { assertSafeBlobKey } from "../src/paths.js";
import { InvalidInputError } from "../src/errors.js";
import { resolveContentType } from "../src/content-type.js";
import type { Bundle, Version } from "../src/types.js";
import { T_DOC } from "./scenario.js";

/** Run `fn` against a bundle over a fresh temp-dir FilesystemBackend, then clean up. */
async function withFsBundle(fn: (bundle: Bundle) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-blob-fs-"));
  try {
    await fn({ root, backend: new FilesystemBackend(root) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Run `fn` against a bundle over a fresh MemoryBackend (its `root` is inert). */
async function withMemBundle(fn: (bundle: Bundle) => Promise<void>): Promise<void> {
  await fn({ root: "mem://blob-bundle", backend: new MemoryBackend() });
}

/** The two Part-A adapters, driven through the identical runner shape. */
const RUNNERS = [
  ["FilesystemBackend", withFsBundle],
  ["MemoryBackend", withMemBundle],
] as const;

const enc = (s: string) => new TextEncoder().encode(s);

// ── raw-bytes versioning: a SEPARATE primitive from the doc-shaped hashes (B1) ─

test("blobVersion hashes RAW bytes with no string/UTF-8 step (binary fidelity)", () => {
  // A lone continuation byte (0x80) is INVALID UTF-8 — routed through a string-based
  // hash it would decode to U+FFFD before hashing, silently colliding with any other
  // byte sequence that decodes the same lossy way. blobVersion must never do that.
  const invalidUtf8 = new Uint8Array([0x80, 0x81, 0xff, 0x00, 0x01]);
  const v = blobVersion(invalidUtf8);
  assert.match(v, /^sha256:[0-9a-f]{64}$/);
  const other = new Uint8Array([0x80, 0x82, 0xff, 0x00, 0x01]);
  assert.notEqual(v, blobVersion(other), "distinct byte sequences must hash to distinct versions");
});

// ── concurrent CAS writers (B3) ────────────────────────────────────────────

test("FilesystemBackend: N concurrent CAS blob writes to the SAME key produce exactly ONE winner and N-1 typed VersionConflicts (writeBlob's check-then-write runs inside the SAME per-key mutex as docs)", async () => {
  await withFsBundle(async (bundle) => {
    const baseVersion = await writeBlob(bundle, "hot/cas.bin", enc("base"));

    const N = 10;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        writeBlob(bundle, "hot/cas.bin", enc(`v${i}`), undefined, { expectedVersion: baseVersion }),
      ),
    );

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Version> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one CAS blob write racing the same expectedVersion must win");
    assert.equal(rejected.length, N - 1, "every other racer must observe a genuine conflict, not silent loss");
    for (const r of rejected) {
      assert.ok(r.reason instanceof VersionConflict, `expected a VersionConflict, got ${String(r.reason)}`);
      assert.equal(r.reason.expected, baseVersion);
    }

    const final = await readBlob(bundle, "hot/cas.bin");
    assert.equal(final!.version, fulfilled[0]!.value);
  });
});

test("FilesystemBackend: N concurrent CAS blob deletes racing the SAME expectedVersion converge to exactly ONE true winner and N-1 idempotent false losers (never a VersionConflict)", async () => {
  await withFsBundle(async (bundle) => {
    const baseVersion = await writeBlob(bundle, "hot/cas-delete.bin", enc("base"));

    const N = 10;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => deleteBlob(bundle, "hot/cas-delete.bin", { expectedVersion: baseVersion })),
    );
    assert.deepEqual(results.filter((r) => r.status === "rejected"), []);
    const values = results.map((r) => (r as PromiseFulfilledResult<boolean>).value);
    assert.equal(values.filter((v) => v === true).length, 1);
    assert.equal(values.filter((v) => v === false).length, N - 1);
    assert.equal(await existsBlob(bundle, "hot/cas-delete.bin"), false);
  });
});

// ── guards: traversal, .md (incl. case-insensitive), reserved names, dot-segments (I1) ─

const UNSAFE_BLOB_KEYS = [
  "../../../etc/passwd",
  "/etc/passwd",
  "artifacts/../../../etc/passwd",
  "artifacts/report.md", // collides with the concept-document namespace
  "artifacts/report.MD", // B6: case-insensitive
  "index.md", // reserved filename (subsumed by the .md check)
  "LOG.MD", // reserved filename, upper-case
  ".git/config", // dot-prefixed leading segment
  "artifacts/.hidden.bin", // dot-prefixed non-leading segment
  "artifacts/", // trailing slash, names no file
  "report.md/attachment.png", // .md collision in a non-final segment
];

test("assertSafeBlobKey: pure guard rejects every unsafe shape directly", () => {
  for (const key of UNSAFE_BLOB_KEYS) {
    assert.throws(() => assertSafeBlobKey(key), /blob key/i, `assertSafeBlobKey('${key}') must throw`);
  }
  assertSafeBlobKey("artifacts/report.html"); // sanity: a normal key stays valid
});

for (const [name, run] of RUNNERS) {
  test(`${name}: the engine rejects every unsafe blob key before storage`, async () => {
    await run(async (bundle) => {
      for (const key of UNSAFE_BLOB_KEYS) {
        await assert.rejects(() => readBlob(bundle, key), /blob key/i);
        await assert.rejects(() => writeBlob(bundle, key, enc("x")), /blob key/i);
        await assert.rejects(() => existsBlob(bundle, key), /blob key/i);
        await assert.rejects(() => deleteBlob(bundle, key), /blob key/i);
      }
    });
  });
}

test("FilesystemBackend: an unsafe blob key never creates a file outside the bundle root (belt-and-suspenders)", async () => {
  await withFsBundle(async (bundle) => {
    for (const key of ["../../../../tmp/pwned.bin", "/tmp/pwned.bin"]) {
      await assert.rejects(() => writeBlob(bundle, key, enc("pwned")));
    }
    // Sanity: a SAFE sibling write still lands exactly inside the bundle root.
    await writeBlob(bundle, "safe/blob.bin", enc("ok"));
    assert.equal(await existsBlob(bundle, "safe/blob.bin"), true);
  });
});

test("FilesystemBackend: direct unsafe writes fail before realizing a path", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "okf-blob-direct-"));
  const root = path.join(parent, "bundle");
  const escaped = path.join(parent, "outside.bin");
  try {
    const backend = new FilesystemBackend(root);
    await assert.rejects(() => backend.writeBlob("../outside.bin", enc("blocked")), InvalidInputError);
    await assert.rejects(
      () => stat(escaped),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("FilesystemBackend: listBlobs skips dot-entries on disk (I3 — the WALK itself excludes atomicWrite-shaped temp files and dotfiles, not just the write-time guard)", async () => {
  await withFsBundle(async (bundle) => {
    await writeBlob(bundle, "artifacts/keep.bin", enc("kept"));
    // Simulate a leftover atomicWrite temp file and a stray dotfile/dot-dir directly on
    // disk (bypassing writeBlob's guard entirely, the way a real leftover would) to prove
    // the LISTING walk itself excludes dot-entries.
    await writeFile(path.join(bundle.root, ".artifacts-keep.bin.12345.deadbeef.tmp"), "leftover");
    await mkdir(path.join(bundle.root, ".git"), { recursive: true });
    await writeFile(path.join(bundle.root, ".git", "config"), "junk");

    assert.deepEqual(await listBlobs(bundle), ["artifacts/keep.bin"]);
  });
});

// ── content-type: ONE resolution point, per-adapter persistence posture (B5) ──

test("resolveContentType: explicit override wins, else inferred from extension, else application/octet-stream (the ONE MIME source)", () => {
  assert.equal(resolveContentType("artifacts/report.html"), "text/html; charset=utf-8");
  assert.equal(resolveContentType("artifacts/report.html", "application/x-custom"), "application/x-custom");
  assert.equal(resolveContentType("artifacts/data.unknownext"), "application/octet-stream");
  assert.equal(resolveContentType("artifacts/noext"), "application/octet-stream");
});

test("FilesystemBackend: writeBlob accepts-but-does-NOT-persist an explicit content-type override — readBlob always infers from the key extension (documented divergence, B5)", async () => {
  await withFsBundle(async (bundle) => {
    await writeBlob(bundle, "artifacts/report.html", enc("<p>hi</p>"), "application/x-custom-override");
    const read = await readBlob(bundle, "artifacts/report.html");
    assert.equal(read!.contentType, "text/html; charset=utf-8"); // the override did NOT stick
  });
});

test("MemoryBackend: writeBlob PERSISTS an explicit content-type override — readBlob returns exactly what was stored (documented divergence, B5)", async () => {
  await withMemBundle(async (bundle) => {
    await writeBlob(bundle, "artifacts/report.html", enc("<p>hi</p>"), "application/x-custom-override");
    const read = await readBlob(bundle, "artifacts/report.html");
    assert.equal(read!.contentType, "application/x-custom-override"); // the override DID stick
  });
});

// ── blob-free / blob-carrying bundles: the concept walk never sees blobs ──────

for (const [name, run] of RUNNERS) {
  test(`${name}: a bundle carrying blobs is byte-identical to a blob-free bundle from the concept walk's perspective (list/query never see blobs)`, async () => {
    await run(async (bundle) => {
      await writeDoc(bundle, {
        id: "concepts/alpha",
        frontmatter: { type: "Concept", title: "Alpha", timestamp: T_DOC },
        body: "Alpha.",
      });
      const before = (await list(bundle)).map((d) => d.id);

      await writeBlob(bundle, "artifacts/report.html", enc("<p>hi</p>"));
      await writeBlob(bundle, "artifacts/data.bin", enc("raw"));

      const after = (await list(bundle)).map((d) => d.id);
      assert.deepEqual(after, before);
      assert.deepEqual(after, ["concepts/alpha"]);
    });
  });
}

test("MemoryBackend: writeBlob copies a Buffer's bytes rather than aliasing them — mutating the caller's buffer AFTER the write must not mutate the stored blob (Buffer.prototype.slice() returns a VIEW, not a copy)", async () => {
  const mem = new MemoryBackend();
  const bundle: Bundle = { root: "mem://buffer-alias", backend: mem };
  const original = Buffer.from("original content");
  await writeBlob(bundle, "artifacts/x.bin", original);

  // Mutate the SOURCE buffer in place after the write returned.
  original.fill(0);
  assert.equal(original.toString("utf8"), "\0".repeat(original.length));

  const stored = await readBlob(bundle, "artifacts/x.bin");
  assert.equal(Buffer.from(stored!.bytes).toString("utf8"), "original content");
});

test("MemoryBackend: readBlob returns a copy too — mutating the RETURNED bytes must not mutate the stored blob on a subsequent read", async () => {
  const mem = new MemoryBackend();
  const bundle: Bundle = { root: "mem://buffer-alias-read", backend: mem };
  await writeBlob(bundle, "artifacts/x.bin", Buffer.from("stable"));

  const first = await readBlob(bundle, "artifacts/x.bin");
  first!.bytes.fill(0);

  const second = await readBlob(bundle, "artifacts/x.bin");
  assert.equal(Buffer.from(second!.bytes).toString("utf8"), "stable");
});

test("FilesystemBackend: existsBlob returns false for a DIRECTORY-shaped path (a sibling key leaves a real directory on disk), matching MemoryBackend's directory-free model", async () => {
  await withFsBundle(async (bundle) => {
    // Writing "artifacts/x/y.bin" creates a real directory "artifacts/x" on disk.
    await writeBlob(bundle, "artifacts/x/y.bin", enc("nested"));
    assert.equal(await existsBlob(bundle, "artifacts/x/y.bin"), true);
    // "artifacts/x" itself is a DIRECTORY, not a blob — must report false, not true
    // (a bare pathExists()-style check would wrongly say true here).
    assert.equal(await existsBlob(bundle, "artifacts/x"), false);
    // A MemoryBackend has no such collision to begin with (no directory concept at
    // all) — "artifacts/x" was simply never written as a key, so it is trivially
    // false there too; the interesting case is FilesystemBackend's disk reality.
  });
});

test("FilesystemBackend: readBlob returns null (not a throw) for a DIRECTORY-shaped path (EISDIR treated as absent, same as ENOENT)", async () => {
  await withFsBundle(async (bundle) => {
    await writeBlob(bundle, "artifacts/x/y.bin", enc("nested"));
    assert.equal(await readBlob(bundle, "artifacts/x"), null);
  });
});

test("FilesystemBackend: readBlob reports a file-shaped path segment as 'absent' but PROPAGATES a genuine fs error — a blanket catch would misreport a real failure as a normal miss", async (t) => {
  await withFsBundle(async (bundle) => {
    // "artifacts/x.bin" is a FILE; a NESTED key underneath it names a shape the bundle cannot
    // hold (ENOTDIR), which the identity protocol classifies as absence for observations,
    // exactly like ENOENT and EISDIR.
    await writeBlob(bundle, "artifacts/x.bin", enc("a file, not a dir"));
    assert.equal(await readBlob(bundle, "artifacts/x.bin/nested.bin"), null);
    if (process.getuid?.() === 0) {
      // Skip, not a diagnostic: as root the permission-failure half of this row cannot run, and a
      // pass would report coverage the run did not have. A skip counts in the runner's summary.
      t.skip("running as root: EACCES cannot be provoked, permission-failure row not exercised");
      return;
    }
    // An unreadable blob is a real failure (EACCES), deterministic and non-flaky, and it must surface.
    const unreadable = path.join(bundle.root, "artifacts", "x.bin");
    await chmod(unreadable, 0o000);
    try {
      await assert.rejects(
        () => readBlob(bundle, "artifacts/x.bin"),
        (err: unknown) => {
          assert.equal((err as NodeJS.ErrnoException).code, "EACCES");
          return true;
        },
      );
    } finally {
      await chmod(unreadable, 0o600);
    }
  });
});

test("assertSafeBlobKey: rejects a '.md'-ending NON-FINAL segment, not just the final one — 'report.md/attachment.png' would otherwise create an on-disk directory literally named 'report.md', colliding with a future concept doc at id 'report'", () => {
  assert.throws(() => assertSafeBlobKey("report.md/attachment.png"), /blob key/i);
  assert.throws(() => assertSafeBlobKey("a/Report.MD/b/c.bin"), /blob key/i); // case-insensitive, any depth
  assert.throws(() => assertSafeBlobKey("index.md/nested.bin"), /blob key/i); // a reserved name mid-path too
});

// ── mutation-survivor pins (core-survivor-triage unit) ────────────────────────

// kills: memory-backend.ts:240:53 ConditionalExpression #2488
// kills: memory-backend.ts:240:53 EqualityOperator #2489
test("pin: MemoryBackend re-writing IDENTICAL bytes with a DIFFERENT explicit content-type updates the stored type (idempotence = bytes AND type)", async () => {
  const backend = new MemoryBackend();
  const bytes = enc("same bytes");
  await backend.writeBlob("data/x.bin", bytes, "application/octet-stream");
  await backend.writeBlob("data/x.bin", bytes, "text/plain; charset=utf-8");
  const read = await backend.readBlob("data/x.bin");
  assert.equal(read?.contentType, "text/plain; charset=utf-8");
});
