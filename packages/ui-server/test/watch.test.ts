import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import {
  FilesystemBackend,
  MemoryBackend,
  deleteDoc,
  initBundle,
  toPosix,
  writeBlob,
  writeDoc,
  type Bundle,
} from "@superbee/core";
import { createRouter } from "@superbee/server";
import { bootUiServer } from "../src/server.js";
import { HELD_HINT_MAX_WAIT_MS, startWatcher, watchDirectory, type ChangeEvent } from "../src/watch.js";

const REGISTRY = "views-registry/board";
const POLL_MS = 2_000;

// Memory documents with the real walk rule; the constructor touches no filesystem.
const WALK_RULE = new FilesystemBackend("/superbee-watch-test-walk-rule");

class ScanBackend extends MemoryBackend {
  scans = 0;
  beforeScan?: () => Promise<void>;
  classifyChangedPath = (relPath: string) => WALK_RULE.classifyChangedPath(relPath);
  override async list(prefix?: string) {
    this.scans++;
    await this.beforeScan?.();
    return super.list(prefix);
  }
}

class NativeWatcher extends EventEmitter {
  closes = 0;
  notify: (filename?: string | null) => void = () => {};
  close() { this.closes++; }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function fixture(t: TestContext, attach?: (backend: ScanBackend) => void, now = () => 0, root = "memory://watch-test") {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(performance, "now", now);
  const backend = new ScanBackend();
  const bundle: Bundle = { root, backend };
  await writeDoc(bundle, { id: REGISTRY, frontmatter: { type: "View", entry: "views/board.html" }, body: "" });
  await writeBlob(bundle, "views/board.html", new TextEncoder().encode("old"), "text/html");
  const events: ChangeEvent[] = [];
  const errors: unknown[] = [];
  const native = new NativeWatcher();
  let attachments = 0;
  const handle = await startWatcher({ mode: "dir", bundle, onChange: (e) => events.push(e), onError: (e) => errors.push(e),
    watch: (_root, notify) => {
      attachments++;
      native.notify = notify;
      attach?.(backend);
      return native;
    } });
  t.after(() => handle.stop());
  const advance = async (ms = POLL_MS) => {
    t.mock.timers.tick(ms);
    // Drain the snapshot's promises without advancing another interval.
    await setImmediate();
  };
  return { backend, bundle, events, errors, native, handle, advance, attachments };
}

test("local reconciliation observes a deleted registration without any native notification", async (t) => {
  const f = await fixture(t);
  assert.equal(f.attachments, 1, "native watch attached successfully; this is not the error fallback");
  await deleteDoc(f.bundle, REGISTRY);
  await writeDoc(f.bundle, { id: "docs/new", frontmatter: { type: "Doc" }, body: "new" });
  await writeBlob(f.bundle, "views/board.html", new TextEncoder().encode("new"), "text/html");
  await f.advance();
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.events[0]!.docs.removed, [REGISTRY]);
  assert.deepEqual(f.events[0]!.docs.changed.map((d) => d.id), ["docs/new"]);
  assert.deepEqual(f.events[0]!.blobs.changed.map((b) => b.key), ["views/board.html"]);
  await f.advance();
  assert.equal(f.events.length, 1, "unchanged polls do not repeat a removal");
  assert.deepEqual(f.errors, []);
});

for (const duration of [0, 100, 4_000]) {
  test(`the baseline scan's ${duration}ms cost sets the first idle rest`, async (t) => {
    let clockCalls = 0;
    const f = await fixture(t, undefined, () => clockCalls++ === 0 ? 0 : duration);
    await deleteDoc(f.bundle, REGISTRY);
    const rest = Math.max(POLL_MS, 10 * duration);
    await f.advance(rest - 1);
    assert.equal(f.backend.scans, 1, "no whole-bundle scan before the cost-scaled rest");
    await f.advance(1);
    assert.deepEqual(f.events.map((e) => e.docs.removed), [[REGISTRY]]);
  });
}

test("idle rest grows after a slow scan and shrinks again after a cheap one", async (t) => {
  let now = 0;
  const f = await fixture(t, undefined, () => now);
  const held = deferred();
  f.backend.beforeScan = async () => { await held.promise; };
  await f.advance();
  assert.equal(f.backend.scans, 2);
  now = 4_000;
  f.backend.beforeScan = undefined;
  held.resolve();
  await setImmediate();
  await f.advance(39_999);
  assert.equal(f.backend.scans, 2, "four seconds of work earns forty seconds of rest");
  await f.advance(1);
  assert.equal(f.backend.scans, 3);
  await f.advance(POLL_MS);
  assert.equal(f.backend.scans, 4, "a cheap scan restores the short rest");
});

test("native hints bypass a long idle rest without overlapping or duplicating reconciliation", async (t) => {
  let clockCalls = 0;
  const f = await fixture(t, undefined, () => clockCalls++ === 0 ? 0 : 4_000);
  await deleteDoc(f.bundle, REGISTRY);
  f.native.notify();
  await f.advance(150);
  assert.deepEqual(f.events.map((e) => e.docs.removed), [[REGISTRY]]);
  await f.advance(39_850);
  assert.equal(f.events.length, 1);
});

for (const fails of [false, true]) {
  test(`a slow native scan resets an old periodic deadline even when it ${fails ? "fails" : "succeeds"}`, async (t) => {
    let now = 0;
    const f = await fixture(t, undefined, () => now);
    await deleteDoc(f.bundle, REGISTRY);
    await f.advance(1_800);
    const failure = new Error("slow failed scan");
    f.backend.beforeScan = async () => {
      now = 4_000;
      f.backend.beforeScan = undefined;
      if (fails) throw failure;
    };
    f.native.notify();
    await f.advance(150);
    assert.equal(f.backend.scans, 2);
    assert.deepEqual(f.errors, fails ? [failure] : []);
    await f.advance(39_999);
    assert.equal(f.backend.scans, 2, "the old periodic deadline cannot bypass the new rest");
    await f.advance(1);
    assert.equal(f.backend.scans, 3);
    assert.deepEqual(f.events.map((e) => e.docs.removed), [[REGISTRY]]);
    await f.handle.stop();
    await f.advance(40_000);
    assert.equal(f.backend.scans, 3, "stop cancels adaptive reconciliation");
  });
}

test("local reconciliation catches deletion between the baseline and native watch attachment", async (t) => {
  let deletion!: Promise<boolean>;
  const f = await fixture(t, (backend) => { deletion = backend.delete(REGISTRY); });
  await deletion;
  await f.advance();
  assert.deepEqual(f.events.map((e) => e.docs.removed), [[REGISTRY]]);
});

test("native hints still emit before the reconciliation interval and do not duplicate its delta", async (t) => {
  const f = await fixture(t);
  await deleteDoc(f.bundle, REGISTRY);
  f.native.notify();
  await f.advance(150);
  assert.deepEqual(f.events.map((e) => e.docs.removed), [[REGISTRY]]);
  await f.advance(POLL_MS);
  assert.equal(f.events.length, 1);
});

test("a failed local scan retries on the next reconciliation without needing a new hint", async (t) => {
  const f = await fixture(t);
  await deleteDoc(f.bundle, REGISTRY);
  const failure = new Error("temporary scan failure");
  f.backend.beforeScan = async () => {
    f.backend.beforeScan = undefined;
    throw failure;
  };
  await f.advance();
  assert.deepEqual(f.errors, [failure]);
  assert.equal(f.events.length, 0);
  await f.advance();
  assert.deepEqual(f.events.map((e) => e.docs.removed), [[REGISTRY]]);
});

test("native errors or attachment failure keep exactly one reconciliation timer", async (t) => {
  for (const failure of ["attach", "later"] as const) {
    await t.test(failure, async (t) => {
      const f = await fixture(t, failure === "attach" ? () => { throw new Error("watch unavailable"); } : undefined);
      if (failure === "later") {
        f.native.emit("error", new Error("watch failed"));
        f.native.emit("error", new Error("queued second error"));
        assert.equal(f.native.closes, 1);
      }
      await deleteDoc(f.bundle, REGISTRY);
      await f.advance();
      assert.equal(f.backend.scans, 2, "one baseline and one reconciliation");
      assert.deepEqual(f.events.map((e) => e.docs.removed), [[REGISTRY]]);
      await f.advance();
      assert.equal(f.backend.scans, 3);
    });
  }
});

for (const start of ["poll", "native"] as const) {
  test(`a slow ${start} scan does not trigger continuous reconciliation of an idle bundle`, async (t) => {
    const f = await fixture(t);
    const held = deferred();
    f.backend.beforeScan = async () => { await held.promise; };
    if (start === "native") f.native.notify();
    await f.advance(start === "native" ? 150 : POLL_MS);
    assert.equal(f.backend.scans, 2);
    await f.advance(POLL_MS * 3);
    assert.equal(f.backend.scans, 2);
    f.backend.beforeScan = undefined;
    held.resolve();
    await setImmediate();
    assert.equal(f.backend.scans, 2, "periodic ticks cannot request an immediate rerun");
    if (start === "poll") {
      await f.advance(POLL_MS - 1);
      assert.equal(f.backend.scans, 2, "rest for the full interval after the slow poll settles");
      await f.advance(1);
    } else {
      await f.advance(POLL_MS);
    }
    assert.equal(f.backend.scans, 3, "reconciliation still continues after the pause");
    assert.deepEqual(f.events, []);
  });
}

test("ticks and native hints during a local scan serialize into one follow-up scan", async (t) => {
  const f = await fixture(t);
  const held = deferred();
  f.backend.beforeScan = async () => { await held.promise; };
  await f.advance();
  assert.equal(f.backend.scans, 2);
  await deleteDoc(f.bundle, REGISTRY);
  f.native.notify();
  await f.advance(POLL_MS * 3);
  assert.equal(f.backend.scans, 2, "no overlapping scan while the first is held");
  f.backend.beforeScan = undefined;
  held.resolve();
  await setImmediate();
  assert.equal(f.backend.scans, 3, "coalesced one follow-up scan");
  assert.deepEqual(f.events.map((e) => e.docs.removed), [[REGISTRY]]);
});

test("stop suppresses an in-flight deletion delta and queued native callbacks cannot restart work", async (t) => {
  const f = await fixture(t);
  const held = deferred();
  f.backend.beforeScan = async () => { await held.promise; };
  await f.advance();
  assert.equal(f.backend.scans, 2);
  await deleteDoc(f.bundle, REGISTRY);
  f.native.notify(); // pending debounce also needs clearing
  await f.handle.stop();
  f.native.notify(); // a callback already queued by the OS
  f.native.emit("error", new Error("queued after stop"));
  held.resolve();
  await setImmediate();
  await f.advance(POLL_MS * 3);
  assert.equal(f.backend.scans, 2);
  assert.equal(f.events.length, 0);
  assert.deepEqual(f.errors, []);
  assert.equal(f.native.closes, 1);
});

/** Every scan costs `cost` ms by the watcher's clock, so the rest is max(2s, 10 x cost). */
function scanCost(cost: number): () => number {
  let calls = 0;
  return () => (calls++ % 2) * cost;
}

for (const cost of [0, 4_000]) {
  test(`a sustained stream of document hints scans once per rest at ${cost}ms a scan`, async (t) => {
    const f = await fixture(t, undefined, scanCost(cost));
    const rest = Math.min(Math.max(POLL_MS, 10 * cost), HELD_HINT_MAX_WAIT_MS);
    const rests = 5;
    for (let elapsed = 0; elapsed < rest * rests; elapsed += 200) {
      f.native.notify("docs/hot.md");
      await f.advance(200);
    }
    // One baseline, the leading scan, then one scan as each rest ends.
    assert.ok(f.backend.scans - 1 <= rests + 1, `${f.backend.scans - 1} scans over ${rests} rests`);
    assert.ok(f.backend.scans - 1 >= rests, `${f.backend.scans - 1} scans: the stream must not starve scans`);
  });
}

test("a document change during a rest is seen when the rest ends, without a further hint", async (t) => {
  const f = await fixture(t, undefined, scanCost(1_000));
  f.native.notify("docs/first.md");
  await f.advance(150);
  assert.equal(f.backend.scans, 2, "the leading hint scans at once");
  await deleteDoc(f.bundle, REGISTRY);
  f.native.notify(`${REGISTRY}.md`);
  await f.advance(9_999);
  assert.equal(f.backend.scans, 2, "the deletion waits out the rest");
  assert.deepEqual(f.events, []);
  await f.advance(1);
  assert.equal(f.backend.scans, 3);
  assert.deepEqual(f.events.map((e) => e.docs.removed), [[REGISTRY]]);
});

test("a stalled hint-answering scan holds a later deletion no longer than the cap, and the periodic rest stays uncapped", async (t) => {
  const stall = 60_000;
  const f = await fixture(t, undefined, scanCost(stall));
  const held = deferred();
  f.backend.beforeScan = async () => { await held.promise; };
  f.native.notify("docs/first.md");
  await f.advance(150);
  assert.equal(f.backend.scans, 2);
  await deleteDoc(f.bundle, REGISTRY);
  f.native.notify(`${REGISTRY}.md`);
  await f.advance(stall);
  assert.equal(f.backend.scans, 2, "no scan overlaps the stalled one");
  f.backend.beforeScan = undefined;
  held.resolve();
  await setImmediate();
  await f.advance(HELD_HINT_MAX_WAIT_MS - 1);
  assert.equal(f.backend.scans, 2);
  await f.advance(1);
  assert.equal(f.backend.scans, 3);
  assert.deepEqual(f.events.map((e) => e.docs.removed), [[REGISTRY]]);

  await f.advance(10 * stall - 1);
  assert.equal(f.backend.scans, 3, "with no hints, a costly scan still earns its full periodic rest");
  await f.advance(1);
  assert.equal(f.backend.scans, 4);
});

test("a stream of hints closer than the debounce still reaches a scan within the cap", async (t) => {
  const stall = 60_000;
  const f = await fixture(t, undefined, scanCost(stall));
  f.native.notify("docs/first.md");
  await f.advance(150);
  assert.equal(f.backend.scans, 2);
  await deleteDoc(f.bundle, REGISTRY);
  for (let elapsed = 0; elapsed < HELD_HINT_MAX_WAIT_MS + 1_000; elapsed += 100) {
    f.native.notify("docs/hot.md");
    await f.advance(100);
  }
  assert.equal(f.backend.scans, 3);
  assert.deepEqual(f.events.map((e) => e.docs.removed), [[REGISTRY]]);
});

test("a hint during a hint-answering scan waits for the rest instead of chaining a scan", async (t) => {
  const f = await fixture(t, undefined, () => 0);
  const held = deferred();
  f.backend.beforeScan = async () => { await held.promise; };
  f.native.notify("docs/first.md");
  await f.advance(150);
  assert.equal(f.backend.scans, 2);
  await deleteDoc(f.bundle, REGISTRY);
  f.native.notify(`${REGISTRY}.md`);
  await f.advance(150);
  f.backend.beforeScan = undefined;
  held.resolve();
  await setImmediate();
  assert.equal(f.backend.scans, 2, "settling does not chain a scan");
  await f.advance(POLL_MS);
  assert.equal(f.backend.scans, 3);
  assert.deepEqual(f.events.map((e) => e.docs.removed), [[REGISTRY]]);
});

test("a single edit on an idle watcher is prompt at any point of a long periodic rest", async (t) => {
  const f = await fixture(t, undefined, scanCost(4_000));
  await f.advance(40_000);
  assert.equal(f.backend.scans, 2, "an idle periodic scan ran");
  await f.advance(100);
  await deleteDoc(f.bundle, REGISTRY);
  f.native.notify(`${REGISTRY}.md`);
  await f.advance(149);
  assert.equal(f.backend.scans, 2);
  await f.advance(1);
  assert.equal(f.backend.scans, 3, "the debounce alone delays it, not the periodic rest");
  assert.deepEqual(f.events.map((e) => e.docs.removed), [[REGISTRY]]);

  await writeDoc(f.bundle, { id: "docs/later", frontmatter: { type: "Doc" }, body: "" });
  await f.advance(40_000);
  assert.equal(f.backend.scans, 4, "the hint scan's rest ends in a periodic scan");
  f.native.notify("docs/later.md");
  await f.advance(150);
  assert.equal(f.backend.scans, 5, "a periodic scan after that rest does not hold back the next edit");
});

test("hints for paths the walk cannot see, and for plain files outside the snapshot, cause no scan", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "superbee-watch-hints-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "scratch.log"), "x");
  const f = await fixture(t, undefined, () => 0, root);
  for (const hidden of [".git/index", ".git/objects/ab/cd", "docs/.tmp-write", ".git", ".superbee/x.md"]) f.native.notify(hidden);
  f.native.notify("scratch.log");
  // `lstat` finishes on the thread pool, which the mock clock does not drain.
  await sleep(50);
  await f.advance(150);
  assert.equal(f.backend.scans, 1, "only the baseline scanned");

  f.native.notify("views/board.html");
  await f.advance(150);
  assert.equal(f.backend.scans, 2, "a page blob is inside the snapshot");
});

test("a plain file that replaced a directory the last snapshot read still scans", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "superbee-watch-replaced-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "archive"), "x");
  await writeFile(path.join(root, "archive-notes"), "x");
  const f = await fixture(t, undefined, () => 0, root);
  await writeDoc(f.bundle, { id: "archive/old", frontmatter: { type: "Doc" }, body: "" });
  await f.advance();
  assert.equal(f.backend.scans, 2, "the snapshot now reads archive/old");
  f.native.notify("archive-notes");
  await sleep(50);
  await f.advance(150);
  assert.equal(f.backend.scans, 2, "a shared name prefix is not a parent directory");
  f.native.notify("archive");
  await sleep(50);
  await f.advance(150);
  assert.equal(f.backend.scans, 3);
});

for (const [label, hint] of [["no filename", null], ["no argument", undefined], ["a Windows path", "docs\\win.md"]] as const) {
  test(`a hint with ${label} counts as relevant`, async (t) => {
    const f = await fixture(t);
    f.native.notify(hint);
    await f.advance(150);
    assert.equal(f.backend.scans, 2);
  });
}

test("a backend that cannot classify paths keeps every hint relevant", async (t) => {
  const f = await fixture(t);
  (f.backend as { classifyChangedPath?: unknown }).classifyChangedPath = undefined;
  f.native.notify(".git/index");
  await f.advance(150);
  assert.equal(f.backend.scans, 2);
});

// A directory can carry any name and its rename can arrive as the only notification, so an
// extension must not decide relevance.
for (const shape of ["present", "gone"] as const) {
  test(`a hint naming a ${shape} directory with a file-like name still scans`, async (t) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "superbee-watch-dir-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    if (shape === "present") await mkdir(path.join(root, "archive.log"));
    const f = await fixture(t, undefined, () => 0, root);
    f.native.notify("archive.log");
    await sleep(50);
    await f.advance(150);
    assert.equal(f.backend.scans, 2);
  });
}

test("live revocation: a bridge read is refused at once while the watcher has not reported the deletion", async () => {
  const backend = new ScanBackend();
  const bundle: Bundle = { root: "memory://watch-revocation", backend };
  const headers = { cookie: "aslite_ui_session=watch-secret", "content-type": "application/json", "x-requested-with": "agentstate-lite-ui" };
  await writeDoc(bundle, { id: "docs/secret", frontmatter: { type: "Doc", title: "Secret" }, body: "secret" });
  await writeDoc(bundle, { id: REGISTRY, frontmatter: { type: "View", title: "Board", entry: "views/board.html", access: "bundle-read" }, body: "" });
  await writeBlob(bundle, "views/board.html", new TextEncoder().encode("<!doctype html>"), "text/html; charset=utf-8");
  const server = await bootUiServer({
    mode: "dir", bundle, router: createRouter(bundle), sessionSecret: "watch-secret",
    renderDocument: ({ id, body }) => ({ html: `<article data-id="${id}">${body}</article>`, bounded: false }),
    serveAsset: () => ({ status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: new Uint8Array() }),
  });
  const post = async (route: string, body: unknown) => (await fetch(`http://${server.host}:${server.port}${route}`, {
    method: "POST", headers, body: JSON.stringify(body),
  })).json() as Promise<Record<string, any>>;
  try {
    const { launchId } = await post("/__page/mint", { registryId: REGISTRY });
    await post("/__ui/views/authorize", { launchId });
    const read = { launchId, request: { bridge: "v0", type: "read", id: "r", docId: "docs/secret" } };
    assert.equal((await post("/__ui/views/bridge", read)).reply.result.id, "docs/secret");
    const scansBefore = backend.scans;
    await deleteDoc(bundle, REGISTRY);
    const refused = await post("/__ui/views/bridge", read);
    assert.equal(refused.reply.error.code, "FORBIDDEN");
    assert.equal(backend.scans - scansBefore <= 1, true, "the refusal comes from the request's own check, not a watcher pass");
  } finally {
    await server.close();
  }
});

test("native notifications name the changed path relative to the root, including .git and documents", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "superbee-watch-native-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initBundle(root);
  await mkdir(path.join(root, ".git"));
  const seen: (string | null | undefined)[] = [];
  const events: ChangeEvent[] = [];
  const bundle: Bundle = { root, backend: new FilesystemBackend(root) };
  const handle = await startWatcher({
    mode: "dir", bundle, onChange: (e) => events.push(e),
    watch: (dir, notify) => watchDirectory(dir, (filename) => { seen.push(filename); notify(filename); }),
  });
  t.after(() => handle.stop());
  await writeFile(path.join(root, ".git", "index"), "x");
  await writeDoc(bundle, { id: "docs/native", frontmatter: { type: "Doc", title: "Native" }, body: "" });
  for (let waited = 0; waited < 15_000 && !events.some((e) => e.docs.changed.some((d) => d.id === "docs/native")); waited += 50) await sleep(50);
  assert.ok(events.some((e) => e.docs.changed.some((d) => d.id === "docs/native")), "the document change was reported");
  for (let waited = 0; waited < 5_000 && !seen.some((f) => typeof f === "string" && toPosix(f) === "docs/native.md"); waited += 50) await sleep(50);
  assert.ok(seen.some((f) => typeof f === "string" && toPosix(f) === "docs/native.md"), `native paths: ${JSON.stringify(seen)}`);
  assert.equal(seen.filter((f): f is string => typeof f === "string" && toPosix(f).startsWith(".git")).every((f) => bundle.backend!.classifyChangedPath!(f) === "hidden"), true);
});
