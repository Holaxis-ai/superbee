import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCredentials, saveApiKeyForOrigin } from "../src/credentials.js";
import { CliError } from "../src/errors.js";
import {
  canonicalUserStateDir,
  legacyUserStateDir,
  readUserStateMarker,
  USER_STATE_MARKER_BYTES,
  userStateDirForPackage,
} from "../src/user-state.js";
import { inspectUserStateMigration, migrateUserState } from "../src/user-state-migration.js";

const BUILT_CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/superbee.mjs");

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "superbee-user-state-"));
}

async function writeLegacy(file: string, bytes: string): Promise<void> {
  await writeFile(file, bytes, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function absent(file: string): Promise<boolean> {
  try {
    await access(file);
    return false;
  } catch {
    return true;
  }
}

async function runBuiltCli(
  args: string[],
  options: { home: string; cwd: string },
): Promise<{ stdout: string; stderr: string }> {
  const env = { ...process.env, HOME: options.home };
  delete env.SUPERBEE_NO_UPDATE_CHECK;
  delete env.AGENTSTATE_LITE_NO_UPDATE_CHECK;
  return new Promise((resolveRun, reject) => {
    execFile(process.execPath, [BUILT_CLI, ...args], { cwd: options.cwd, env }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });
}

test("package identity keeps the Aslite bridge on the legacy root while Superbee is canonical-only", async () => {
  const root = await home();
  try {
    assert.equal(userStateDirForPackage(root, "superbee"), canonicalUserStateDir(root));
    assert.equal(userStateDirForPackage(root, "@holaxis/aslite"), legacyUserStateDir(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary Superbee state is canonical-only and initializes an exact private marker", async () => {
  const root = await home();
  try {
    const legacy = legacyUserStateDir(root);
    await mkdir(legacy, { mode: 0o700 });
    await writeLegacy(join(legacy, "okf-config.json"), `${JSON.stringify({ remotes: { "https://old.example": { api_key: "old" } } })}\n`);

    assert.equal(await loadCredentials(root), null, "ordinary reads never fall back to legacy state");
    await saveApiKeyForOrigin("https://new.example", "new", root);
    assert.equal((await loadCredentials(root))?.remotes?.["https://new.example"]?.api_key, "new");
    assert.equal((await loadCredentials(root))?.remotes?.["https://old.example"], undefined);
    assert.equal(await readUserStateMarker(root), USER_STATE_MARKER_BYTES);
    assert.equal((await stat(canonicalUserStateDir(root))).mode & 0o777, 0o700);
    assert.equal((await stat(join(canonicalUserStateDir(root), "state.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup inspection distinguishes fresh, unknown-only, malformed, and conflicting state", async () => {
  const fresh = await home();
  const unknown = await home();
  const malformed = await home();
  const conflicting = await home();
  try {
    assert.equal((await inspectUserStateMigration(fresh)).state, "fresh");

    await mkdir(join(legacyUserStateDir(unknown), "personal-bundle"), { recursive: true, mode: 0o755 });
    assert.equal((await inspectUserStateMigration(unknown)).state, "fresh", "unknown legacy entries are ignored");

    await mkdir(legacyUserStateDir(malformed), { mode: 0o700 });
    await writeLegacy(join(legacyUserStateDir(malformed), "catalog.json"), "not json\n");
    assert.equal((await inspectUserStateMigration(malformed)).state, "blocked");

    await mkdir(canonicalUserStateDir(conflicting), { recursive: true, mode: 0o700 });
    await writeFile(join(canonicalUserStateDir(conflicting), "foreign.json"), "{}\n", { mode: 0o600 });
    assert.equal((await inspectUserStateMigration(conflicting)).state, "blocked");
  } finally {
    await Promise.all([fresh, unknown, malformed, conflicting].map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("plain built CLI leaves legacy migration discoverable until an explicit state mutation", async () => {
  const root = await home();
  try {
    const legacy = legacyUserStateDir(root);
    await mkdir(legacy, { mode: 0o700 });
    await writeLegacy(
      join(legacy, "catalog.json"),
      `${JSON.stringify({ schema_version: 1, entries: [] })}\n`,
    );

    await runBuiltCli([], { home: root, cwd: root });
    assert.equal(await absent(canonicalUserStateDir(root)), true);

    const { stdout } = await runBuiltCli(["setup", "--host", "codex", "--json"], {
      home: root,
      cwd: root,
    });
    const plan = JSON.parse(stdout) as {
      setup: { capabilities: Array<{ id: string; state: string }>; next: { command: string } };
    };
    assert.equal(plan.setup.capabilities.find((capability) => capability.id === "state")?.state, "needs_action");
    assert.equal(plan.setup.next.command, "superbee setup migrate-state");
    assert.equal(await absent(canonicalUserStateDir(root)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one-shot migration copies only validated durable records, preserves legacy bytes, and is idempotent", async () => {
  const root = await home();
  try {
    const legacy = legacyUserStateDir(root);
    const authorizations = join(legacy, "view-authorizations");
    await mkdir(authorizations, { recursive: true, mode: 0o700 });
    await chmod(legacy, 0o700);
    await chmod(authorizations, 0o700);

    const catalog = `${JSON.stringify({ schema_version: 1, entries: [] }, null, 2)}\n`;
    const credentials = `${JSON.stringify({ remotes: { "https://worker.example": { api_key: "secret" } } }, null, 2)}\n`;
    const authorization = JSON.stringify({
      bundle: "/bundles/planning",
      subject: {
        registryId: "views-registry/roadmap",
        contentVersion: "sha256:exact-html",
        contentType: "text/html; charset=utf-8",
        capability: "bundle-read",
        execution: "active",
        policyVersion: "active-view-v1",
      },
    });
    const authorizationName = `${createHash("sha256").update(authorization).digest("hex")}.json`;
    await writeLegacy(join(legacy, "catalog.json"), catalog);
    await writeLegacy(join(legacy, "okf-config.json"), credentials);
    await writeLegacy(join(authorizations, authorizationName), `${authorization}\n`);
    await mkdir(join(legacy, "sync", "exports"), { recursive: true, mode: 0o700 });
    await writeLegacy(join(legacy, "sync", "exports", "recovery.md"), "keep me\n");
    await writeLegacy(join(legacy, "ui-url"), "http://127.0.0.1/private\n");

    const before = {
      catalog: await readFile(join(legacy, "catalog.json"), "utf8"),
      credentials: await readFile(join(legacy, "okf-config.json"), "utf8"),
      authorization: await readFile(join(authorizations, authorizationName), "utf8"),
      recovery: await readFile(join(legacy, "sync", "exports", "recovery.md"), "utf8"),
    };
    const inspection = await inspectUserStateMigration(root);
    assert.deepEqual(inspection, {
      state: "migratable",
      reason: "validated legacy operational state is ready to migrate",
      records: 3,
    });

    const first = await migrateUserState(root);
    assert.equal(first.status, "migrated");
    assert.equal(first.changed, true);
    assert.deepEqual(first.records, {
      catalog: "migrated",
      credentials: "migrated",
      view_authorizations: 1,
      sync_state: "rederived",
      ephemeral_state: "rederived",
    });
    assert.equal(first.legacy_preserved, true);

    const canonical = canonicalUserStateDir(root);
    assert.equal(await readFile(join(canonical, "catalog.json"), "utf8"), catalog);
    assert.equal(await readFile(join(canonical, "okf-config.json"), "utf8"), credentials);
    assert.equal(await readFile(join(canonical, "view-authorizations", authorizationName), "utf8"), `${authorization}\n`);
    assert.equal(await readFile(join(canonical, "state.json"), "utf8"), USER_STATE_MARKER_BYTES);
    assert.equal(await absent(join(canonical, "sync")), true);
    assert.equal(await absent(join(canonical, "ui-url")), true);
    assert.equal((await stat(join(canonical, "catalog.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(canonical, "view-authorizations"))).mode & 0o777, 0o700);

    assert.equal(await readFile(join(legacy, "catalog.json"), "utf8"), before.catalog);
    assert.equal(await readFile(join(legacy, "okf-config.json"), "utf8"), before.credentials);
    assert.equal(await readFile(join(authorizations, authorizationName), "utf8"), before.authorization);
    assert.equal(await readFile(join(legacy, "sync", "exports", "recovery.md"), "utf8"), before.recovery);

    assert.equal((await inspectUserStateMigration(root)).state, "ready");
    const second = await migrateUserState(root);
    assert.equal(second.status, "already_current");
    assert.equal(second.changed, false);
    assert.deepEqual(second.records, {
      catalog: "unchanged",
      credentials: "unchanged",
      view_authorizations: 1,
      sync_state: "rederived",
      ephemeral_state: "rederived",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed recognized legacy state and foreign canonical roots are never mutated", async () => {
  const malformed = await home();
  const foreign = await home();
  try {
    await mkdir(legacyUserStateDir(malformed), { mode: 0o700 });
    await writeLegacy(join(legacyUserStateDir(malformed), "okf-config.json"), '{"remotes":{"bad":{"api_key":"secret"}}}\n');
    await assert.rejects(() => migrateUserState(malformed), (error: unknown) =>
      error instanceof CliError && error.code === "CONFLICT");
    assert.equal(await absent(canonicalUserStateDir(malformed)), true);

    await mkdir(canonicalUserStateDir(foreign), { recursive: true, mode: 0o700 });
    const foreignFile = join(canonicalUserStateDir(foreign), "foreign.json");
    await writeFile(foreignFile, "foreign\n", { mode: 0o600 });
    await assert.rejects(() => migrateUserState(foreign), (error: unknown) =>
      error instanceof CliError && error.code === "CONFLICT");
    assert.equal(await readFile(foreignFile, "utf8"), "foreign\n");
    assert.equal((await lstat(foreignFile)).isFile(), true);
  } finally {
    await Promise.all([malformed, foreign].map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("migration refuses canonical appearance and destination replacement without losing either side", async () => {
  const appeared = await home();
  const replaced = await home();
  try {
    for (const root of [appeared, replaced]) {
      await mkdir(legacyUserStateDir(root), { mode: 0o700 });
      await writeLegacy(join(legacyUserStateDir(root), "catalog.json"), `${JSON.stringify({ schema_version: 1, entries: [] })}\n`);
    }

    const appearedCanonical = canonicalUserStateDir(appeared);
    await assert.rejects(
      () => migrateUserState(appeared, {
        beforeCanonicalClaim: async () => {
          await mkdir(appearedCanonical, { mode: 0o700 });
          await writeLegacy(join(appearedCanonical, "foreign.json"), "foreign\n");
        },
      }),
      (error: unknown) => error instanceof CliError && error.code === "CONFLICT",
    );
    assert.equal(await readFile(join(appearedCanonical, "foreign.json"), "utf8"), "foreign\n");

    const replacedCanonical = canonicalUserStateDir(replaced);
    await assert.rejects(
      () => migrateUserState(replaced, {
        beforeRecordPublish: async (relative) => {
          if (relative === "catalog.json") await writeLegacy(join(replacedCanonical, relative), "foreign\n");
        },
      }),
      (error: unknown) => error instanceof CliError && error.code === "CONFLICT",
    );
    assert.equal(await readFile(join(replacedCanonical, "catalog.json"), "utf8"), "foreign\n");
    assert.match(await readFile(join(replacedCanonical, ".migration.json"), "utf8"), /"product":"superbee"/);
  } finally {
    await Promise.all([appeared, replaced].map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("source drift before completion preserves a resumable copy and a ready root never deletes foreign residue", async () => {
  const root = await home();
  try {
    const legacy = legacyUserStateDir(root);
    const catalogFile = join(legacy, "catalog.json");
    const original = `${JSON.stringify({ schema_version: 1, entries: [] })}\n`;
    await mkdir(legacy, { mode: 0o700 });
    await writeLegacy(catalogFile, original);

    await assert.rejects(
      () => migrateUserState(root, {
        beforeMarkerPublish: async () => writeLegacy(catalogFile, `${JSON.stringify({ schema_version: 1, entries: [{ changed: true }] })}\n`),
      }),
      (error: unknown) => error instanceof CliError && error.code === "CONFLICT",
    );
    const canonical = canonicalUserStateDir(root);
    assert.equal(await readFile(join(canonical, "catalog.json"), "utf8"), original);
    assert.equal(await absent(join(canonical, "state.json")), true);

    await writeLegacy(catalogFile, original);
    assert.equal((await migrateUserState(root)).status, "migrated", "an exact interrupted migration resumes");

    const residue = join(canonical, ".migration.json");
    await writeLegacy(residue, "foreign residue\n");
    assert.equal((await migrateUserState(root)).status, "already_current");
    assert.equal(await readFile(residue, "utf8"), "foreign residue\n", "a ready root never deletes an unowned journal path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exact interrupted record temp resumes, while ancestor and claimed-root swaps refuse", async () => {
  const interrupted = await home();
  const ancestorSwap = await home();
  const rootSwap = await home();
  try {
    for (const root of [interrupted, ancestorSwap, rootSwap]) {
      await mkdir(legacyUserStateDir(root), { mode: 0o700 });
      await writeLegacy(
        join(legacyUserStateDir(root), "catalog.json"),
        `${JSON.stringify({ schema_version: 1, entries: [] })}\n`,
      );
    }

    const interruptedBytes = await readFile(join(legacyUserStateDir(interrupted), "catalog.json"), "utf8");
    const interruptedName = `.migration-${createHash("sha256").update(interruptedBytes).digest("hex")}-${"a".repeat(24)}.tmp`;
    await assert.rejects(
      () => migrateUserState(interrupted, {
        beforeRecordPublish: async (relative) => {
          if (relative !== "catalog.json") return;
          await writeLegacy(
            join(canonicalUserStateDir(interrupted), interruptedName),
            interruptedBytes.slice(0, Math.floor(interruptedBytes.length / 2)),
          );
          throw new Error("simulated interruption");
        },
      }),
      (error: unknown) => error instanceof CliError && error.code === "CONFLICT",
    );
    assert.equal((await migrateUserState(interrupted)).status, "migrated");
    assert.equal(await absent(join(canonicalUserStateDir(interrupted), interruptedName)), true);

    const foreignParent = join(ancestorSwap, "foreign-config");
    const originalParent = join(ancestorSwap, "original-config");
    await mkdir(foreignParent, { mode: 0o700 });
    await assert.rejects(
      () => migrateUserState(ancestorSwap, {
        beforeCanonicalClaim: async () => {
          await rename(join(ancestorSwap, ".config"), originalParent);
          await symlink(foreignParent, join(ancestorSwap, ".config"), "dir");
        },
      }),
      (error: unknown) => error instanceof CliError && error.code === "CONFLICT",
    );
    assert.equal(await absent(join(foreignParent, "superbee")), true);

    const abandonedRoot = join(rootSwap, "abandoned-superbee");
    await assert.rejects(
      () => migrateUserState(rootSwap, {
        beforeRecordPublish: async (relative) => {
          if (relative !== "catalog.json") return;
          const canonical = canonicalUserStateDir(rootSwap);
          const journal = await readFile(join(canonical, ".migration.json"), "utf8");
          await rename(canonical, abandonedRoot);
          await mkdir(canonical, { mode: 0o700 });
          await writeLegacy(join(canonical, ".migration.json"), journal);
        },
      }),
      (error: unknown) => error instanceof CliError && error.code === "CONFLICT",
    );
    assert.equal(await absent(join(canonicalUserStateDir(rootSwap), "catalog.json")), true);
    assert.equal(await absent(join(canonicalUserStateDir(rootSwap), "state.json")), true);
    assert.equal((await lstat(join(abandonedRoot, ".migration.json"))).isFile(), true);
  } finally {
    await Promise.all([interrupted, ancestorSwap, rootSwap].map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("migration rejects symlinked roots, non-regular legacy records, and unexpected staging entries", async () => {
  const linked = await home();
  const fifoHome = await home();
  const staged = await home();
  try {
    const foreign = join(linked, "foreign");
    await mkdir(foreign, { mode: 0o700 });
    await mkdir(join(linked, ".config"), { mode: 0o700 });
    await symlink(foreign, canonicalUserStateDir(linked), "dir");
    assert.equal((await inspectUserStateMigration(linked)).state, "blocked");
    await assert.rejects(() => migrateUserState(linked), (error: unknown) => error instanceof CliError && error.code === "CONFLICT");
    assert.equal((await lstat(canonicalUserStateDir(linked))).isSymbolicLink(), true);
    assert.deepEqual(await readdir(foreign), []);

    const fifoLegacy = legacyUserStateDir(fifoHome);
    await mkdir(fifoLegacy, { mode: 0o700 });
    await new Promise<void>((resolve, reject) => {
      execFile("mkfifo", [join(fifoLegacy, "catalog.json")], (error) => error ? reject(error) : resolve());
    });
    const started = Date.now();
    assert.equal((await inspectUserStateMigration(fifoHome)).state, "blocked");
    assert.ok(Date.now() - started < 1_000, "FIFO inspection is bounded and nonblocking");
    assert.equal(await absent(canonicalUserStateDir(fifoHome)), true);

    const stagedLegacy = legacyUserStateDir(staged);
    await mkdir(stagedLegacy, { mode: 0o700 });
    await writeLegacy(join(stagedLegacy, "catalog.json"), `${JSON.stringify({ schema_version: 1, entries: [] })}\n`);
    await assert.rejects(
      () => migrateUserState(staged, {
        beforeMarkerPublish: async () => writeLegacy(join(canonicalUserStateDir(staged), "unexpected"), "foreign\n"),
      }),
      (error: unknown) => error instanceof CliError && error.code === "CONFLICT",
    );
    assert.equal(await readFile(join(canonicalUserStateDir(staged), "unexpected"), "utf8"), "foreign\n");
    assert.equal(await absent(join(canonicalUserStateDir(staged), "state.json")), true);
  } finally {
    await Promise.all([linked, fifoHome, staged].map((dir) => rm(dir, { recursive: true, force: true })));
  }
});
