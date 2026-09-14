// THE migration-source table (boundary specification section 7, statement M8).
//
// Migration reads guarded roots it does not own, and the only question this table asks is the one
// that was answered wrong: given a source root of some SHAPE, is it absent, usable, or blocked?
// `~/.agentstate -> ~/dotfiles/agentstate` is an ordinary dotfile layout, and reporting it as
// absent silently abandoned a live catalog, credential, and View-approval store.
//
// One row per shape: `[label, build, expected, reason, exitNode]`. ENOENT is the ONLY absence;
// every other detected shape fails closed, names the root in `~`-relative form, and carries its
// own exit node — a source-side block is never cleared by quarantining the canonical root.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CliError } from "../src/errors.js";
import { canonicalUserStateDir, legacyUserStateDir, supersededUserStateDirs } from "../src/user-state.js";
import { inspectUserStateMigration, migrateUserState } from "../src/user-state-migration.js";

const CATALOG = `${JSON.stringify({ schema_version: 1, entries: [] })}\n`;
const CREDENTIALS = `${JSON.stringify({ remotes: { "https://worker.example": { api_key: "carried" } } })}\n`;
const WINDOWS = process.platform === "win32";
const directoryLinkType: "dir" | "junction" = WINDOWS ? "junction" : "dir";
const sourceExit = (display: string, detailed = false): string => WINDOWS
  ? "superbee setup"
  : `ls -l${detailed ? "a" : "d"} ${display}`;

interface SourceShapeRow {
  readonly label: string;
  /** Build the shape under `home`. The canonical root is deliberately never created. */
  readonly build: (home: string) => Promise<void>;
  readonly expected: "fresh" | "migratable" | "blocked";
  /** What the reported reason must say. A blocked row MUST name the offending root. */
  readonly reason: RegExp;
  /** The exit node the block hands the operator, or `undefined` when there is nothing to fix. */
  readonly exitNode?: string;
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function privateFile(file: string, bytes: string): Promise<void> {
  await writeFile(file, bytes, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function legacyStore(home: string, at: string): Promise<void> {
  await privateDirectory(at);
  await privateFile(join(at, "catalog.json"), CATALOG);
  await privateFile(join(at, "okf-config.json"), CREDENTIALS);
  assert.ok(home.length > 0);
}

const SOURCE_SHAPES: readonly SourceShapeRow[] = [
  {
    label: "no source root at all — the genuinely fresh machine",
    build: async () => {},
    expected: "fresh",
    reason: /no legacy operational state requires migration/,
  },
  {
    label: "a real private directory holding nothing migration carries",
    build: async (home) => privateDirectory(legacyUserStateDir(home)),
    expected: "fresh",
    reason: /no legacy operational state requires migration/,
  },
  {
    label: "a real private directory holding a catalog and credentials",
    build: async (home) => legacyStore(home, legacyUserStateDir(home)),
    expected: "migratable",
    reason: /validated legacy operational state is ready to migrate/,
  },
  {
    // The reported defect: an ordinary dotfile layout (stow, chezmoi, yadm, a hand-made link).
    label: "a SYMLINK to a real private directory — the ordinary dotfile layout",
    build: async (home) => {
      const real = join(home, "dotfiles", "agentstate");
      await legacyStore(home, real);
      await symlink(real, legacyUserStateDir(home), directoryLinkType);
    },
    expected: "blocked",
    reason: /legacy operational state at .*\.agentstate exists but is not a real directory/,
    exitNode: sourceExit("~/.agentstate"),
  },
  {
    label: "a DANGLING symlink — a declared future identity, still not an absence",
    build: async (home) => symlink(join(home, "nowhere"), legacyUserStateDir(home), directoryLinkType),
    expected: "blocked",
    reason: /legacy operational state at .*\.agentstate exists but is not a real directory/,
    exitNode: sourceExit("~/.agentstate"),
  },
  {
    label: "a regular FILE where the source root is expected",
    build: async (home) => privateFile(legacyUserStateDir(home), "not a directory\n"),
    expected: "blocked",
    reason: /legacy operational state at .*\.agentstate exists but is not a real directory/,
    exitNode: sourceExit("~/.agentstate"),
  },
  {
    label: "a real source root whose durable record is malformed",
    build: async (home) => {
      await privateDirectory(legacyUserStateDir(home));
      await privateFile(join(legacyUserStateDir(home), "catalog.json"), "not json\n");
    },
    expected: "blocked",
    reason: /legacy operational state at .*\.agentstate holds operational state that is not safe to migrate automatically/,
    exitNode: sourceExit("~/.agentstate", true),
  },
  {
    label: "a real source root whose private mode drifted while holding records",
    build: async (home) => {
      await legacyStore(home, legacyUserStateDir(home));
      await chmod(legacyUserStateDir(home), 0o755);
    },
    expected: WINDOWS ? "migratable" : "blocked",
    reason: WINDOWS
      ? /validated legacy operational state is ready to migrate/
      : /legacy operational state at ~\/\.agentstate holds operational state that is not safe to migrate automatically/,
    exitNode: WINDOWS ? undefined : sourceExit("~/.agentstate", true),
  },
  {
    // The list is ORDERED and every entry answers to the same rule, so the SUPERSEDED root has to
    // name itself rather than borrowing the bridge root's spelling.
    label: "a symlinked SUPERSEDED root names ITSELF, not the bridge root",
    build: async (home) => {
      const [superseded] = supersededUserStateDirs(home) as [string];
      const real = join(home, "dotfiles", "superbee");
      await legacyStore(home, real);
      await mkdir(join(home, ".config"), { recursive: true, mode: 0o700 });
      await symlink(real, superseded, directoryLinkType);
    },
    expected: "blocked",
    reason: /legacy operational state at .*(?:\.superbee-state|\.config[\\/]superbee) exists but is not a real directory/,
    exitNode: WINDOWS ? "superbee setup" : "ls -ld ~/.config/superbee",
  },
];

async function scratchHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "superbee-migration-source-"));
}

test("migration source shapes: ENOENT is the only absence, and every other shape fails closed", async (t) => {
  for (const row of SOURCE_SHAPES) {
    await t.test(row.label, async () => {
      const home = await scratchHome();
      try {
        await row.build(home);
        const inspection = await inspectUserStateMigration(home);
        assert.equal(inspection.state, row.expected, `${row.label}: ${inspection.reason}`);
        assert.match(inspection.reason, row.reason, row.label);
        if (row.expected === "blocked") {
          assert.equal(
            inspection.state === "blocked" ? inspection.command : undefined,
            row.exitNode,
            `${row.label}: the exit node`,
          );
          // The canonical root's quarantine is the WRONG exit node here: on this machine that root
          // does not exist, so running it would fail and leave the block un-cleared.
          assert.doesNotMatch(row.exitNode ?? "", /superbee-state/, row.label);
          await assert.rejects(
            () => migrateUserState(home),
            (error: unknown) => error instanceof CliError
              && error.code === "CONFLICT"
              && row.reason.test(error.message)
              && error.help === row.exitNode,
            `${row.label}: the leaf refuses with the same reason and exit node`,
          );
        } else {
          const receipt = await migrateUserState(home);
          assert.equal(receipt.status, row.expected === "fresh" ? "nothing_to_migrate" : "migrated", row.label);
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

test("a blocked source root is never adopted: nothing claims the canonical root", async () => {
  const home = await scratchHome();
  try {
    const real = join(home, "dotfiles", "agentstate");
    await legacyStore(home, real);
    await symlink(real, legacyUserStateDir(home), directoryLinkType);
    await assert.rejects(() => migrateUserState(home), (error: unknown) => error instanceof CliError);
    await assert.rejects(
      () => rm(canonicalUserStateDir(home), { recursive: true }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
      "a refused migration creates no canonical root",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
