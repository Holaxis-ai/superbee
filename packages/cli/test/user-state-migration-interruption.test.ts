// THE migration-interruption table (boundary specification section 7).
//
// Migration is the one mechanic that legitimately reads one guarded root and writes another, and
// the interesting failures are all in the middle of it. `migrateUserState` exposes four kill
// points; this table gives them a home, one row per stage:
//
//     [stageHook, expectedState, expectedExitNode, lossy?]
//
// `expectedExitNode` is what a RERUN offers the operator — `resumes` when the rerun completes
// unaided, otherwise the exact refusal + help the operator is handed. `lossy` records whether the
// stated exit node can destroy bytes. Adding a stage is one row; it must not need a new harness.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CliError } from "../src/errors.js";
import {
  canonicalUserStateDir,
  legacyUserStateDir,
  USER_STATE_MARKER_BYTES,
  USER_STATE_MARKER_FILE_NAME,
} from "../src/user-state.js";
import { migrateUserState, type UserStateMigrationHooks } from "../src/user-state-migration.js";

const CATALOG = `${JSON.stringify({ schema_version: 1, entries: [] })}\n`;
const CREDENTIALS = `${JSON.stringify({ remotes: { "https://worker.example": { api_key: "carried" } } })}\n`;
const JOURNAL_FILE_NAME = ".migration.json";
const AUTHORIZATION_DIR_NAME = "view-authorizations";
// A record in the nested store, so every row exercises the directory `writeNoReplace` creates on
// the way to a destination — the second place an interrupted copy can strand a temporary.
const AUTHORIZATION = JSON.stringify({
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
const AUTHORIZATION_NAME = `${createHash("sha256").update(AUTHORIZATION).digest("hex")}.json`;
/**
 * The residue a kill between a temporary's create and its unlink leaves behind: the temporary's
 * name is derived from the destination it stages, so the interrupted predecessor's leftover for a
 * given record sits at one knowable path. Mirrors the private derivation in the source.
 */
function ownTemporaryFor(relative: string): string {
  return `.migration-${createHash("sha256").update(relative).digest("hex").slice(0, 24)}.tmp`;
}
/** A pattern-matching temporary that is NOT at any owned path — residue migration must not touch. */
const FOREIGN_TEMPORARY = ".migration-deadbeefdeadbeef.tmp";

type Stage = "none" | "beforeCanonicalClaim" | "beforeRecordPublish" | "beforeMarkerPublish" | "afterMarkerPublish";

interface InterruptionRow {
  readonly label: string;
  /** Which kill point the interruption lands on. `none` is the control run. */
  readonly stage: Stage;
  /** Residue the interruption leaves behind, applied AT the kill point. */
  readonly damage?: (canonical: string) => void;
  /** Does the kill point abort the run, or only leave its damage and let the run continue? */
  readonly abort?: boolean;
  /** The state the interrupted attempt must leave behind. */
  readonly expectedState: (canonical: string, entries: readonly string[]) => void;
  /** `resumes` = a bare rerun completes unaided; otherwise the refusal + help the operator gets. */
  readonly expectedExitNode: "resumes" | { readonly message: RegExp; readonly help: RegExp };
  /** Can following the stated exit node destroy bytes? */
  readonly lossy: boolean;
  /** For a refusal row: a path (relative to the canonical root) that MUST still exist after the rerun. */
  readonly residueSurvives?: string;
  readonly skip?: string;
}

const INTERRUPTIONS: readonly InterruptionRow[] = [
  {
    // The control. Without it every interruption row could pass against a fixture that never
    // migrates anything.
    label: "no interruption — the control",
    stage: "none",
    expectedState: (canonical, entries) => {
      assert.ok(entries.includes(USER_STATE_MARKER_FILE_NAME), "the marker is migration's commit record");
      assert.equal(entries.includes(JOURNAL_FILE_NAME), false, "the journal is removed on success");
      assert.ok(entries.includes(".gitignore"), "a migrated root is hardened like an ensured one");
      assert.ok(canonical.length > 0);
    },
    expectedExitNode: "resumes",
    lossy: false,
  },
  {
    label: "M-I1 — before the canonical claim",
    stage: "beforeCanonicalClaim",
    abort: true,
    expectedState: (_canonical, entries) => {
      assert.deepEqual(entries, [], "no canonical root, so nothing to inspect or clean up");
    },
    expectedExitNode: "resumes",
    lossy: false,
  },
  {
    label: "M-I2 — between the root claim and the journal write",
    stage: "beforeCanonicalClaim",
    // The claim SUCCEEDS for someone else: an unmarked, journal-less root is what a kill in that
    // window leaves.
    damage: (canonical) => {
      writeFileSync(join(canonical, ".keep"), "", { mode: 0o600 });
    },
    expectedState: (_canonical, entries) => {
      assert.equal(entries.includes(USER_STATE_MARKER_FILE_NAME), false, "an unmarked root blocks everything");
      assert.equal(entries.includes(JOURNAL_FILE_NAME), false, "and carries no migration authority");
    },
    // A stated, non-lossy exit node — but note it points at the hostless `setup`, which the
    // recoverability table records as VIOLATED (R5): the screen it reaches has no state row.
    expectedExitNode: {
      message: /already exists but is not recognized/,
      help: /superbee setup/,
    },
    lossy: false,
  },
  {
    label: "M-I2b — journal written, its own staging temporary survived the write",
    stage: "beforeRecordPublish",
    abort: true,
    damage: (canonical) => {
      writeFileSync(join(canonical, ownTemporaryFor(JOURNAL_FILE_NAME)), "partial\n", { mode: 0o600 });
    },
    expectedState: (_canonical, entries) => {
      assert.ok(entries.includes(JOURNAL_FILE_NAME), "the journal landed");
      assert.ok(entries.includes(ownTemporaryFor(JOURNAL_FILE_NAME)), "and its temporary outlived the write");
    },
    // The journal is a destination this module stages like any other; its temporary is owned by
    // the same argument that owns the marker's. Omitting it from the sweep bricks this window.
    expectedExitNode: "resumes",
    lossy: false,
  },
  {
    label: "M-I3 — during record copying, leaving OUR OWN temporary in the root",
    stage: "beforeRecordPublish",
    abort: true,
    damage: (canonical) => {
      writeFileSync(join(canonical, ownTemporaryFor("okf-config.json")), "partial\n", { mode: 0o600 });
    },
    expectedState: (_canonical, entries) => {
      assert.ok(entries.includes(JOURNAL_FILE_NAME), "the journal survives, so the run is resumable in principle");
      assert.ok(entries.includes(ownTemporaryFor("okf-config.json")), "and the residue the rerun must clear is really there");
    },
    // REQUIRED: resumable without operator intervention. The journal records the record set, the
    // temporary's path derives from a recorded record — that is the ownership that authorizes the unlink.
    expectedExitNode: "resumes",
    lossy: false,
  },
  {
    label: "M-I3x — during record copying, a FOREIGN pattern-matching temporary in the root",
    stage: "beforeRecordPublish",
    abort: true,
    damage: (canonical) => {
      writeFileSync(join(canonical, FOREIGN_TEMPORARY), "not ours\n", { mode: 0o600 });
    },
    expectedState: (_canonical, entries) => {
      assert.ok(entries.includes(JOURNAL_FILE_NAME));
      assert.ok(entries.includes(FOREIGN_TEMPORARY));
    },
    // The red probe that found the defect: a journal proves the root and the record set, not
    // ownership of every name that matches the temporary pattern. Unrecognized residue stays and
    // the exactness assertion refuses — a stated, non-lossy exit node, never a silent unlink.
    expectedExitNode: {
      message: /user state changed during migration; legacy state remains preserved/,
      help: /superbee setup migrate-state/,
    },
    lossy: false,
    residueSurvives: FOREIGN_TEMPORARY,
  },
  {
    label: "M-I3b — during record copying, leaving OUR OWN temporary in the nested authorization store",
    stage: "beforeRecordPublish",
    abort: true,
    damage: (canonical) => {
      const store = join(canonical, AUTHORIZATION_DIR_NAME);
      mkdirSync(store, { recursive: true, mode: 0o700 });
      chmodSync(store, 0o700);
      writeFileSync(join(store, ownTemporaryFor(`${AUTHORIZATION_DIR_NAME}/${AUTHORIZATION_NAME}`)), "partial\n", { mode: 0o600 });
    },
    expectedState: (canonical, entries) => {
      assert.ok(entries.includes(AUTHORIZATION_DIR_NAME), "the store the interrupted copy created survives");
      assert.deepEqual(
        readdirSync(join(canonical, AUTHORIZATION_DIR_NAME)),
        [ownTemporaryFor(`${AUTHORIZATION_DIR_NAME}/${AUTHORIZATION_NAME}`)],
        "holding nothing but the residue",
      );
    },
    // Cleanup that only swept the root would leave this one, and the nested exactness check refuses
    // it just as permanently.
    expectedExitNode: "resumes",
    lossy: false,
  },
  {
    label: "M-I3bx — during record copying, a FOREIGN temporary in the nested authorization store",
    stage: "beforeRecordPublish",
    abort: true,
    damage: (canonical) => {
      const store = join(canonical, AUTHORIZATION_DIR_NAME);
      mkdirSync(store, { recursive: true, mode: 0o700 });
      chmodSync(store, 0o700);
      writeFileSync(join(store, FOREIGN_TEMPORARY), "not ours\n", { mode: 0o600 });
    },
    expectedState: (canonical) => {
      assert.deepEqual(readdirSync(join(canonical, AUTHORIZATION_DIR_NAME)), [FOREIGN_TEMPORARY]);
    },
    expectedExitNode: {
      message: /user state changed during migration; legacy state remains preserved/,
      help: /superbee setup migrate-state/,
    },
    lossy: false,
    residueSurvives: `${AUTHORIZATION_DIR_NAME}/${FOREIGN_TEMPORARY}`,
  },
  {
    label: "M-I3c — after every copy, before marker publication",
    stage: "beforeMarkerPublish",
    abort: true,
    expectedState: (_canonical, entries) => {
      assert.equal(entries.includes(USER_STATE_MARKER_FILE_NAME), false, "no marker: the root is still staging");
      assert.ok(entries.includes(JOURNAL_FILE_NAME), "the journal is the resume authority");
      assert.ok(entries.includes("okf-config.json"), "and the copies are already in place");
    },
    // Every destination already matches, so the rerun writes nothing and only publishes the marker.
    expectedExitNode: "resumes",
    lossy: false,
  },
  {
    label: "M-I4 — between marker publication and journal unlink",
    stage: "afterMarkerPublish",
    abort: true,
    expectedState: (_canonical, entries) => {
      assert.ok(entries.includes(USER_STATE_MARKER_FILE_NAME), "the marker is published: the root is complete and usable");
      assert.ok(entries.includes(JOURNAL_FILE_NAME), "and the journal is the residue this window leaves");
    },
    // Usable and non-lossy: readers ignore the journal, so the root is `already_current`; the
    // rerun removes the stale journal (it parses as ours) rather than leaving it forever.
    expectedExitNode: "resumes",
    lossy: false,
  },
];

class Interrupted extends Error {}

async function legacyFixture(): Promise<{ home: string; legacy: string; canonical: string; digest: string }> {
  const home = await mkdtemp(join(tmpdir(), "superbee-migration-interruption-"));
  const legacy = legacyUserStateDir(home);
  await mkdir(join(legacy, AUTHORIZATION_DIR_NAME), { recursive: true, mode: 0o700 });
  await chmod(legacy, 0o700);
  await chmod(join(legacy, AUTHORIZATION_DIR_NAME), 0o700);
  for (const [name, bytes] of [
    ["catalog.json", CATALOG],
    ["okf-config.json", CREDENTIALS],
    [`${AUTHORIZATION_DIR_NAME}/${AUTHORIZATION_NAME}`, `${AUTHORIZATION}\n`],
  ] as const) {
    await writeFile(join(legacy, name), bytes, { mode: 0o600 });
    await chmod(join(legacy, name), 0o600);
  }
  return {
    home,
    legacy,
    canonical: canonicalUserStateDir(home),
    digest: createHash("sha256").update(CATALOG + CREDENTIALS).digest("hex"),
  };
}

async function entriesOf(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Every file under `directory` as `relative:bytes`, so a nested source compares byte for byte. */
async function snapshotOf(directory: string, prefix = ""): Promise<string[]> {
  const rows: string[] = [];
  for (const name of await entriesOf(directory)) {
    const path = join(directory, name);
    rows.push(
      ...((await stat(path)).isDirectory()
        ? await snapshotOf(path, `${prefix}${name}/`)
        : [`${prefix}${name}:${await readFile(path, "utf8")}`]),
    );
  }
  return rows;
}

function hooksFor(row: InterruptionRow, canonical: string): UserStateMigrationHooks {
  if (row.stage === "none") return {};
  const fire = () => {
    row.damage?.(canonical);
    if (row.abort) throw new Interrupted(row.label);
  };
  if (row.stage === "beforeCanonicalClaim") {
    // The damage belongs INSIDE the claimed root, so claim it here and let the run collide.
    return {
      beforeCanonicalClaim: async () => {
        if (row.damage) {
          await mkdir(canonical, { mode: 0o700 });
          row.damage(canonical);
        }
        if (row.abort) throw new Interrupted(row.label);
      },
    };
  }
  if (row.stage === "beforeRecordPublish") return { beforeRecordPublish: () => fire() };
  if (row.stage === "afterMarkerPublish") return { afterMarkerPublish: () => fire() };
  return { beforeMarkerPublish: () => fire() };
}

test("migration interruption: one row per kill point, with the exit node a rerun offers", async (t) => {
  for (const row of INTERRUPTIONS) {
    await t.test(row.label, row.skip === undefined ? {} : { skip: row.skip }, async () => {
      const fixture = await legacyFixture();
      try {
        const legacyBefore = await snapshotOf(fixture.legacy);

        if (row.stage === "none") {
          const receipt = await migrateUserState(fixture.home);
          assert.equal(receipt.status, "migrated");
        } else {
          await assert.rejects(() => migrateUserState(fixture.home, hooksFor(row, fixture.canonical)));
        }
        row.expectedState(fixture.canonical, await entriesOf(fixture.canonical));

        // MUST PRESERVE: the source is byte-identical whatever happened downstream.
        const legacyAfter = await snapshotOf(fixture.legacy);
        assert.deepEqual(legacyAfter, legacyBefore, `${row.label}: legacy state must be preserved`);
        assert.equal(row.lossy, false, "a lossy exit node must be marked and justified in the row");

        if (row.expectedExitNode === "resumes") {
          const rerun = await migrateUserState(fixture.home);
          assert.match(rerun.status, /^(migrated|already_current)$/, `${row.label}: the rerun must complete unaided`);
          assert.equal(await readFile(join(fixture.canonical, USER_STATE_MARKER_FILE_NAME), "utf8"), USER_STATE_MARKER_BYTES);
          assert.equal(await readFile(join(fixture.canonical, "catalog.json"), "utf8"), CATALOG);
          assert.equal(await readFile(join(fixture.canonical, "okf-config.json"), "utf8"), CREDENTIALS);
          assert.equal((await stat(join(fixture.canonical, "okf-config.json"))).mode & 0o777, 0o600);
          assert.equal(
            await readFile(join(fixture.canonical, AUTHORIZATION_DIR_NAME, AUTHORIZATION_NAME), "utf8"),
            `${AUTHORIZATION}\n`,
          );
          assert.deepEqual(
            (await entriesOf(join(fixture.canonical, AUTHORIZATION_DIR_NAME))),
            [AUTHORIZATION_NAME],
            "a resumed migration leaves no staging residue in the nested store",
          );
          assert.deepEqual(
            (await entriesOf(fixture.canonical)).filter((name) => name.startsWith(".migration-")),
            [],
            "nor in the root",
          );
          assert.equal((await entriesOf(fixture.canonical)).includes(JOURNAL_FILE_NAME), false, "a completed root carries no journal");
          assert.ok((await entriesOf(fixture.canonical)).includes(".gitignore"), "and is hardened like an ensured one");
        } else {
          const expected = row.expectedExitNode;
          await assert.rejects(
            () => migrateUserState(fixture.home),
            (error: unknown) => {
              assert.ok(error instanceof CliError, `${row.label}: a refusal must be a CliError`);
              assert.equal(error.code, "CONFLICT");
              assert.match(error.message, expected.message, row.label);
              assert.match((error as { help?: string }).help ?? "", expected.help, `${row.label}: the exit node`);
              return true;
            },
          );
          if (row.residueSurvives !== undefined) {
            await stat(join(fixture.canonical, row.residueSurvives));
          }
        }
      } finally {
        await rm(fixture.home, { recursive: true, force: true });
      }
    });
  }
});

test("migration interruption: every kill point the source exposes has a row", () => {
  const covered = new Set(INTERRUPTIONS.map((row) => row.stage));
  for (const stage of ["beforeCanonicalClaim", "beforeRecordPublish", "beforeMarkerPublish", "afterMarkerPublish"] as const) {
    assert.ok(covered.has(stage), `no row exercises the ${stage} kill point`);
  }
  assert.ok(covered.has("none"), "the table needs its control row");
});
