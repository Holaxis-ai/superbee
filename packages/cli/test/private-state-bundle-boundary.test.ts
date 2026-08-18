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
  assertBundleOutsidePrivateState,
  assertPathOutsidePrivateState,
  guardedStateRoots,
  relateToPrivateState,
  type PrivateStateRelation,
} from "../src/private-state-bundle-boundary.js";
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

/** A real bundle plus a ready private-state root, both under one throwaway HOME. */
async function crossingFixture(root: string): Promise<{ home: string; project: string; stateRoot: string }> {
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const stateRoot = await ensureUserStateRoot(home);
  const initialized = run(process.execPath, [CLI, "init", "--create-only", "--dir", ".superbee", "--json"], project, { HOME: home });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const wrote = run(
    process.execPath,
    [CLI, "doc", "write", "notes/a", "--type", "Note", "--body", "body", "--dir", ".superbee", "--json"],
    project,
    { HOME: home },
  );
  assert.equal(wrote.status, 0, wrote.stderr || wrote.stdout);
  return { home, project, stateRoot };
}

test("every byte-channel crossing point refuses a private-state path", async () => {
  const root = scratch();
  try {
    const { home, project, stateRoot } = await crossingFixture(root);
    const marker = path.join(stateRoot, USER_STATE_MARKER_FILE_NAME);
    const credential = path.join(stateRoot, "okf-config.json");
    writeFileSync(credential, '{"remotes":{"x":{"api_key":"secret"}}}\n', { mode: 0o600 });

    const sites: Array<[string, string[]]> = [
      // Source positionals: private operational state must not become publishable bundle content.
      ["promote", ["promote", credential, "--doc-key", "leak.json", "--dir", ".superbee", "--json"]],
      ["artifact create", ["artifact", "create", credential, "--title", "Leak", "--dir", ".superbee", "--json"]],
      // --out destinations: a plain 0644 write over the marker bricks every private-state command.
      ["pull --out", ["pull", "--doc-key", "notes/a.md", "--out", marker, "--dir", ".superbee", "--json"]],
      ["doc read --out", ["doc", "read", "notes/a", "--out", marker, "--dir", ".superbee", "--json"]],
      ["doc read --body-out", ["doc", "read", "notes/a", "--body-out", path.join(stateRoot, "body.md"), "--dir", ".superbee", "--json"]],
      ["sync --show-incoming --out", ["sync", "--show-incoming", "notes/a", "--out", path.join(stateRoot, "incoming.md"), "--dir", ".superbee", "--json"]],
      // Nested destinations are the same boundary, not a special case.
      ["doc read --out (nested)", ["doc", "read", "notes/a", "--out", path.join(stateRoot, "deep", "nested.md"), "--dir", ".superbee", "--json"]],
    ];
    for (const [label, argv] of sites) {
      const result = run(process.execPath, [CLI, ...argv], project, { HOME: home });
      assert.equal(result.status, 5, `${label}: ${result.stderr || result.stdout}`);
      assert.match(result.stdout, /private user-state directory/, label);
    }

    assert.equal(readFileSync(marker, "utf8"), USER_STATE_MARKER_BYTES, "the marker survives every refusal");
    assert.equal(statSync(marker).mode & 0o777, 0o600, "and keeps its private mode");
    assert.equal(existsSync(path.join(stateRoot, "body.md")), false);
    assert.equal(existsSync(path.join(stateRoot, "incoming.md")), false);
    assert.equal(existsSync(path.join(stateRoot, "deep")), false);
    const listed = run(process.execPath, [CLI, "list", "--dir", ".superbee", "--json"], project, { HOME: home });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.doesNotMatch(listed.stdout, /leak/, "no refused source positional reached the bundle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same byte channels still work one directory outside the boundary", async () => {
  const root = scratch();
  try {
    const { home, project, stateRoot } = await crossingFixture(root);
    const outside = path.join(root, "exports");
    mkdirSync(outside, { recursive: true });
    // A sibling of the state root, sharing its parent: the guard must be containment, not proximity.
    const sibling = path.join(path.dirname(stateRoot), "exports-beside-state");
    mkdirSync(sibling, { recursive: true });

    for (const destination of [path.join(outside, "a.md"), path.join(sibling, "a.md")]) {
      const result = run(
        process.execPath,
        [CLI, "doc", "read", "notes/a", "--out", destination, "--dir", ".superbee", "--json"],
        project,
        { HOME: home },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(destination), true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
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
