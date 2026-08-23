/**
 * `promote`/`pull` — the out-of-band byte channel (Stage-1 Unit 2a Part C): the reverse of
 * `doc read --out`. Covers the A6 routing split (a `.md` --doc-key goes through the engine as a
 * doc; every other key is a blob), the B6 case-insensitive `.md` check, B7 (no doc-route
 * byte-verify), B8 (the shared kind-validation helper), I5 (`--out -` purity), I8/I9/I10 (per-route
 * flag/error shapes), and A8's edit-iterate acceptance loop (local AND remote — the latter is the
 * unit's canonical demo per A12).
 *
 * Runs command functions in-process against a real temp filesystem bundle (mirrors
 * `doc.test.ts`/`link.test.ts`'s pattern); the remote acceptance test boots a real
 * `@superbee/server` `serve()` instance and also drives a few raw `fetch` calls directly
 * against it to verify server-side behavior (served bytes/content-type, which route a `.md` promote
 * actually rode) beyond what the CLI's own receipt claims.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, readDoc, readBlob } from "@superbee/core";
import { serve, type ServerHandle } from "@superbee/server";

import { promote, type PromoteCliDeps } from "../src/commands/promote.js";
import { pull, type PullCliDeps } from "../src/commands/pull.js";
import { CliError } from "../src/errors.js";
import { KNOWN_COMMANDS } from "../src/cli.js";
import { commandReference } from "../src/reference.js";
import { applyRecipe } from "../src/recipes.js";
import { CONTEXT_NOTES_RECIPE } from "../src/recipe-source.js";

test("promote --help describes edition-aware document normalization", async () => {
  let out = "";
  await promote(["--help"], { stdout: (s) => (out += s) });

  assert.match(out, /edition-aware frontmatter normalization and kind validation/);
  assert.match(out, /Current v0\.2 imports do not invent optional generated metadata or the legacy timestamp/);
  assert.match(out, /explicit v0\.1 bundles retain their historical defaulted timestamp/);
  assert.doesNotMatch(out, /frontmatter key order, a defaulted timestamp/);
});

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-promote-pull-test-"));
}

/** A fresh temp OKF bundle (no kinds seeded). */
async function makeBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await tempDir();
  await initBundle(dir);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A fresh bundle with the Context Note kind applied (for --strict / kind-warning tests). */
async function makeSeededBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await tempDir();
  await initBundle(dir);
  await applyRecipe({ root: dir }, CONTEXT_NOTES_RECIPE);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Run `promote`, capturing + parsing its `--json` stdout. */
async function runPromote(argv: string[], deps: Partial<PromoteCliDeps> = {}): Promise<Record<string, unknown>> {
  let out = "";
  await promote([...argv, "--json"], { stdout: (s) => (out += s), ...deps });
  return JSON.parse(out) as Record<string, unknown>;
}

/** Run `pull` (non-streaming), capturing + parsing its `--json` stdout. */
async function runPull(argv: string[], deps: Partial<PullCliDeps> = {}): Promise<Record<string, unknown>> {
  let out = "";
  await pull([...argv, "--json"], { stdout: (s) => (out += s), ...deps });
  return JSON.parse(out) as Record<string, unknown>;
}

/** Boot the reference server over a filesystem bundle rooted at `dir`. */
async function bootServer(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const handle: ServerHandle = await serve({ bundle: { root: dir }, port: 0 });
  return { url: `http://${handle.host}:${handle.port}`, close: () => handle.close() };
}

// ── blob route ─────────────────────────────────────────────────────────────

test("promote/pull blob: create round-trips byte-identical; content-type inferred from the key extension", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "report.html");
    await writeFile(file, "<html><body>hi</body></html>");

    const p = await runPromote([file, "--doc-key", "artifacts/report.html", "--dir", dir]);
    assert.equal(p.promote, "written");
    assert.equal(p.route, "blob");
    assert.equal(p.key, "artifacts/report.html");
    assert.equal(p.content_type, "text/html; charset=utf-8");
    assert.match(p.version as string, /^sha256:[0-9a-f]{64}$/);
    assert.equal(p.size_bytes, 28);

    const out = path.join(work, "pulled.html");
    const pl = await runPull(["--doc-key", "artifacts/report.html", "--out", out, "--dir", dir]);
    assert.equal(pl.pull, "read");
    assert.equal(pl.route, "blob");
    assert.equal(pl.content_type, "text/html; charset=utf-8");
    assert.equal(pl.version, p.version);
    assert.deepEqual(await readFile(out), await readFile(file));
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("promote blob: an explicit --content-type is reflected in the WRITE-TIME receipt, but a LOCAL (FilesystemBackend) bundle does not persist it — a subsequent pull re-infers from the key extension instead (honest divergence, B5)", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "data.bin");
    await writeFile(file, Buffer.from([0, 1, 2, 3]));
    const p = await runPromote([
      file,
      "--doc-key",
      "artifacts/data.bin",
      "--content-type",
      "application/x-custom",
      "--dir",
      dir,
    ]);
    // The receipt reports the WRITE-TIME resolution (`resolveContentType(key, override)`,
    // the same function every backend's writeBlob uses internally) — the override,
    // verbatim, since it was explicitly given.
    assert.equal(p.content_type, "application/x-custom");

    // But FilesystemBackend does NOT persist an explicit override (core/src/backend.ts's
    // writeBlob doc comment, B5) — it has no sidecar metadata store, so a READ always
    // re-infers from the key extension instead. `.bin` is not in the recognized
    // extension table, so the HONEST answer on a subsequent pull is the generic
    // fallback, NOT the override the promote receipt showed.
    const out = path.join(work, "pulled.bin");
    const pl = await runPull(["--doc-key", "artifacts/data.bin", "--out", out, "--dir", dir]);
    assert.equal(pl.content_type, "application/octet-stream");
    assert.notEqual(pl.content_type, p.content_type);
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("promote blob: BINARY bytes (0x00-0xFF, incl. invalid UTF-8) round-trip byte-identical", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const file = path.join(work, "binary.dat");
    await writeFile(file, bytes);
    await runPromote([file, "--doc-key", "artifacts/binary.dat", "--dir", dir]);
    const out = path.join(work, "pulled.dat");
    await runPull(["--doc-key", "artifacts/binary.dat", "--out", out, "--dir", dir]);
    assert.deepEqual(await readFile(out), bytes);
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("promote blob: no --expected-version on an EXISTING key is ALREADY_EXISTS (exit 5), not a silent overwrite", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "x.txt");
    await writeFile(file, "v1");
    await runPromote([file, "--doc-key", "artifacts/x.txt", "--dir", dir]);

    await writeFile(file, "v2 attempted clobber");
    await assert.rejects(
      () => promote([file, "--doc-key", "artifacts/x.txt", "--dir", dir, "--json"], {}),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "ALREADY_EXISTS");
        assert.equal(err.exitCode, 5);
        assert.match(err.help ?? "", /--expected-version/);
        return true;
      },
    );
    // The rejected write did not mutate the stored blob.
    const stored = await readBlob({ root: dir }, "artifacts/x.txt");
    assert.equal(Buffer.from(stored!.bytes).toString("utf8"), "v1");
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("promote blob: a STALE --expected-version is a CONFLICT (exit 5) whose envelope carries the CURRENT version (A8c)", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "x.txt");
    await writeFile(file, "v1");
    const v1 = (await runPromote([file, "--doc-key", "artifacts/x.txt", "--dir", dir])).version as string;

    await writeFile(file, "v2");
    const v2 = (
      await runPromote([file, "--doc-key", "artifacts/x.txt", "--expected-version", v1, "--dir", dir])
    ).version as string;
    assert.notEqual(v2, v1);

    await writeFile(file, "v3 stale attempt");
    await assert.rejects(
      () => promote([file, "--doc-key", "artifacts/x.txt", "--expected-version", v1, "--dir", dir, "--json"], {}),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "STALE_HEAD");
        assert.equal(err.exitCode, 5);
        assert.deepEqual(err.details, { expected: v1, actual: v2 });
        assert.match(err.help ?? "", /pull/);
        return true;
      },
    );
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("pull: an absent blob key is NOT_FOUND (exit 6)", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    await assert.rejects(
      () => pull(["--doc-key", "artifacts/nope.bin", "--out", path.join(work, "x"), "--dir", dir, "--json"], {}),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "NOT_FOUND");
        assert.equal(err.exitCode, 6);
        return true;
      },
    );
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

// ── doc route (.md) ───────────────────────────────────────────────────────

test("promote .md: parses the file and writes a REAL concept doc through the engine (I8 create)", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "spec.md");
    await writeFile(
      file,
      "---\ntype: Spec\ntitle: Auth\ngenerated:\n  by: process:import\n  at: 2026-07-01T00:00:00.000Z\n---\n\n# Auth\n\nBody.\n",
    );
    const p = await runPromote([file, "--doc-key", "specs/auth.md", "--dir", dir]);
    assert.equal(p.route, "doc");
    assert.equal(p.id, "specs/auth");
    assert.equal(p.type, "Spec");
    assert.match(p.version as string, /^sha256:/);

    const stored = await readDoc({ root: dir }, "specs/auth");
    assert.equal(stored.frontmatter.type, "Spec");
    assert.equal(stored.frontmatter.title, "Auth");
    assert.match(stored.body, /Body\./);
    assert.equal(stored.frontmatter.timestamp, undefined);
    assert.deepEqual(stored.frontmatter.generated, { by: "process:import", at: "2026-07-01T00:00:00.000Z" });
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("promote .md: an explicit legacy bundle retains legacy timestamp normalization", async () => {
  const dir = await tempDir();
  const work = await tempDir();
  try {
    await initBundle(dir, { okfVersion: "0.1" });
    const file = path.join(work, "legacy.md");
    await writeFile(file, "---\ntype: Spec\ntitle: Legacy\n---\n\n# Legacy\n");

    await runPromote([file, "--doc-key", "specs/legacy.md", "--dir", dir]);

    const stored = await readDoc({ root: dir }, "specs/legacy");
    assert.match(String(stored.frontmatter.timestamp), /^\d{4}-\d\d-\d\dT/);
    assert.equal(stored.frontmatter.generated, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test("promote: a case-insensitive '.MD' key routes through the doc engine identically (B6)", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "spec.md");
    await writeFile(file, "---\ntype: Spec\n---\n\nBody.\n");
    const p = await runPromote([file, "--doc-key", "specs/Auth.MD", "--dir", dir]);
    assert.equal(p.route, "doc");
    assert.equal(p.id, "specs/Auth"); // extension normalized to '.md', case of the stem preserved

    const stored = await readDoc({ root: dir }, "specs/Auth");
    assert.equal(stored.frontmatter.type, "Spec");
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("promote .md: --content-type is a USAGE error (I9) — content-type is blob-route-only", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "spec.md");
    await writeFile(file, "---\ntype: Spec\n---\n\nBody.\n");
    await assert.rejects(
      () =>
        promote(
          [file, "--doc-key", "specs/auth.md", "--content-type", "text/plain", "--dir", dir, "--json"],
          {},
        ),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /blob-route-only/);
        return true;
      },
    );
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("promote .md: a reserved-filename target is rejected (comes FREE from the engine, I8)", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "x.md");
    await writeFile(file, "---\ntype: T\n---\n\nBody.\n");
    await assert.rejects(
      () => promote([file, "--doc-key", "index.md", "--dir", dir, "--json"], {}),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        return true;
      },
    );
    // Nested reserved file too (any directory level, §3.1).
    await assert.rejects(() => promote([file, "--doc-key", "sub/log.md", "--dir", dir, "--json"], {}));
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("promote .md: no usable frontmatter is a USAGE error naming the FILE PATH, never a bare engine message about a concept (I10)", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "no-frontmatter.md");
    await writeFile(file, "# Just a heading\n\nNo frontmatter at all.\n");
    await assert.rejects(
      () => promote([file, "--doc-key", "specs/x.md", "--dir", dir, "--json"], {}),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(err.message, /frontmatter/);
        assert.doesNotMatch(err.message, /concept 'specs\/x'/); // never the bare engine conformance wording
        assert.match(err.help ?? "", /new --help/);
        return true;
      },
    );
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("promote .md: a governing kind attaches warnings by default (exit 0, still written); --strict rejects instead (exit 2, no write) — B8 shared helper", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  const work = await tempDir();
  try {
    // The seeded Context Note kind requires `title` — omit it to trigger a warning.
    const file = path.join(work, "note.md");
    await writeFile(file, "---\ntype: Context Note\n---\n\n# Summary\n\nHi.\n");

    const p = await runPromote([file, "--doc-key", "context-notes/x/y/z.md", "--dir", dir]);
    assert.ok(Array.isArray(p.warnings));
    assert.ok((p.warnings as unknown[]).length > 0);
    const stored = await readDoc({ root: dir }, "context-notes/x/y/z");
    assert.equal(stored.frontmatter.type, "Context Note"); // still written despite the warning

    // A second file at a DIFFERENT key with --strict: rejects instead of writing.
    await assert.rejects(
      () =>
        promote([file, "--doc-key", "context-notes/a/b/c.md", "--strict", "--dir", dir, "--json"], {}),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
    await assert.rejects(() => readDoc({ root: dir }, "context-notes/a/b/c")); // never written
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("promote .md: a stale --expected-version is a CONFLICT (exit 5) with the current version in the envelope (A8b .md variant)", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "spec.md");
    await writeFile(file, "---\ntype: Spec\n---\n\nv1\n");
    const v1 = (await runPromote([file, "--doc-key", "specs/x.md", "--dir", dir])).version as string;

    await writeFile(file, "---\ntype: Spec\n---\n\nv2\n");
    const v2 = (
      await runPromote([file, "--doc-key", "specs/x.md", "--expected-version", v1, "--dir", dir])
    ).version as string;
    assert.notEqual(v2, v1);

    await writeFile(file, "---\ntype: Spec\n---\n\nv3 stale\n");
    await assert.rejects(
      () => promote([file, "--doc-key", "specs/x.md", "--expected-version", v1, "--dir", dir, "--json"], {}),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "STALE_HEAD");
        assert.equal(err.exitCode, 5);
        assert.deepEqual(err.details, { expected: v1, actual: v2 });
        return true;
      },
    );
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("pull .md: delivers the CANONICAL re-serialization, reports the store's version with NO byte-verify (B7), and an absent doc-key is NOT_FOUND", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "spec.md");
    await writeFile(file, "---\ntype: Spec\ntitle: Auth\n---\nBody without a blank line.\n");
    await runPromote([file, "--doc-key", "specs/auth.md", "--dir", dir]);

    const out = path.join(work, "pulled.md");
    const pl = await runPull(["--doc-key", "specs/auth.md", "--out", out, "--dir", dir]);
    assert.equal(pl.route, "doc");
    assert.equal(pl.id, "specs/auth");
    const pulledBytes = await readFile(out, "utf8");
    assert.match(pulledBytes, /^---\ntype: Spec\n/); // canonical form, type leads
    assert.match(pulledBytes, /Body without a blank line\./);

    await assert.rejects(
      () => pull(["--doc-key", "specs/nope.md", "--out", path.join(work, "x"), "--dir", dir, "--json"], {}),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "NOT_FOUND");
        return true;
      },
    );
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

// ── --out - (I5: mirrors doc read --out -'s full purity dance) ────────────

test("pull --out -: streams raw bytes to stdout; the receipt (with the promote hint) goes to STDERR", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "report.html");
    await writeFile(file, "<p>hi</p>");
    const p = await runPromote([file, "--doc-key", "artifacts/report.html", "--dir", dir]);

    let stdoutBytes = Buffer.alloc(0);
    let stderrOut = "";
    await pull(["--doc-key", "artifacts/report.html", "--out", "-", "--dir", dir, "--json"], {
      writeStdoutBytes: (d) => (stdoutBytes = Buffer.concat([stdoutBytes, Buffer.from(d)])),
      stderr: (s) => (stderrOut += s),
    });
    assert.equal(stdoutBytes.toString("utf8"), "<p>hi</p>");
    const receipt = JSON.parse(stderrOut) as Record<string, unknown>;
    assert.equal(receipt.route, "blob");
    assert.equal(receipt.version, p.version);
    assert.match((receipt.help as string[])[0]!, /--expected-version/);
    assert.match((receipt.help as string[])[0]!, /<file>/); // no known destination file in stream mode
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("pull --out -: an error routes its envelope to STDERR (not stdout), and the byte stream stays untouched (I5)", async () => {
  const { dir, cleanup } = await makeBundle();
  try {
    let stdoutOut = "";
    let stdoutBytes = Buffer.alloc(0);
    let stderrOut = "";
    await assert.rejects(
      () =>
        pull(["--doc-key", "artifacts/nope.bin", "--out", "-", "--dir", dir, "--json"], {
          stdout: (s) => (stdoutOut += s),
          writeStdoutBytes: (d) => (stdoutBytes = Buffer.concat([stdoutBytes, Buffer.from(d)])),
          stderr: (s) => (stderrOut += s),
        }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.handled, true); // the bin wrapper must not re-emit the envelope on stdout
        return true;
      },
    );
    assert.equal(stdoutOut, "");
    assert.equal(stdoutBytes.length, 0);
    // Error envelopes render as TOON on every channel regardless of --json (output.ts: errors are
    // ALWAYS TOON, since formatError never sees per-invocation flags) — mirrors doc read --out -.
    assert.match(stderrOut, /code: NOT_FOUND/);
  } finally {
    await cleanup();
  }
});

// ── A3/I8: F3-shaped in-bundle pollution warning, reused (not duplicated) from doc.ts ──────────

test("pull: a DOC pulled to a '.md' path INSIDE the open bundle carries the SAME F3-style warning doc read --out uses (reused, not copied)", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "spec.md");
    await writeFile(file, "---\ntype: Spec\n---\n\nBody.\n");
    await runPromote([file, "--doc-key", "specs/x.md", "--dir", dir]);

    const inBundleOut = path.join(dir, "exported-copy.md");
    const pl = await runPull(["--doc-key", "specs/x.md", "--out", inBundleOut, "--dir", dir]);
    assert.equal(typeof pl.warning, "string");
    assert.match(pl.warning as string, /INSIDE this bundle/);
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("pull: a BLOB pulled to its OWN (non-'.md') key shape landing inside the bundle carries NO warning (A3 — not over-applied)", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "report.html");
    await writeFile(file, "<p>hi</p>");
    await runPromote([file, "--doc-key", "artifacts/report.html", "--dir", dir]);

    const inBundleOut = path.join(dir, "artifacts", "report.html");
    await mkdir(path.dirname(inBundleOut), { recursive: true });
    const pl = await runPull(["--doc-key", "artifacts/report.html", "--out", inBundleOut, "--dir", dir]);
    assert.equal("warning" in pl, false);
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

// ── flag validation ─────────────────────────────────────────────────────────

test("pull: a stray positional (a promote-habit slip, e.g. 'pull file.html --doc-key …') is a USAGE error, not silently absorbed", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "report.html");
    await writeFile(file, "<p>hi</p>");
    await runPromote([file, "--doc-key", "artifacts/report.html", "--dir", dir]);

    await assert.rejects(
      () =>
        pull([file, "--doc-key", "artifacts/report.html", "--out", path.join(work, "x"), "--dir", dir, "--json"], {}),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /no positional/);
        return true;
      },
    );
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("promote: requires <file> and --doc-key; pull: requires --doc-key and --out", async () => {
  const { dir, cleanup } = await makeBundle();
  try {
    await assert.rejects(
      () => promote(["--doc-key", "x.txt", "--dir", dir, "--json"], {}),
      (err: unknown) => err instanceof CliError && err.code === "USAGE",
    );
    await assert.rejects(
      () => promote(["/tmp/nope-doesnt-matter", "--dir", dir, "--json"], {}),
      (err: unknown) => err instanceof CliError && err.code === "USAGE",
    );
    await assert.rejects(
      () => pull(["--out", "/tmp/x", "--dir", dir, "--json"], {}),
      (err: unknown) => err instanceof CliError && err.code === "USAGE",
    );
    await assert.rejects(
      () => pull(["--doc-key", "x.txt", "--dir", dir, "--json"], {}),
      (err: unknown) => err instanceof CliError && err.code === "USAGE",
    );
  } finally {
    await cleanup();
  }
});

test("promote: a non-existent local <file> is a USAGE error naming the file, not a raw ENOENT", async () => {
  const { dir, cleanup } = await makeBundle();
  try {
    await assert.rejects(
      () => promote(["/no/such/file.txt", "--doc-key", "x.txt", "--dir", dir, "--json"], {}),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /no such file/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

// ── registration ─────────────────────────────────────────────────────────────

test("promote/pull are registered in KNOWN_COMMANDS and the command reference", () => {
  assert.ok(KNOWN_COMMANDS.includes("promote"));
  assert.ok(KNOWN_COMMANDS.includes("pull"));
  const ref = commandReference("agentstate-lite");
  const artifacts = ref.commands["Artifacts"] ?? [];
  assert.ok(artifacts.some((l) => l.startsWith("promote ")));
  assert.ok(artifacts.some((l) => l.startsWith("pull ")));
  assert.match(ref.remoteEnv, /HTTP is activated only by explicit --remote/);
  assert.match(ref.remoteEnv, /retired AGENTSTATE_LITE_REMOTE/);
});

// ── A8: the edit-iterate acceptance loop ────────────────────────────────────

test("A8 acceptance (LOCAL, blob): promote v1 -> pull (receipt carries v1) -> edit -> promote --expected-version v1 -> v2 -> pull confirms new bytes; a second promote citing v1 is a CONFLICT with the current version", async () => {
  const { dir, cleanup } = await makeBundle();
  const work = await tempDir();
  try {
    const file = path.join(work, "report.html");
    await writeFile(file, "<html>v1</html>");
    const promoted1 = await runPromote([file, "--doc-key", "artifacts/report.html", "--dir", dir]);
    const v1 = promoted1.version as string;

    const pulledOut = path.join(work, "pulled.html");
    const pulled = await runPull(["--doc-key", "artifacts/report.html", "--out", pulledOut, "--dir", dir]);
    assert.equal(pulled.version, v1); // A8a: the pull receipt carries the CAS handle

    await writeFile(pulledOut, "<html>v2 edited</html>");
    const promoted2 = await runPromote([
      pulledOut,
      "--doc-key",
      "artifacts/report.html",
      "--expected-version",
      v1,
      "--dir",
      dir,
    ]);
    const v2 = promoted2.version as string;
    assert.notEqual(v2, v1);

    const pulled2Out = path.join(work, "pulled2.html");
    const pulled2 = await runPull(["--doc-key", "artifacts/report.html", "--out", pulled2Out, "--dir", dir]);
    assert.equal(pulled2.version, v2);
    assert.equal(await readFile(pulled2Out, "utf8"), "<html>v2 edited</html>");

    // A stale re-promote citing the now-superseded v1 is a CONFLICT with the CURRENT version.
    await assert.rejects(
      () =>
        promote(
          [pulledOut, "--doc-key", "artifacts/report.html", "--expected-version", v1, "--dir", dir, "--json"],
          {},
        ),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.exitCode, 5);
        assert.equal((err.details as { actual: string }).actual, v2);
        return true;
      },
    );
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("A8 acceptance (REMOTE, canonical demo per A12): the SAME edit-iterate loop over a real serve() instance — a raw GET serves the NEW bytes with the correct content-type, and the .md promote is verified to ride PUT /docs (I8), never /blobs", async () => {
  const dir = await tempDir();
  const work = await tempDir();
  try {
    await initBundle(dir);
    const server = await bootServer(dir);
    try {
      // --- blob half: promote -> pull -> edit -> promote --expected-version -> GET serves NEW bytes ---
      const file = path.join(work, "report.html");
      await writeFile(file, "<html>v1 remote</html>");
      const promoted1 = await runPromote([file, "--doc-key", "artifacts/report.html", "--remote", server.url]);
      const v1 = promoted1.version as string;

      const pulledOut = path.join(work, "pulled.html");
      const pulled = await runPull(["--doc-key", "artifacts/report.html", "--out", pulledOut, "--remote", server.url]);
      assert.equal(pulled.version, v1);

      await writeFile(pulledOut, "<html>v2 remote edited</html>");
      const promoted2 = await runPromote([
        pulledOut,
        "--doc-key",
        "artifacts/report.html",
        "--expected-version",
        v1,
        "--remote",
        server.url,
      ]);
      const v2 = promoted2.version as string;
      assert.notEqual(v2, v1);

      // The DoD #2 acceptance test, literally: a raw HTTP GET against the reference server returns
      // the EXACT new bytes with the right Content-Type — not routed through the CLI's own pull.
      const res = await fetch(`${server.url}/v0/bundles/default/blobs/artifacts/report.html`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
      assert.equal(await res.text(), "<html>v2 remote edited</html>");
      // Production repair (Stage-1 Unit 2b): X-Version carries the bare token (primary,
      // edge-proof); ETag now carries the RFC-7232-quoted form (this pinned the pre-fix bare
      // ETag, itself the defect Cloudflare's edge strips under Brotli compression).
      assert.equal(res.headers.get("x-version"), v2);
      assert.equal(res.headers.get("etag"), `"${v2}"`);

      // A second promote still citing v1 -> CONFLICT (exit 5) with the current version.
      await assert.rejects(
        () =>
          promote(
            [
              pulledOut,
              "--doc-key",
              "artifacts/report.html",
              "--expected-version",
              v1,
              "--remote",
              server.url,
              "--json",
            ],
            {},
          ),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.exitCode, 5);
          assert.equal((err.details as { actual: string }).actual, v2);
          return true;
        },
      );

      // --- .md half: promote rides PUT /docs, never /blobs (I8) ---
      const mdFile = path.join(work, "spec.md");
      await writeFile(
        mdFile,
        "---\ntype: Spec\ntitle: Remote spec\ngenerated:\n  by: process:import\n  at: 2026-07-01T00:00:00.000Z\n---\n\nRemote body.\n",
      );
      const docPromoted = await runPromote([mdFile, "--doc-key", "specs/remote.md", "--remote", server.url]);
      assert.equal(docPromoted.route, "doc");

      const docRes = await fetch(`${server.url}/v0/bundles/default/docs/specs/remote`);
      assert.equal(docRes.status, 200);
      const docBody = (await docRes.json()) as { frontmatter: { type: string; generated?: unknown } };
      assert.equal(docBody.frontmatter.type, "Spec");
      assert.deepEqual(docBody.frontmatter.generated, { by: "process:import", at: "2026-07-01T00:00:00.000Z" });

      // The SAME key was never written as a blob — the blob route rejects '.md' keys categorically.
      const blobRes = await fetch(`${server.url}/v0/bundles/default/blobs/specs/remote.md`);
      assert.equal(blobRes.status, 400);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

// ── retired AGENTSTATE_LITE_REMOTE migration boundary ──────────────────────

test("promote/pull reject legacy AGENTSTATE_LITE_REMOTE instead of activating HTTP", async () => {
  const dir = await tempDir();
  const work = await tempDir();
  const prior = process.env.AGENTSTATE_LITE_REMOTE;
  try {
    await initBundle(dir);
    const server = await bootServer(dir);
    try {
      const file = path.join(work, "x.txt");
      await writeFile(file, "hello");

      process.env.AGENTSTATE_LITE_REMOTE = server.url;
      for (const run of [
        () => runPromote([file, "--doc-key", "artifacts/x.txt"]),
        () => runPull(["--doc-key", "artifacts/x.txt", "--out", path.join(work, "pulled.txt")]),
      ]) {
        await assert.rejects(run, (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "USAGE");
          assert.match(err.message, /AGENTSTATE_LITE_REMOTE ambient remote selection is retired/);
          assert.match(err.help ?? "", new RegExp(`--remote ${server.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
          return true;
        });
      }
    } finally {
      await server.close();
    }
  } finally {
    if (prior === undefined) delete process.env.AGENTSTATE_LITE_REMOTE;
    else process.env.AGENTSTATE_LITE_REMOTE = prior;
    await rm(dir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test("an explicit --remote flag wins outright over a BOGUS AGENTSTATE_LITE_REMOTE env value (flag beats env — actually exercised, not just asserted by title)", async () => {
  const dir = await tempDir();
  const work = await tempDir();
  const prior = process.env.AGENTSTATE_LITE_REMOTE;
  try {
    await initBundle(dir);
    const server = await bootServer(dir);
    try {
      const file = path.join(work, "x.txt");
      await writeFile(file, "hello");

      // The env value is BOGUS (nothing listens there) — if the flag did not win, this
      // would fail with a transport RUNTIME error, not succeed.
      process.env.AGENTSTATE_LITE_REMOTE = "http://127.0.0.1:1";
      const p = await runPromote([file, "--doc-key", "artifacts/x.txt", "--remote", server.url]);
      assert.equal(p.promote, "written");
    } finally {
      await server.close();
    }
  } finally {
    if (prior === undefined) delete process.env.AGENTSTATE_LITE_REMOTE;
    else process.env.AGENTSTATE_LITE_REMOTE = prior;
    await rm(dir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test("design resolution (explicit beats ambient): an explicit --dir wins SILENTLY over an ambient AGENTSTATE_LITE_REMOTE default (no error) — operates on the LOCAL dir, not the env-named remote", async () => {
  const localDir = await tempDir();
  const remoteDir = await tempDir();
  const work = await tempDir();
  const prior = process.env.AGENTSTATE_LITE_REMOTE;
  try {
    await initBundle(localDir);
    await initBundle(remoteDir);
    const server = await bootServer(remoteDir);
    try {
      const file = path.join(work, "x.txt");
      await writeFile(file, "local content");

      process.env.AGENTSTATE_LITE_REMOTE = server.url;
      // --dir given, no --remote flag: must NOT error, and must operate on localDir, not
      // the env-named remote server.
      const p = await runPromote([file, "--doc-key", "artifacts/x.txt", "--dir", localDir]);
      assert.equal(p.promote, "written");

      const stored = await readBlob({ root: localDir }, "artifacts/x.txt");
      assert.ok(stored, "the blob must have landed in the LOCAL dir");
      assert.equal(Buffer.from(stored!.bytes).toString("utf8"), "local content");

      // The env-named REMOTE bundle must be untouched.
      const remoteStored = await readBlob({ root: remoteDir }, "artifacts/x.txt");
      assert.equal(remoteStored, null);
    } finally {
      await server.close();
    }
  } finally {
    if (prior === undefined) delete process.env.AGENTSTATE_LITE_REMOTE;
    else process.env.AGENTSTATE_LITE_REMOTE = prior;
    await rm(localDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test("an EXPLICIT --remote together with an EXPLICIT --dir remains a USAGE conflict (the one combination that still errors, regardless of AGENTSTATE_LITE_REMOTE)", async () => {
  const dir = await tempDir();
  const work = await tempDir();
  try {
    await initBundle(dir);
    const file = path.join(work, "x.txt");
    await writeFile(file, "hello");
    await assert.rejects(
      () => promote([file, "--doc-key", "artifacts/x.txt", "--dir", dir, "--remote", "http://127.0.0.1:4818", "--json"], {}),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});
