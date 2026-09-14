import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { MemoryBackend } from "@superbee/core";
import { createRouter } from "../src/router.js";
import { MemoryOperationOutcomeStore, type OperationOutcomeStore } from "../src/operation-outcomes.js";

const bundle = "bnd_00112233445566778899aabbccddeeff";
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function put() {
  return new Request(`https://wire.example/v0/bundles/${bundle}/docs/concepts/a`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "async-1", "If-None-Match": "*" },
    body: JSON.stringify({ frontmatter: { type: "Concept" }, body: "one" }),
  });
}

function fixture(backend = new MemoryBackend()) {
  const memory = new MemoryOperationOutcomeStore();
  const entered = deferred();
  const gate = deferred();
  let releases = 0;
  let records = 0;
  const store: OperationOutcomeStore = {
    lookup: (scope, key) => memory.lookup(scope, key),
    claim: async (scope, key) => {
      const claim = await memory.claim(scope, key);
      if (claim.kind !== "claimed") return claim;
      return {
        kind: "claimed",
        record: async (operation) => {
          records++;
          entered.resolve();
          await gate.promise;
          return claim.record(operation);
        },
        release: async () => {
          releases++;
          entered.resolve();
          await gate.promise;
          await claim.release();
        },
      };
    },
  };
  const router = createRouter({
    outcomes: store,
    capabilities: { enforced_cas: true, blobs: true, projections: true, backlinks: false },
    resolveContext: () => ({ backend, attribution: { actor: "tester" } }),
  });
  return { router, memory, backend, entered, gate, counts: () => ({ releases, records }) };
}

for (const refused of [false, true]) {
  test(`identified ${refused ? "refusal" : "success"} and duplicate await asynchronous recording`, { timeout: 5000 }, async () => {
    const f = fixture();
    if (refused) await f.backend.write("concepts/a", { id: "concepts/a", frontmatter: { type: "Concept" }, body: "existing" });
    let completed = 0;
    const first = f.router(put()).then((response) => { completed++; return response; });
    await f.entered.promise;
    const duplicate = f.router(put()).then((response) => { completed++; return response; });
    await setImmediate();
    assert.equal(completed, 0, "neither caller can see an unrecorded result");
    assert.equal(await f.memory.lookup(bundle, "async-1"), null);
    f.gate.resolve();
    const [a, b] = await Promise.all([first, duplicate]);
    assert.equal(a.status, refused ? 412 : 201);
    assert.equal(b.status, a.status);
    assert.equal(await b.text(), await a.text());
    assert.deepEqual(f.counts(), { releases: 0, records: 1 });
    assert.equal((await f.memory.lookup(bundle, "async-1"))?.response.status, a.status);
  });
}

test("record failure returns no success and does not release a possibly applied write", { timeout: 5000 }, async () => {
  const f = fixture();
  const response = f.router(put());
  await f.entered.promise;
  assert.ok(await f.backend.read("concepts/a"), "the mutation already happened");
  f.gate.reject(new Error("persistence unavailable"));
  assert.equal((await response).status, 500);
  assert.deepEqual(f.counts(), { releases: 0, records: 1 });
  assert.equal((await f.memory.claim(bundle, "async-1")).kind, "in_progress");
});

for (const fails of [false, true]) {
  test(`runtime failure awaits asynchronous release${fails ? " rejection" : " completion"}`, { timeout: 5000 }, async () => {
    class FailingBackend extends MemoryBackend {
      override async write(..._args: Parameters<MemoryBackend["write"]>): ReturnType<MemoryBackend["write"]> {
        throw new Error("backend unavailable");
      }
    }
    const f = fixture(new FailingBackend());
    let completed = false;
    const response = f.router(put()).then((value) => { completed = true; return value; });
    await f.entered.promise;
    await setImmediate();
    assert.equal(completed, false);
    assert.equal((await f.memory.claim(bundle, "async-1")).kind, "in_progress");
    if (fails) f.gate.reject(new Error("release unavailable"));
    else f.gate.resolve();
    assert.equal((await response).status, 500);
    assert.deepEqual(f.counts(), { releases: 1, records: 0 });
    assert.equal((await f.memory.claim(bundle, "async-1")).kind, fails ? "in_progress" : "claimed");
  });
}
