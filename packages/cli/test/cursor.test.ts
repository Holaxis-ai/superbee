/**
 * `cursor.ts` — the per-clone sync/awareness state store (sync-verb plan §U2; keying made
 * per-clone by PR#13 review item 4 — see the module's own KEYING/MIGRATION header).
 *
 * Covers the plan's binding acceptance criteria on the STORE side: the dangling-SHA → honest
 * re-anchor note flow (the `git cat-file -e` guard itself is the caller's job — U1 — so the git
 * side here is exercised directly against the U0 harness), cross-bundle isolation over TWO
 * DISTINCT ORIGINS (two `makeTwoCloneTopology` calls, per the U0 reviewer note), atomic-write +
 * permissions (0600 file / 0700 dirs), absent/malformed/stale → null (NEVER throw — home's
 * double-guard depends on it), `{tier, token}` opacity (an unknown tier round-trips untouched),
 * and the cache + marker schema round-trip.
 *
 * Uses REAL disk I/O against an isolated temp `home` dir (the injectable param every store
 * function accepts) — no mocking of `os.homedir()`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  REANCHOR_NOTE,
  bundleKey,
  readCache,
  readCursor,
  readMarker,
  readSyncState,
  recordReanchor,
  refreshMarker,
  syncStateDir,
  syncStatePath,
  writeCache,
  writeCursor,
  writeSyncState,
  createSyncStore,
  defaultSyncStore,
  type AwarenessCache,
  type SyncCursor,
} from "../src/cursor.js";
import { credentialsDir } from "../src/credentials.js";
import { ensureUserStateRoot } from "../src/user-state.js";
import {
  BUNDLE_DIR,
  boardHead,
  danglingCursorSha,
  git,
  gitTry,
  makeTwoCloneTopology,
} from "../../board-git/test/git-harness.js";

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-cursor-test-"));
}

/** A fully-populated, schema-valid awareness cache fixture (rows carry frontmatter-sourced actor). */
function sampleCache(): AwarenessCache {
  return {
    updatedAt: "2026-07-07T12:00:00.000Z",
    delta: [
      { docId: "tasks/seed-one", verb: "updated", kind: "Task", title: "Seed one", actor: "mike" },
      { docId: "notes/fresh", verb: "added", kind: "Note", title: "Fresh", actor: "brian" },
      { docId: "tasks/seed-two", verb: "deleted", kind: "Task", title: "Seed two", actor: "mike" },
    ],
    unpushedCount: 2,
    uncommittedCount: 1,
  };
}

// ── bundle key ────────────────────────────────────────────────────────────────

test("bundleKey: remote-keyed — equivalent URL/subpath/root spellings key together; distinct bundles stay distinct", () => {
  const base = bundleKey({ remoteUrl: "https://github.com/org/repo", subpath: ".agentstate-lite", checkoutRoot: "/w/clone-a/.agentstate-lite" });
  // Trivial spelling variants of the SAME checkout of the SAME bundle → same key.
  assert.equal(bundleKey({ remoteUrl: "https://github.com/org/repo.git", subpath: ".agentstate-lite", checkoutRoot: "/w/clone-a/.agentstate-lite" }), base);
  assert.equal(bundleKey({ remoteUrl: "https://github.com/org/repo/", subpath: "./.agentstate-lite/", checkoutRoot: "/w/clone-a/x/../.agentstate-lite" }), base);
  // A different subpath in the SAME repo is a different bundle.
  assert.notEqual(bundleKey({ remoteUrl: "https://github.com/org/repo", subpath: "other-bundle", checkoutRoot: "/w/clone-a/.agentstate-lite" }), base);
  // A different repo is a different bundle.
  assert.notEqual(bundleKey({ remoteUrl: "https://github.com/org/other", subpath: ".agentstate-lite", checkoutRoot: "/w/clone-a/.agentstate-lite" }), base);
});

test("bundleKey: per-CLONE — the SAME origin checked out at two roots on one machine gets two keys (PR#13 review, item 4)", () => {
  const cloneA = bundleKey({ remoteUrl: "https://github.com/org/repo", subpath: "", checkoutRoot: "/w/clone-a/.agentstate-lite" });
  const cloneB = bundleKey({ remoteUrl: "https://github.com/org/repo", subpath: "", checkoutRoot: "/w/clone-b/.agentstate-lite" });
  assert.notEqual(cloneA, cloneB, "two clones of one origin must never share a state file");
  assert.notEqual(syncStatePath(cloneA, "/home/x"), syncStatePath(cloneB, "/home/x"), "distinct state files too");
  // The remote component still matters: a RECYCLED checkout root under a different origin is a
  // different key — stale state from the previous project at this path can never be inherited.
  assert.notEqual(
    bundleKey({ remoteUrl: "https://github.com/org/other", subpath: "", checkoutRoot: "/w/clone-a/.agentstate-lite" }),
    cloneA,
  );
});

test("bundleKey: path fallback is keyed by ABSOLUTE root and can never collide with a remote key", () => {
  const p = bundleKey({ root: "/tmp/some/bundle" });
  assert.equal(bundleKey({ root: "/tmp/some/../some/bundle" }), p, "resolved to one absolute root");
  assert.notEqual(bundleKey({ root: "/tmp/other/bundle" }), p);
  // The kind prefix keeps a pathological remote URL from ever colliding with a path key.
  assert.notEqual(bundleKey({ remoteUrl: "/tmp/some/bundle", subpath: "", checkoutRoot: "/tmp/some/bundle" }), p);
});

// ── cursor opacity ────────────────────────────────────────────────────────────

test("cursor: git-tier round-trip; an UNKNOWN tier (numeric token + extra fields) round-trips untouched", async () => {
  const home = await tempHome();
  try {
    const key = bundleKey({ root: "/tmp/bundle-a" });
    assert.equal(await readCursor(key, home), null, "no state yet reads null");

    const gitCursor: SyncCursor = { tier: "git", token: "0123456789abcdef0123456789abcdef01234567" };
    await writeCursor(key, gitCursor, home);
    assert.deepEqual(await readCursor(key, home), gitCursor);

    // The future d1 tier: the store must persist it VERBATIM — numeric token, extra fields and
    // all — without any CLI-side change (plan §U2's tier-agnostic contract).
    const d1Cursor: SyncCursor = { tier: "d1", token: 9942, shard: "eu-west" };
    await writeCursor(key, d1Cursor, home);
    assert.deepEqual(await readCursor(key, home), d1Cursor, "unknown tier round-trips untouched");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cursor: writing a shape-invalid cursor is a programmer error (throws), never silently stored", async () => {
  const home = await tempHome();
  try {
    const key = bundleKey({ root: "/tmp/bundle-a" });
    await assert.rejects(writeCursor(key, { tier: "", token: "x" } as SyncCursor, home), TypeError);
    await assert.rejects(writeCursor(key, { tier: "git", token: "" } as SyncCursor, home), TypeError);
    await assert.rejects(writeCursor(key, { tier: "d1", token: NaN } as unknown as SyncCursor, home), TypeError);
    assert.equal(await readCursor(key, home), null, "nothing was stored");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ── atomic write + permissions ────────────────────────────────────────────────

test("private state has platform-native containment and no temporary residue", async () => {
  const home = await tempHome();
  try {
    const key = bundleKey({ remoteUrl: "https://github.com/org/repo", subpath: BUNDLE_DIR, checkoutRoot: "/w/clone-a/.agentstate-lite" });
    await writeCursor(key, { tier: "git", token: "a".repeat(40) }, home);

    const fileMode = (await stat(syncStatePath(key, home))).mode & 0o777;
    if (process.platform !== "win32") {
      assert.equal(fileMode, 0o600, "state file is 0600");
      assert.equal((await stat(syncStateDir(home))).mode & 0o777, 0o700, "sync dir is 0700");
      assert.equal((await stat(credentialsDir(home))).mode & 0o777, 0o700, "canonical state root is 0700");
    } else {
      assert.equal((await stat(syncStatePath(key, home))).isFile(), true, "state record remains a regular file");
      assert.equal((await stat(syncStateDir(home))).isDirectory(), true, "sync container remains a directory");
      assert.equal((await stat(credentialsDir(home))).isDirectory(), true, "state root remains a directory");
    }

    // The O_EXCL temp is renamed over the target — a completed write leaves no `.tmp` strays.
    const entries = await readdir(syncStateDir(home));
    assert.deepEqual(entries, [path.basename(syncStatePath(key, home))]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("atomic replace: a rewrite fully replaces the file (valid JSON, latest content, still one file)", async () => {
  const home = await tempHome();
  try {
    const key = bundleKey({ root: "/tmp/bundle-a" });
    // First write is LARGER than the second — a torn/partial overwrite would leave trailing junk.
    await writeCache(key, sampleCache(), home);
    await writeSyncState(key, { cache: null, cursor: { tier: "git", token: "b".repeat(40) } }, home);

    const raw = await readFile(syncStatePath(key, home), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>; // throws if torn
    assert.equal(parsed.key, key, "the key is stored inside the file");
    assert.equal(parsed.cache, undefined, "explicit null CLEARS a section");
    assert.deepEqual(await readCursor(key, home), { tier: "git", token: "b".repeat(40) });
    assert.deepEqual(await readdir(syncStateDir(home)), [path.basename(syncStatePath(key, home))]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ── absent / malformed / stale → null, never throw ───────────────────────────

test("reads never throw: absent, garbage JSON, non-object JSON, foreign key, unreadable path — all null", async () => {
  const home = await tempHome();
  try {
    const key = bundleKey({ root: "/tmp/bundle-a" });

    // Absent.
    assert.deepEqual(await readSyncState(key, home), { cursor: null, cache: null, marker: null, selfActors: null, autoPullAttemptAt: null, hookHintedAt: null });

    // Garbage JSON.
    await mkdir(syncStateDir(home), { recursive: true, mode: 0o700 });
    await writeFile(syncStatePath(key, home), "{ not json", "utf8");
    assert.deepEqual(await readSyncState(key, home), { cursor: null, cache: null, marker: null, selfActors: null, autoPullAttemptAt: null, hookHintedAt: null });

    // Valid JSON, wrong top-level shape.
    await writeFile(syncStatePath(key, home), "[1,2,3]\n", "utf8");
    assert.deepEqual(await readSyncState(key, home), { cursor: null, cache: null, marker: null, selfActors: null, autoPullAttemptAt: null, hookHintedAt: null });

    // FOREIGN KEY guard: a file at this key's path whose stored key names ANOTHER bundle (hash
    // collision / hand-copied file) reads as absent — never another bundle's state.
    await writeFile(
      syncStatePath(key, home),
      JSON.stringify({ key: "path\n/somewhere/else", cursor: { tier: "git", token: "x".repeat(40) } }),
      "utf8",
    );
    assert.equal(await readCursor(key, home), null);

    // Unreadable: the state path is a DIRECTORY (read error, not ENOENT) — still null, no throw.
    await rm(syncStatePath(key, home));
    await mkdir(syncStatePath(key, home));
    assert.deepEqual(await readSyncState(key, home), { cursor: null, cache: null, marker: null, selfActors: null, autoPullAttemptAt: null, hookHintedAt: null });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("section independence: one malformed section reads null while the valid sections survive", async () => {
  const home = await tempHome();
  try {
    const key = bundleKey({ root: "/tmp/bundle-a" });
    await ensureUserStateRoot(home);
    await mkdir(syncStateDir(home), { recursive: true, mode: 0o700 });
    await writeFile(
      syncStatePath(key, home),
      JSON.stringify({
        key,
        cursor: { tier: "git" }, // malformed: token missing
        cache: { ...sampleCache(), delta: [{ docId: "x" }] }, // malformed: incomplete row
        marker: { updatedAt: "2026-07-07T12:00:00.000Z", origin: "seen" }, // valid (+ extra field)
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const state = await readSyncState(key, home);
    assert.equal(state.cursor, null);
    assert.equal(state.cache, null);
    assert.deepEqual(state.marker, { updatedAt: "2026-07-07T12:00:00.000Z", origin: "seen" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("staleness: cache/marker older than maxAgeMs read null; fresh ones read back; no maxAgeMs = no cutoff", async () => {
  const home = await tempHome();
  try {
    const key = bundleKey({ root: "/tmp/bundle-a" });
    const writtenAt = new Date("2026-07-07T12:00:00.000Z");
    await writeCache(key, sampleCache(), home); // updatedAt = writtenAt
    await refreshMarker(key, home, () => writtenAt);

    const later = () => new Date(writtenAt.getTime() + 60_000);
    // Fresh within the window.
    assert.ok(await readCache(key, { maxAgeMs: 120_000, now: later }, home));
    assert.ok(await readMarker(key, { maxAgeMs: 120_000, now: later }, home));
    // Stale past the window → null (stale = absent for the consumer).
    assert.equal(await readCache(key, { maxAgeMs: 30_000, now: later }, home), null);
    assert.equal(await readMarker(key, { maxAgeMs: 30_000, now: later }, home), null);
    // No policy → no cutoff.
    assert.ok(await readCache(key, undefined, home));
    assert.ok(await readMarker(key, undefined, home));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ── cache + marker schema round-trip ──────────────────────────────────────────

test("cache round-trip: enriched delta rows (frontmatter-sourced actor), backstop counts, extra fields preserved", async () => {
  const home = await tempHome();
  try {
    const key = bundleKey({ remoteUrl: "https://github.com/org/repo", subpath: BUNDLE_DIR, checkoutRoot: "/w/clone-a/.agentstate-lite" });
    assert.equal(await readCache(key, undefined, home), null);

    const cache: AwarenessCache = { ...sampleCache(), source: "sync" }; // extra field survives
    await writeCache(key, cache, home);
    const back = await readCache(key, undefined, home);
    assert.deepEqual(back, cache);
    // The row shape IS the single-feed contract: verb/kind/id/title + per-doc frontmatter actor.
    assert.deepEqual(back!.delta[0], {
      docId: "tasks/seed-one",
      verb: "updated",
      kind: "Task",
      title: "Seed one",
      actor: "mike",
    });
    assert.equal(back!.unpushedCount, 2, "unpushed backstop count");
    assert.equal(back!.uncommittedCount, 1, "uncommitted backstop count");

    // A shape-invalid cache is a programmer error, never silently stored.
    await assert.rejects(
      writeCache(key, { ...sampleCache(), unpushedCount: -1 } as AwarenessCache, home),
      TypeError,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("marker: refreshMarker timestamps + refreshes (every pull step), preserving extra fields; cursor/cache untouched", async () => {
  const home = await tempHome();
  try {
    const key = bundleKey({ root: "/tmp/bundle-a" });
    await writeCursor(key, { tier: "git", token: "c".repeat(40) }, home);

    const t1 = new Date("2026-07-07T12:00:00.000Z");
    const first = await refreshMarker(key, home, () => t1);
    assert.equal(first.updatedAt, t1.toISOString());

    // A prior writer's extra marker field survives a refresh.
    await writeSyncState(key, { marker: { ...first, seenOrigin: true } }, home);
    const t2 = new Date("2026-07-07T12:05:00.000Z");
    const second = await refreshMarker(key, home, () => t2);
    assert.deepEqual(second, { updatedAt: t2.toISOString(), seenOrigin: true });
    assert.deepEqual(await readMarker(key, undefined, home), second);

    // Refreshing the marker never disturbs its siblings under the same key.
    assert.deepEqual(await readCursor(key, home), { tier: "git", token: "c".repeat(40) });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ── cross-bundle isolation (two DISTINCT origins — U0 reviewer note) ──────────

test("cross-bundle isolation: two bundles from two distinct origins get distinct keys/files; no state bleed", async () => {
  const home = await tempHome();
  const topoOne = await makeTwoCloneTopology();
  const topoTwo = await makeTwoCloneTopology(); // SECOND distinct origin (reviewer note)
  try {
    const urlOne = git(topoOne.a.root, ["remote", "get-url", "origin"]).trim();
    const urlTwo = git(topoTwo.a.root, ["remote", "get-url", "origin"]).trim();
    assert.notEqual(urlOne, urlTwo, "harness gave two distinct origins");

    const keyOne = bundleKey({ remoteUrl: urlOne, subpath: BUNDLE_DIR, checkoutRoot: topoOne.a.board });
    const keyTwo = bundleKey({ remoteUrl: urlTwo, subpath: BUNDLE_DIR, checkoutRoot: topoTwo.a.board });
    assert.notEqual(keyOne, keyTwo, "distinct origins → distinct keys");
    assert.notEqual(syncStatePath(keyOne, home), syncStatePath(keyTwo, home), "distinct state files");

    // Same origin, same checkout → SAME key, whatever the URL spelling; the OTHER clone of the
    // same origin is a DIFFERENT key (per-CLONE keying — PR#13 review, item 4).
    const urlOneB = git(topoOne.b.root, ["remote", "get-url", "origin"]).trim();
    assert.equal(urlOneB, urlOne, "harness: both clones share one origin URL");
    assert.equal(bundleKey({ remoteUrl: urlOneB, subpath: BUNDLE_DIR, checkoutRoot: topoOne.a.board }), keyOne);
    assert.notEqual(bundleKey({ remoteUrl: urlOneB, subpath: BUNDLE_DIR, checkoutRoot: topoOne.b.board }), keyOne);

    // Populate bundle ONE fully; bundle TWO stays empty.
    await writeCursor(keyOne, { tier: "git", token: boardHead(topoOne.a) }, home);
    await writeCache(keyOne, sampleCache(), home);
    await refreshMarker(keyOne, home);
    assert.deepEqual(await readSyncState(keyTwo, home), { cursor: null, cache: null, marker: null, selfActors: null, autoPullAttemptAt: null, hookHintedAt: null });

    // Now write bundle TWO and mutate it — bundle ONE must be untouched.
    await writeCursor(keyTwo, { tier: "git", token: boardHead(topoTwo.a) }, home);
    await writeSyncState(keyTwo, { cache: null, marker: null }, home);
    assert.deepEqual(await readCursor(keyOne, home), { tier: "git", token: boardHead(topoOne.a) });
    assert.deepEqual(await readCache(keyOne, undefined, home), sampleCache());
    assert.ok(await readMarker(keyOne, undefined, home));
    assert.deepEqual(await readCursor(keyTwo, home), { tier: "git", token: boardHead(topoTwo.a) });

    // Path-fallback keys for the two boards are distinct too.
    assert.notEqual(bundleKey({ root: topoOne.a.board }), bundleKey({ root: topoTwo.a.board }));
  } finally {
    await topoOne.cleanup();
    await topoTwo.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

// ── dangling-SHA → honest re-anchor note (store side) ─────────────────────────

test("re-anchor: a dangling cursor SHA is re-anchored with the HONEST note — never a silent skip, never fatal", async () => {
  const home = await tempHome();
  const topo = await makeTwoCloneTopology();
  try {
    const url = git(topo.a.root, ["remote", "get-url", "origin"]).trim();
    const key = bundleKey({ remoteUrl: url, subpath: BUNDLE_DIR, checkoutRoot: topo.a.board });

    // Store a cursor whose SHA is subsequently rewritten OUT of history and pruned (U0 fixture).
    const dangling = await danglingCursorSha(topo.a);
    await writeCursor(key, { tier: "git", token: dangling }, home);

    // The CALLER's existence guard (U1's job — reproduced here test-side): `git cat-file -e`
    // fails for the stored token…
    assert.notEqual(gitTry(topo.a.board, ["cat-file", "-e", `${dangling}^{commit}`]).status, 0);
    // …and the store still reads it back fine (the store never interprets the token).
    assert.deepEqual(await readCursor(key, home), { tier: "git", token: dangling });

    // On the miss the caller re-anchors to HEAD, recording the honest note atomically.
    const head = boardHead(topo.a);
    assert.equal(gitTry(topo.a.board, ["cat-file", "-e", `${head}^{commit}`]).status, 0);
    const now = new Date("2026-07-07T12:00:00.000Z");
    const written = await recordReanchor(
      key,
      { tier: "git", token: head },
      { unpushedCount: 3, uncommittedCount: 0 },
      home,
      () => now,
    );

    const state = await readSyncState(key, home);
    assert.deepEqual(state.cursor, { tier: "git", token: head }, "cursor re-anchored to HEAD");
    assert.deepEqual(state.cache, written);
    assert.equal(state.cache!.note, REANCHOR_NOTE, "the honest 'delta unavailable' note is recorded");
    assert.equal(REANCHOR_NOTE, "delta unavailable (history rewritten or repositioned)");
    assert.deepEqual(state.cache!.delta, [], "no fabricated delta across a rewrite");
    assert.equal(state.cache!.unpushedCount, 3, "backstop counts carried through the re-anchor");
    assert.equal(state.cache!.updatedAt, now.toISOString());
  } finally {
    await topo.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

// ── the store factory (board-git A0: the package-ready injection seam) ────────

test("createSyncStore: injected stateDir + writeAtomic own persistence — reads/writes round-trip through the injected seams only", async () => {
  const home = await tempHome();
  try {
    const stateDir = path.join(home, "custom-state");
    const writes: Array<{ dir: string; fileName: string }> = [];
    const store = createSyncStore({
      stateDir,
      writeAtomic: async (dir, fileName, content) => {
        writes.push({ dir, fileName });
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, fileName), content, "utf8");
      },
    });
    const key = bundleKey({ root: "/w/injected/.agentstate-lite" });

    assert.equal(await store.readCursor(key), null, "empty store reads null");
    await store.writeCursor(key, { tier: "git", token: "a".repeat(40) });
    assert.deepEqual(await store.readCursor(key), { tier: "git", token: "a".repeat(40) });

    // Persistence went through the INJECTED seams: the write named the injected dir, and the
    // state file sits under the injected root (nothing under the product root).
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.dir, stateDir);
    assert.equal(path.dirname(store.statePath(key)), stateDir);
    assert.equal(writes[0]!.fileName, path.basename(store.statePath(key)));
    assert.ok(store.exportsDir(key).startsWith(path.join(stateDir, "exports")));

    // The free functions are per-home projections of the SAME implementation: a different home
    // sees nothing from the injected store.
    assert.equal(await readCursor(key, home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("defaultSyncStore: resolves the home directory PER OPERATION (the HOME-swapping test pattern keeps working)", async () => {
  const home = await tempHome();
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const key = bundleKey({ root: "/w/default-store/.agentstate-lite" });
    await defaultSyncStore.writeCursor(key, { tier: "git", token: "b".repeat(40) });
    // The write landed under the SWAPPED home — proving lazy per-call resolution — and the
    // free-function projection over the same home reads the identical state.
    assert.deepEqual(await readCursor(key, home), { tier: "git", token: "b".repeat(40) });
    assert.equal(path.dirname(defaultSyncStore.statePath(key)), syncStateDir(home));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await rm(home, { recursive: true, force: true });
  }
});
