/**
 * The public error-classification contract, as ONE table (tasks/error-classification-boundary).
 *
 * `classifyBundleError` is THE boundary from typed failures to public error codes + exit codes;
 * `toExit` (what the bin wrapper applies to anything uncaught) must agree with it row for row.
 * Every row here runs against the REAL boundary functions — no mocks of them — and the
 * command-level probes below run REAL commands over real/injected backends, so a regression in
 * either layer (boundary or a command catch-all reclassifying on its own) fails this suite.
 *
 * The invariant the table pins: USAGE (exit 2, "fix your input") is reachable ONLY from
 * provably-input-derived failures (an explicit `CliError("USAGE")`, core's typed
 * `InvalidInputError`, or a wire envelope's own client-error code) — an arbitrary plain `Error`,
 * an fs errno (ENOSPC/EACCES, or a raw untranslated ENOENT), or any other unexpected failure
 * lands RUNTIME (exit 1). A missing DOCUMENT lands NOT_FOUND (exit 6) via the call-site
 * translations that know the id (probed below through the real `doc read`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  initBundle,
  writeDoc,
  InvalidInputError,
  MalformedDocumentError,
  MemoryBackend,
  RemoteError,
  VersionConflict,
  type Bundle,
  type OkfDocument,
  type Version,
} from "@superbee/core";
import { CliError, classifyBundleError, toExit, asHandled, EXIT } from "../src/errors.js";
import { addLink } from "../src/commands/link.js";
import { doc } from "../src/commands/doc.js";
import { promote } from "../src/commands/promote.js";

const OLD_TS = "2020-01-01T00:00:00.000Z";

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** One row of the public matrix: a thrown value and the code/exit the boundary must produce. */
interface MatrixRow {
  name: string;
  make: () => unknown;
  code: string;
  exit: number;
}

const MATRIX: MatrixRow[] = [
  // Already-classified CliErrors pass through untouched (any code; two representatives).
  { name: "CliError USAGE passes through", make: () => new CliError("USAGE", "bad flag"), code: "USAGE", exit: 2 },
  { name: "CliError GIT_BUSY (classifyGitError output) passes through", make: () => new CliError("GIT_BUSY", "locked", { details: { retryable: true } }), code: "GIT_BUSY", exit: 1 },
  // Invalid input -> USAGE, exit 2 — via core's TYPED rejection, never a fallback bucket.
  { name: "InvalidInputError -> USAGE", make: () => new InvalidInputError("Concept id must not contain '..' segments: '../x'."), code: "USAGE", exit: 2 },
  // A raw, untranslated ENOENT is context-free (an output dir can be missing too): a failed
  // syscall, RUNTIME. Missing DOCUMENTS reach NOT_FOUND via the call-site translations that know
  // the id — pinned by the `doc read` probe below.
  { name: "raw untranslated ENOENT -> RUNTIME", make: () => errnoError("ENOENT", "ENOENT: no such file or directory"), code: "RUNTIME", exit: 1 },
  // CAS conflict -> STALE_HEAD, exit 5.
  { name: "VersionConflict -> STALE_HEAD", make: () => new VersionConflict("tasks/x", "sha256:aa", "sha256:bb"), code: "STALE_HEAD", exit: 5 },
  // Authentication failure -> AUTH_REQUIRED, exit 4.
  { name: "RemoteError AUTH_REQUIRED -> exit 4", make: () => new RemoteError("401", "AUTH_REQUIRED", 401), code: "AUTH_REQUIRED", exit: 4 },
  // Remote 5xx / stripped version header -> RUNTIME, exit 1.
  { name: "RemoteError RUNTIME (5xx) -> exit 1", make: () => new RemoteError("500", "RUNTIME", 500), code: "RUNTIME", exit: 1 },
  { name: "RemoteError VERSION_MISSING -> RUNTIME", make: () => new RemoteError("no version header", "VERSION_MISSING", 200), code: "RUNTIME", exit: 1 },
  { name: "RemoteError REDIRECT_REFUSED -> RUNTIME", make: () => new RemoteError("redirect refused", "REDIRECT_REFUSED", 307), code: "RUNTIME", exit: 1 },
  // Remaining pinned wire codes.
  { name: "RemoteError FORBIDDEN -> FORBIDDEN (exit 2)", make: () => new RemoteError("403", "FORBIDDEN", 403), code: "FORBIDDEN", exit: 2 },
  { name: "RemoteError NOT_FOUND -> exit 6", make: () => new RemoteError("404", "NOT_FOUND", 404), code: "NOT_FOUND", exit: 6 },
  { name: "RemoteError LAST_ADMIN -> exit 5", make: () => new RemoteError("409", "LAST_ADMIN", 409), code: "LAST_ADMIN", exit: 5 },
  { name: "RemoteError with the wire's own USAGE (400) -> exit 2", make: () => new RemoteError("400", "USAGE", 400), code: "USAGE", exit: 2 },
  // An UNRECOGNIZED wire code falls back by HTTP status, never blindly to USAGE:
  // 429 rate limiting is attested client fault whose fix is BACKING OFF -> TRANSIENT, retryable.
  { name: "RemoteError RATE_LIMITED (429) -> TRANSIENT", make: () => new RemoteError("too many join attempts", "RATE_LIMITED", 429), code: "TRANSIENT", exit: 1 },
  { name: "RemoteError envelope-less 429 (status-derived code) -> TRANSIENT", make: () => new RemoteError("429", "USAGE", 429), code: "TRANSIENT", exit: 1 },
  { name: "RemoteError unknown code on a 5xx -> RUNTIME", make: () => new RemoteError("boom", "INTERNAL_ERROR", 500), code: "RUNTIME", exit: 1 },
  // Adjudicated: an unknown code on a 400-class status stays USAGE — the status IS the server
  // attesting client fault, the one sanctioned non-typed USAGE source.
  { name: "RemoteError unknown code on a 4xx -> USAGE", make: () => new RemoteError("nope", "TEAPOT", 418), code: "USAGE", exit: 2 },
  // Corrupt stored bytes: a valid invocation hitting bad data is RUNTIME, not USAGE.
  { name: "MalformedDocumentError -> RUNTIME", make: () => new MalformedDocumentError("a.md", "unparseable YAML"), code: "RUNTIME", exit: 1 },
  // Local I/O failures and anything unexpected -> RUNTIME, exit 1 — never USAGE.
  { name: "ENOSPC -> RUNTIME", make: () => errnoError("ENOSPC", "ENOSPC: no space left on device"), code: "RUNTIME", exit: 1 },
  { name: "EACCES -> RUNTIME", make: () => errnoError("EACCES", "EACCES: permission denied"), code: "RUNTIME", exit: 1 },
  { name: "arbitrary plain Error -> RUNTIME (the killed USAGE fallback)", make: () => new Error("something unexpected broke"), code: "RUNTIME", exit: 1 },
  { name: "non-Error throw -> RUNTIME", make: () => "string throw", code: "RUNTIME", exit: 1 },
];

for (const row of MATRIX) {
  test(`error matrix: ${row.name}`, () => {
    const classified = classifyBundleError(row.make());
    assert.equal(classified.code, row.code);
    assert.equal(classified.exitCode, row.exit);

    // toExit (the bin wrapper's mapping for anything uncaught) must agree row for row.
    const exit = toExit(row.make());
    assert.equal(exit.exitCode, row.exit);
    assert.equal(exit.envelope.error.code, row.code);
    assert.equal(exit.handled, false);
  });
}

test("error matrix: a CliError instance passes through classifyBundleError IDENTICALLY (same object)", () => {
  const original = new CliError("NOT_FOUND", "no doc", { help: "list", details: { id: "x" } });
  assert.equal(classifyBundleError(original), original);
});

test("error matrix: an uncaught VersionConflict carries {expected, actual} details", () => {
  const exit = toExit(new VersionConflict("tasks/x", "sha256:aa", "sha256:bb"));
  assert.equal(exit.exitCode, EXIT.CONFLICT);
  assert.deepEqual(exit.envelope.error.details, { expected: "sha256:aa", actual: "sha256:bb" });
});

test("error matrix: the 429 TRANSIENT envelope is a structured retry signal (retryable + status)", () => {
  const classified = classifyBundleError(new RemoteError("too many join attempts", "RATE_LIMITED", 429));
  assert.deepEqual(classified.details, { retryable: true, status: 429 });
});

test("error matrix: AUTH_REQUIRED keeps the remote-url fixing hint when the caller has it", () => {
  const classified = classifyBundleError(new RemoteError("401", "AUTH_REQUIRED", 401), "http://127.0.0.1:4818");
  assert.match(classified.help ?? "", /SUPERBEE_API_KEY/);
  assert.match(classified.help ?? "", /--remote http:\/\/127\.0\.0\.1:4818/);
});

test("error matrix: asHandled applies the SAME classification, flagged handled", () => {
  const handledRuntime = asHandled(errnoError("ENOSPC", "ENOSPC: no space left on device"));
  assert.equal(handledRuntime.code, "RUNTIME");
  assert.equal(handledRuntime.handled, true);
  const handledUsage = asHandled(new InvalidInputError("bad id"));
  assert.equal(handledUsage.code, "USAGE");
  assert.equal(handledUsage.handled, true);
  assert.equal(toExit(handledUsage).handled, true);
});

// ── Command-level regression probes: sensitive paths through REAL commands ──────────────────────

test("probe: link add over a backend whose write fails ENOSPC is RUNTIME (exit 1), never USAGE", async () => {
  // Deterministic disk-full: a real MemoryBackend whose write for the source doc throws an
  // errno-shaped ENOSPC — exactly what a full filesystem hands FilesystemBackend.
  const backend = new MemoryBackend();
  const bundle: Bundle = { root: "mem://boundary-enospc", backend };
  await writeDoc(bundle, { id: "a", frontmatter: { type: "Concept", timestamp: OLD_TS }, body: "" });
  await writeDoc(bundle, { id: "b", frontmatter: { type: "Concept", timestamp: OLD_TS }, body: "" });
  const originalWrite = backend.write.bind(backend);
  backend.write = (async (id: string, d: OkfDocument, options?: { expectedVersion?: Version | null }) => {
    if (id === "a") throw errnoError("ENOSPC", "ENOSPC: no space left on device, write");
    return originalWrite(id, d, options);
  }) as typeof backend.write;

  let thrown: unknown;
  try {
    await addLink(bundle, "a", "b", { text: "b" });
    assert.fail("expected addLink to reject on the simulated ENOSPC write failure");
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof CliError, "the boundary classified it before it escaped the command");
  assert.equal(thrown.code, "RUNTIME");
  assert.equal(thrown.exitCode, 1);
  assert.match(thrown.message, /ENOSPC/);
});

test("probe: a missing document through the real `doc read` is NOT_FOUND (exit 6) naming the id", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-boundary-notfound-"));
  try {
    await initBundle(dir);
    await assert.rejects(
      () => doc(["read", "missing/doc", "--dir", dir, "--json"], {}),
      (err: unknown) =>
        err instanceof CliError &&
        err.code === "NOT_FOUND" &&
        err.exitCode === 6 &&
        /missing\/doc/.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("probe: core's typed input rejections stay USAGE (exit 2) through real commands", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-boundary-usage-"));
  try {
    await initBundle(dir);
    // Traversal id -> core InvalidInputError -> USAGE.
    await assert.rejects(
      () => doc(["write", "../evil", "--type", "Concept", "--body", "x", "--dir", dir, "--json"], {}),
      (err: unknown) => err instanceof CliError && err.code === "USAGE" && err.exitCode === 2,
    );
    // Reserved-file id on the engine path -> core InvalidInputError -> USAGE.
    await assert.rejects(
      () => doc(["write", "sub/index", "--type", "Concept", "--body", "x", "--dir", dir, "--json"], {}),
      (err: unknown) => err instanceof CliError && err.code === "USAGE" && err.exitCode === 2,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("probe: an unreadable promote SOURCE (EISDIR/EACCES) is RUNTIME (exit 1); only a MISSING one is USAGE", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-boundary-promote-"));
  try {
    await initBundle(dir);
    // EISDIR: the named source exists but is a directory — an I/O failure, not user input.
    const subdir = path.join(dir, "not-a-file");
    await mkdir(subdir);
    await assert.rejects(
      () => promote([subdir, "--doc-key", "artifacts/x.txt", "--dir", dir, "--json"], {}),
      (err: unknown) => err instanceof CliError && err.code === "RUNTIME" && err.exitCode === 1,
    );
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      // EACCES: the source exists but is unreadable.
      const blocked = path.join(dir, "blocked.txt");
      await writeFile(blocked, "x");
      await chmod(blocked, 0o000);
      try {
        await assert.rejects(
          () => promote([blocked, "--doc-key", "artifacts/x.txt", "--dir", dir, "--json"], {}),
          (err: unknown) => err instanceof CliError && err.code === "RUNTIME" && err.exitCode === 1,
        );
      } finally {
        await chmod(blocked, 0o644);
      }
    }
    // The ratified call-site translation: a MISSING source names the file, USAGE.
    await assert.rejects(
      () => promote([path.join(dir, "absent.txt"), "--doc-key", "artifacts/x.txt", "--dir", dir, "--json"], {}),
      (err: unknown) =>
        err instanceof CliError && err.code === "USAGE" && err.exitCode === 2 && /no such file/.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("probe: a local EACCES on the doc-write path is RUNTIME (exit 1), not USAGE", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-bit probe needs a non-root POSIX environment");
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-boundary-eacces-"));
  try {
    await initBundle(dir);
    await chmod(dir, 0o555); // read-only bundle root: the temp-file write fails EACCES
    await assert.rejects(
      () => doc(["write", "blocked", "--type", "Concept", "--body", "x", "--dir", dir, "--json"], {}),
      (err: unknown) => err instanceof CliError && err.code === "RUNTIME" && err.exitCode === 1,
    );
  } finally {
    await chmod(dir, 0o755);
    await rm(dir, { recursive: true, force: true });
  }
});
