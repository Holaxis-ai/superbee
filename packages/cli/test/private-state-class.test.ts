// THE state-class table (boundary specification sections 5 and 6).
//
// "Carries an ownership marker" and "fails closed" are INDEPENDENT properties, and conflating them
// did damage in both directions. This table separates them by asking FOUR questions of one
// directory — what an inspect reports, what a read of an EXISTING record does, what a read of an
// ABSENT record does, what a write does — so an inspect/write disagreement is a failing cell rather
// than a judgement call nobody was positioned to make.
//
// Adding a state class: one row `[label, build, expectations]`. The builder below is the only
// fixture; a new class must not need a new harness. If it does, this table is shaped wrong.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalUserStateDir,
  ensureUserStateRoot,
  inspectCanonicalUserStateRoot,
  inspectUserStateRootSync,
  readUserStateFile,
  USER_STATE_MARKER_BYTES,
  USER_STATE_MARKER_FILE_NAME,
  writeUserStateFileAtomic0600,
} from "../src/user-state.js";

/** The durable record every row reads: present iff the class can hold one. */
const RECORD_FILE_NAME = "catalog.json";
const RECORD_BYTES = '{"version":1,"entries":[]}\n';
const MAX_RECORD_BYTES = 64 * 1024;

type Inspection = "absent" | "ready" | "conflict";
/** `ok` = succeeded, `absent` = ENOENT (degrade), `denied` = refused (fail closed). */
type Access = "ok" | "absent" | "denied";

interface StateClassRow {
  readonly label: string;
  /** Build the class's shape under `home`. Returns nothing: the row's expectations are the claim. */
  readonly build: (home: string) => Promise<void>;
  /** Does the class hold a readable durable record? */
  readonly record: boolean;
  /** Is the guarded root an existing DIRECTORY? (drives the section-6 equivalences) */
  readonly directory: boolean;
  readonly inspect: Inspection;
  /** The synchronous inspector's verdict — the specification's A3, previously UNKNOWN. */
  readonly inspectSync: Inspection;
  /** Read of an EXISTING record. Omitted when the class cannot hold one. */
  readonly readExisting?: Access;
  /** Read of an ABSENT record. */
  readonly readAbsent: Access;
  readonly write: Access;
  readonly skip?: string;
}

async function withMarker(root: string, mode = 0o600): Promise<void> {
  await writeFile(join(root, USER_STATE_MARKER_FILE_NAME), USER_STATE_MARKER_BYTES, { mode });
  await chmod(join(root, USER_STATE_MARKER_FILE_NAME), mode);
}

async function withRecord(root: string): Promise<void> {
  await writeFile(join(root, RECORD_FILE_NAME), RECORD_BYTES, { mode: 0o600 });
  await chmod(join(root, RECORD_FILE_NAME), 0o600);
}

const STATE_CLASSES: readonly StateClassRow[] = [
  {
    label: "absent root",
    build: async () => {},
    record: false,
    directory: false,
    inspect: "absent",
    inspectSync: "absent",
    readAbsent: "absent",
    write: "ok",
  },
  {
    label: "ready (0700 root, exact 0600 marker, uid match)",
    build: async (home) => {
      await ensureUserStateRoot(home);
      await withRecord(canonicalUserStateDir(home));
    },
    record: true,
    directory: true,
    inspect: "ready",
    inspectSync: "ready",
    readExisting: "ok",
    readAbsent: "absent",
    write: "ok",
  },
  {
    label: "markerless root (foreign, or half-created)",
    build: async (home) => {
      const root = canonicalUserStateDir(home);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await withRecord(root);
    },
    record: true,
    directory: true,
    inspect: "conflict",
    inspectSync: "conflict",
    readExisting: "denied",
    readAbsent: "absent",
    write: "denied",
  },
  {
    label: "migration staging root (journal present, marker deliberately deferred)",
    build: async (home) => {
      const root = canonicalUserStateDir(home);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await withRecord(root);
      await writeFile(join(root, ".migration.json"), '{"product":"superbee","schema_version":1,"records":[]}\n', { mode: 0o600 });
    },
    record: true,
    directory: true,
    inspect: "conflict",
    inspectSync: "conflict",
    readExisting: "denied",
    readAbsent: "absent",
    write: "denied",
  },
  {
    label: "root is a SYMLINK to a real directory",
    build: async (home) => {
      const real = join(home, "elsewhere");
      await mkdir(real, { recursive: true, mode: 0o700 });
      await withMarker(real);
      await withRecord(real);
      await symlink(real, canonicalUserStateDir(home), "dir");
    },
    record: true,
    directory: false,
    inspect: "conflict",
    inspectSync: "conflict",
    readExisting: "denied",
    readAbsent: "absent",
    write: "denied",
  },
  {
    // The specification's P8: the boundary side was pinned (a regular file classifies, never
    // raises), the PRIVATE-STATE side had never been probed. This row determines it.
    label: "root is a regular FILE",
    build: async (home) => {
      await writeFile(canonicalUserStateDir(home), "not a directory\n", { mode: 0o600 });
    },
    record: false,
    directory: false,
    inspect: "conflict",
    inspectSync: "conflict",
    readAbsent: "denied",
    write: "denied",
  },
  {
    // The specification's A3: the async and sync inspectors handle an oversized marker by different
    // code (a size check vs a bounded read). Both must still say `conflict`.
    label: "marker exceeds its size limit",
    build: async (home) => {
      const root = canonicalUserStateDir(home);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await withRecord(root);
      await writeFile(join(root, USER_STATE_MARKER_FILE_NAME), `${" ".repeat(4096)}\n`, { mode: 0o600 });
    },
    record: true,
    directory: true,
    inspect: "conflict",
    inspectSync: "conflict",
    readExisting: "denied",
    readAbsent: "absent",
    write: "denied",
  },
  {
    label: "loose directory mode (0755) with a VALID marker",
    build: async (home) => {
      await ensureUserStateRoot(home);
      await withRecord(canonicalUserStateDir(home));
      await chmod(canonicalUserStateDir(home), 0o755);
    },
    record: true,
    directory: true,
    // The REQUIRED cells: this root is ours and repairable, so the three authorities must agree.
    inspect: "ready",
    inspectSync: "ready",
    readExisting: "ok",
    readAbsent: "absent",
    write: "ok",
    skip: "VIOLATED (specification P4 / A1 / A6 / R6, unfixed here): inspect reports `conflict` and setup "
      + "prescribes a quarantine `mv`, a read of an existing record fails, and a WRITE succeeds and "
      + "silently tightens the mode to 0700 — three authorities, three verdicts, one directory. Delete "
      + "this skip when they agree.",
  },
  {
    label: "valid marker with a LOOSE marker mode (0644)",
    build: async (home) => {
      await ensureUserStateRoot(home);
      await withRecord(canonicalUserStateDir(home));
      await chmod(join(canonicalUserStateDir(home), USER_STATE_MARKER_FILE_NAME), 0o644);
    },
    record: true,
    directory: true,
    // The REQUIRED cells: either repair the marker mode (as the directory mode is repaired) or
    // refuse with a remedy that names the actual fix.
    inspect: "ready",
    inspectSync: "ready",
    readExisting: "ok",
    readAbsent: "absent",
    write: "ok",
    skip: "VIOLATED (specification P6 / R7, unfixed here): every write fails forever, the marker mode is "
      + "never repaired, and the only offered remedy is a quarantine that would destroy the only copy of "
      + "the catalog, credentials, and View approvals. Delete this skip when the class is repaired or "
      + "given an accurate remedy.",
  },
  {
    label: "every GUARDED root carries an ownership marker",
    build: async () => {},
    record: false,
    directory: true,
    inspect: "ready",
    inspectSync: "ready",
    readAbsent: "absent",
    write: "ok",
    skip: "VIOLATED (specification P11, unfixed here): only the CANONICAL root carries a marker. The legacy "
      + "root is markerless by design (P10: readiness there is directory existence), which is exactly why a "
      + "marker-based publication backstop (F8) cannot cover it. This row states the requirement F8 would "
      + "need; delete the skip when every guarded root is marked.",
  },
  {
    label: "foreign uid on the root or the marker",
    build: async () => {},
    record: true,
    directory: true,
    inspect: "conflict",
    inspectSync: "conflict",
    readExisting: "denied",
    readAbsent: "absent",
    write: "denied",
    skip: "UNKNOWN (specification P9): a second uid is not reachable from a scratch HOME — this needs a CI "
      + "row, not a local probe. Delete this skip when that job exists.",
  },
  {
    label: "legacy-bridge build (@holaxis/aslite) root",
    build: async () => {},
    record: true,
    directory: true,
    inspect: "ready",
    inspectSync: "ready",
    readExisting: "ok",
    readAbsent: "absent",
    write: "ok",
    skip: "UNKNOWN (specification P10): readiness on that build is directory existence with no marker, and "
      + "the package identity is baked in at build time — this row needs a bridge-identity build, not a "
      + "fixture. Delete this skip when one is available.",
  },
];

async function scratchHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "superbee-state-class-"));
}

async function access(operation: () => Promise<unknown>): Promise<Access> {
  try {
    await operation();
    return "ok";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "denied";
  }
}

interface Observation {
  readonly row: StateClassRow;
  readonly inspect: Inspection;
  readonly inspectSync: Inspection;
  readonly readExisting?: Access;
  readonly readAbsent: Access;
  readonly write: Access;
}

async function observe(row: StateClassRow): Promise<Observation> {
  const home = await scratchHome();
  try {
    await row.build(home);
    const root = canonicalUserStateDir(home);
    const inspect = await inspectCanonicalUserStateRoot(home);
    const inspectSync = inspectUserStateRootSync(home);
    const readExisting = row.record
      ? await access(() => readUserStateFile(home, join(root, RECORD_FILE_NAME), MAX_RECORD_BYTES))
      : undefined;
    const readAbsent = await access(() => readUserStateFile(home, join(root, "absent.json"), MAX_RECORD_BYTES));
    const write = await access(() => writeUserStateFileAtomic0600(home, root, "probe.json", "{}\n"));
    return { row, inspect, inspectSync, readExisting, readAbsent, write };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const observations: Observation[] = [];

test("state classes: inspect / read-existing / read-absent / write, one row per class", async (t) => {
  for (const row of STATE_CLASSES) {
    await t.test(row.label, row.skip === undefined ? {} : { skip: row.skip }, async () => {
      const seen = await observe(row);
      observations.push(seen);
      assert.equal(seen.inspect, row.inspect, `${row.label}: inspect`);
      assert.equal(seen.inspectSync, row.inspectSync, `${row.label}: inspect (sync)`);
      assert.equal(seen.readExisting, row.readExisting, `${row.label}: read of an EXISTING record`);
      assert.equal(seen.readAbsent, row.readAbsent, `${row.label}: read of an ABSENT record`);
      assert.equal(seen.write, row.write, `${row.label}: write`);
    });
  }
  assert.ok(observations.length > 0, "the table would be vacuous with no executed row");
});

// ── Section 6: the same rows, read as equivalences ────────────────────────────
//
// These are computed from the rows above rather than probed again: a divergence between two
// authorities is a failing assertion here, not a judgement call. The VIOLATED classes are skipped
// rows above, so they are excluded by construction — which is exactly how a skipped row converts
// into a passing one when the defect is fixed.

test("A1 — for an EXISTING root, inspect says `ready` exactly when a write succeeds", () => {
  for (const seen of observations.filter((candidate) => candidate.row.directory)) {
    assert.equal(
      seen.inspect === "ready",
      seen.write === "ok",
      `${seen.row.label}: inspect=${seen.inspect} but write=${seen.write}`,
    );
  }
});

test("A2 — inspect says `ready` exactly when a read of an EXISTING record succeeds", () => {
  for (const seen of observations.filter((candidate) => candidate.readExisting !== undefined)) {
    assert.equal(
      seen.inspect === "ready",
      seen.readExisting === "ok",
      `${seen.row.label}: inspect=${seen.inspect} but read=${seen.readExisting}`,
    );
  }
});

test("A3 — the async and the synchronous inspector return the same verdict for the same root", () => {
  for (const seen of observations) {
    assert.equal(seen.inspectSync, seen.inspect, seen.row.label);
  }
});

test("A6 — no write repairs what an inspect calls unrecoverable", () => {
  for (const seen of observations) {
    assert.ok(
      !(seen.inspect === "conflict" && seen.write === "ok"),
      `${seen.row.label}: inspect refuses the root while a write succeeds on it`,
    );
  }
});

test("P3 — an ABSENT record is absent in every DIRECTORY-rooted class, whatever the root's health", () => {
  for (const seen of observations.filter((candidate) => candidate.row.directory)) {
    assert.equal(seen.readAbsent, "absent", seen.row.label);
  }
});
