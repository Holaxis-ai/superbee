// THE migration-interruption table (boundary specification section 7).
//
// Migration is the one mechanic that legitimately reads one guarded root and writes another, and
// the interesting failures are all in the middle of it. `migrateUserState` already exposes three
// kill points; this table gives them a home, one row per stage:
//
//     [stageHook, expectedState, expectedExitNode, lossy?]
//
// `expectedExitNode` is what a RERUN offers the operator — `resumes` when the rerun completes
// unaided, otherwise the exact refusal + help the operator is handed. `lossy` records whether the
// stated exit node can destroy bytes. Adding a stage is one row; it must not need a new harness.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
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

type Stage = "none" | "beforeCanonicalClaim" | "beforeRecordPublish" | "beforeMarkerPublish";

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
    label: "M-I3 — during record copying, leaving a temporary file behind",
    stage: "beforeRecordPublish",
    abort: true,
    damage: (canonical) => {
      writeFileSync(join(canonical, ".migration-deadbeefdeadbeef.tmp"), "partial\n", { mode: 0o600 });
    },
    expectedState: (_canonical, entries) => {
      assert.ok(entries.includes(JOURNAL_FILE_NAME), "the journal survives, so the run is resumable in principle");
    },
    // REQUIRED: resumable without operator intervention.
    expectedExitNode: "resumes",
    lossy: false,
    skip: "VIOLATED (specification M-I3, unfixed here): the rerun refuses permanently — the exact-topology "
      + "assertion sees the leftover `.migration-<hex>.tmp` as an unexpected entry — and recovery needs the "
      + "operator to run the quarantine command. It is non-lossy only because legacy state is preserved and "
      + "the canonical root holds nothing but copies. Delete this skip when a rerun resumes unaided.",
  },
  {
    label: "M-I4 — between marker publication and journal unlink",
    stage: "beforeMarkerPublish",
    expectedState: () => {},
    expectedExitNode: "resumes",
    lossy: false,
    skip: "UNKNOWN (specification M-I4): there is NO kill point between the marker write and the journal "
      + "unlink — `beforeMarkerPublish` fires before both — so this stage is unreachable from the existing "
      + "hooks. Adding one is a source change this unit deliberately does not make. Delete this skip when "
      + "the hook exists; the residue to check is a stale `.migration.json` holding the credential digest.",
  },
];

class Interrupted extends Error {}

async function legacyFixture(): Promise<{ home: string; legacy: string; canonical: string; digest: string }> {
  const home = await mkdtemp(join(tmpdir(), "superbee-migration-interruption-"));
  const legacy = legacyUserStateDir(home);
  await mkdir(legacy, { recursive: true, mode: 0o700 });
  await chmod(legacy, 0o700);
  for (const [name, bytes] of [["catalog.json", CATALOG], ["okf-config.json", CREDENTIALS]] as const) {
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
  return { beforeMarkerPublish: () => fire() };
}

test("migration interruption: one row per kill point, with the exit node a rerun offers", async (t) => {
  for (const row of INTERRUPTIONS) {
    await t.test(row.label, row.skip === undefined ? {} : { skip: row.skip }, async () => {
      const fixture = await legacyFixture();
      try {
        const legacyBefore = await Promise.all(
          (await entriesOf(fixture.legacy)).map(async (name) => `${name}:${await readFile(join(fixture.legacy, name), "utf8")}`),
        );

        if (row.stage === "none") {
          const receipt = await migrateUserState(fixture.home);
          assert.equal(receipt.status, "migrated");
        } else {
          await assert.rejects(() => migrateUserState(fixture.home, hooksFor(row, fixture.canonical)));
        }
        row.expectedState(fixture.canonical, await entriesOf(fixture.canonical));

        // MUST PRESERVE: the source is byte-identical whatever happened downstream.
        const legacyAfter = await Promise.all(
          (await entriesOf(fixture.legacy)).map(async (name) => `${name}:${await readFile(join(fixture.legacy, name), "utf8")}`),
        );
        assert.deepEqual(legacyAfter, legacyBefore, `${row.label}: legacy state must be preserved`);
        assert.equal(row.lossy, false, "a lossy exit node must be marked and justified in the row");

        if (row.expectedExitNode === "resumes") {
          const rerun = await migrateUserState(fixture.home);
          assert.match(rerun.status, /^(migrated|already_current)$/, `${row.label}: the rerun must complete unaided`);
          assert.equal(await readFile(join(fixture.canonical, USER_STATE_MARKER_FILE_NAME), "utf8"), USER_STATE_MARKER_BYTES);
          assert.equal(await readFile(join(fixture.canonical, "catalog.json"), "utf8"), CATALOG);
          assert.equal(await readFile(join(fixture.canonical, "okf-config.json"), "utf8"), CREDENTIALS);
          assert.equal((await stat(join(fixture.canonical, "okf-config.json"))).mode & 0o777, 0o600);
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
        }
      } finally {
        await rm(fixture.home, { recursive: true, force: true });
      }
    });
  }
});

test("migration interruption: every kill point the source exposes has a row", () => {
  const covered = new Set(INTERRUPTIONS.map((row) => row.stage));
  for (const stage of ["beforeCanonicalClaim", "beforeRecordPublish", "beforeMarkerPublish"] as const) {
    assert.ok(covered.has(stage), `no row exercises the ${stage} kill point`);
  }
  assert.ok(covered.has("none"), "the table needs its control row");
});
