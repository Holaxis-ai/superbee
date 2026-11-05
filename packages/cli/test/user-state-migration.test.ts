import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCredentials, saveApiKeyForOrigin } from "../src/credentials.js";
import { CliError } from "../src/errors.js";
import {
  canonicalUserStateDir,
  inspectCanonicalUserStateRoot,
  legacyUserStateDir,
  readUserStateMarker,
  supersededUserStateDirs,
  USER_STATE_MARKER_BYTES,
  USER_STATE_QUARANTINE_COMMAND,
  userStateDirForPackage,
} from "../src/user-state.js";
import { setupStateCapability } from "../src/setup-plan.js";
import { inspectUserStateMigration, migrateUserState, migrationSourceRoots } from "../src/user-state-migration.js";
import { isolatedUserEnv } from "./support/user-env.js";

const BUILT_CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../superbee/dist/superbee.mjs");

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
  const env = isolatedUserEnv(options.home);
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
    const unrecognized = await inspectUserStateMigration(conflicting);
    assert.equal(unrecognized.state, "blocked");
    assert.match((unrecognized as { command: string }).command, /setup quarantine-state$/);
    assert.equal(setupStateCapability(unrecognized).command, (unrecognized as { command: string }).command);
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
      setup: { capabilities: Array<{ id: string; state: string }>; next: { command: string[] } };
    };
    assert.equal(plan.setup.capabilities.find((capability) => capability.id === "state")?.state, "needs_action");
    const launcher = plan.setup.next.command.slice(0, -2);
    assert.ok(
      (launcher.length === 1 && launcher[0] === "superbee")
        || (launcher.length === 3 && launcher.join(" ") === "npx --no-install superbee"),
      `migration must use a resolved installed launcher or no-download fallback: ${plan.setup.next.command.join(" ")}`,
    );
    assert.deepEqual(plan.setup.next.command.slice(-2), ["setup", "migrate-state"]);
    assert.equal(await absent(canonicalUserStateDir(root)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration draws from an ORDERED source list, so every superseded root is carried forward", async () => {
  const root = await home();
  try {
    const sources = migrationSourceRoots(root);
    assert.deepEqual(
      sources,
      [legacyUserStateDir(root), ...supersededUserStateDirs(root)],
    );
    assert.ok(sources.length > 1, "a superseded canonical root is still a migration source");
    const winningSource = sources[0]!;
    const authorizationSource = sources.at(-1)!;

    const catalog = `${JSON.stringify({ schema_version: 1, entries: [] })}\n`;
    const winning = `${JSON.stringify({ remotes: { "https://worker.example": { api_key: "from-bridge" } } })}\n`;
    const losing = `${JSON.stringify({ remotes: { "https://worker.example": { api_key: "from-superseded" } } })}\n`;
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

    // The first source supplies the catalog and WINNING credentials.
    await mkdir(winningSource, { recursive: true, mode: 0o700 });
    await chmod(winningSource, 0o700);
    await writeLegacy(join(winningSource, "catalog.json"), catalog);
    await writeLegacy(join(winningSource, "okf-config.json"), winning);

    // The superseded canonical root — which never shipped, but a tester on this branch may have
    // one — supplies a View authorization and a LOSING copy of the same credential record.
    const supersededAuthorizations = join(authorizationSource, "view-authorizations");
    await mkdir(supersededAuthorizations, { recursive: true, mode: 0o700 });
    await chmod(dirname(authorizationSource), 0o700);
    await chmod(authorizationSource, 0o700);
    await chmod(supersededAuthorizations, 0o700);
    await writeLegacy(join(authorizationSource, "okf-config.json"), losing);
    await writeLegacy(join(supersededAuthorizations, authorizationName), `${authorization}\n`);

    const inspection = await inspectUserStateMigration(root);
    assert.equal(inspection.state, "migratable");
    assert.equal(inspection.records, 3, "records from BOTH sources are carried forward");

    const receipt = await migrateUserState(root);
    assert.equal(receipt.status, "migrated");
    assert.equal(receipt.records.catalog, "migrated");
    assert.equal(receipt.records.credentials, "migrated");
    assert.equal(receipt.records.view_authorizations, 1);

    const canonical = canonicalUserStateDir(root);
    assert.equal(await readFile(join(canonical, "catalog.json"), "utf8"), catalog);
    assert.equal(
      await readFile(join(canonical, "okf-config.json"), "utf8"),
      winning,
      "a record present in both roots resolves by ORDER, not by walk accident",
    );
    assert.equal(await readFile(join(canonical, "view-authorizations", authorizationName), "utf8"), `${authorization}\n`);
    assert.equal(await readUserStateMarker(root), USER_STATE_MARKER_BYTES);

    // A MIGRATED root must end up as unstageable as one created by `ensureUserStateRoot`: the
    // promised total .gitignore lands after the marker and the journal removal, never during the
    // exact-topology staging that would have seen it as foreign stock.
    assert.equal(await readFile(join(canonical, ".gitignore"), "utf8"), "*\n");
    assert.equal((await stat(join(canonical, ".gitignore"))).mode & 0o777, 0o600);
    assert.equal(await absent(join(canonical, ".migration.json")), true, "the journal is gone");

    // Every source is PRESERVED, never moved or deleted.
    assert.equal(await absent(join(winningSource, "catalog.json")), false);
    assert.equal(await absent(join(authorizationSource, "okf-config.json")), false);
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
      sync_state: "left_in_legacy_root",
      ephemeral_state: "left_in_legacy_root",
    });
    assert.equal(first.legacy_preserved, true);
    assert.deepEqual(first.left_behind, {
      roots: ["~/.agentstate"],
      conflict_copies: 1,
      conflict_copies_at: ["~/.agentstate/sync/exports"],
      scan: "complete",
      notes: [],
    });
    assert.equal(
      await readFile(join(legacy, "sync", "exports", "recovery.md"), "utf8"),
      "keep me\n",
      "the conflict copy the receipt names is really there",
    );

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
      sync_state: "left_in_legacy_root",
      ephemeral_state: "left_in_legacy_root",
    });
    assert.equal(second.left_behind.conflict_copies, 1);
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
    // The interrupted root is this migration's own staging: setup routes to the resuming command,
    // not to quarantine.
    const interrupted = await inspectUserStateMigration(root);
    assert.equal(interrupted.state, "migratable");
    assert.match(interrupted.reason, /interrupted/);
    assert.equal(setupStateCapability(interrupted).command, "superbee setup migrate-state");
    assert.equal((await migrateUserState(root)).status, "migrated", "an exact interrupted migration resumes");
    assert.equal((await inspectUserStateMigration(root)).state, "ready");

    const residue = join(canonical, ".migration.json");
    await writeLegacy(residue, "foreign residue\n");
    assert.equal((await migrateUserState(root)).status, "already_current");
    assert.equal(await readFile(residue, "utf8"), "foreign residue\n", "a ready root never deletes an unowned journal path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The SOURCE side of "symlinked root" lives in `user-state-migration-sources.test.ts`; this name
// once claimed both and constructed only the canonical case.
test("migration rejects a symlinked CANONICAL root, non-regular legacy records, and unexpected staging entries", async () => {
  const linked = await home();
  const fifoHome = await home();
  const staged = await home();
  try {
    const foreign = join(linked, "foreign");
    await mkdir(foreign, { mode: 0o700 });
    await mkdir(dirname(canonicalUserStateDir(linked)), { recursive: true, mode: 0o700 });
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

/** Execute the one emitted product-owned remediation without a platform shell. */
async function runEmittedCommand(command: string, home: string): Promise<number> {
  assert.equal(command, "superbee setup quarantine-state");
  try {
    await runBuiltCli(["setup", "quarantine-state", "--json"], { home, cwd: home });
    return 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException & { code?: number }).code as number ?? 1;
  }
}

/**
 * The quarantine remediation is only an exit node if it actually EXECUTES from the states that
 * emit it. A fixed `.unrecognized` destination fails outright against a pre-existing regular file
 * (leaving the block un-cleared) and cannot run twice, so this runs the emitted string verbatim
 * against both collisions and re-inspects afterwards.
 */
test("the emitted quarantine command executes and clears the block even against a colliding name", async () => {
  const collidingFile = await home();
  const collidingDir = await home();
  const twice = await home();
  try {
    for (const [label, root, collide] of [
      ["pre-existing file", collidingFile, "file"],
      ["pre-existing directory", collidingDir, "dir"],
    ] as const) {
      const canonical = canonicalUserStateDir(root);
      await mkdir(canonical, { recursive: true, mode: 0o700 });
      await writeLegacy(join(canonical, "state.json"), "{\"product\":\"foreign\"}\n");
      const collision = `${canonical}.unrecognized`;
      if (collide === "file") await writeFile(collision, "PRIOR EVIDENCE\n", { mode: 0o600 });
      else await mkdir(collision, { mode: 0o700 });
      assert.equal(await inspectCanonicalUserStateRoot(root), "conflict", label);

      assert.equal(await runEmittedCommand(USER_STATE_QUARANTINE_COMMAND, root), 0, label);
      assert.equal(await inspectCanonicalUserStateRoot(root), "absent", `${label}: the block is cleared`);
      if (collide === "file") {
        assert.equal(await readFile(collision, "utf8"), "PRIOR EVIDENCE\n", `${label}: prior evidence survives`);
      }
      const canonicalParent = dirname(canonical);
      const canonicalBase = basename(canonical);
      const quarantined = (await readdir(canonicalParent)).filter((entry) => entry.startsWith(`${canonicalBase}.unrecognized.`));
      assert.equal(quarantined.length, 1, `${label}: exactly one fresh quarantine destination`);
      assert.deepEqual(await readdir(join(canonicalParent, quarantined[0]!)), [canonicalBase], label);
      assert.equal((await stat(join(canonicalParent, quarantined[0]!))).mode & 0o777, 0o700, `${label}: private mode`);
    }

    // Twice in a row: the second run must not collide with the first run's own output.
    for (const round of ["first", "second"]) {
      const canonical = canonicalUserStateDir(twice);
      await mkdir(canonical, { recursive: true, mode: 0o700 });
      await writeLegacy(join(canonical, "state.json"), `{"round":"${round}"}\n`);
      assert.equal(await runEmittedCommand(USER_STATE_QUARANTINE_COMMAND, twice), 0, round);
      assert.equal(await inspectCanonicalUserStateRoot(twice), "absent", round);
    }
    assert.equal(
      (await readdir(dirname(canonicalUserStateDir(twice))))
        .filter((entry) => entry.startsWith(`${basename(canonicalUserStateDir(twice))}.unrecognized.`)).length,
      2,
      "each run gets its own destination — no evidence is overwritten",
    );
  } finally {
    await Promise.all([collidingFile, collidingDir, twice].map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

// `setup` and `migrate-state` apply one proof to a canonical root that has no marker. Every forged
// root below must get quarantine advice from BOTH, and neither may write into it.
const OWNED_CATALOG_TEMPORARY = `.migration-${createHash("sha256").update("catalog.json").digest("hex").slice(0, 24)}.tmp`;

async function interruptedRoot(stage: "journal-only" | "catalog-staged"): Promise<{ root: string; canonical: string; original: string }> {
  const root = await home();
  const legacy = legacyUserStateDir(root);
  const original = `${JSON.stringify({ schema_version: 1, entries: [] })}\n`;
  await mkdir(legacy, { mode: 0o700 });
  await writeLegacy(join(legacy, "catalog.json"), original);
  await assert.rejects(() => migrateUserState(root, stage === "journal-only"
    ? { beforeRecordPublish: async () => { throw new Error("interrupt"); } }
    : { beforeMarkerPublish: async () => { throw new Error("interrupt"); } }));
  return { root, canonical: canonicalUserStateDir(root), original };
}

const FORGED_ROOTS: Array<{ name: string; stage: "journal-only" | "catalog-staged"; forge: (canonical: string, original: string) => Promise<void> }> = [
  { name: "staged catalog with different same-size bytes", stage: "catalog-staged", forge: async (c, o) => writeLegacy(join(c, "catalog.json"), "x".repeat(o.length - 1) + "\n") },
  { name: "truncated staged catalog", stage: "catalog-staged", forge: async (c) => writeLegacy(join(c, "catalog.json"), "") },
  { name: "larger staged catalog", stage: "catalog-staged", forge: async (c, o) => writeLegacy(join(c, "catalog.json"), `${o}${o}`) },
  { name: "symlinked staged catalog", stage: "catalog-staged", forge: async (c, o) => {
    await rm(join(c, "catalog.json"));
    await writeLegacy(join(c, "..", "elsewhere.json"), o);
    await symlink(join(c, "..", "elsewhere.json"), join(c, "catalog.json"));
  } },
  { name: "directory at an owned temporary path", stage: "catalog-staged", forge: async (c) => mkdir(join(c, OWNED_CATALOG_TEMPORARY), { mode: 0o700 }) },
  { name: "foreign.json beside the journal", stage: "journal-only", forge: async (c) => writeLegacy(join(c, "foreign.json"), "{}\n") },
  { name: "sync directory beside the journal", stage: "journal-only", forge: async (c) => mkdir(join(c, "sync"), { mode: 0o700 }) },
  { name: "bad marker", stage: "journal-only", forge: async (c) => writeLegacy(join(c, "state.json"), "not the marker\n") },
  { name: "group-readable journal", stage: "journal-only", forge: async (c) => chmod(join(c, ".migration.json"), 0o644) },
];

for (const row of FORGED_ROOTS) {
  test(`forged interrupted root (${row.name}): setup and migrate-state agree on quarantine and nothing is written`, async () => {
    const { root, canonical, original } = await interruptedRoot(row.stage);
    try {
      await row.forge(canonical, original);
      const before = (await readdir(canonical)).sort();
      const inspection = await inspectUserStateMigration(root);
      assert.equal(inspection.state, "blocked");
      assert.match((inspection as { command: string }).command, /setup quarantine-state$/);
      await assert.rejects(
        () => migrateUserState(root),
        (error: unknown) => error instanceof CliError && error.code === "CONFLICT" && /quarantine-state$/.test(error.help ?? ""),
      );
      assert.deepEqual((await readdir(canonical)).sort(), before, "the refusal wrote nothing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("an owned staging temporary left by a kill is tolerated by inspect and swept by migrate-state", async () => {
  const { root, canonical } = await interruptedRoot("journal-only");
  try {
    await writeLegacy(join(canonical, OWNED_CATALOG_TEMPORARY), "partial");
    assert.equal((await inspectUserStateMigration(root)).state, "migratable");
    assert.equal((await migrateUserState(root)).status, "migrated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the receipt names truncation, unreadable data, symlinks, and a second root", async () => {
  const root = await home();
  try {
    const [first, second] = migrationSourceRoots(root) as [string, string];
    for (const source of [first, second]) {
      await mkdir(dirname(source), { recursive: true, mode: 0o700 });
      await mkdir(join(source, "sync", "exports", "a"), { recursive: true, mode: 0o700 });
      await chmod(dirname(source), 0o700);
      await chmod(source, 0o700);
    }
    await writeLegacy(join(first, "catalog.json"), `${JSON.stringify({ schema_version: 1, entries: [] })}\n`);
    await writeLegacy(join(second, "sync", "exports", "a", "copy.md"), "second root\n");
    await mkdir(join(first, "sync", "exports", "locked"), { mode: 0o000 });
    await symlink(join(first, "catalog.json"), join(first, "sync", "exports", "link.md"));
    const receipt = await migrateUserState(root);
    await chmod(join(first, "sync", "exports", "locked"), 0o700);
    assert.equal(receipt.left_behind.scan, "partial");
    assert.equal(receipt.left_behind.conflict_copies, 1, "the second root is counted");
    assert.equal(receipt.left_behind.roots.length, 2);
    assert.ok(receipt.left_behind.notes.some((note) => /locked could not be read/.test(note)));
    assert.ok(receipt.left_behind.notes.some((note) => /link\.md is a symlink and was not followed/.test(note)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("left_behind stays bounded under a flood of directories or symlinks", async () => {
  const root = await home();
  try {
    const [first, second] = migrationSourceRoots(root) as [string, string];
    for (const source of [first, second]) {
      await mkdir(join(source, "sync", "exports"), { recursive: true, mode: 0o700 });
      await chmod(dirname(source), 0o700);
      await chmod(source, 0o700);
    }
    await writeLegacy(join(first, "catalog.json"), `${JSON.stringify({ schema_version: 1, entries: [] })}\n`);
    for (let index = 0; index < 2_100; index += 1) await mkdir(join(first, "sync", "exports", `d${index}`));
    for (let index = 0; index < 40; index += 1) await symlink(join(first, "catalog.json"), join(second, "sync", "exports", `l${index}`));
    const receipt = await migrateUserState(root);
    assert.equal(receipt.left_behind.scan, "partial");
    assert.ok(receipt.left_behind.notes.length <= 21, `${receipt.left_behind.notes.length} notes`);
    assert.equal(receipt.left_behind.notes.filter((note) => /directory limit/.test(note)).length, 1);
    assert.match(receipt.left_behind.notes.at(-1) ?? "", /^\d+ more notes omitted$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked sync directory is not followed, and nothing to migrate reports no legacy state", async () => {
  const empty = await home();
  const linked = await home();
  try {
    const none = await migrateUserState(empty);
    assert.equal(none.status, "nothing_to_migrate");
    assert.equal(none.records.sync_state, "absent");
    assert.equal(none.records.ephemeral_state, "absent");
    assert.deepEqual(none.left_behind.roots, []);

    const [source] = migrationSourceRoots(linked) as [string];
    await mkdir(source, { recursive: true, mode: 0o700 });
    await writeLegacy(join(source, "catalog.json"), `${JSON.stringify({ schema_version: 1, entries: [] })}\n`);
    const outside = join(linked, "outside");
    await mkdir(join(outside, "exports"), { recursive: true });
    await writeLegacy(join(outside, "exports", "x.md"), "x\n");
    await symlink(outside, join(source, "sync"));
    const receipt = await migrateUserState(linked);
    assert.equal(receipt.left_behind.conflict_copies, 0);
    assert.ok(receipt.left_behind.notes.some((note) => /sync is a symlink and was not followed/.test(note)));
  } finally {
    await Promise.all([empty, linked].map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("a symlinked legacy root is reported even when canonical state is already ready", async () => {
  const root = await home();
  try {
    const [source] = migrationSourceRoots(root) as [string];
    await mkdir(dirname(source), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "real-legacy"), { mode: 0o700 });
    await symlink(join(root, "real-legacy"), source);
    await mkdir(canonicalUserStateDir(root), { recursive: true, mode: 0o700 });
    await writeLegacy(join(canonicalUserStateDir(root), "state.json"), USER_STATE_MARKER_BYTES);
    const receipt = await migrateUserState(root);
    assert.equal(receipt.status, "already_current");
    assert.equal(receipt.left_behind.roots.length >= 1, true);
    assert.ok(receipt.left_behind.notes.some((note) => /is a symlink and was not scanned/.test(note)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
