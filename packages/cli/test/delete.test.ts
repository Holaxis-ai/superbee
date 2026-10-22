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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, readDoc, readBlob, writeDoc, writeBlob, readDocVersioned } from "@superbee/core";
import { serve, type ServerHandle } from "@superbee/server";

import { deleteCommand, type DeleteCliDeps } from "../src/commands/delete.js";
import { docDelete } from "../src/commands/doc/delete.js";
import { CliError } from "../src/errors.js";
import { KNOWN_COMMANDS } from "../src/cli.js";
import { commandReference } from "../src/reference.js";
import { testInvocation } from "./support/command-prefix.js";

const OLD_TS = "2020-01-01T00:00:00.000Z";

async function withDeleteActorEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const keys = ["SUPERBEE_ACTOR", "AGENTSTATE_LITE_ACTOR"] as const;
  const before = keys.map(key => process.env[key]);
  for (const key of keys) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try { return await run(); }
  finally {
    for (const [i, key] of keys.entries()) {
      if (before[i] === undefined) delete process.env[key];
      else process.env[key] = before[i];
    }
  }
}

const DOCUMENT_DELETE_SURFACES = [
  { name: "doc delete", run: (root: string, flags: string[]) => docDelete(["notes/a", "--dir", root, "--json", ...flags], { stdout: () => {} }) },
  { name: "delete --doc-key", run: (root: string, flags: string[]) => deleteCommand(["--doc-key", "notes/a.md", "--dir", root, "--json", ...flags], { stdout: () => {} }) },
];
for (const surface of DOCUMENT_DELETE_SURFACES) {
  for (const row of [
    { name: "v0.1 free-form configured actor", edition: "0.1", env: { SUPERBEE_ACTOR: "legacy name" }, flags: [], refused: false },
    { name: "v0.2 canonical environment actor", edition: "0.2", env: { SUPERBEE_ACTOR: "human:canonical" }, flags: [], refused: false },
    { name: "v0.2 legacy environment actor", edition: "0.2", env: { AGENTSTATE_LITE_ACTOR: "human:legacy" }, flags: [], refused: false },
    { name: "explicit actor overrides environment", edition: "0.2", env: { SUPERBEE_ACTOR: "invalid", AGENTSTATE_LITE_ACTOR: "also invalid" }, flags: ["--actor", "human:explicit"], refused: false },
    { name: "missing actor is allowed", edition: "0.2", env: {}, flags: [], refused: false },
    { name: "invalid configured actor", edition: "0.2", env: { SUPERBEE_ACTOR: "invalid" }, flags: [], refused: true },
    { name: "blank configured actor", edition: "0.2", env: { SUPERBEE_ACTOR: " " }, flags: [], refused: true },
    { name: "conflicting configured actors", edition: "0.2", env: { SUPERBEE_ACTOR: "human:one", AGENTSTATE_LITE_ACTOR: "human:two" }, flags: [], refused: true },
    { name: "blank explicit actor", edition: "0.2", env: {}, flags: ["--actor", " "], refused: true },
    { name: "invalid configured actor still refuses absence", edition: "0.2", env: { SUPERBEE_ACTOR: "invalid" }, flags: [], refused: true, absent: true },
  ] as const) {
    test(`${surface.name} actor policy: ${row.name}`, async () => {
      const root = await tempDir();
      try {
        await initBundle(root, { okfVersion: row.edition });
        const absent = "absent" in row && row.absent;
        if (!absent) await writeDoc({ root }, { id: "notes/a", frontmatter: { type: "Note" }, body: "keep until accepted" });
        const file = path.join(root, "notes/a.md");
        const before = absent ? undefined : await readFile(file);
        await withDeleteActorEnv(row.env, async () => {
          if (row.refused) await assert.rejects(() => surface.run(root, [...row.flags]), (error: unknown) => error instanceof CliError && error.code === "USAGE");
          else await surface.run(root, [...row.flags]);
        });
        if (row.refused && !absent) assert.deepEqual(await readFile(file), before);
        else await assert.rejects(() => readFile(file), { code: "ENOENT" });
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
  test(`${surface.name}: absent document remains success with an explicit stale token`, async () => {
    const { dir, cleanup } = await makeBundle();
    try {
      await withDeleteActorEnv({}, () => surface.run(dir, ["--expected-version", "old-version"]));
    } finally { await cleanup(); }
  });
  test(`${surface.name}: a literal .md-suffixed concept is deleted without touching reserved bytes`, async () => {
    const { dir, cleanup } = await makeBundle();
    try {
      await writeDoc({ root: dir }, { id: "index.md", frontmatter: { type: "Note" }, body: "ordinary concept" });
      const index = await readFile(path.join(dir, "index.md"));
      await withDeleteActorEnv({}, () => surface.name === "doc delete"
        ? docDelete(["index.md.md", "--dir", dir], { stdout: () => {} })
        : deleteCommand(["--doc-key", "index.md.md", "--dir", dir], { stdout: () => {} }));
      await assert.rejects(() => readFile(path.join(dir, "index.md.md")), { code: "ENOENT" });
      assert.deepEqual(await readFile(path.join(dir, "index.md")), index);
    } finally { await cleanup(); }
  });
}

test("delete blob route ignores invalid, blank and conflicting document attribution", async () => {
  const { dir, cleanup } = await makeBundle();
  try {
    for (const env of [{ SUPERBEE_ACTOR: "invalid" }, { SUPERBEE_ACTOR: " " }, { SUPERBEE_ACTOR: "human:one", AGENTSTATE_LITE_ACTOR: "human:two" }]) {
      await writeBlob({ root: dir }, "keep.bin", new Uint8Array([1, 2, 3]));
      const receipt = await withDeleteActorEnv(env, () => runDelete(["--doc-key", "keep.bin", "--dir", dir, "--actor", " "]));
      assert.equal(receipt.route, "blob");
      assert.equal(receipt.deleted, true);
    }
  } finally { await cleanup(); }
});

test("document deletion preserves the callers' different reserved-file refusal boundaries", async () => {
  const missing = path.join(tmpdir(), "superbee-delete-target-that-does-not-exist", "missing");
  await assert.rejects(() => docDelete(["index.md", "--dir", missing], {}),
    (error: unknown) => error instanceof CliError && error.code === "USAGE" && /reserved file/.test(error.message));
  await assert.rejects(() => deleteCommand(["--doc-key", "index.md", "--dir", missing]),
    (error: unknown) => error instanceof CliError && error.code === "NOT_FOUND");
});

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
  assert.match(out, /superbee delete/);
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
  const ref = commandReference(testInvocation("agentstate-lite"));
  const artifacts = ref.commands["Artifacts"] ?? [];
  assert.ok(artifacts.some((l) => l.startsWith("delete ")));
});
