import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import {
  prepareBodyDelivery, validatePreparedBodyDelivery, validateBodyReceipt, assertSameBodyDelivery,
  performBodyDelivery, reconcileBodyReceipt, BODY_DELIVERY_LIMITS,
  type PreparedBodyDelivery, type CommittedBodyReceipt, type BodyDeliveryTransport, type BodyDeliveryOutcome,
} from "../src/governed-body-write.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { mutateDocument } from "../src/document-mutation.js";
import { stringifyDoc, parseMarkdown } from "../src/frontmatter.js";
import { versionOfBytes } from "../src/versioning.js";
import { performUncertainWrite } from "../src/uncertain-write.js";
import type { IntentRecord } from "../src/journaled-backend.js";

const at = "2026-09-10T12:00:00.000Z";
const token = versionOfBytes("base");
function input(body = "edited\n", requestId = "edit-1") {
  const content = stringifyDoc({ type: "Note", generated: { by: "process:local", at } }, body);
  return { scope: "selected-copy", requestId, target: "notes/example", okfVersion: "0.2" as const,
    operation: { kind: "document.body.update" as const, body }, content, local: versionOfBytes(content), createdAt: at };
}
function prepared() { return prepareBodyDelivery(input(), { expectedVersion: token }); }
function receipt(p = prepared(), content = stringifyDoc({ type: "Note", generated: { by: "process:authority", at } }, p.operation.body)): CommittedBodyReceipt {
  return { scope: p.scope, requestId: p.requestId, target: p.target, expectedVersion: p.expectedVersion,
    body: p.operation.body, version: versionOfBytes(content), content };
}
function journal(p = prepared(), sequence = 1): IntentRecord {
  return { requestId: p.requestId, kind: "document.write", target: p.target, base: token, local: p.local,
    content: p.content, createdAt: at, attempts: 0, state: "pending", sequence, updatedAt: at, baseContent: null };
}
async function authority() {
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
  const bundle = { root: "memory", backend }, registry = { kinds: new Map(), warnings: [] };
  const created = await mutateDocument({ bundle, registry, id: "notes/example", mode: "create-only", strict: false,
    actor: "process:authority", now: () => at, buildCandidate: () => ({ frontmatter: { type: "Note" }, body: "initial\n" }) });
  const saved = new Map<string, { prepared: PreparedBodyDelivery; outcome: BodyDeliveryOutcome }>();
  let writes = 0;
  const transport: BodyDeliveryTransport = {
    async submit(p) {
      const prior = saved.get(p.requestId);
      if (prior) { assertSameBodyDelivery(prior.prepared, p); return prior.outcome; }
      const result = await mutateDocument({ bundle, registry, id: p.target, mode: "patch", expectedVersion: p.expectedVersion,
        strict: false, actor: "process:authority", now: () => "2026-09-10T12:01:00.000Z",
        buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: p.operation.body }) });
      writes++;
      const outcome: BodyDeliveryOutcome = { kind: "committed", receipt: { ...receipt(p, stringifyDoc(result.doc.frontmatter, result.doc.body)), version: result.version } };
      saved.set(p.requestId, { prepared: p, outcome }); return outcome;
    },
    async lookup(p) { const prior = saved.get(p.requestId); if (!prior) return null; assertSameBodyDelivery(prior.prepared, p); return prior.outcome; },
  };
  return { backend, transport, base: created.version, writes: () => writes };
}

const rows: Array<{ name: string; run: () => unknown | Promise<unknown> }> = [
  { name: "authority metadata and immutable predecessor snapshots", async run() {
    const a = await authority(), p = prepareBodyDelivery(input(), { expectedVersion: a.base });
    const first = await performBodyDelivery(a.transport, p, 0);
    assert.equal(first.outcome.kind, "committed"); if (first.outcome.kind !== "committed") return;
    const r = first.outcome.receipt;
    assert.notEqual(r.version, p.local);
    assert.equal(parseMarkdown(r.content).frontmatter.generated?.by, "process:authority");
    const next = prepareBodyDelivery(input("next\n", "edit-2"), { prepared: p, receipt: r });
    assert.equal(next.expectedVersion, r.version);
    await performBodyDelivery(a.transport, next, 0);
    assert.notEqual((await a.backend.read(p.target))!.version, r.version);
    const recovered = await performBodyDelivery(a.transport, JSON.parse(JSON.stringify(p)), 1);
    assert.deepEqual(recovered.outcome, first.outcome);
    assert.equal(a.writes(), 2);
    const proposal = reconcileBodyReceipt(p, r, { version: p.local, intents: [journal(p)], shared: { version: p.expectedVersion, content: p.content } });
    assert.equal(proposal.action, "replace-local-under-CAS");
    assert.equal(proposal.shared.action, "replace-shared-under-CAS");
    if (proposal.shared.action === "replace-shared-under-CAS") assert.equal(proposal.shared.content, r.content);
  } },
  { name: "lost reply reload looks up before submitting and mutates once", async run() {
    const a = await authority(), p = prepareBodyDelivery(input(), { expectedVersion: a.base });
    const lost: BodyDeliveryTransport = { submit: async p => { await a.transport.submit(p); throw new Error("lost"); }, lookup: async () => { throw new Error("offline"); } };
    const first = await performBodyDelivery(lost, p, 0, { maxLookups: 1 });
    assert.equal(first.outcome.kind, "unknown"); assert.equal(first.attempts, 1);
    let submits = 0;
    const result = await performBodyDelivery({ ...a.transport, submit: async () => { submits++; throw new Error("unexpected"); } }, JSON.parse(JSON.stringify(first.prepared)), first.attempts);
    assert.equal(result.outcome.kind, "committed"); assert.equal(submits, 0); assert.equal(a.writes(), 1);
  } },
  { name: "unavailable evidence never blindly resubmits", async run() {
    for (const lookup of [async () => ({ kind: "unknown" as const }), async () => { throw new Error("offline"); }]) {
      let calls = 0;
      const result = await performBodyDelivery({ submit: async () => { calls++; return { kind: "unknown" }; }, lookup }, prepared(), 1, { maxLookups: 1 });
      assert.equal(result.outcome.kind, "unknown"); assert.equal(calls, 0);
    }
    let calls = 0;
    const result = await performBodyDelivery({ submit: async p => { calls++; return { kind: "committed", receipt: receipt(p) }; }, lookup: async () => null }, prepared(), 1);
    assert.equal(result.outcome.kind, "committed"); assert.equal(calls, 1);
  } },
  { name: "exact-content legacy settlement stays default and governed conflicts stay conflicts", async run() {
    const p = prepared(), intent = journal(p);
    const transport = { submit: async () => ({ kind: "conflict" as const, actual: p.local }), lookup: async () => null };
    assert.equal((await performUncertainWrite(transport, intent)).outcome.kind, "committed");
    assert.equal((await performUncertainWrite(transport, intent, { settlement: "recorded-only" })).outcome.kind, "conflict");
    assert.equal((await performBodyDelivery(transport, p, 0)).outcome.kind, "conflict");
    let calls = 0;
    await assert.rejects(performUncertainWrite({ ...transport, submit: async () => { calls++; return { kind: "unknown" }; } }, intent, { settlement: "wrong" as never }));
    assert.equal(calls, 0);
  } },
  { name: "receipt binding and content failures never authorize a successor", async run() {
    const p = prepared();
    for (const changes of [{ scope: "other" }, { requestId: "other" }, { target: "notes/other" }, { expectedVersion: p.local },
      { body: "other" }, { content: "---\ntype: Note\n---\nunrelated\n" }, { content: "---\ntype: ''\n---\nedited\n" }, { content: undefined }, { version: "bad" }, { extra: true }]) {
      const r = { ...receipt(p), ...changes };
      assert.throws(() => validateBodyReceipt(p, r));
      assert.throws(() => prepareBodyDelivery(input("next", "next"), { prepared: p, receipt: r as never }));
      const result = await performBodyDelivery({ submit: async () => ({ kind: "committed", receipt: r as never }), lookup: async () => ({ kind: "committed", receipt: r as never }) }, p, 0);
      assert.equal(result.outcome.kind, "unknown"); assert.ok(result.diagnostic);
    }
  } },
  { name: "strict inputs reject extra operations fields identities and oversized bytes before calls", async run() {
    const p = prepared(); let calls = 0;
    const t: BodyDeliveryTransport = { submit: async () => { calls++; return { kind: "unknown" }; }, lookup: async () => { calls++; return null; } };
    for (const changes of [{ operation: { kind: "document.write", body: "edited\n" } }, { operation: { ...p.operation, frontmatter: {} } },
      { create: true }, { schema: 2 }, { okfVersion: "0.3" }, { scope: "" }, { target: "../bad" }, { target: "notes/index" },
      { requestId: ".." }, { createdAt: "2026-02-30T12:00:00Z" }, { local: token }, { expectedVersion: null },
      { operation: { ...p.operation, body: "x".repeat(BODY_DELIVERY_LIMITS.bodyBytes + 1) } }]) {
      await assert.rejects(performBodyDelivery(t, { ...p, ...changes } as never, 0));
    }
    for (const attempts of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER]) await assert.rejects(performBodyDelivery(t, p, attempts));
    for (const opts of [{ settlement: "exact-content" }, { maxSubmissions: NaN }, { maxLookups: -1 }, { sleep: 7 }, { extra: 1 }]) await assert.rejects(performBodyDelivery(t, p, 0, opts as never));
    assert.equal(calls, 0);
  } },
  { name: "frozen preparation rejects changed reloads and arbitrary successor premises", run() {
    const original = input(); const p = prepareBodyDelivery(original, { expectedVersion: token });
    original.operation.body = "changed";
    assert.equal(p.operation.body, "edited\n"); assert.ok(Object.isFrozen(p.operation));
    const reload = validatePreparedBodyDelivery(JSON.parse(JSON.stringify(p)));
    assertSameBodyDelivery(p, reload);
    assert.throws(() => assertSameBodyDelivery(p, { ...reload, scope: "other" }));
    assert.throws(() => prepareBodyDelivery(input("next", "next"), { acknowledgedVersion: token } as never));
    for (const changes of [{ scope: "other" }, { target: "notes/other" }, { okfVersion: "0.1" }, { requestId: p.requestId }]) {
      assert.throws(() => prepareBodyDelivery({ ...input("next", "next"), ...changes } as never, { prepared: p, receipt: receipt(p) }));
    }
  } },
  { name: "raw original hash and canonical receipt content use separate rules", run() {
    const raw = "---\r\ntype: Note\r\ntitle: 'old'\r\n---\r\nedited\n";
    const parsed = parseMarkdown(raw, "notes/example", { okfVersion: "0.2" });
    const p = prepareBodyDelivery({ ...input(parsed.body), content: raw, local: versionOfBytes(raw) }, { expectedVersion: token });
    const r = { ...receipt(p, stringifyDoc(parsed.frontmatter, parsed.body)), version: versionOfBytes(raw) };
    assert.notEqual(versionOfBytes(r.content), r.version);
    assert.equal(validateBodyReceipt(p, r).version, r.version);
    assert.throws(() => validatePreparedBodyDelivery({ ...p, local: versionOfBytes(r.content) }));
  } },
  { name: "every newer local journal intent preserves content even when bytes match", run() {
    const p = prepared(), r = receipt(p), anchor = journal(p);
    for (const state of ["pending", "in_flight", "unknown", "conflict", "refused", "acknowledged"] as const) {
      const snapshot = { version: p.local, intents: [anchor, { ...anchor, requestId: "later", sequence: 2, state }], shared: { version: p.expectedVersion, content: p.content } };
      const before = JSON.stringify(snapshot);
      const result = reconcileBodyReceipt(p, r, snapshot);
      assert.equal(result.action, "preserve-local"); assert.equal(JSON.stringify(snapshot), before);
      assert.deepEqual(result.expected, snapshot); assert.ok(Object.isFrozen(result.expected.intents[1]));
    }
    for (const intents of [[], [{ ...anchor, target: "notes/other" }], [{ ...anchor, content: "other" }]]) {
      assert.equal(reconcileBodyReceipt(p, r, { version: p.local, intents, shared: { version: p.expectedVersion, content: p.content } }).action, "preserve-local");
    }
    assert.equal(reconcileBodyReceipt(p, r, { version: token, intents: [anchor], shared: null }).action, "preserve-local");
    assert.throws(() => reconcileBodyReceipt(p, r, { version: p.local, intents: [anchor, anchor], shared: null }));
    assert.throws(() => reconcileBodyReceipt(p, r, { version: p.local, intents: [{ ...anchor, attempts: NaN }], shared: null }));
  } },
  { name: "stale receipts and independent shared refresh preserve the shared base", run() {
    const p = prepared(), r = receipt(p), anchor = journal(p);
    const next = prepareBodyDelivery(input("second", "second"), { prepared: p, receipt: r });
    const nextReceipt = receipt(next);
    const successor = { ...journal(next, 2), state: "acknowledged" as const, acknowledgedVersion: nextReceipt.version };
    for (const snapshot of [
      { version: next.local, intents: [anchor, successor], shared: { version: nextReceipt.version, content: nextReceipt.content } },
      { version: p.local, intents: [anchor], shared: { version: nextReceipt.version, content: nextReceipt.content } },
      { version: p.local, intents: [anchor, successor], shared: { version: p.expectedVersion, content: p.content } },
      { version: p.local, intents: [], shared: { version: p.expectedVersion, content: p.content } },
      { version: p.local, intents: [anchor], shared: null },
    ]) {
      const proposal = reconcileBodyReceipt(p, r, snapshot);
      assert.equal(proposal.action, "preserve-local"); assert.deepEqual(proposal.shared, { action: "preserve-shared" });
      assert.deepEqual(proposal.expected, snapshot); assert.deepEqual(proposal.receipt, r);
      assert.ok(Object.isFrozen(proposal.expected.shared) || proposal.expected.shared === null);
    }
  } },
  { name: "exact shared receipt permits idempotent local reconciliation but mismatched content does not", run() {
    const p = prepared(), r = receipt(p);
    for (const content of [r.content, p.content]) {
      const proposal = reconcileBodyReceipt(p, r, { version: p.local, intents: [journal(p)], shared: { version: r.version, content } });
      assert.equal(proposal.action, content === r.content ? "replace-local-under-CAS" : "preserve-local");
      assert.deepEqual(proposal.shared, { action: "preserve-shared" });
    }
    const sameVersionReceipt = { ...r, version: p.expectedVersion };
    const proposal = reconcileBodyReceipt(p, sameVersionReceipt, { version: p.local, intents: [journal(p)], shared: { version: p.expectedVersion, content: p.content } });
    assert.equal(proposal.action, "preserve-local"); assert.deepEqual(proposal.shared, { action: "preserve-shared" });
  } },
  { name: "authorization refusal remains a refusal", async run() {
    const outcome = { kind: "refused" as const, code: "FORBIDDEN", message: "Write permission required" };
    const result = await performBodyDelivery({ submit: async () => outcome, lookup: async () => outcome }, prepared(), 0);
    assert.deepEqual(result.outcome, outcome); assert.equal(result.state, "refused");
  } },
  { name: "deadline-late response cannot replace lookup evidence", async run() {
    const p = prepared(), first = receipt(p), late = { ...receipt(p), version: token };
    let resolve!: (v: BodyDeliveryOutcome) => void;
    const result = await performBodyDelivery({ submit: () => new Promise(r => { resolve = r; }), lookup: async () => ({ kind: "committed", receipt: first }) }, p, 0,
      { deadlineMs: 1, sleep: async () => {} });
    resolve({ kind: "committed", receipt: late }); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(result.outcome, { kind: "committed", receipt: first });
  } },
];
for (const row of rows) test(`body delivery: ${row.name}`, row.run);

test("body delivery package subpath resolves in a browser consumer", async () => {
  const result = await build({ stdin: { contents: 'export { performBodyDelivery } from "@superbee/core/governed-body-write";', resolveDir: process.cwd() },
    bundle: true, platform: "browser", write: false, logLevel: "silent" });
  assert.ok(result.outputFiles[0]!.text.includes("performBodyDelivery"));
});
