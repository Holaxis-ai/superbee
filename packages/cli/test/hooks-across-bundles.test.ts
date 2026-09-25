// Hooks across bundles (designs/local-git-hosted-cli-experience, PR 10).
//
// session-start lists the other catalog bundles with their home and freshness, from the catalog,
// private state and local Git only. `turn-end --git-boards` gives a shared Git board the hosted
// end-of-turn rules (quiet on success, report once, skip when unchanged); without the flag a Git
// board is never synced by the hook.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle } from "@superbee/core";

import { addCatalogEntry } from "../src/catalog.js";
import { checkout } from "../src/commands/checkout.js";
import { hook } from "../src/commands/hook.js";
import { otherCatalogBundles, sessionStart } from "../src/commands/session-start.js";
import { readTurnEndGitBoards, recordTurnEndGitBoards, sharedGitBoardAt, turnEnd, type GitTurnEndBoard } from "../src/commands/turn-end.js";
import { CliError } from "../src/errors.js";
import { defaultHostedAuthDeps } from "../src/hosted-auth/session.js";
import {
  boardHead,
  divergeSameDoc,
  makeTwoCloneTopology,
  originBoardHead,
  writeBoardDoc,
} from "../../board-git/test/git-harness.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";
import { withIsolatedUserEnv } from "./support/user-env.js";

const MIN = 60_000;

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function withCwd<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

// ------------------------------------------------------------------------ session-start

test("session-start lists the other catalog bundles with home and freshness, and never the current one", async () => {
  const topo = await makeTwoCloneTopology();
  const home = await tempDir("sb-hab-home-");
  try {
    const personal = path.join(home, "personal-bundle");
    await initBundle(personal);
    await addCatalogEntry("personal", personal, { home });
    await addCatalogEntry("team", topo.b.board, { home });
    await addCatalogEntry("here", topo.a.board, { home });

    const rows = await otherCatalogBundles(topo.a.board, { home, now: new Date(Date.now() + 3 * 60 * MIN) });
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
    assert.equal(byLabel.here, undefined, "the bundle this session is in is not an 'other' bundle");
    assert.deepEqual(byLabel.personal, { label: "personal", home: "local", freshness: "local only" });
    assert.equal(byLabel.team!.home, "git");
    assert.equal(byLabel.team!.freshness, "fetched 3h ago", "the board's last fetch, as of three hours from now");

    // The session-start render carries the same rows, without any path or id.
    const out: string[] = [];
    await withIsolatedUserEnv(home, () =>
      withCwd(topo.a.root, () =>
        sessionStart(["--json"], { stdout: (text) => void out.push(text), budgetMs: 50, pull: async () => ({ offline: false, boardPath: topo.a.board }) }),
      ),
    );
    const view = JSON.parse(out.join("")) as { workspaces: { count: number; entries: { label: string; home: string; freshness: string }[] } };
    assert.deepEqual(view.workspaces.entries.map((entry) => [entry.label, entry.home]), [
      ["personal", "local"],
      ["team", "git"],
    ]);
    assert.equal(view.workspaces.count, 2);
    assert.doesNotMatch(JSON.stringify(view.workspaces), /(?:locator|personal-bundle|bnd_|aslite-git-harness)/);
  } finally {
    await topo.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("a hosted checkout in the catalog reads as hosted with its last pull; a missing folder says so", async () => {
  const host = new FakeHost();
  const home = await tempDir("sb-hab-hosted-home-");
  const cwd = await tempDir("sb-hab-hosted-cwd-");
  try {
    const auth = defaultHostedAuthDeps(home, {
      env: { SUPERBEE_ACCESS_TOKEN: TOKEN },
      fetch: async () => {
        throw new Error("the sign-in module must not be reached");
      },
    });
    await checkout([BUNDLE, "--host", HOST, "--dir", "team", "--json"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
    const missing = path.join(home, "moved-away");
    await initBundle(missing);
    await addCatalogEntry("moved", missing, { home });
    await rm(missing, { recursive: true, force: true });
    host.requests.length = 0;

    const rows = await otherCatalogBundles(null, { home });
    const hosted = rows.find((row) => row.home === "hosted");
    assert.ok(hosted, JSON.stringify(rows));
    assert.match(hosted.freshness!, /^pulled \d+m ago$/);
    assert.deepEqual(rows.find((row) => row.label === "moved"), { label: "moved", home: "unknown", freshness: "folder missing" });
    assert.equal(host.requests.length, 0, "listing never reaches the host");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------ turn-end --git-boards

test("turn-end syncs a Git board only with --git-boards, and then silently", async () => {
  const topo = await makeTwoCloneTopology();
  const home = await tempDir("sb-hab-turn-home-");
  try {
    await writeBoardDoc(topo.a, "notes/turn", { frontmatter: { type: "Note", title: "Turn" }, body: "# Turn\n" });
    const before = originBoardHead(topo);
    const run = async (argv: string[]) => {
      const out: string[] = [];
      await withIsolatedUserEnv(home, () =>
        withCwd(topo.a.root, () => turnEnd(argv, { stdout: (text) => void out.push(text), env: {}, readStdin: async () => null })),
      );
      return out.join("");
    };

    assert.equal(await run([]), "");
    assert.equal(originBoardHead(topo), before, "without --git-boards a Git board is never synced by the hook");

    assert.equal(await run(["--git-boards"]), "", "a clean sync is silent");
    assert.notEqual(originBoardHead(topo), before, "the edit was committed and pushed");
    assert.equal(originBoardHead(topo), boardHead(topo.a));
  } finally {
    await topo.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("a real same-document Git conflict at turn end comes back once, in Git's form", async () => {
  const topo = await makeTwoCloneTopology();
  const home = await tempDir("sb-hab-conflict-home-");
  try {
    const { docId } = await divergeSameDoc(topo);
    const run = async () => {
      const out: string[] = [];
      await withIsolatedUserEnv(home, () =>
        withCwd(topo.b.root, () => turnEnd(["--git-boards"], { stdout: (text) => void out.push(text), env: {}, readStdin: async () => null })),
      );
      return out.join("");
    };
    const decision = JSON.parse(await run()) as { decision: string; reason: string };
    assert.equal(decision.decision, "block");
    assert.ok(decision.reason.includes(docId), decision.reason);
    assert.match(decision.reason, /Git board/);
    // The sync converged (teammate's version kept, B's exported), so the next turn has nothing to report.
    assert.equal(await run(), "");
  } finally {
    await topo.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("turn-end --git-boards skips Git entirely when nothing changed and the last fetch is recent", async () => {
  const topo = await makeTwoCloneTopology();
  const home = await tempDir("sb-hab-skip-home-");
  try {
    const board = await withIsolatedUserEnv(home, () => sharedGitBoardAt(topo.a.board, home));
    assert.ok(board);
    assert.equal(board.changed, false);
    assert.ok(board.lastFetch, "a provisioned board has fetched");

    let synced = 0;
    const once = (now: Date, facts: GitTurnEndBoard = board) =>
      turnEnd(["--dir", topo.a.board, "--git-boards"], {
        stdout: () => {},
        env: {},
        readStdin: async () => null,
        hostedCheckout: async () => null,
        gitBoard: async () => facts,
        gitSync: async () => void (synced += 1),
        now: () => now,
        syncDeps: { auth: defaultHostedAuthDeps(home) },
      });
    const fetchedAt = Date.parse(board.lastFetch!);
    await once(new Date(fetchedAt + 2 * MIN));
    assert.equal(synced, 0, "clean and fetched two minutes ago: no Git at all");
    await once(new Date(fetchedAt + 6 * MIN));
    assert.equal(synced, 1, "clean but the fetch is stale: one sync pulls");
    await once(new Date(fetchedAt + 1 * MIN), { ...board, changed: true });
    assert.equal(synced, 2, "anything to send always syncs");

    // An unshared board or a plain local bundle is not a shared Git board.
    const local = await tempDir("sb-hab-local-");
    await initBundle(local);
    assert.equal(await sharedGitBoardAt(local, home), null);
    await rm(local, { recursive: true, force: true });
  } finally {
    await topo.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("turn-end --git-boards hands a conflict back once, stays quiet for offline, and resets after a clean sync", async () => {
  const home = await tempDir("sb-hab-block-home-");
  const board: GitTurnEndBoard = { root: path.join(home, "project", ".superbee"), changed: true, lastFetch: null };
  let failure: Error | null = null;
  const run = async (stdin: string | null = null) => {
    const out: string[] = [];
    await turnEnd(["--git-boards"], {
      stdout: (text) => void out.push(text),
      env: {},
      readStdin: async () => stdin,
      hostedCheckout: async () => null,
      gitBoard: async () => board,
      gitSync: async () => {
        if (failure) throw failure;
      },
      syncDeps: { auth: defaultHostedAuthDeps(home) },
    });
    return out.join("");
  };
  try {
    const conflict = new CliError("CONFLICT", "notes/a changed on both sides; teammate's version kept, yours saved at /x/notes/a.md", {
      help: "superbee sync --show-incoming notes/a",
    });
    failure = conflict;
    const first = JSON.parse(await run()) as { decision: string; reason: string };
    assert.equal(first.decision, "block");
    assert.match(first.reason, /Git board/);
    assert.match(first.reason, /teammate's version kept/);
    assert.match(first.reason, /sync --show-incoming notes\/a/);
    assert.equal(await run(), "", "the same condition is reported once");
    assert.equal(await run(JSON.stringify({ stop_hook_active: true })), "");

    for (const quiet of [new CliError("TRANSIENT", "offline"), new CliError("GIT_BUSY", "busy"), new CliError("RUNTIME", "odd")]) {
      failure = quiet;
      assert.equal(await run(), "", quiet.code);
    }

    failure = null;
    assert.equal(await run(), "");
    failure = conflict;
    assert.equal(JSON.parse(await run()).decision, "block", "after a clean sync the same condition is new again");

    failure = new CliError("AUTH_REQUIRED", "git could not authenticate to origin");
    assert.match((JSON.parse(await run()) as { reason: string }).reason, /committed locally/);
    assert.equal(await run(), "");

    assert.equal(await turnEndQuietWith({ SUPERBEE_NO_TURN_SYNC: "1" }, home, board), "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function turnEndQuietWith(env: Record<string, string>, home: string, board: GitTurnEndBoard): Promise<string> {
  const out: string[] = [];
  let synced = false;
  await turnEnd(["--git-boards"], {
    stdout: (text) => void out.push(text),
    env,
    readStdin: async () => null,
    hostedCheckout: async () => null,
    gitBoard: async () => board,
    gitSync: async () => void (synced = true),
    syncDeps: { auth: defaultHostedAuthDeps(home) },
  });
  assert.equal(synced, false);
  return out.join("");
}

// ------------------------------------------------------------------------ hook install

test("hook install --turn-end-sync --git-boards records a per-user opt-in; the hook command stays `turn-end`", async () => {
  const base = await tempDir("sb-hab-hook-");
  const home = await tempDir("sb-hab-hook-home-");
  try {
    const program = path.join(base, "packages", "superbee", "dist", "superbee.mjs");
    const deps = { base, home, commandBase: program };
    const stopCommand = async (file: string) =>
      (JSON.parse(await readFile(path.join(base, file), "utf8")) as { hooks: { Stop?: { hooks: { command: string }[] }[] } }).hooks.Stop?.map((g) => g.hooks[0]!.command);
    const status = async () => {
      const out: string[] = [];
      await hook(["status", "--json"], { ...deps, stdout: (t) => void out.push(t) });
      return JSON.parse(out.join("")).hook.turn_end_sync as Record<string, unknown>;
    };

    await assert.rejects(hook(["install", "--git-boards"], { ...deps, stdout: () => {} }), (e: unknown) => e instanceof CliError && e.code === "USAGE");
    await assert.rejects(hook(["uninstall", "--turn-end-sync", "--git-boards"], { ...deps, stdout: () => {} }), (e: unknown) => e instanceof CliError && e.code === "USAGE");

    await hook(["install", "--turn-end-sync"], { ...deps, stdout: () => {} });
    assert.deepEqual(await stopCommand(".claude/settings.json"), [`${program} turn-end`]);
    assert.deepEqual(await status(), { claude_code: true, codex: true }, "hosted-only status is unchanged");
    assert.equal(await readTurnEndGitBoards(home), false);

    const out: string[] = [];
    await hook(["install", "--turn-end-sync", "--git-boards", "--json"], { ...deps, stdout: (t) => void out.push(t) });
    const receipt = JSON.parse(out.join("")).hook.turn_end_sync as { command: string; git_boards: boolean };
    assert.equal(receipt.command, `${program} turn-end`, "older CLIs still recognize (and safely ignore) the hook");
    assert.equal(receipt.git_boards, true);
    for (const file of [".claude/settings.json", ".codex/hooks.json"]) {
      assert.deepEqual(await stopCommand(file), [`${program} turn-end`], "rewritten in place, never duplicated");
    }
    assert.equal(await readTurnEndGitBoards(home), true);
    assert.deepEqual(await status(), { claude_code: true, codex: true, git_boards: true });

    await hook(["install"], { ...deps, stdout: () => {} });
    assert.equal(await readTurnEndGitBoards(home), true, "a plain reinstall keeps the Git opt-in");

    await hook(["install", "--turn-end-sync"], { ...deps, stdout: () => {} });
    assert.equal(await readTurnEndGitBoards(home), false, "--turn-end-sync alone switches Git back off");
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("the recorded opt-in makes the plain Stop hook command sync a Git board", async () => {
  const topo = await makeTwoCloneTopology();
  const home = await tempDir("sb-hab-optin-home-");
  try {
    await writeBoardDoc(topo.a, "notes/optin", { frontmatter: { type: "Note", title: "Opt in" }, body: "# Opt in\n" });
    const before = originBoardHead(topo);
    const run = () => withIsolatedUserEnv(home, () => withCwd(topo.a.root, () => turnEnd([], { stdout: () => {}, env: {}, readStdin: async () => null })));
    await run();
    assert.equal(originBoardHead(topo), before);
    await recordTurnEndGitBoards(home, true);
    await run();
    assert.equal(originBoardHead(topo), boardHead(topo.a));
    assert.notEqual(originBoardHead(topo), before);
  } finally {
    await topo.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("the listing stops probing at its deadline and keeps every label", async () => {
  const home = await tempDir("sb-hab-deadline-home-");
  try {
    for (const label of ["a", "b", "c"]) {
      const dir = path.join(home, label);
      await initBundle(dir);
      await addCatalogEntry(label, dir, { home });
    }
    const rows = await otherCatalogBundles(null, { home, deadlineMs: 0 });
    assert.deepEqual(rows, ["a", "b", "c"].map((label) => ({ label, home: "unknown", freshness: "not checked" })));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a Git-only user with no hooks installed sees no change: home lists labels only", async () => {
  const home = await tempDir("sb-hab-plain-home-");
  try {
    const personal = path.join(home, "personal-bundle");
    await initBundle(personal);
    await addCatalogEntry("personal", personal, { home });
    const { home: renderHome } = await import("../src/commands/home.js");
    const out: string[] = [];
    await withIsolatedUserEnv(home, () => renderHome(["--json"], { stdout: (t) => void out.push(t), hookNeedsUpdate: () => false, autoPull: async () => undefined }));
    assert.deepEqual((JSON.parse(out.join("")) as { workspaces: { entries: unknown[] } }).workspaces.entries, [{ label: "personal" }]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
