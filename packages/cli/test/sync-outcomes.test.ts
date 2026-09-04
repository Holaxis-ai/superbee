// The sync-outcome AGREEMENT SUITE (sync-outcome-table unit, plans/sync-outcome-table).
//
// Enumerates EVERY row of the outcome table (`src/sync-outcomes.ts` — error rows AND guidance-line
// rows) against the committed rendered-byte fixtures in `fixtures/sync-outcomes/fixtures.json`,
// which were captured from the PRE-refactor construction sites (fixture-first: the fixtures are
// the freeze, written before any site moved). Assertions are BYTE equality on the rendered
// envelope (through renderErrorEnvelope — TOON field order included) or the raw guidance string.
//
// Coverage is bidirectional and closed: a table row without a fixture FAILS the suite, a fixture
// without a table row FAILS the suite, and a fixture without a param builder FAILS the suite.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SYNC_OUTCOMES,
  SYNC_OUTCOME_LINES,
  ffSwallowToError,
  withSharingDetails,
  syncOutcomeError,
  syncOutcomeLine,
  type SyncOutcomeKey,
  type SyncOutcomeLineKey,
} from "../src/sync-outcomes.js";
import { showIncomingInTreeNoBasis } from "../src/commands/sync.js";
import { CLEANUP_BRANCH } from "../src/commands/sync-establish.js";
import { buildBoardBlock } from "../src/commands/home.js";
import { CliError, toEnvelope } from "../src/errors.js";
import { renderErrorEnvelope } from "../src/output.js";
import { boardWindowGuidance, preShareWindowError, type StatusRow } from "@superbee/board-git";
import { makeLocalBoardTop, makePlainTop, makeRemnantTop, type OutcomeState } from "./sync-outcome-states.js";
import { testInvocation } from "./support/command-prefix.js";
import { renderedQuoted } from "./support/rendered-command.js";

interface Fixture {
  key: string;
  variant: string;
  kind: "envelope" | "line";
  bytes: string;
}

const FIXTURES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/sync-outcomes/fixtures.json",
);
const FIXTURES = (JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as { fixtures: Fixture[] }).fixtures;

// The fixed representative params the capture used — MUST stay in lockstep with the fixtures.
const INV = testInvocation("aslite");
const BOARD_PATH = "/repo/.superbee";
const BUNDLE_DIR = path.basename(BOARD_PATH);
const TOP = "/repo";
const MARKER = "3f786850e387550fdab836ed7e6dc881de23001b";
const MARKER_PATH = "/repo/.git/agentstate.establishCommittedShare";
const BRANCH = "main";
const REF = "origin/main";
// Annotated the way boardNamespaceConflicts actually reports them (review fixup: the bare names
// captured originally are a shape no real invocation produces).
const CONFLICTING = ["board/x (local)", "board/y (on origin)"];
const BEHIND = [
  "1111111111111111111111111111111111111111",
  "2222222222222222222222222222222222222222",
];
const SNAPSHOT_TREE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CURRENT_TREE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
// The committed-dirty fixture's representative statusRows() shape (PR1: sync-copy-unification).
const DIRTY_ROWS: StatusRow[] = [
  { status: "M", path: ".superbee/tasks/a.md" },
  { status: "A", path: ".superbee/tasks/b.md" },
];

/**
 * The fixtures pin the POSIX spelling. Exactly ONE line renders its cleanup-branch value through
 * the quoting authority (`line.marker.interrupted-offer.note`), and the authority spells a token
 * differently per platform — so only that line's POSIX spelling is rewritten before comparing.
 *
 * Scoped to the one key on purpose. A blanket "normalise quotes" would also rewrite the lines that
 * quote the same branch name as plain ENGLISH — `line.marker.prepared.note` and
 * `establish.cleanup-branch-exists` — and those must keep their literal quotes. Rewriting them
 * would assert the wrong bytes and hide the drift these fixtures exist to catch. (Confirmed by
 * running this file under a forced win32 platform: the blanket form failed on exactly those lines.)
 * On POSIX every case is a no-op, so the pin still compares byte-for-byte there.
 */
const RENDERS_CLEANUP_BRANCH = "line.marker.interrupted-offer.note";

function expectedLineBytes(key: string, bytes: string): string {
  if (key !== RENDERS_CLEANUP_BRANCH) return bytes;
  return bytes.replaceAll(`'${CLEANUP_BRANCH}'`, renderedQuoted(CLEANUP_BRANCH));
}

test("sync-outcome agreement: every row renders byte-identical to its pre-refactor fixture", async () => {
  const plainTop = await makePlainTop();
  const localBoardTop = await makeLocalBoardTop();
  const remnantTop = await makeRemnantTop();
  try {
    const storyValid = syncOutcomeLine("line.marker.story.lost-race", {});
    const storyUnverifiable = syncOutcomeLine("line.marker.story.unverifiable", {});

    // (key, variant) → the CliError (envelope fixtures) or string (line fixtures) the TABLE
    // produces for the capture's representative params. The ff rows build through the
    // ffSwallowToError dispatcher so its routing is pinned along with the row bytes.
    const builders: Record<string, () => CliError | string> = {
      "ff.git-missing#default": () => ffSwallowToError("git-missing", INV),
      "ff.no-upstream.unpublished#default": () => ffSwallowToError("no-upstream", INV, localBoardTop.top),
      "ff.no-upstream.unlinked#default": () => ffSwallowToError("no-upstream", INV, plainTop.top),
      "ff.auth#default": () => ffSwallowToError("auth", INV),
      "ff.network#default": () => ffSwallowToError("network", INV),
      "ff.busy#default": () => ffSwallowToError("busy", INV),
      "ff.diverged#default": () => ffSwallowToError("diverged", INV),
      "ff.conflict#default": () => ffSwallowToError("conflict", INV),
      "ff.dirty#default": () => ffSwallowToError("dirty", INV),
      "ff.detached-head#default": () => ffSwallowToError("detached-head", INV),
      "ff.not-a-repo#default": () => ffSwallowToError("not-a-repo", INV),
      "ff.unclassified#default": () => ffSwallowToError("mystery-reason", INV),
      "establish.local-git-missing#default": () =>
        syncOutcomeError("establish.local-git-missing", {}),
      "establish.origin-unconfigured#default": () =>
        syncOutcomeError("establish.origin-unconfigured", { inv: INV }),
      "sync.local-board.remote-exists#default": () => syncOutcomeError("sync.local-board.remote-exists", { inv: INV }),
      "sync.local-board.unpublished#default": () => syncOutcomeError("sync.local-board.unpublished", { inv: INV }),
      "in-tree.sync-refusal#origin": () =>
        syncOutcomeError("in-tree.sync-refusal", { inv: INV, boardPath: BOARD_PATH, hasOrigin: true }),
      "in-tree.sync-refusal#no-origin": () =>
        syncOutcomeError("in-tree.sync-refusal", { inv: INV, boardPath: BOARD_PATH, hasOrigin: false }),
      "in-tree.show-incoming.no-basis#detached-head": () => showIncomingInTreeNoBasis(INV, "detached-head"),
      "in-tree.show-incoming.no-basis#no-upstream": () => showIncomingInTreeNoBasis(INV, "no-upstream"),
      "in-tree.show-incoming.no-basis#unusable-upstream": () =>
        showIncomingInTreeNoBasis(INV, "unusable-upstream", REF),
      "establish.behind-origin#default": () =>
        syncOutcomeError("establish.behind-origin", { inv: INV, branch: BRANCH, behind: BEHIND }),
      "establish.namespace-conflict.greenfield#default": () =>
        syncOutcomeError("establish.namespace-conflict.greenfield", { inv: INV, conflicts: CONFLICTING }),
      "establish.namespace-conflict.committed#default": () =>
        syncOutcomeError("establish.namespace-conflict.committed", { inv: INV, conflicts: CONFLICTING }),
      "establish.board-branch-mismatch#default": () => syncOutcomeError("establish.board-branch-mismatch", {}),
      "establish.detached-head.committed#default": () => syncOutcomeError("establish.detached-head.committed", { bundleDir: BUNDLE_DIR }),
      "establish.detached-head.marker#default": () => syncOutcomeError("establish.detached-head.marker", { inv: INV, bundleDir: BUNDLE_DIR }),
      "marker.shallow.refusal#default": () => syncOutcomeError("marker.shallow.refusal", { inv: INV, marker: MARKER }),
      "marker.lost-race.conflict#valid": () =>
        syncOutcomeError("marker.lost-race.conflict", { inv: INV, marker: MARKER, markerValid: true }),
      "marker.lost-race.conflict#unverifiable": () =>
        syncOutcomeError("marker.lost-race.conflict", { inv: INV, marker: MARKER, markerValid: false }),
      "marker.offline.refusal#default": () => syncOutcomeError("marker.offline.refusal", {}),
      "marker.tree-changed.conflict#default": () =>
        syncOutcomeError("marker.tree-changed.conflict", {
          inv: INV,
          branch: BRANCH,
          bundleDir: BUNDLE_DIR,
          snapshotTree: SNAPSHOT_TREE,
          currentTree: CURRENT_TREE,
        }),
      "marker.unavailable.tree#default": () => syncOutcomeError("marker.unavailable.tree", { marker: MARKER }),
      "marker.unavailable.commit.moved#default": () =>
        syncOutcomeError("marker.unavailable.commit.moved", { marker: MARKER }),
      "marker.unavailable.commit.changed#default": () =>
        syncOutcomeError("marker.unavailable.commit.changed", { marker: MARKER }),
      "window.pre-share#default": () => syncOutcomeError("window.pre-share", { top: plainTop.top, boardPath: BOARD_PATH }),
      "window.pre-share.no-origin#default": () =>
        syncOutcomeError("window.pre-share.no-origin", { top: plainTop.top, boardPath: BOARD_PATH }),
      "window.remnant#default": () => syncOutcomeError("window.remnant", { top: remnantTop.top, boardPath: BOARD_PATH }),
      "window.dual-board#default": () => syncOutcomeError("window.dual-board", { boardPath: BOARD_PATH }),
      "provision.foreign#default": () => syncOutcomeError("provision.foreign", { boardPath: BOARD_PATH, top: TOP }),
      "provision.foreign-checkout#default": () =>
        syncOutcomeError("provision.foreign-checkout", { boardPath: BOARD_PATH, top: TOP }),
      "provision.unrepairable#default": () =>
        syncOutcomeError("provision.unrepairable", { boardPath: BOARD_PATH, top: TOP }),
      "provision.wrong-branch#default": () =>
        syncOutcomeError("provision.wrong-branch", { boardPath: BOARD_PATH, top: TOP }),
      "line.in-tree.no-basis#detached-head": () => syncOutcomeLine("line.in-tree.no-basis", { reason: "detached-head" }),
      "line.in-tree.no-basis#no-upstream": () => syncOutcomeLine("line.in-tree.no-basis", { reason: "no-upstream" }),
      "line.in-tree.no-basis#unusable-upstream": () =>
        syncOutcomeLine("line.in-tree.no-basis", { reason: "unusable-upstream", ref: REF }),
      "line.window-note.landed#default": () => syncOutcomeLine("line.window-note.landed", { inv: INV, branch: BRANCH, bundleDir: BUNDLE_DIR }),
      "line.window-note.pending#default": () => syncOutcomeLine("line.window-note.pending", { inv: INV, bundleDir: BUNDLE_DIR }),
      "line.marker.story.lost-race#default": () => storyValid,
      "line.marker.story.unverifiable#default": () => storyUnverifiable,
      "line.marker.cleared.removed#default": () => syncOutcomeLine("line.marker.cleared.removed", { story: storyValid }),
      "line.marker.cleared.failed#default": () =>
        syncOutcomeLine("line.marker.cleared.failed", { story: storyUnverifiable, markerPath: MARKER_PATH }),
      "line.marker.lost-race.note#default": () => syncOutcomeLine("line.marker.lost-race.note", { story: storyValid }),
      "line.marker.lost-race.discard#default": () => syncOutcomeLine("line.marker.lost-race.discard", { inv: INV }),
      "line.marker.shallow.note#default": () => syncOutcomeLine("line.marker.shallow.note", { inv: INV }),
      "line.marker.interrupted-offer.note#default": () =>
        syncOutcomeLine("line.marker.interrupted-offer.note", { inv: INV, cleanupBranch: CLEANUP_BRANCH }),
      "line.marker.offline.note#default": () => syncOutcomeLine("line.marker.offline.note", { inv: INV }),
      "line.marker.prepared.note#default": () =>
        syncOutcomeLine("line.marker.prepared.note", { cleanupBranch: CLEANUP_BRANCH }),
      "line.home.first-contact#default": () => syncOutcomeLine("line.home.first-contact", { inv: INV }),
      "line.home.up-to-date#default": () => syncOutcomeLine("line.home.up-to-date", {}),
      "line.home.offline-note#default": () => syncOutcomeLine("line.home.offline-note", {}),
      "line.home.in-tree#default": () => syncOutcomeLine("line.home.in-tree", {}),
      "line.home.unpushed#n1": () => syncOutcomeLine("line.home.unpushed", { n: 1 }),
      "line.home.unpushed#n2": () => syncOutcomeLine("line.home.unpushed", { n: 2 }),
      "line.home.uncommitted#n1": () => syncOutcomeLine("line.home.uncommitted", { n: 1 }),
      "line.home.uncommitted#n2": () => syncOutcomeLine("line.home.uncommitted", { n: 2 }),
      "line.home.in-tree.unpushed#n1": () => syncOutcomeLine("line.home.in-tree.unpushed", { n: 1 }),
      "line.home.in-tree.unpushed#n2": () => syncOutcomeLine("line.home.in-tree.unpushed", { n: 2 }),
      "line.home.in-tree.uncommitted#n1": () => syncOutcomeLine("line.home.in-tree.uncommitted", { n: 1 }),
      "line.home.in-tree.uncommitted#n2": () => syncOutcomeLine("line.home.in-tree.uncommitted", { n: 2 }),
      "line.home.in-tree.pull-hint#n1": () => syncOutcomeLine("line.home.in-tree.pull-hint", { n: 1 }),
      "line.home.in-tree.pull-hint#n2": () => syncOutcomeLine("line.home.in-tree.pull-hint", { n: 2 }),
      // PR1 (sync-copy-unification): the remaining guidance sites become rows.
      "sync.full.no-upstream#default": () => syncOutcomeError("sync.full.no-upstream", { inv: INV }),
      "show-incoming.no-upstream#default": () => syncOutcomeError("show-incoming.no-upstream", { inv: INV }),
      "establish.on-board-branch#default": () => syncOutcomeError("establish.on-board-branch", {}),
      "establish.committed-dirty#default": () =>
        syncOutcomeError("establish.committed-dirty", { inv: INV, bundleDir: BUNDLE_DIR, rows: DIRTY_ROWS, total: DIRTY_ROWS.length }),
      "establish.cleanup-branch-exists#default": () =>
        syncOutcomeError("establish.cleanup-branch-exists", { cleanupBranch: CLEANUP_BRANCH }),
      "establish.local-branch-unrecognized#default": () =>
        syncOutcomeError("establish.local-branch-unrecognized", {}),
      "line.session-start.fetch-skipped#default": () =>
        syncOutcomeLine("line.session-start.fetch-skipped", { code: "RUNTIME", inv: INV }),
      "line.session-start.pull-skipped#default": () =>
        syncOutcomeLine("line.session-start.pull-skipped", { reason: "diverged", inv: INV }),
    };

    // CLOSED COVERAGE, both directions: every row has a fixture; every fixture has a row+builder.
    const fixtureKeys = new Set(FIXTURES.map((f) => f.key));
    for (const key of Object.keys(SYNC_OUTCOMES) as SyncOutcomeKey[]) {
      assert.ok(fixtureKeys.has(key), `error row without a fixture: ${key}`);
    }
    for (const key of Object.keys(SYNC_OUTCOME_LINES) as SyncOutcomeLineKey[]) {
      assert.ok(fixtureKeys.has(key), `line row without a fixture: ${key}`);
    }
    for (const f of FIXTURES) {
      assert.ok(
        f.key in SYNC_OUTCOMES || f.key in SYNC_OUTCOME_LINES,
        `fixture without a table row: ${f.key}`,
      );
      assert.ok(builders[`${f.key}#${f.variant}`], `fixture without a builder: ${f.key}#${f.variant}`);
    }

    // BYTE AGREEMENT: table output === pre-refactor fixture, per fixture.
    for (const f of FIXTURES) {
      const built = builders[`${f.key}#${f.variant}`]!();
      if (f.kind === "envelope") {
        assert.notEqual(typeof built, "string", `${f.key}#${f.variant}: expected a CliError`);
        if (process.platform === "win32" && f.key.startsWith("provision.")) {
          const rendered = renderErrorEnvelope(toEnvelope(built as CliError));
          assert.match(rendered, /Rename-Item -LiteralPath/, `${f.key}#${f.variant}: Windows move-aside remedy`);
          assert.match(rendered, /\.superbee\.bak/, `${f.key}#${f.variant}: backup destination`);
          continue;
        }
        assert.equal(
          renderErrorEnvelope(toEnvelope(built as CliError)),
          f.bytes,
          `rendered envelope drifted from the pre-refactor fixture: ${f.key}#${f.variant}`,
        );
      } else {
        assert.equal(typeof built, "string", `${f.key}#${f.variant}: expected a line string`);
        assert.equal(
          built,
          expectedLineBytes(f.key, f.bytes),
          `guidance line drifted from the pre-refactor fixture: ${f.key}#${f.variant}`,
        );
      }
    }

    // CROSS-SURFACE SHARING (window family): establish's remnant note and home's window line are
    // the SAME factory bytes sync's refusal carries — never a reworded copy.
    const remnantGuidance = boardWindowGuidance(remnantTop.top);
    assert.equal(remnantGuidance.state, "window-remnant");
    assert.equal(
      remnantGuidance.message,
      SYNC_OUTCOMES["window.remnant"].message({ top: remnantTop.top, boardPath: BOARD_PATH }),
      "establish's remnant window note must be the refusal factory's own message",
    );
    const refusal = preShareWindowError(plainTop.top, BOARD_PATH);
    const block = buildBoardBlock({ state: "window", line: refusal.message }, undefined, INV);
    assert.equal(
      block.firstContact,
      refusal.message,
      "home's window line must render the refusal's message verbatim (one-hop guidance)",
    );

    // Compatibility is selected-path behavior, not the default fixture shape: an existing
    // legacy bundle must still be named exactly as selected in operational guidance.
    const legacyRefusal = syncOutcomeError("in-tree.sync-refusal", {
      inv: INV,
      boardPath: "/repo/.agentstate-lite",
      hasOrigin: true,
    });
    assert.match(legacyRefusal.message, /\.agentstate-lite\//);
    assert.doesNotMatch(legacyRefusal.message, /\.superbee\//);

    const legacyRows = [
      syncOutcomeError("establish.committed-dirty", {
        inv: INV, bundleDir: ".agentstate-lite", rows: DIRTY_ROWS, total: DIRTY_ROWS.length,
      }).message,
      syncOutcomeError("establish.detached-head.committed", { bundleDir: ".agentstate-lite" }).message,
      syncOutcomeError("establish.detached-head.marker", { inv: INV, bundleDir: ".agentstate-lite" }).message,
      syncOutcomeError("marker.tree-changed.conflict", {
        inv: INV, branch: BRANCH, bundleDir: ".agentstate-lite",
        snapshotTree: SNAPSHOT_TREE, currentTree: CURRENT_TREE,
      }).message,
      syncOutcomeLine("line.window-note.landed", {
        inv: INV, branch: BRANCH, bundleDir: ".agentstate-lite",
      }),
      syncOutcomeLine("line.window-note.pending", { inv: INV, bundleDir: ".agentstate-lite" }),
    ];
    for (const message of legacyRows) {
      assert.match(message, /\.agentstate-lite\//);
      assert.doesNotMatch(message, /\.superbee\//);
    }
  } finally {
    await plainTop.cleanup();
    await localBoardTop.cleanup();
    await remnantTop.cleanup();
  }
});

test("permission-aware sharing adapter preserves the CliError contract and emits only locked projections", () => {
  const rows = [
    {
      name: "preflight access",
      error: new CliError("AUTH_REQUIRED", "denied", {
        details: { op: "fetch", best_effort: true, future: "preserved", sharing: { stale: true } },
        help: "original help",
        handled: true,
      }),
      context: { operation: "establish-preflight" as const },
      expected: {
        operation: "establish-preflight",
        remote_repository: "unknown",
        remote_board: "unknown",
        repository_creation: "external-if-absent",
        required_authority: "repository-read-or-visibility",
        local_work: "preserved",
        cause_certainty: "best-effort",
        possible_causes: ["url", "authentication", "visibility", "repository-read"],
      },
    },
    {
      name: "preflight network",
      error: new CliError("TRANSIENT", "offline", { details: { op: "fetch", retryable: true } }),
      context: { operation: "establish-preflight" as const },
      expected: {
        operation: "establish-preflight",
        remote_repository: "unknown",
        remote_board: "unknown",
        repository_creation: "external-if-absent",
        local_work: "preserved",
        cause_certainty: "best-effort",
        possible_causes: ["network"],
      },
    },
    {
      name: "create access",
      error: new CliError("AUTH_REQUIRED", "denied", { details: { op: "push", best_effort: true } }),
      context: { operation: "create-board" as const, remote_board: "absent-confirmed" as const },
      expected: {
        operation: "create-board",
        remote_repository: "exists-confirmed",
        remote_board: "absent-confirmed",
        repository_creation: "irrelevant",
        required_authority: "repository-write-and-board-create-policy",
        local_work: "preserved",
        cause_certainty: "best-effort",
        possible_causes: ["authentication", "repository-write", "branch-policy"],
      },
    },
    {
      name: "create provider-neutral rejection",
      error: new CliError("RUNTIME", "rejected", {
        details: { op: "push", reason: "remote-rejected", best_effort: true },
      }),
      context: { operation: "create-board" as const, remote_board: "absent-confirmed" as const },
      expected: {
        operation: "create-board",
        remote_repository: "exists-confirmed",
        remote_board: "absent-confirmed",
        repository_creation: "irrelevant",
        required_authority: "repository-write-and-board-create-policy",
        local_work: "preserved",
        cause_certainty: "best-effort",
        possible_causes: ["repository-write", "branch-policy"],
      },
    },
    {
      name: "create transport uncertainty",
      error: new CliError("TRANSIENT", "offline", { details: { op: "push", retryable: true } }),
      context: { operation: "create-board" as const, remote_board: "unknown" as const },
      expected: {
        operation: "create-board",
        remote_repository: "exists-confirmed",
        remote_board: "unknown",
        repository_creation: "irrelevant",
        local_work: "preserved",
        cause_certainty: "best-effort",
        possible_causes: ["network"],
      },
    },
    {
      name: "update access",
      error: new CliError("AUTH_REQUIRED", "denied", { details: { op: "push", best_effort: true } }),
      context: { operation: "update-board" as const },
      expected: {
        operation: "update-board",
        remote_repository: "exists-confirmed",
        remote_board: "exists-confirmed",
        repository_creation: "irrelevant",
        required_authority: "repository-write-and-board-update-policy",
        local_work: "committed",
        cause_certainty: "best-effort",
        possible_causes: ["authentication", "repository-write", "branch-policy"],
      },
    },
    {
      name: "update provider-neutral rejection",
      error: new CliError("RUNTIME", "rejected", {
        details: { op: "push", reason: "remote-rejected", best_effort: true },
      }),
      context: { operation: "update-board" as const },
      expected: {
        operation: "update-board",
        remote_repository: "exists-confirmed",
        remote_board: "exists-confirmed",
        repository_creation: "irrelevant",
        required_authority: "repository-write-and-board-update-policy",
        local_work: "committed",
        cause_certainty: "best-effort",
        possible_causes: ["repository-write", "branch-policy"],
      },
    },
    {
      name: "update network",
      error: new CliError("TRANSIENT", "offline", { details: { op: "push", retryable: true } }),
      context: { operation: "update-board" as const },
      expected: {
        operation: "update-board",
        remote_repository: "exists-confirmed",
        remote_board: "exists-confirmed",
        repository_creation: "irrelevant",
        local_work: "committed",
        cause_certainty: "best-effort",
        possible_causes: ["network"],
      },
    },
    {
      name: "update race",
      error: new CliError("TRANSIENT", "raced", {
        details: { op: "push", retryable: true, reason: "non-fast-forward" },
      }),
      context: { operation: "update-board" as const },
      expected: {
        operation: "update-board",
        remote_repository: "exists-confirmed",
        remote_board: "exists-confirmed",
        repository_creation: "irrelevant",
        local_work: "committed",
      },
    },
  ];

  for (const row of rows) {
    const mapped = withSharingDetails(row.error, row.context);
    assert.notStrictEqual(mapped, row.error, row.name);
    assert.equal(mapped.code, row.error.code, row.name);
    assert.equal(mapped.exitCode, row.error.exitCode, row.name);
    assert.equal(mapped.handled, row.error.handled, row.name);
    assert.equal(mapped.message, row.error.message, row.name);
    assert.equal(mapped.help, row.error.help, row.name);
    assert.equal(mapped.details?.op, row.error.details?.op, row.name);
    assert.equal(mapped.details?.future, row.error.details?.future, row.name);
    assert.deepEqual(mapped.details?.sharing, row.expected, row.name);
    assert.deepEqual(Object.keys(mapped.details?.sharing as object), Object.keys(row.expected), row.name);
    assert.notEqual((mapped.details?.sharing as { remote_repository: string }).remote_repository, "absent-confirmed", row.name);
    const sharing = mapped.details?.sharing as { cause_certainty?: string; possible_causes?: string[] };
    assert.equal(sharing.cause_certainty === undefined, sharing.possible_causes === undefined, row.name);
  }
});

test("establishment preflight copy stops at diagnosis while repository and board state remain unknown", () => {
  const rows = [
    {
      error: new CliError("AUTH_REQUIRED", "denied", { details: { op: "fetch", best_effort: true } }),
      diagnosis: "verify the exact 'origin' URL, active HTTPS/SSH identity, repository visibility, and repository Read access",
    },
    {
      error: new CliError("TRANSIENT", "offline", { details: { op: "fetch", retryable: true } }),
      diagnosis: "verify the network and exact 'origin' URL",
    },
  ];

  for (const row of rows) {
    const mapped = withSharingDetails(row.error, { operation: "establish-preflight" }, INV);
    assert.equal(
      mapped.help,
      `${row.diagnosis}; after access is restored, confirm the repository is visible and determine ` +
        "whether origin/board exists before choosing a sharing action",
    );
    assert.doesNotMatch(`${mapped.message} ${mapped.help}`, /sync --establish|create (?:a|the|another|it) (?:remote )?repository/i);
  }
});
