// The bundle / private-state boundary. Every fixture derives its paths from
// `canonicalUserStateDir` / `legacyUserStateDir` — the state root's NAME is a single constant in
// `user-state.ts`, and a test that only passes for one spelling of it would mean the name had
// leaked into the design.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  HOME_LEAF,
  PUBLIC_LEAVES,
  type CliLeafSpec,
  type CliPathRole,
} from "../src/command-spec.js";
import {
  assertBundleOutsidePrivateState,
  assertPathOutsidePrivateState,
  guardedStateRoots,
  relateToPrivateState,
  type PrivateStateRelation,
} from "../src/private-state-bundle-boundary.js";
import { boundaryFixture, runCli, type BoundaryFixture } from "./support/private-state-fixtures.js";
import { syncExportsRoot } from "../src/cursor.js";
import {
  canonicalUserStateDir,
  ensureUserStateRoot,
  legacyUserStateDir,
  supersededUserStateDirs,
  USER_STATE_MARKER_BYTES,
  USER_STATE_MARKER_FILE_NAME,
} from "../src/user-state.js";

const CLI = fileURLToPath(new URL("../dist/superbee.mjs", import.meta.url));

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "superbee-state-bundle-boundary-"));
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      ASLITE_NO_UPDATE_CHECK: "1",
      AGENTSTATE_LITE_NO_AUTOPULL: "1",
      ...env,
    },
    encoding: "utf8",
  });
}

function git(cwd: string, args: string[]): ReturnType<typeof spawnSync> {
  const result = run("git", args, cwd);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

/** Rewrite a path's FINAL segment to a different ASCII case, derived — never a hardcoded name. */
function caseVariantOf(target: string): string {
  const base = path.basename(target);
  const flipped = base === base.toUpperCase() ? base.toLowerCase() : base.toUpperCase();
  assert.notEqual(flipped, base, "the derived fixture needs a case-bearing final segment");
  return path.join(path.dirname(target), flipped);
}

/** True when the volume folds case, i.e. the two spellings name ONE directory. */
function foldsCase(left: string, right: string): boolean {
  try {
    return statSync(left).ino === statSync(right).ino;
  } catch {
    return false;
  }
}

// ── The relation truth table ──────────────────────────────────────────────────
//
// Direction matters: `bundle-contains-state` and `bundle-inside-state` differ only in their
// message, so a swapped pair passes any test that merely checks "it threw". Every row below pins
// the relation VALUE.

function withHome<T>(body: (home: string, root: string) => T): T {
  const root = scratch();
  try {
    const home = path.join(root, "home");
    mkdirSync(home, { recursive: true });
    return body(home, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("truth table — BOTH the bundle and the state root exist", async () => {
  const root = scratch();
  try {
    const home = path.join(root, "home");
    mkdirSync(home, { recursive: true });
    const state = await ensureUserStateRoot(home);
    const rows: Array<[string, PrivateStateRelation]> = [
      [state, "identical"],
      [home, "bundle-contains-state"],
      [path.dirname(home), "bundle-contains-state"],
      [path.join(root, "project", ".superbee"), "unrelated"],
    ];
    mkdirSync(path.join(root, "project", ".superbee"), { recursive: true });
    mkdirSync(path.join(state, "sub"), { recursive: true });
    rows.push([path.join(state, "sub"), "bundle-inside-state"]);
    for (const [candidate, expected] of rows) {
      assert.equal(relateToPrivateState(candidate, state), expected, candidate);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("truth table — the state root does NOT exist (the first-run fixture)", () => {
  withHome((home, root) => {
    const state = canonicalUserStateDir(home);
    assert.equal(existsSync(state), false, "this row exists to catch the first-run brick");

    // THE regression that the `missing is empty` guards exist for: on a machine that has never run
    // superbee, an absent state root collapses onto $HOME. Without those guards every project
    // bundle under $HOME reads as a descendant of private state and every command refuses.
    const project = path.join(home, "projects", "demo", ".superbee");
    mkdirSync(project, { recursive: true });
    assert.equal(relateToPrivateState(project, state), "unrelated");
    assert.equal(relateToPrivateState(path.join(root, "elsewhere", ".superbee"), state), "unrelated");

    // Still exact where it matters, with the root absent.
    assert.equal(relateToPrivateState(home, state), "bundle-contains-state");
    assert.equal(relateToPrivateState(state, state), "identical");
    assert.equal(relateToPrivateState(path.join(state, "sub"), state), "bundle-inside-state");
  });
});

test("truth table — BOTH missing: identity folds to the portable equivalence class", () => {
  withHome((home) => {
    const state = canonicalUserStateDir(home);
    const variant = caseVariantOf(state);
    assert.equal(existsSync(state), false);
    assert.equal(relateToPrivateState(variant, state), "identical");
    assert.equal(relateToPrivateState(path.join(variant, "sub"), state), "bundle-inside-state");
    assert.equal(relateToPrivateState(path.join(home, "unrelated-name"), state), "unrelated");
    assert.equal(existsSync(state), false, "classification never creates anything");
  });
});

test("truth table — Unicode normalization form is not a bypass", () => {
  const root = scratch();
  try {
    // A MISSING non-ASCII ancestor makes NFC/NFD a real distinction in the folded tail. The fold is
    // what closes it; nothing here depends on the state root's own name.
    const composed = "cafe\u0301".normalize("NFC");
    const decomposed = composed.normalize("NFD");
    assert.notEqual(composed, decomposed, "the fixture needs two distinct byte sequences");
    const nfc = path.join(root, composed);
    const nfd = path.join(root, decomposed);

    assert.equal(relateToPrivateState(canonicalUserStateDir(nfd), canonicalUserStateDir(nfc)), "identical");
    assert.equal(relateToPrivateState(nfd, canonicalUserStateDir(nfc)), "bundle-contains-state");
    assert.equal(relateToPrivateState(path.join(root, "other"), canonicalUserStateDir(nfc)), "unrelated");

    // Once the ancestor EXISTS, identity is settled exactly by inode: on a normalization-folding
    // volume both spellings open one directory; on a byte-exact volume they are two directories and
    // `unrelated` is the correct answer, not an over-refusal.
    mkdirSync(nfc, { recursive: true });
    const state = canonicalUserStateDir(nfc);
    mkdirSync(state, { recursive: true });
    assert.equal(
      relateToPrivateState(canonicalUserStateDir(nfd), state),
      foldsCase(nfd, nfc) ? "identical" : "unrelated",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("truth table — a symlinked ancestor cannot alias across the boundary", () => {
  const root = scratch();
  try {
    const home = path.join(root, "home");
    const bundle = path.join(root, "project", ".superbee");
    mkdirSync(bundle, { recursive: true });
    mkdirSync(home, { recursive: true });
    const state = canonicalUserStateDir(home);

    // The state root IS the bundle, reached under a different name.
    symlinkSync(bundle, state, "dir");
    assert.equal(relateToPrivateState(bundle, state), "identical");
    assert.equal(relateToPrivateState(path.join(bundle, "sub"), state), "bundle-inside-state");
    assert.equal(relateToPrivateState(path.dirname(bundle), state), "bundle-contains-state");
    unlinkSync(state);

    // A DANGLING alias still declares where the path will land once created, so a state-root alias
    // cannot quietly become a bundle later.
    const future = path.join(root, "future-project", ".superbee");
    mkdirSync(path.dirname(future), { recursive: true });
    symlinkSync(future, state, "dir");
    assert.equal(relateToPrivateState(future, state), "identical");
    assert.equal(existsSync(future), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("truth table — a REGULAR FILE at the state-root path classifies, never raises RUNTIME", () => {
  withHome((home, root) => {
    const state = canonicalUserStateDir(home);
    writeFileSync(state, "not a directory\n");

    assert.equal(relateToPrivateState(state, state), "identical");
    // ENOTDIR must walk up exactly like ENOENT — without that arm this is a RUNTIME failure
    // instead of the CONFLICT it actually is.
    assert.equal(relateToPrivateState(path.join(state, "sub"), state), "bundle-inside-state");
    assert.equal(relateToPrivateState(home, state), "bundle-contains-state");

    mkdirSync(path.join(root, "project", ".superbee"), { recursive: true });
    assert.equal(relateToPrivateState(path.join(root, "project", ".superbee"), state), "unrelated");
  });
});

test("truth table — relative and non-normalized spellings resolve to the same verdict", () => {
  withHome((home) => {
    const state = canonicalUserStateDir(home);
    assert.equal(relateToPrivateState(`${state}${path.sep}.${path.sep}sub${path.sep}..`, state), "identical");
    assert.equal(relateToPrivateState(path.join(state, "a", "..", "b"), state), "bundle-inside-state");
  });
});

// ── The guarded root set ──────────────────────────────────────────────────────

test("every guarded root is enforced unconditionally, canonical first and deduplicated", () => {
  withHome((home) => {
    const roots = guardedStateRoots(home);
    assert.deepEqual(
      roots,
      [canonicalUserStateDir(home), legacyUserStateDir(home), ...supersededUserStateDirs(home)],
      "canonical first, then every root that is still a migration source",
    );
    assert.equal(new Set(roots).size, roots.length, "the set is deduplicated");
    for (const root of roots) {
      assert.throws(() => assertBundleOutsidePrivateState(root, home), /cannot be used as an OKF bundle/, root);
      assert.throws(() => assertBundleOutsidePrivateState(path.join(root, "sub"), home), /cannot live inside/, root);
      assert.throws(() => assertPathOutsidePrivateState(path.join(root, "state.json"), home), /private user-state/, root);
    }
    // $HOME encloses every guarded root, so it can never itself be a bundle.
    assert.throws(() => assertBundleOutsidePrivateState(home, home), /cannot enclose/);
  });
});

test("coordinates must be absolute, and a bundle beside the roots stays usable", () => {
  withHome((home, root) => {
    assert.throws(() => canonicalUserStateDir(""), /must be an absolute path/);
    assert.throws(() => legacyUserStateDir(""), /must be an absolute path/);
    const bundle = path.join(root, "project", ".superbee");
    mkdirSync(bundle, { recursive: true });
    assert.doesNotThrow(() => assertBundleOutsidePrivateState(bundle, home));
    assert.doesNotThrow(() => assertPathOutsidePrivateState(path.join(bundle, "out.md"), home));
  });
});

test("a refusal that breaks a working configuration carries a move-out exit node", () => {
  withHome((home) => {
    assert.throws(
      () => assertBundleOutsidePrivateState(home, home),
      (error: unknown) => {
        const help = (error as { details?: unknown; help?: string }).help ?? "";
        assert.match(help, /mkdir -p/, "the user has to be told how to move the bundle out");
        assert.match(help, /init --create-only --dir \.superbee/);
        return true;
      },
    );
  });
});

// ── Crossing points, through the BUILT CLI ────────────────────────────────────

test("built init refuses the private state root before creating bundle bytes", () => {
  withHome((home, root) => {
    const stateRoot = canonicalUserStateDir(home);
    for (const extra of [[], ["--create-only"]]) {
      const result = run(process.execPath, [CLI, "init", ...extra, "--dir", stateRoot, "--json"], root, { HOME: home });
      assert.equal(result.status, 5, result.stderr || result.stdout);
      assert.match(result.stdout, /private user-state directory cannot be used as an OKF bundle/);
      assert.equal(existsSync(stateRoot), false);
    }
  });
});

test("built init refuses a missing portable case variant before creating bundle bytes", () => {
  withHome((home, root) => {
    const caseVariant = caseVariantOf(canonicalUserStateDir(home));
    for (const extra of [[], ["--create-only"]]) {
      const result = run(process.execPath, [CLI, "init", ...extra, "--dir", caseVariant, "--json"], root, { HOME: home });
      assert.equal(result.status, 5, result.stderr || result.stdout);
      assert.match(result.stdout, /private user-state directory cannot be used as an OKF bundle/);
      assert.equal(existsSync(caseVariant), false);
      assert.equal(existsSync(canonicalUserStateDir(home)), false);
    }
  });
});

test("a different spelling of an EXISTING state root is refused (the shipped case bypass)", async () => {
  const root = scratch();
  try {
    const home = path.join(root, "home");
    mkdirSync(home, { recursive: true });
    const stateRoot = await ensureUserStateRoot(home);
    const variant = caseVariantOf(stateRoot);

    if (foldsCase(variant, stateRoot)) {
      // Case-folding volume (macOS default): the two spellings are ONE directory. This is exactly
      // what shipped broken — the identity check resolved both coordinates, saw two different
      // strings, and allowed it. Only inode identity closes it.
      assert.equal(relateToPrivateState(variant, stateRoot), "identical");
      for (const extra of [[], ["--create-only"]]) {
        const result = run(process.execPath, [CLI, "init", ...extra, "--dir", variant, "--json"], root, { HOME: home });
        assert.equal(result.status, 5, result.stderr || result.stdout);
        assert.match(result.stdout, /private user-state directory cannot be used as an OKF bundle/);
      }
    } else {
      // Case-sensitive volume: the variant is a genuinely different directory and a bundle there is
      // harmless. Pin the VALUE so this cell cannot silently drift into either error.
      assert.equal(relateToPrivateState(variant, stateRoot), "unrelated");
    }

    // Deterministic on every volume: a second NAME that resolves to the existing root is refused.
    const alias = path.join(root, "alias");
    symlinkSync(stateRoot, alias, "dir");
    assert.equal(relateToPrivateState(alias, stateRoot), "identical");
    const aliased = run(process.execPath, [CLI, "init", "--dir", alias, "--json"], root, { HOME: home });
    assert.equal(aliased.status, 5, aliased.stderr || aliased.stdout);
    assert.match(aliased.stdout, /private user-state directory cannot be used as an OKF bundle/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit bundle selection preserves the path-free private-state conflict", async () => {
  const root = scratch();
  try {
    const home = path.join(root, "home");
    mkdirSync(home, { recursive: true });
    const stateRoot = await ensureUserStateRoot(home);
    const result = run(process.execPath, [CLI, "bundle", "locate", "--dir", stateRoot, "--json"], root, { HOME: home });
    assert.equal(result.status, 5, result.stderr || result.stdout);
    assert.match(result.stdout, /private user-state directory cannot be used as an OKF bundle/);
    assert.doesNotMatch(result.stdout, /NOT_FOUND|init --create-only/);
    assert.equal(result.stdout.includes(stateRoot), false, "the private coordinate never enters the envelope");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync publication refuses a physical alias of private state", () => {
  const root = scratch();
  try {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const remote = path.join(root, "remote.git");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    git(project, ["init", "-b", "main"]);
    git(project, ["config", "user.name", "Boundary Test"]);
    git(project, ["config", "user.email", "boundary@example.invalid"]);
    git(root, ["init", "--bare", remote]);
    git(project, ["remote", "add", "origin", remote]);

    const initialized = run(process.execPath, [CLI, "init", "--create-only", "--dir", ".superbee", "--json"], project, { HOME: home });
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    git(project, ["commit", "--allow-empty", "-m", "initialize project"]);

    symlinkSync(path.join(project, ".superbee"), canonicalUserStateDir(home), "dir");
    const result = run(process.execPath, [CLI, "sync", "--establish", "--json"], project, { HOME: home });
    assert.equal(result.status, 5, result.stderr || result.stdout);
    assert.match(result.stdout, /private user-state directory cannot be used as an OKF bundle/);
    const board = run("git", ["--git-dir", remote, "show-ref", "--verify", "refs/heads/board"], root);
    assert.notEqual(board.status, 0, "the harm-boundary refusal must occur before board publication");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── THE crossing-point table ──────────────────────────────────────────────────
//
// This is the table section 9 of the boundary specification points at. Its required rows are
// ENUMERATED FROM THE REGISTRY (`CliLeafSpec.pathFlags` / `pathPositionals`, proved against the
// shipped parser by `cli-path-surface.test.ts`), not hand-kept: a new path-accepting command fails
// the coverage assertion below until someone adds its row. Four review rounds each missed a
// different member of this class because the list was maintained by hand.
//
// Adding a row: `[leaf, surface, argv]` using a COMPLETE VALID invocation. The runner supplies the
// guarded target from the surface's declared role and re-runs the SAME argv against a benign
// target, so a row whose invocation is incomplete fails on the control instead of passing
// vacuously (the specification's F6).

type CrossingExpectation = number | "no-refusal" | "usage-rejected";

interface CrossingRow {
  /** Leaf id from the registry. */
  readonly leaf: string;
  /** `--<flag>` or `<n>` for the nth positional — the declared path surface this row exercises. */
  readonly surface: string;
  /** A COMPLETE VALID invocation with the row's own path token substituted. */
  readonly argv?: (target: string) => string[];
  /** Benign target override; the default follows the surface's role. */
  readonly control?: (fixture: BoundaryFixture) => string;
  /** Expected exit for the guarded target. Default: CONFLICT (5). */
  readonly expect?: CrossingExpectation;
  /** Where this leaf writes its envelope. Default: stdout (AXI errors-on-stdout). */
  readonly channel?: "stdout" | "stderr";
  /** Expected exit for the benign target. Default: 0. */
  readonly controlExit?: number;
  /** Why this row's control run is not executed. Never omit the reason. */
  readonly controlSkip?: string;
  /** Why this row is not executed at all. Never omit the reason. */
  readonly skip?: string;
}

const BOUNDARY_MESSAGE = /private user-state directory/;

function surfaceRole(leaf: CliLeafSpec, surface: string): CliPathRole {
  if (surface.startsWith("--")) {
    const flag = leaf.pathFlags.find((entry) => `--${entry.flag}` === surface);
    assert.ok(flag, `${leaf.path} does not declare ${surface}`);
    return flag!.role;
  }
  const index = Number(surface.replace(/[<>]/g, ""));
  const positional = leaf.pathPositionals.find((entry) => entry.index === index);
  assert.ok(positional, `${leaf.path} does not declare positional ${surface}`);
  return positional!.role;
}

/** Every (leaf, path surface) pair the registry knows about — the table's required row set. */
function requiredCrossingKeys(): string[] {
  return [...PUBLIC_LEAVES, HOME_LEAF].flatMap((leaf) => [
    ...leaf.pathFlags.map((entry) => `${leaf.id} --${entry.flag}`),
    ...leaf.pathPositionals.map((entry) => `${leaf.id} <${entry.index}>`),
  ]);
}

function slug(key: string): string {
  return key.replace(/[^a-z0-9]+/gi, "-");
}

function guardedTarget(role: CliPathRole, fixture: BoundaryFixture, key: string): string {
  if (role === "ingress") return fixture.credential;
  // The guarded destination is NESTED under a directory that does not exist: F3 requires the
  // refusal to land before any parent is created, and the post-condition below proves none was.
  if (role === "egress") return path.join(fixture.stateRoot, "deep", `${slug(key)}.md`);
  return fixture.stateRoot;
}

function benignTarget(role: CliPathRole, fixture: BoundaryFixture, key: string): string {
  if (role === "ingress") return fixture.ordinaryFile;
  // Flat, because an ordinary `--out` does not create missing parents.
  if (role === "egress") return path.join(fixture.outside, `${slug(key)}.md`);
  return ".superbee";
}

const CROSSING_ROWS: readonly CrossingRow[] = [
  // ── Bundle roots (`--dir`): the target BECOMES the bundle. ──────────────────
  { leaf: "bundleLocate", surface: "--dir", argv: (t) => ["bundle", "locate", "--dir", t, "--json"] },
  { leaf: "catalogAdd", surface: "--dir", argv: (t) => ["catalog", "add", "probe-label", "--dir", t, "--json"] },
  {
    leaf: "init",
    surface: "--dir",
    argv: (t) => ["init", "--create-only", "--dir", t, "--json"],
    control: (f) => path.join(f.outside, "fresh-bundle"),
  },
  { leaf: "indexGenerate", surface: "--dir", argv: (t) => ["index", "generate", "--dir", t, "--json"] },
  { leaf: "status", surface: "--dir", argv: (t) => ["status", "--dir", t, "--json"] },
  { leaf: "docWrite", surface: "--dir", argv: (t) => ["doc", "write", "probe/dw", "--type", "Note", "--body", "x", "--dir", t, "--json"] },
  { leaf: "docUpdate", surface: "--dir", argv: (t) => ["doc", "update", "notes/a", "--title", "Probe", "--dir", t, "--json"] },
  { leaf: "docRead", surface: "--dir", argv: (t) => ["doc", "read", "notes/a", "--dir", t, "--json"] },
  {
    leaf: "docOpen",
    surface: "--dir",
    skip: "the control invocation boots the loopback UI host; `doc open` resolves --dir through the same "
      + "resolveLocalBundleTarget authority every executed row above exercises",
  },
  { leaf: "docHistory", surface: "--dir", argv: (t) => ["doc", "history", "notes/a", "--dir", t, "--json"] },
  { leaf: "docDelete", surface: "--dir", argv: (t) => ["doc", "delete", "probe/absent", "--dir", t, "--json"] },
  { leaf: "list", surface: "--dir", argv: (t) => ["list", "--dir", t, "--json"] },
  { leaf: "query", surface: "--dir", argv: (t) => ["query", "--dir", t, "--json"] },
  { leaf: "linkAdd", surface: "--dir", argv: (t) => ["link", "add", "notes/a", "notes/b", "--dir", t, "--json"] },
  { leaf: "linkShow", surface: "--dir", argv: (t) => ["link", "show", "notes/a", "--dir", t, "--json"] },
  { leaf: "linkList", surface: "--dir", argv: (t) => ["link", "list", "--dir", t, "--json"] },
  {
    leaf: "artifactCreate",
    surface: "--dir",
    argv: (t) => ["artifact", "create", "ordinary.html", "--title", "Probe", "--dir", t, "--json"],
  },
  { leaf: "promote", surface: "--dir", argv: (t) => ["promote", "ordinary.md", "--doc-key", "probe/p.bin", "--dir", t, "--json"] },
  { leaf: "pull", surface: "--dir", argv: (t) => ["pull", "--doc-key", "notes/a.md", "--out", "-", "--dir", t, "--json"] },
  { leaf: "blobs", surface: "--dir", argv: (t) => ["blobs", "--dir", t, "--json"] },
  { leaf: "delete", surface: "--dir", argv: (t) => ["delete", "--doc-key", "probe/absent.bin", "--dir", t, "--json"] },
  { leaf: "new", surface: "--dir", argv: (t) => ["new", "Context Note", "probe-new", "--title", "Probe", "--dir", t, "--json"] },
  { leaf: "kinds", surface: "--dir", argv: (t) => ["kinds", "--dir", t, "--json"] },
  { leaf: "kindFieldAdd", surface: "--dir", argv: (t) => ["kind", "field", "Context Note", "add", "probe_field", "--dir", t, "--json"] },
  { leaf: "kindFieldRemove", surface: "--dir", argv: (t) => ["kind", "field", "Context Note", "remove", "probe_field", "--dir", t, "--json"] },
  { leaf: "recipes", surface: "--dir", argv: (t) => ["recipes", "--dir", t, "--json"] },
  { leaf: "recipeAdd", surface: "--dir", argv: (t) => ["recipe", "add", "work-tracking", "--dir", t, "--json"] },
  {
    leaf: "serve",
    surface: "--dir",
    argv: (t) => ["serve", "--dir", t, "--port", "0"],
    controlSkip: "the control would boot a long-lived reference server; the refusal above still proves the "
      + "boundary check runs before any listener and is not a USAGE error",
  },
  {
    leaf: "ui",
    surface: "--dir",
    argv: (t) => ["ui", "--dir", t, "--port", "0"],
    controlSkip: "the control would boot the long-lived loopback UI host",
  },
  {
    leaf: "mcp",
    surface: "--dir",
    argv: (t) => ["mcp", "--dir", t],
    // stdout is the JSON-RPC transport, so mcp's envelopes go to STDERR by design.
    channel: "stderr",
    controlSkip: "the control would hold a long-lived stdio JSON-RPC session open",
  },
  { leaf: "viewList", surface: "--dir", argv: (t) => ["view", "list", "--dir", t, "--json"] },
  {
    // Sync never resolves a bundle through `resolveLocalBundleTarget`, so its run directory answers
    // to the relation at sync's own resolution point (orchestrate.ts, before retargeting or any git
    // probe). It used to exit 0 with `nothing to sync` — absence where the answer is the conflict.
    leaf: "sync",
    surface: "--dir",
    argv: (t) => ["sync", "--dir", t, "--json"],
  },
  {
    // session-start is the SessionStart hook payload: like `home` below it must not exit nonzero,
    // so the row pins exit 0 PLUS the boundary message — the same conflict `home --dir` reports,
    // through the same render. It used to report `no OKF bundle found` and emit an
    // `init --create-only --dir <guarded root>/.superbee` hint pointing INSIDE private state.
    leaf: "sessionStart",
    surface: "--dir",
    argv: (t) => ["session-start", "--dir", t, "--no-update-check"],
    expect: 0,
  },
  {
    // `home` is the session render: it consults the guard, reports `bundle.status: conflict` with the
    // boundary help, and performs no bundle operation. Degrading rather than exiting non-zero is
    // deliberate here (a hard failure would break the SessionStart payload), so the row pins exit 0
    // PLUS the boundary message — losing either half is a regression.
    leaf: "home",
    surface: "--dir",
    argv: (t) => ["home", "--dir", t, "--json"],
    expect: 0,
  },

  // ── `--dir` parsed by the shared selector config, then REJECTED before it can be a target. ──
  {
    leaf: "catalogList",
    surface: "--dir",
    argv: (t) => ["catalog", "list", "--dir", t, "--json"],
    expect: "usage-rejected",
  },
  {
    leaf: "catalogResolve",
    surface: "--dir",
    argv: (t) => ["catalog", "resolve", "probe-label", "--dir", t, "--json"],
    expect: "usage-rejected",
  },

  // ── Ingress: the target's BYTES are read. ───────────────────────────────────
  { leaf: "docWrite", surface: "--body-file", argv: (t) => ["doc", "write", "probe/bf", "--type", "Note", "--body-file", t, "--dir", ".superbee", "--json"] },
  { leaf: "docUpdate", surface: "--body-file", argv: (t) => ["doc", "update", "notes/b", "--body-file", t, "--dir", ".superbee", "--json"] },
  { leaf: "new", surface: "--body-file", argv: (t) => ["new", "Context Note", "probe-bf", "--title", "Probe", "--body-file", t, "--dir", ".superbee", "--json"] },
  { leaf: "promote", surface: "<0>", argv: (t) => ["promote", t, "--doc-key", "probe/leak.json", "--dir", ".superbee", "--json"] },
  { leaf: "artifactCreate", surface: "<0>", argv: (t) => ["artifact", "create", t, "--title", "Probe", "--dir", ".superbee", "--json"] },

  // ── Egress: the target is WRITTEN to. ───────────────────────────────────────
  { leaf: "docRead", surface: "--out", argv: (t) => ["doc", "read", "notes/a", "--out", t, "--dir", ".superbee", "--json"] },
  { leaf: "docRead", surface: "--body-out", argv: (t) => ["doc", "read", "notes/a", "--body-out", t, "--dir", ".superbee", "--json"] },
  { leaf: "docRead", surface: "--rendered-out", argv: (t) => ["doc", "read", "notes/a", "--rendered-out", t, "--dir", ".superbee", "--json"] },
  { leaf: "pull", surface: "--out", argv: (t) => ["pull", "--doc-key", "notes/a.md", "--out", t, "--dir", ".superbee", "--json"] },
  {
    leaf: "sync",
    surface: "--out",
    argv: (t) => ["sync", "--show-incoming", "notes/a", "--out", t, "--dir", ".superbee", "--json"],
    // The fixture project is not a git work tree, so the benign run reaches the command and then
    // fails for a git reason (RUNTIME) — which is all the control owes F6: parsing got that far.
    controlExit: 1,
  },

  // ── Recipe roots: deliberately NOT routed through the ingress guard. ────────
  {
    leaf: "init",
    surface: "--recipe",
    skip: "specification F11 / N7: a recipe ROOT answers to the recipe adapter's own containment "
      + "authority, not to this boundary. What actually protects it is that the recipe grammar's "
      + "filenames do not exist in private state — pinned by the guarded-root layout test below.",
  },
  {
    leaf: "recipeAdd",
    surface: "<0>",
    skip: "specification F11 / N7: see the `init --recipe` row.",
  },
];

async function runCrossingRow(fixture: BoundaryFixture, row: CrossingRow): Promise<void> {
  const leaf = [...PUBLIC_LEAVES, HOME_LEAF].find((candidate) => candidate.id === row.leaf);
  assert.ok(leaf, `unknown leaf id: ${row.leaf}`);
  const key = `${row.leaf} ${row.surface}`;
  const role = surfaceRole(leaf!, row.surface);
  const argv = row.argv;
  assert.ok(argv, `${key}: an executed row needs a complete valid invocation`);

  const refusal = runCli(argv!(guardedTarget(role, fixture, key)), { cwd: fixture.project, home: fixture.home });
  const envelope = row.channel === "stderr" ? refusal.stderr : refusal.stdout;
  if (row.expect === "usage-rejected") {
    // The flag never becomes a filesystem target because the command refuses it outright.
    assert.equal(refusal.status, 2, `${key}: ${refusal.stderr || refusal.stdout}`);
    assert.doesNotMatch(envelope, BOUNDARY_MESSAGE, key);
    return;
  }
  // F6, structurally: argument validation runs BEFORE the boundary check, so a USAGE exit means the
  // boundary was never consulted and the row proves nothing.
  assert.notEqual(refusal.status, 2, `${key}: the guarded invocation is incomplete (USAGE): ${refusal.stdout}`);
  if (row.expect === "no-refusal") {
    assert.notEqual(refusal.status, 5, `${key}: this surface must not refuse: ${refusal.stdout}`);
    assert.doesNotMatch(envelope, BOUNDARY_MESSAGE, key);
  } else {
    assert.equal(refusal.status, row.expect ?? 5, `${key}: ${refusal.stderr || refusal.stdout}`);
    assert.match(envelope, BOUNDARY_MESSAGE, key);
  }

  if (row.controlSkip) return;
  const control = runCli(argv!(row.control?.(fixture) ?? benignTarget(role, fixture, key)), {
    cwd: fixture.project,
    home: fixture.home,
  });
  assert.notEqual(control.status, 2, `${key}: the control invocation is incomplete (USAGE) — the row would pass vacuously: ${control.stdout}`);
  assert.equal(control.status, row.controlExit ?? 0, `${key} control: ${control.stderr || control.stdout}`);
}

test("every byte-channel crossing point refuses a private-state path", async (t) => {
  const fixture = await boundaryFixture();
  try {
    for (const row of CROSSING_ROWS) {
      const key = `${row.leaf} ${row.surface}`;
      await t.test(key, row.skip === undefined ? {} : { skip: row.skip }, async () => {
        await runCrossingRow(fixture, row);
      });
    }

    // No refused destination left residue, and no refused source positional reached the bundle.
    assert.equal(readFileSync(path.join(fixture.stateRoot, USER_STATE_MARKER_FILE_NAME), "utf8"), USER_STATE_MARKER_BYTES);
    assert.equal(statSync(path.join(fixture.stateRoot, USER_STATE_MARKER_FILE_NAME)).mode & 0o777, 0o600);
    assert.equal(existsSync(path.join(fixture.stateRoot, "deep")), false, "a refused --out created a parent directory");
    for (const entry of readdirSync(fixture.stateRoot)) {
      assert.doesNotMatch(entry, /\.md$/, `a refused --out destination created ${entry}`);
    }
    const listed = runCli(["list", "--dir", ".superbee", "--json"], { cwd: fixture.project, home: fixture.home });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.doesNotMatch(listed.stdout, /leak/, "no refused source positional reached the bundle");
    assert.equal(
      readFileSync(path.join(fixture.bundle, "notes", "a.md"), "utf8").includes("api_key"),
      false,
      "no private-state byte reached an existing document",
    );
  } finally {
    fixture.cleanup();
  }
});

test("the crossing-point table covers every path surface the registry declares", () => {
  const rows = CROSSING_ROWS.map((row) => `${row.leaf} ${row.surface}`);
  assert.deepEqual(
    [...new Set(rows)].sort(),
    [...new Set(requiredCrossingKeys())].sort(),
    "every declared path surface needs a row (add one — an omitted surface is exactly how four rounds "
    + "each missed a different crossing point); a row for an undeclared surface means the registry is stale",
  );
  assert.equal(rows.length, new Set(rows).size, "duplicate rows");
});

/**
 * The invariant the recipe non-inclusion (N7) actually rests on. Containment only stops the recipe
 * walk ESCAPING its root; what stops a recipe root that IS a guarded root is that the grammar's
 * filenames do not exist there. Nothing enforced that until this row.
 */
test("no guarded root's layout uses the recipe grammar's filenames", async () => {
  const root = scratch();
  try {
    const home = path.join(root, "home");
    mkdirSync(home, { recursive: true });
    const stateRoot = await ensureUserStateRoot(home);
    runCli(["catalog", "add", "probe", "--dir", ".", "--json"], { cwd: root, home });
    for (const guarded of guardedStateRoots(home)) {
      if (!existsSync(guarded)) continue;
      for (const entry of readdirSync(guarded, { withFileTypes: true })) {
        assert.notEqual(entry.name, "recipe.md", `${guarded} would be readable as a recipe root`);
        assert.notEqual(entry.name, "conventions", `${guarded} would be readable as a recipe root`);
      }
    }
    assert.ok(existsSync(stateRoot));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Target SHAPES at a crossing point ─────────────────────────────────────────
//
// The crossing-point table varies the COMMAND; these rows vary the TARGET's shape at a fixed
// command. They are separate rows rather than a second dimension of that table because what they
// pin is the verdict, not the guard's reach.

interface TargetShapeRow {
  readonly label: string;
  readonly argv: (fixture: BoundaryFixture) => string[];
  readonly expect: number;
  /** Does the refusal have to carry the boundary message? */
  readonly boundary: boolean;
  readonly skip?: string;
}

const TARGET_SHAPE_ROWS: readonly TargetShapeRow[] = [
  {
    // F7: a `--dir` naming a path inside a guarded root that does NOT exist yet.
    label: "F7 — an ABSENT path inside a guarded root, via init: CONFLICT",
    argv: (f) => ["init", "--create-only", "--dir", path.join(f.stateRoot, "nope"), "--json"],
    expect: 5,
    boundary: true,
  },
  {
    // The same path, asked by a read verb. This ANSWERED 6 while init answered 5, because existence
    // resolution ran before the boundary check — and the NOT_FOUND it produced echoed `--dir` back
    // as an `init --create-only` command pointing into private state. `resolveLocalBundleTarget`
    // now consults the relation BEFORE resolving existence, closing both halves at once.
    label: "F7 — the same absent path via `status`: CONFLICT, as init answers",
    argv: (f) => ["status", "--dir", path.join(f.stateRoot, "nope"), "--json"],
    expect: 5,
    boundary: true,
  },
  {
    label: "F7 — and via `list`, the same verdict",
    argv: (f) => ["list", "--dir", path.join(f.stateRoot, "nope"), "--json"],
    expect: 5,
    boundary: true,
  },
  {
    // D14: `bundle-contains-state` is meaningless for a single FILE target, so a destination that
    // ENCLOSES a guarded root is not a boundary refusal — it fails, if at all, for ordinary I/O
    // reasons and destroys nothing.
    label: "D14 — a single-FILE destination that ENCLOSES a guarded root is not a boundary refusal",
    argv: (f) => ["doc", "read", "notes/a", "--out", f.home, "--dir", ".superbee", "--json"],
    expect: 1,
    boundary: false,
  },
  {
    // A4's agreement claim, on a THIRD verb so it is not a copy of the F7 status row: what this
    // pins is that the verdict does not depend on which verb asks, not any one verb's exit code.
    label: "A4 — every verb returns the SAME verdict for the same absent path inside a guarded root",
    argv: (f) => ["doc", "read", "notes/a", "--dir", path.join(f.stateRoot, "nope"), "--json"],
    expect: 5,
    boundary: true,
  },
];

test("target shapes at a crossing point", async (t) => {
  const fixture = await boundaryFixture();
  try {
    for (const row of TARGET_SHAPE_ROWS) {
      await t.test(row.label, row.skip === undefined ? {} : { skip: row.skip }, () => {
        const result = runCli(row.argv(fixture), { cwd: fixture.project, home: fixture.home });
        assert.equal(result.status, row.expect, `${row.label}: ${result.stderr || result.stdout}`);
        if (row.boundary) assert.match(result.stdout, BOUNDARY_MESSAGE, row.label);
        else assert.doesNotMatch(result.stdout, BOUNDARY_MESSAGE, row.label);
      });
    }
    // Nothing was created, and the enclosing-destination row destroyed nothing.
    assert.equal(existsSync(path.join(fixture.stateRoot, "nope")), false);
    assert.equal(
      readFileSync(path.join(fixture.stateRoot, USER_STATE_MARKER_FILE_NAME), "utf8"),
      USER_STATE_MARKER_BYTES,
    );
  } finally {
    fixture.cleanup();
  }
});

// ── RESOLUTION PATHS ──────────────────────────────────────────────────────────
//
// The crossing-point table varies the COMMAND and the shape table varies the TARGET. These rows
// vary the ROUTE by which a guarded root becomes the resolved bundle. `--dir` is only one of three
// — the cwd discovery walk and a committed project binding are the others — and while every
// `--dir` row above refused, both of the others answered `no OKF bundle found` and offered an
// `init --create-only --dir .superbee` that resolves INSIDE the guarded root the caller is standing
// in. Same class, different route, and the route is what nobody enumerated.
//
// Each row asserts three things: the exit code, that the envelope names the boundary, and that NO
// `--dir` token anywhere in the output resolves inside a guarded root. That third assertion is the
// guidance half, which is a SEPARATE defect from the degradation: a command can report the conflict
// correctly and still hand back a next command that lands in private state.

/**
 * Every `--dir <target>` token in `text` that, resolved against the cwd it was emitted for, lands
 * in a guarded root. A RELATIVE hint is as dangerous as an absolute one — `--dir .superbee` read
 * from inside private state creates a bundle there — so resolution, not spelling, decides.
 */
function guardedDirHints(text: string, cwd: string, home: string): string[] {
  const roots = guardedStateRoots(home);
  const hits: string[] = [];
  for (const match of text.matchAll(/--dir\s+'?([^\s'"`,]+)/g)) {
    const token = match[1]!;
    // Only path-shaped tokens: `--dir <path>` placeholders and prose ("an explicit --dir wins")
    // are not emitted commands.
    if (!/^[~./]/.test(token) && !token.includes("/")) continue;
    const expanded = token.startsWith("~/") ? path.join(home, token.slice(2)) : token;
    const resolved = path.resolve(cwd, expanded);
    if (roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
      hits.push(`${token} -> ${resolved}`);
    }
  }
  return hits;
}

interface ResolutionRow {
  readonly label: string;
  /** Where the run happens. Default: the fixture project (an ordinary, unrelated cwd). */
  readonly cwd?: (fixture: BoundaryFixture) => string;
  /** A committed `.superbee.json` directory binding written at the cwd before the run. */
  readonly binding?: (fixture: BoundaryFixture) => string;
  readonly argv: readonly string[];
  /** Default CONFLICT (5); the two session renders report the conflict at exit 0. */
  readonly expect?: number;
  readonly skip?: string;
}

const RESOLUTION_ROWS: readonly ResolutionRow[] = [
  // ── Route 2: the cwd discovery walk. `findBundleRoot` is THE one place a "no bundle here"
  // verdict is reached, so it is the one place that verdict is denied to private state. ──
  { label: "cwd IS a guarded root — list", cwd: (f) => f.stateRoot, argv: ["list", "--json"] },
  { label: "cwd IS a guarded root — status", cwd: (f) => f.stateRoot, argv: ["status", "--json"] },
  { label: "cwd IS a guarded root — bundle locate", cwd: (f) => f.stateRoot, argv: ["bundle", "locate", "--json"] },
  { label: "cwd IS a guarded root — recipes", cwd: (f) => f.stateRoot, argv: ["recipes", "--json"] },
  { label: "cwd IS a guarded root — catalog add", cwd: (f) => f.stateRoot, argv: ["catalog", "add", "probe", "--json"] },
  { label: "cwd IS a guarded root — sync", cwd: (f) => f.stateRoot, argv: ["sync", "--json"] },
  { label: "cwd IS a guarded root — home reports it at exit 0", cwd: (f) => f.stateRoot, argv: ["home", "--json"], expect: 0 },
  {
    label: "cwd IS a guarded root — session-start reports it at exit 0",
    cwd: (f) => f.stateRoot,
    argv: ["session-start", "--json", "--no-update-check"],
    expect: 0,
  },
  {
    label: "cwd is INSIDE a guarded root — list",
    cwd: (f) => path.join(f.stateRoot, "sync"),
    argv: ["list", "--json"],
  },
  {
    label: "cwd is INSIDE a guarded root — home reports it at exit 0",
    cwd: (f) => path.join(f.stateRoot, "sync"),
    argv: ["home", "--json"],
    expect: 0,
  },

  // ── Route 3: a committed project binding. It is an exact declared boundary like `--dir`, and an
  // ABSENT target used to reach the same NOT_FOUND-plus-private-init-hint. ──
  { label: "a project binding naming a guarded root — list", binding: (f) => f.stateRoot, argv: ["list", "--json"] },
  {
    label: "a project binding naming an ABSENT path inside a guarded root — list",
    binding: (f) => path.join(f.stateRoot, "nope"),
    argv: ["list", "--json"],
  },
  {
    label: "a project binding naming an ABSENT path inside a guarded root — home reports it at exit 0",
    binding: (f) => path.join(f.stateRoot, "nope"),
    argv: ["home", "--json"],
    expect: 0,
  },
];

test("every resolution path that can select a guarded root refuses, and points nowhere inside one", async (t) => {
  const fixture = await boundaryFixture();
  try {
    for (const row of RESOLUTION_ROWS) {
      await t.test(row.label, row.skip === undefined ? {} : { skip: row.skip }, () => {
        const cwd = row.binding ? path.join(fixture.root, "bound") : (row.cwd?.(fixture) ?? fixture.project);
        mkdirSync(cwd, { recursive: true });
        if (row.binding) {
          writeFileSync(path.join(cwd, ".superbee.json"), JSON.stringify({ bundle: row.binding(fixture) }));
        }
        const result = runCli(row.argv, { cwd, home: fixture.home });
        assert.notEqual(result.status, 2, `${row.label}: incomplete invocation (USAGE): ${result.stdout}`);
        assert.equal(result.status, row.expect ?? 5, `${row.label}: ${result.stderr || result.stdout}`);
        assert.match(result.stdout, BOUNDARY_MESSAGE, row.label);
        assert.deepEqual(
          guardedDirHints(result.stdout, cwd, fixture.home),
          [],
          `${row.label}: emitted a next command whose --dir lands inside a guarded root`,
        );
      });
    }
    // Nothing was created inside private state by any refused resolution.
    assert.equal(existsSync(path.join(fixture.stateRoot, ".superbee")), false);
    assert.equal(existsSync(path.join(fixture.stateRoot, "nope")), false);
  } finally {
    fixture.cleanup();
  }
});

// ── The ONE read exemption, as a row table ────────────────────────────────────
//
// Sync's converging conflict mechanic exports the local version of a conflicted BUNDLE document
// into `<state>/sync/exports/…` and the CLI itself emits `doc update --body-file <that export>` as
// the reconcile chain, so those bytes must read back. Every anti-widening property of that
// exemption is a ROW here: widening or narrowing it changes a row, never a bespoke test.

interface ExemptionRow {
  readonly label: string;
  readonly target: (fixture: ExemptionFixture) => string;
  /** Exit code expected from `doc update --body-file <target>` (or the row's own argv). */
  readonly expect: number;
  readonly argv?: (target: string) => string[];
  /** Which fixture variant the row needs. Default: the exports tree EXISTS. */
  readonly exports?: "present" | "absent";
  readonly skip?: string;
}

interface ExemptionFixture extends BoundaryFixture {
  readonly exportsRoot: string;
  readonly exported: string;
  readonly exportsAlias: string;
}

async function exemptionFixture(exports: "present" | "absent" = "present"): Promise<ExemptionFixture> {
  const fixture = await boundaryFixture();
  const exportsRoot = syncExportsRoot(fixture.home);
  const exported = path.join(exportsRoot, "abc123", "notes", "a.md");
  const exportsAlias = path.join(fixture.root, "exports-alias");
  if (exports === "absent") return { ...fixture, exportsRoot, exported, exportsAlias };

  mkdirSync(path.dirname(exported), { recursive: true, mode: 0o700 });
  writeFileSync(exported, "# Yours\n\nthe local version sync saved\n", { mode: 0o600 });
  // A sibling under the same sync state directory, one level ABOVE the exports tree.
  writeFileSync(path.join(fixture.stateRoot, "sync", "cursor.json"), '{"schema_version":1}\n', { mode: 0o600 });
  // A symlink INSIDE the exports tree, pointing back at opaque private state.
  symlinkSync(fixture.credential, path.join(exportsRoot, "abc123", "escape.md"));
  // A second NAME for the exports tree, outside private state: the exemption is decided by the
  // inode relation, so this must behave exactly like the real path — a prefix-string match would
  // refuse it.
  symlinkSync(exportsRoot, exportsAlias, "dir");
  return { ...fixture, exportsRoot, exported, exportsAlias };
}

const EXEMPTION_ROWS: readonly ExemptionRow[] = [
  { label: "exempt: a conflict export reads back", target: (f) => f.exported, expect: 0 },
  {
    label: "exempt through a second NAME for the exports tree (inode containment, not a prefix match)",
    target: (f) => path.join(f.exportsAlias, "abc123", "notes", "a.md"),
    expect: 0,
  },
  { label: "sibling: the sync state file one directory up", target: (f) => path.join(f.stateRoot, "sync", "cursor.json"), expect: 5 },
  { label: "root itself: the exports root is `identical`, not `inside`", target: (f) => f.exportsRoot, expect: 5 },
  { label: "symlink escape: the relation follows to the real target", target: (f) => path.join(f.exportsRoot, "abc123", "escape.md"), expect: 5 },
  {
    // The source comment says "an absent exports root exempts nothing". True of every reachable
    // OUTCOME, false of the predicate: containment IS satisfied, so the read is attempted and fails
    // ENOENT. This row pins the outcome (never exit 0) and records the distinction.
    label: "absent exports: the containment predicate holds, but nothing can be read",
    target: (f) => path.join(f.exportsRoot, "abc123", "notes", "a.md"),
    exports: "absent",
    expect: 1,
  },
  {
    label: "read-exempt is not write-exempt: an --out destination inside the exports tree",
    target: (f) => path.join(f.exportsRoot, "abc123", "out.md"),
    argv: (t) => ["doc", "read", "notes/a", "--out", t, "--dir", ".superbee", "--json"],
    expect: 5,
  },
];

test("the ingress guard's ONE exemption, row by row", async (t) => {
  const fixture = await exemptionFixture();
  const absent = await exemptionFixture("absent");
  try {
    for (const row of EXEMPTION_ROWS) {
      await t.test(row.label, row.skip === undefined ? {} : { skip: row.skip }, () => {
        const active = row.exports === "absent" ? absent : fixture;
        const target = row.target(active);
        const argv = row.argv?.(target)
          ?? ["doc", "update", "notes/a", "--body-file", target, "--dir", ".superbee", "--json"];
        const result = runCli(argv, { cwd: active.project, home: active.home });
        assert.equal(result.status, row.expect, `${row.label}: ${result.stderr || result.stdout}`);
        if (row.expect === 5) assert.match(result.stdout, BOUNDARY_MESSAGE, row.label);
      });
    }
    // The exempt rows really did reconcile the document — a guard that refused everything would
    // satisfy every refusal row above.
    const read = runCli(["doc", "read", "notes/a", "--dir", ".superbee", "--json"], { cwd: fixture.project, home: fixture.home });
    assert.match(read.stdout, /the local version sync saved/, "the exported bundle content reads back");
    assert.equal(existsSync(path.join(fixture.exportsRoot, "abc123", "out.md")), false);
    assert.equal(existsSync(absent.exportsRoot), false, "the absent-exports variant must stay absent");
  } finally {
    fixture.cleanup();
    absent.cleanup();
  }
});

/**
 * The positive control for the ingress guard: the SAME three verbs, the same flag, an ordinary
 * project file. A guard that refused everything would satisfy the refusal table above.
 */
test("the --body-file ingress still reads an ordinary project file", async () => {
  const fixture = await boundaryFixture();
  try {
    const source = fixture.ordinaryFile;
    const sites: Array<[string, string[]]> = [
      ["doc write --body-file", ["doc", "write", "notes/from-file", "--type", "Note", "--body-file", source, "--dir", ".superbee", "--json"]],
      ["doc update --body-file", ["doc", "update", "notes/a", "--body-file", source, "--dir", ".superbee", "--json"]],
      ["new --body-file", ["new", "Context Note", "from-file", "--title", "From File", "--body-file", source, "--dir", ".superbee", "--json"]],
    ];
    for (const [label, argv] of sites) {
      const result = runCli(argv, { cwd: fixture.project, home: fixture.home });
      assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
    }
    for (const id of ["notes/from-file", "notes/a", "context-notes/from-file"]) {
      const read = runCli(["doc", "read", id, "--dir", ".superbee", "--json"], { cwd: fixture.project, home: fixture.home });
      assert.equal(read.status, 0, read.stderr || read.stdout);
      assert.match(read.stdout, /ordinary project content/, id);
    }
  } finally {
    fixture.cleanup();
  }
});

test("the same byte channels still work one directory outside the boundary", async () => {
  const fixture = await boundaryFixture();
  try {
    // A sibling of the state root, sharing its parent: the guard must be containment, not proximity.
    const sibling = path.join(path.dirname(fixture.stateRoot), "exports-beside-state");
    mkdirSync(sibling, { recursive: true });

    for (const destination of [path.join(fixture.outside, "a.md"), path.join(sibling, "a.md")]) {
      const result = runCli(
        ["doc", "read", "notes/a", "--out", destination, "--dir", ".superbee", "--json"],
        { cwd: fixture.project, home: fixture.home },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(destination), true);
    }
  } finally {
    fixture.cleanup();
  }
});

test("the state root carries a total .gitignore, added opportunistically to older roots", async () => {
  const root = scratch();
  try {
    const home = path.join(root, "home");
    mkdirSync(home, { recursive: true });
    const stateRoot = await ensureUserStateRoot(home);
    const ignore = path.join(stateRoot, ".gitignore");
    assert.equal(readFileSync(ignore, "utf8"), "*\n");
    assert.equal(statSync(ignore).mode & 0o777, 0o600);

    // A root created by an earlier version has no .gitignore; the next ensure republishes it,
    // strictly after the ownership assertion (so a foreign root never receives product bytes).
    unlinkSync(ignore);
    await ensureUserStateRoot(home);
    assert.equal(readFileSync(ignore, "utf8"), "*\n");

    // And it does not disturb the ownership marker.
    assert.equal(readFileSync(path.join(stateRoot, USER_STATE_MARKER_FILE_NAME), "utf8"), USER_STATE_MARKER_BYTES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
