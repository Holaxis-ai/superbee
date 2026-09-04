/**
 * CLI <-> wire-protocol integration suite (Stage 1 Unit 3 part B): drives the CLI's command
 * layer with `--remote` against a REAL `@superbee/server` `serve()` instance (an actual
 * `node:http` listener on an ephemeral port — unlike `packages/core/test/wire-protocol.test.ts`,
 * which injects the router directly as the fetch transport with no sockets, this file exercises
 * exactly what a `--remote` CLI invocation talks to) and asserts PARITY against the same
 * operations run locally via `--dir`.
 *
 * Also covers the multi-writer convergence smoke (N concurrent `link add`s to the SAME source
 * doc through one server) and the error-path taxonomy (`--remote` transport failure -> RUNTIME/1,
 * `--remote` + `--dir` -> USAGE/2, `init --remote` -> USAGE/2 with a specific message, a malformed
 * `--remote` URL -> USAGE/2).
 *
 * Test build coupling: this file imports `@superbee/server`, which resolves to
 * `packages/server/dist` — fine under `npm run check` (build runs first), but a bare
 * `npm test -w @holaxis/aslite` with a stale/missing server build will fail to resolve this
 * import. Mirrors `docs/WIRE-PROTOCOL.md`'s "Test coupling note".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { initBundle, writeDoc, MemoryBackend, type Bundle } from "@superbee/core";
import { serve, type ServerHandle } from "@superbee/server";

import { newCommand } from "../src/commands/new.js";
import { doc } from "../src/commands/doc.js";
import { list } from "../src/commands/list.js";
import { link } from "../src/commands/link.js";
import { init } from "../src/commands/init.js";
import { CliError } from "../src/errors.js";
import { applyRecipe } from "../src/recipes.js";
import { CONTEXT_NOTES_RECIPE } from "../src/recipe-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const SAMPLE_BUNDLE = path.join(REPO_ROOT, "examples/sample-bundle");

const T = "2026-07-01T00:00:00.000Z";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-remote-test-"));
}

/** Boot the reference server over `bundle` (a real socket listener, ephemeral port). */
async function bootServerOverBundle(bundle: Bundle): Promise<{ url: string; close: () => Promise<void> }> {
  const handle: ServerHandle = await serve({ bundle, port: 0 });
  return { url: `http://${handle.host}:${handle.port}`, close: () => handle.close() };
}

/** Boot the reference server over a filesystem bundle rooted at `dir`. */
async function bootServer(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  return bootServerOverBundle({ root: dir });
}

/** Run a command function, capturing its `--json` stdout and parsing the envelope. */
async function runJson(
  cmd: (argv: string[], deps: { stdout: (s: string) => void }) => Promise<void>,
  argv: string[],
): Promise<Record<string, unknown>> {
  let out = "";
  await cmd([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

test("new \"Context Note\" + doc read --remote: round-trip parity with the same operation run locally via --dir (the note command is gone; context notes are authored via the GENERIC path)", async () => {
  const localDir = await tempDir();
  const remoteDir = await tempDir();
  try {
    await initBundle(localDir);
    await applyRecipe({ root: localDir }, CONTEXT_NOTES_RECIPE);
    await initBundle(remoteDir);
    await applyRecipe({ root: remoteDir }, CONTEXT_NOTES_RECIPE);
    const server = await bootServer(remoteDir);
    try {
      const createArgs = ["Context Note", "c1", "--title", "c1", "--timestamp", T];
      const localCreate = await runJson(newCommand, [...createArgs, "--dir", localDir]);
      const remoteCreate = await runJson(newCommand, [...createArgs, "--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000"]);
      assert.equal(remoteCreate.id, localCreate.id);
      assert.equal(remoteCreate.timestamp, localCreate.timestamp);

      const localRead = await runJson(doc, ["read", localCreate.id as string, "--dir", localDir]);
      const remoteRead = await runJson(doc, ["read", remoteCreate.id as string, "--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000"]);
      assert.deepEqual(remoteRead, localRead);
    } finally {
      await server.close();
    }
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  }
});

test("list --remote: count + default 4-field schema + --fields hatch, parity with local", async () => {
  const localDir = await tempDir();
  const remoteDir = await tempDir();
  try {
    const localBundle: Bundle = { root: localDir };
    const remoteBundle: Bundle = { root: remoteDir };
    await initBundle(localDir);
    await initBundle(remoteDir);
    for (const bundle of [localBundle, remoteBundle]) {
      await writeDoc(bundle, { id: "a", frontmatter: { type: "Concept", title: "A", tags: ["x"], timestamp: T }, body: "A" });
      await writeDoc(bundle, { id: "b", frontmatter: { type: "Concept", title: "B", tags: ["y"], timestamp: T }, body: "B" });
    }
    const server = await bootServer(remoteDir);
    try {
      const localList = await runJson(list, ["--dir", localDir]);
      const remoteList = await runJson(list, ["--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000"]);
      assert.deepEqual(remoteList, localList);
      assert.equal(remoteList.count, 2);

      const localFields = await runJson(list, ["--dir", localDir, "--fields", "tags"]);
      const remoteFields = await runJson(list, ["--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000", "--fields", "tags"]);
      assert.deepEqual(remoteFields, localFields);
    } finally {
      await server.close();
    }
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  }
});

test("link add --remote: idempotent (changed:false, exit 0) on re-add", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, { id: "a", frontmatter: { type: "Concept", title: "A", timestamp: T }, body: "A" });
    await writeDoc(bundle, { id: "b", frontmatter: { type: "Concept", title: "B", timestamp: T }, body: "B" });
    const server = await bootServer(dir);
    try {
      const first = await runJson(link, ["add", "a", "b", "--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000"]);
      assert.equal(first.changed, true);
      assert.equal(first.link, "added");

      const second = await runJson(link, ["add", "a", "b", "--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000"]);
      assert.equal(second.changed, false);
      assert.equal(second.link, "exists");

      const shown = await runJson(link, ["show", "a", "--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000"]);
      assert.equal(shown.outbound_count, 1);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link show --text --remote: backlink text + exact-match filtering are IDENTICAL over --remote and --dir (backlinks are derived CLIENT-SIDE via readMany, no wire route)", async () => {
  const localDir = await tempDir();
  const remoteDir = await tempDir();
  try {
    for (const dir of [localDir, remoteDir]) {
      const bundle: Bundle = { root: dir };
      await initBundle(dir);
      await writeDoc(bundle, { id: "hub", frontmatter: { type: "Concept", title: "Hub", timestamp: T }, body: "" });
      await writeDoc(bundle, { id: "citer", frontmatter: { type: "Concept", title: "Citer", timestamp: T }, body: "" });
    }
    const server = await bootServer(remoteDir);
    try {
      await link(["add", "citer", "hub", "--text", "prereq", "--dir", localDir, "--json"], { stdout: () => {} });
      await link(["add", "citer", "hub", "--text", "prereq", "--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000", "--json"], { stdout: () => {} });

      const localShown = await runJson(link, ["show", "hub", "--text", "prereq", "--dir", localDir]);
      const remoteShown = await runJson(link, ["show", "hub", "--text", "prereq", "--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000"]);
      assert.deepEqual(remoteShown, localShown);
      assert.equal(remoteShown.backlink_count, 1);
      assert.deepEqual(remoteShown.backlinks, [{ from: "citer", text: "prereq" }]);

      // A filter matching nothing is the same definitive empty state over both transports.
      const localEmpty = await runJson(link, ["show", "hub", "--text", "no-match", "--dir", localDir]);
      const remoteEmpty = await runJson(link, ["show", "hub", "--text", "no-match", "--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000"]);
      assert.deepEqual(remoteEmpty, localEmpty);
      assert.equal(remoteEmpty.backlink_count, 0);
    } finally {
      await server.close();
    }
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  }
});

test("doc read --out --remote: canonical re-serialization is byte-identical to a LOCAL read for an engine-written doc", async () => {
  const dir = await tempDir();
  const outDir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, {
      id: "concepts/x",
      frontmatter: { type: "Concept", title: "X", tags: ["a", "b"], timestamp: T },
      body: "Hello **world**.\n\nA second paragraph.\n",
    });
    const server = await bootServer(dir);
    try {
      const localOut = path.join(outDir, "local.md");
      const remoteOut = path.join(outDir, "remote.md");
      // Capture the receipt (like every other call in this file via runJson) instead of letting
      // it hit real test stdout — doc's default stdout falls back to process.stdout.write.
      const captureStdout = { stdout: (_s: string) => {} };
      await doc(["read", "concepts/x", "--out", localOut, "--dir", dir], captureStdout);
      await doc(["read", "concepts/x", "--out", remoteOut, "--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000"], captureStdout);
      const localBytes = await readFile(localOut);
      const remoteBytes = await readFile(remoteOut);
      assert.deepEqual(remoteBytes, localBytes);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

/**
 * Multi-writer convergence over the historical MemoryBackend hard case. The filesystem adapter
 * now enforces the same CAS premise through a cross-process lock; the separate test below keeps
 * this wire-protocol proof backend-independent.
 *
 * Writer count is 5, not more, and that bound is load-bearing too: `link add`'s retry budget is
 * `LINK_ADD_MAX_ATTEMPTS = 5` (link.ts), which tolerates at most 4 `VersionConflict`s per writer
 * (`attempt < LINK_ADD_MAX_ATTEMPTS - 1`). Under worst-case lockstep interleaving — all N writers
 * read the same starting version before any PUT lands, then one winner lands per round — the
 * unluckiest of N writers conflicts N-1 times. N=5 puts that worst case at exactly 4 conflicts,
 * inside the budget; N=8 would let the unluckiest writer need 7 retries and could genuinely exceed
 * the budget (STALE_HEAD) on unlucky scheduling, which is a test-flakiness bug, not a product bug —
 * do NOT "fix" this by raising `LINK_ADD_MAX_ATTEMPTS` for the test's sake.
 */
test("multi-writer convergence: N concurrent `link add`s to the SAME source doc through one server (MemoryBackend: real enforced CAS) all land, all exit 0", async () => {
  const bundle: Bundle = { root: "mem://multi-writer-test", backend: new MemoryBackend() };
  await writeDoc(bundle, { id: "hub", frontmatter: { type: "Concept", title: "Hub", timestamp: T }, body: "Hub." });
  const targets = ["t1", "t2", "t3", "t4", "t5"];
  for (const t of targets) {
    await writeDoc(bundle, { id: t, frontmatter: { type: "Concept", title: t, timestamp: T }, body: t });
  }
  const server = await bootServerOverBundle(bundle);
  try {
    const results = await Promise.all(
      targets.map((t) => runJson(link, ["add", "hub", t, "--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000"])),
    );
    for (const r of results) {
      assert.equal(r.changed, true, `expected ${r.to as string} to land`);
      assert.equal(r.link, "added");
    }

    const shown = await runJson(link, ["show", "hub", "--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000"]);
    assert.equal(shown.outbound_count, targets.length);
    const linked = new Set((shown.outbound as Array<{ to: string }>).map((l) => l.to));
    for (const t of targets) assert.ok(linked.has(t), `${t} missing from converged outbound set`);
  } finally {
    await server.close();
  }
});

/**
 * Same concurrent-writer shape over FilesystemBackend through one server. A stronger built-process
 * proof in `filesystem-cross-process-cas.test.ts` exercises independent local writers directly.
 *
 * Writer count is 5, not more, for the SAME reason as the `MemoryBackend` test above:
 * `LINK_ADD_MAX_ATTEMPTS = 5` in `link.ts` tolerates at most 4 `VersionConflict`s per writer under
 * worst-case lockstep interleaving. Do NOT raise the writer count here without also reasoning about
 * that budget (see the comment on the `MemoryBackend` test).
 */
test("multi-writer convergence over FilesystemBackend: N concurrent `link add`s through one server converge losslessly", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, { id: "hub", frontmatter: { type: "Concept", title: "Hub", timestamp: T }, body: "Hub." });
    const targets = ["t1", "t2", "t3", "t4", "t5"];
    for (const t of targets) {
      await writeDoc(bundle, { id: t, frontmatter: { type: "Concept", title: t, timestamp: T }, body: t });
    }
    const server = await bootServer(dir);
    try {
      const results = await Promise.all(
        targets.map((t) => runJson(link, ["add", "hub", t, "--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000"])),
      );
      for (const r of results) {
        assert.equal(r.changed, true, `expected ${r.to as string} to land`);
        assert.equal(r.link, "added");
      }

      const shown = await runJson(link, ["show", "hub", "--remote", server.url, "--bundle", "bnd_00000000000000000000000000000000"]);
      assert.equal(shown.outbound_count, targets.length);
      const linked = new Set((shown.outbound as Array<{ to: string }>).map((l) => l.to));
      for (const t of targets) assert.ok(linked.has(t), `${t} missing from converged outbound set`);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--remote: an unreachable server maps to exit 1 RUNTIME with a serve hint, not a raw TypeError/USAGE misclassification", async () => {
  await assert.rejects(
    () => list(["--remote", "http://127.0.0.1:1", "--bundle", "bnd_00000000000000000000000000000000", "--json"], {}),
    (err: unknown) => {
      assert.ok(err instanceof CliError, `expected a CliError, got ${String(err)}`);
      assert.equal(err.code, "RUNTIME");
      assert.equal(err.exitCode, 1);
      assert.match(err.help ?? "", /serve/);
      return true;
    },
  );
});

test("--remote + --dir together: USAGE (exit 2)", async () => {
  await assert.rejects(
    () => list(["--remote", "http://127.0.0.1:4818", "--bundle", "bnd_00000000000000000000000000000000", "--dir", "/nonexistent", "--json"], {}),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    },
  );
});

test("init --remote: USAGE (exit 2) with the specific no-create-bundle-endpoint message", async () => {
  await assert.rejects(
    () => init(["--remote", "http://127.0.0.1:4818", "--bundle", "bnd_00000000000000000000000000000000", "--json"], {}),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "USAGE");
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /create-bundle endpoint/);
      return true;
    },
  );
});

test("malformed --remote URL: USAGE (exit 2)", async () => {
  await assert.rejects(
    () => list(["--remote", "not-a-url", "--bundle", "bnd_00000000000000000000000000000000", "--json"], {}),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    },
  );
});
