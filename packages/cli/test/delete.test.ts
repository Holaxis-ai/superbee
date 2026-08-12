/**
 * `agentstate-lite delete --doc-key <key>` — the top-level, key-addressed delete verb
 * (symmetric with `promote`/`pull`; the DELETE-operation pass, binding plan item 9).
 *
 * Covers the same `.md`-suffix routing split `promote`/`pull` use (A6/B6), the CAS contract
 * (`--expected-version` omitted = unconditional; a stale token = CONFLICT exit 5), idempotency
 * (an absent key is `deleted:false`, exit 0, never NOT_FOUND), the no-positionals guard, and
 * registration in `KNOWN_COMMANDS`/the command reference. `doc.test.ts` covers `doc delete
 * <id>`, the concept-native form this verb complements.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, readDoc, readBlob, writeDoc, writeBlob, readDocVersioned } from "@superbee/core";
import { serve, type ServerHandle } from "@superbee/server";

import { deleteCommand, type DeleteCliDeps } from "../src/commands/delete.js";
import { CliError } from "../src/errors.js";
import { KNOWN_COMMANDS } from "../src/cli.js";
import { commandReference } from "../src/reference.js";

const OLD_TS = "2020-01-01T00:00:00.000Z";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-delete-test-"));
}

async function makeBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await tempDir();
  await initBundle(dir);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Run `delete`, capturing + parsing its `--json` stdout. */
async function runDelete(argv: string[], deps: Partial<DeleteCliDeps> = {}): Promise<Record<string, unknown>> {
  let out = "";
  await deleteCommand([...argv, "--json"], { stdout: (s) => (out += s), ...deps });
  return JSON.parse(out) as Record<string, unknown>;
}

async function bootServer(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const handle: ServerHandle = await serve({ bundle: { root: dir }, port: 0 });
  return { url: `http://${handle.host}:${handle.port}`, close: () => handle.close() };
}

// ── doc route ──────────────────────────────────────────────────────────────

test("delete --doc-key <x>.md: routes as a DOC, removes it, and it is genuinely gone", async () => {
  const { dir, cleanup } = await makeBundle();
  try {
    await writeDoc({ root: dir }, { id: "concepts/a", frontmatter: { type: "Concept", timestamp: OLD_TS }, body: "Body." });

    const result = await runDelete(["--doc-key", "concepts/a.md", "--dir", dir]);
    assert.equal(result.delete, "deleted");
    assert.equal(result.route, "doc");
    assert.equal(result.key, "concepts/a.md");
    assert.equal(result.deleted, true);
    assert.match((result.help as string[])[0]!, /\blist$/);

    await assert.rejects(() => readDoc({ root: dir }, "concepts/a"));
  } finally {
    await cleanup();
  }
});

test("delete --doc-key <X>.MD (case-insensitive): routes as a DOC exactly like the lowercase form", async () => {
  const { dir, cleanup } = await makeBundle();
  try {
    await writeDoc({ root: dir }, { id: "concepts/mixed", frontmatter: { type: "Concept", timestamp: OLD_TS }, body: "x" });
    const result = await runDelete(["--doc-key", "concepts/mixed.MD", "--dir", dir]);
    assert.equal(result.route, "doc");
    assert.equal(result.deleted, true);
    await assert.rejects(() => readDoc({ root: dir }, "concepts/mixed"));
  } finally {
    await cleanup();
  }
});

test("delete --doc-key <absent>.md: idempotent — deleted:false, exit 0, never NOT_FOUND", async () => {
  const { dir, cleanup } = await makeBundle();
  try {
    const result = await runDelete(["--doc-key", "concepts/never-existed.md", "--dir", dir]);
    assert.equal(result.route, "doc");
    assert.equal(result.deleted, false);
  } finally {
    await cleanup();
  }
});

// ── blob route ─────────────────────────────────────────────────────────────

test("delete --doc-key <key> (non-.md): routes as a BLOB, removes it, and it is genuinely gone", async () => {
  const { dir, cleanup } = await makeBundle();
  try {
    await writeBlob({ root: dir }, "artifacts/report.html", new TextEncoder().encode("<p>hi</p>"));

    const result = await runDelete(["--doc-key", "artifacts/report.html", "--dir", dir]);
    assert.equal(result.delete, "deleted");
    assert.equal(result.route, "blob");
    assert.equal(result.key, "artifacts/report.html");
    assert.equal(result.deleted, true);
    assert.match((result.help as string[])[0]!, /\blist$/);

    assert.equal(await readBlob({ root: dir }, "artifacts/report.html"), null);
  } finally {
    await cleanup();
  }
});

test("delete --doc-key <absent-blob>: idempotent — deleted:false, exit 0", async () => {
  const { dir, cleanup } = await makeBundle();
  try {
    const result = await runDelete(["--doc-key", "artifacts/never-existed.bin", "--dir", dir]);
    assert.equal(result.route, "blob");
    assert.equal(result.deleted, false);
  } finally {
    await cleanup();
  }
});

// ── CAS ────────────────────────────────────────────────────────────────────

test("delete --expected-version: a stale token is STALE_HEAD (exit 5, {expected,actual} details); the current token succeeds", async () => {
  const { dir, cleanup } = await makeBundle();
  try {
    await writeDoc({ root: dir }, { id: "concepts/a", frontmatter: { type: "Concept", timestamp: OLD_TS }, body: "v1" });
    const { version: v1 } = await readDocVersioned({ root: dir }, "concepts/a");
    await writeDoc({ root: dir }, { id: "concepts/a", frontmatter: { type: "Concept", timestamp: OLD_TS }, body: "v2" });
    const { version: v2 } = await readDocVersioned({ root: dir }, "concepts/a");
    assert.notEqual(v1, v2);

    await assert.rejects(
      () => deleteCommand(["--doc-key", "concepts/a.md", "--expected-version", v1, "--dir", dir, "--json"], {}),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "STALE_HEAD");
        assert.equal(err.exitCode, 5);
        assert.deepEqual(err.details, { expected: v1, actual: v2 });
        return true;
      },
    );
    assert.equal((await readDoc({ root: dir }, "concepts/a")).body.trim(), "v2"); // untouched

    const result = await runDelete(["--doc-key", "concepts/a.md", "--expected-version", v2, "--dir", dir]);
    assert.equal(result.deleted, true);
  } finally {
    await cleanup();
  }
});

test("delete --expected-version '' (blank): USAGE (exit 2), does NOT silently downgrade to an unconditional delete", async () => {
  const { dir, cleanup } = await makeBundle();
  try {
    await writeDoc({ root: dir }, { id: "concepts/a", frontmatter: { type: "Concept", timestamp: OLD_TS }, body: "keep" });
    await assert.rejects(
      () => deleteCommand(["--doc-key", "concepts/a.md", "--expected-version", "", "--dir", dir, "--json"], {}),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /empty value/);
        return true;
      },
    );
    // The doc must survive — a blank CAS token must never delete unconditionally.
    assert.equal((await readDoc({ root: dir }, "concepts/a")).body.trim(), "keep");
  } finally {
    await cleanup();
  }
});

// ── usage guards ───────────────────────────────────────────────────────────

test("delete: --doc-key is required (USAGE, exit 2)", async () => {
  await assert.rejects(
    () => deleteCommand(["--dir", "/does/not/matter", "--json"], {}),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "USAGE");
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /--doc-key/);
      return true;
    },
  );
});

test("delete: a stray positional is a USAGE error, not silently absorbed", async () => {
  await assert.rejects(
    () => deleteCommand(["stray.md", "--doc-key", "x.md", "--json"], {}),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "USAGE");
      assert.match(err.message, /positional/);
      return true;
    },
  );
});

test("delete --help: prints usage and does not touch a bundle", async () => {
  let out = "";
  await deleteCommand(["--help"], { stdout: (s) => (out += s) });
  assert.match(out, /agentstate-lite delete/);
});

// ── --remote parity ────────────────────────────────────────────────────────

test("delete --doc-key --remote: round-trip parity with the same operation run locally via --dir (doc + blob routes)", async () => {
  const localDir = await tempDir();
  const remoteDir = await tempDir();
  try {
    await initBundle(localDir);
    await initBundle(remoteDir);
    for (const root of [localDir, remoteDir]) {
      await writeDoc({ root }, { id: "concepts/a", frontmatter: { type: "Concept", timestamp: OLD_TS }, body: "x" });
      await writeBlob({ root }, "artifacts/b.bin", new TextEncoder().encode("y"));
    }
    const server = await bootServer(remoteDir);
    try {
      const localDoc = await runDelete(["--doc-key", "concepts/a.md", "--dir", localDir]);
      const remoteDoc = await runDelete(["--doc-key", "concepts/a.md", "--remote", server.url]);
      assert.equal(remoteDoc.deleted, localDoc.deleted);
      assert.equal(remoteDoc.deleted, true);

      const localBlob = await runDelete(["--doc-key", "artifacts/b.bin", "--dir", localDir]);
      const remoteBlob = await runDelete(["--doc-key", "artifacts/b.bin", "--remote", server.url]);
      assert.equal(remoteBlob.deleted, localBlob.deleted);
      assert.equal(remoteBlob.deleted, true);

      await assert.rejects(() => readDoc({ root: remoteDir }, "concepts/a"));
      assert.equal(await readBlob({ root: remoteDir }, "artifacts/b.bin"), null);
    } finally {
      await server.close();
    }
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  }
});

// ── registration ─────────────────────────────────────────────────────────────

test("delete is registered in KNOWN_COMMANDS and the command reference", () => {
  assert.ok(KNOWN_COMMANDS.includes("delete"));
  const ref = commandReference("agentstate-lite");
  const artifacts = ref.commands["Artifacts"] ?? [];
  assert.ok(artifacts.some((l) => l.startsWith("delete ")));
});
