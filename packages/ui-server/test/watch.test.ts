import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { MemoryBackend, deleteDoc, writeBlob, writeDoc, type Bundle } from "@superbee/core";
import { startWatcher, type ChangeEvent } from "../src/watch.js";

const REGISTRY = "views-registry/board";
const POLL_MS = 2_000;

class ScanBackend extends MemoryBackend {
  scans = 0;
  beforeScan?: () => Promise<void>;
  override async list(prefix?: string) {
    this.scans++;
    await this.beforeScan?.();
    return super.list(prefix);
  }
}

class NativeWatcher extends EventEmitter {
  closes = 0;
  notify = () => {};
  close() { this.closes++; }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function fixture(t: TestContext, attach?: (backend: ScanBackend) => void, now = () => 0) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(performance, "now", now);
  const backend = new ScanBackend();
  const bundle: Bundle = { root: "memory://watch-test", backend };
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
