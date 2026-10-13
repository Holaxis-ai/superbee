import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeDocumentTargetV1 as targetDecode, decodeDocumentObservationV1 as observationDecode,
  decodePresentDocumentRequestV1 as requestDecode, decodePresentDocumentReceiptV1 as receiptDecode,
  decodeDocumentPresentationCapabilitiesV1 as capabilitiesDecode, sameDocumentTargetV1,
  compareAuthorityVersionV1, type DocumentTargetV1, type DocumentObservationV1,
  type PresentDocumentRequestV1, type ArtifactDecodeResult,
} from "../src/artifact-contract.js";
const v = `sha256:${"a".repeat(64)}`, other = `sha256:${"b".repeat(64)}`;
const target: DocumentTargetV1 = { schemaVersion: "superbee.document-target.v1", authority: { mode: "local", authorityKey: "root-digest" }, bundleKey: "selected", documentId: "x.md" };
const observed: DocumentObservationV1 = { schemaVersion: "superbee.document-observation.v1", target, provenance: { state: "shared-confirmed", version: v, acknowledged: other }, lifecycle: { state: "unverified" } };
const request: PresentDocumentRequestV1 = { schemaVersion: "superbee.present-document.v1", operation: "present_document", invocationId: "invocation", target, referenceVersion: v };
const receipt = { schemaVersion: "superbee.present-document-receipt.v1", operation: "present_document", invocationId: request.invocationId, target, ok: true, presentation: { state: "open_requested", observation: observed } };
function valid<T>(result: ArtifactDecodeResult<T>): T { assert.equal(result.ok, true); if (!result.ok) throw new Error(result.code); return result.value; }
function invalid(result: ArtifactDecodeResult<unknown>, code = "invalid_input") { assert.deepEqual(result, { ok: false, code }); }

for (const id of ["x", "x.md", "index", "index.md", "log.md", "docs/雪 🐝", "x".repeat(1024)]) {
  test(`canonical ID remains exact: ${id.slice(0, 30)}`, () => assert.equal(valid(targetDecode({ ...target, documentId: id })).documentId, id));
}
for (const id of ["", " ", "../x", "/x", "x//y", "./x", "x/./y", "x/../y", "x\\y", "C:x", "x.md/y", "x\0"]) {
  test(`canonical ID refuses alias/traversal: ${JSON.stringify(id)}`, () => invalid(targetDecode({ ...target, documentId: id })));
}
test("target identity includes mode, authority, workspace, bundle and exact ID", () => {
  const hosted: DocumentTargetV1 = { ...target, authority: { mode: "hosted", authorityKey: "root-digest", workspaceKey: "workspace" } };
  assert.equal(sameDocumentTargetV1(target, valid(targetDecode(target))), true);
  for (const changed of [{ ...target, documentId: "x" }, { ...target, bundleKey: "other" }, { ...target, authority: { mode: "local" as const, authorityKey: "other" } }, hosted]) assert.equal(sameDocumentTargetV1(target, changed), false);
  assert.equal(sameDocumentTargetV1(hosted, { ...hosted, authority: { ...hosted.authority, mode: "hosted", workspaceKey: "other" } }), false);
});
for (const value of ["", "a b", "a/b", "a\\b", "a\t", "é", "a".repeat(257)]) {
  test(`opaque key refuses ${JSON.stringify(value).slice(0, 30)}`, () => {
    invalid(targetDecode({ ...target, bundleKey: value }));
    invalid(targetDecode({ ...target, authority: { mode: "hosted", authorityKey: "host", workspaceKey: value } }));
    invalid(requestDecode({ ...request, invocationId: value }));
    invalid(observationDecode({ ...observed, lifecycle: { state: "bound", sourceToken: value, documentToken: "doc" } }));
  });
}
test("opaque keys accept exact 256 printable bytes without normalization", () => {
  assert.equal(valid(targetDecode({ ...target, bundleKey: "a".repeat(256) })).bundleKey.length, 256);
  assert.equal(valid(targetDecode({ ...target, authority: { mode: "local", authorityKey: "Case:!" } })).authority.authorityKey, "Case:!");
});

test("provenance compares authority acknowledgement, preserves pending/conflict and requestId domain", () => {
  assert.equal(compareAuthorityVersionV1(valid(observationDecode(observed)), v), "different");
  assert.equal(compareAuthorityVersionV1(observed, other), "same");
  for (const state of ["local-pending", "local-conflict"] as const) for (const base of [null, v]) {
    const provenance = { state, version: v, base, requestId: " outside/key grammar\n".repeat(40), ...(state === "local-conflict" ? { remote: null } : {}) };
    const value = valid(observationDecode({ ...observed, provenance }));
    assert.deepEqual(value.provenance, provenance);
    assert.equal(compareAuthorityVersionV1(value, v), "unconfirmed");
  }
  invalid(observationDecode({ ...observed, provenance: { ...observed.provenance, requestId: "contradiction" } }));
  invalid(observationDecode({ ...observed, provenance: { state: "local-pending", version: v, base: null, requestId: "", remote: v } }));
  valid(observationDecode({ ...observed, provenance: { state: "local-conflict", version: v, base: null, requestId: "", remote: other } }));
});
for (const bad of ["sha256:ABC", `sha256:${"A".repeat(64)}`, v + "\n", null, 3]) test(`version owner refuses ${String(bad).slice(0, 20)}`, () => {
  invalid(requestDecode({ ...request, referenceVersion: bad }));
  invalid(observationDecode({ ...observed, provenance: { state: "shared-confirmed", version: v, acknowledged: bad } }));
});

test("new envelopes reject exotic records without reading own getters", () => {
  let calls = 0;
  const accessor = { ...target };
  Object.defineProperty(accessor, "documentId", { get() { calls++; throw new Error("must not execute"); } });
  const cycle: Record<string, unknown> = { ...target }; cycle.extra = cycle;
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const badInputs = [null, [], new Date(), Object.create(target), { ...target, extra: true }, { ...target, [Symbol("hidden")]: true }, accessor, cycle, revoked.proxy,
    new Proxy(target, { ownKeys() { throw new Error("reflection"); } }),
    new Proxy(target, { getOwnPropertyDescriptor() { throw new Error("reflection"); } }),
    new Proxy(target, { getPrototypeOf() { throw new Error("reflection"); } })];
  for (const input of badInputs) invalid(targetDecode(input));
  assert.equal(calls, 0);
  assert.deepEqual(valid(targetDecode(Object.assign(Object.create(null), target))), target);
});
test("every decoder catches reflection, cycles and scalar failure before schema classification", () => {
  const decoders = [targetDecode, observationDecode, requestDecode, capabilitiesDecode, (value: unknown) => receiptDecode(value, request)];
  for (const decode of decoders) {
    const cyclic: Record<string, unknown> = { schemaVersion: "future" }; cyclic.self = cyclic;
    invalid(decode(cyclic));
    invalid(decode({ schemaVersion: "future", extra: Infinity }));
    invalid(decode({ schemaVersion: "future", [Symbol("s")]: 1 }));
    invalid(decode({ schemaVersion: "future" }), "unsupported_version");
    invalid(decode({})); invalid(decode({ schemaVersion: 1 }));
  }
});
test("cloned accepted graphs allow repeated noncyclic references and resist later input mutation", () => {
  const input = structuredClone(receipt);
  input.presentation.observation.target = input.target;
  const parsed = valid(receiptDecode(input, request));
  input.target.documentId = "mutated";
  input.presentation.observation.provenance.version = other;
  assert.equal(parsed.target.documentId, "x.md");
  assert.ok(parsed.ok);
  assert.equal(parsed.presentation.observation?.target.documentId, "x.md");
  assert.equal(parsed.presentation.observation?.provenance.version, v);
  const req = structuredClone(request); const parsedReq = valid(requestDecode(req)); req.target.documentId = "mutated";
  assert.equal(parsedReq.target.documentId, "x.md");
});
test("schema/field failures precede receipt correlation mismatch", () => {
  invalid(receiptDecode({ ...receipt, invocationId: "other", schemaVersion: "superbee.present-document-receipt.v2" }, request), "unsupported_version");
  invalid(receiptDecode({ ...receipt, invocationId: "other", operation: "other" }, request));
  invalid(receiptDecode({ ...receipt, invocationId: "other", presentation: { state: "offered", expiresAt: -1 } }, request));
  invalid(receiptDecode({ ...receipt, invocationId: "other", presentation: { state: "open_requested", observation: { ...observed, lifecycle: { state: "bound", sourceToken: "s" } } } }, request));
});
test("receipts correlate the full target, invocation and observation even on error", () => {
  for (const changed of [{ ...target, documentId: "x" }, { ...target, bundleKey: "elsewhere" }, { ...target, authority: { mode: "local", authorityKey: "elsewhere" } }]) {
    invalid(receiptDecode({ ...receipt, target: changed }, request), "receipt_mismatch");
    invalid(receiptDecode({ ...receipt, presentation: { state: "open_requested", observation: { ...observed, target: changed } } }, request), "receipt_mismatch");
  }
  invalid(receiptDecode({ ...receipt, invocationId: "different" }, request), "receipt_mismatch");
  invalid(receiptDecode({ ...receipt, ok: false, presentation: undefined, error: { code: "busy", retryable: true } }, request));
  const errorReceipt = { schemaVersion: receipt.schemaVersion, operation: receipt.operation, target, invocationId: "other", ok: false, error: { code: "busy", retryable: true } };
  invalid(receiptDecode(errorReceipt, request), "receipt_mismatch");
});
test("expected lifecycle cannot succeed without matching bound observation", () => {
  const expectedLifecycle = { state: "bound" as const, sourceToken: "source", documentToken: "doc" };
  const expected = valid(requestDecode({ ...request, expectedLifecycle }));
  invalid(requestDecode({ ...request, expectedLifecycle: { state: "unverified" } }));
  for (const state of ["open_requested", "navigated", "offered", "payload_prepared"]) {
    const common = { state, ...(state === "offered" ? { expiresAt: 0 } : {}) };
    if (state !== "payload_prepared") invalid(receiptDecode({ ...receipt, presentation: common }, expected), "receipt_mismatch");
    for (const lifecycle of [{ state: "unverified" }, { ...expectedLifecycle, sourceToken: "other" }, { ...expectedLifecycle, documentToken: "other" }]) invalid(receiptDecode({ ...receipt, presentation: { ...common, observation: { ...observed, lifecycle } } }, expected), "receipt_mismatch");
    valid(receiptDecode({ ...receipt, presentation: { ...common, observation: { ...observed, lifecycle: expectedLifecycle } } }, expected));
  }
});
test("presentation states, historical expiry and capabilities have exact finite shapes", () => {
  for (const expiresAt of [0, Number.MAX_SAFE_INTEGER]) valid(receiptDecode({ ...receipt, presentation: { state: "offered", expiresAt } }, request));
  for (const expiresAt of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) invalid(receiptDecode({ ...receipt, presentation: { state: "offered", expiresAt } }, request));
  invalid(receiptDecode({ ...receipt, presentation: { state: "payload_prepared" } }, request));
  invalid(receiptDecode({ ...receipt, presentation: { state: "navigated", expiresAt: 0 } }, request));
  for (const states of [[], ["open_requested", "payload_prepared", "offered", "navigated"]]) assert.deepEqual(valid(capabilitiesDecode({ schemaVersion: "superbee.document-presentation-capabilities.v1", states })).states, states);
  for (const states of [["offered", "offered"], ["rendered"], new Array(1), { 0: "offered", length: 1 }]) invalid(capabilitiesDecode({ schemaVersion: "superbee.document-presentation-capabilities.v1", states }));
  const accessors = ["offered"]; Object.defineProperty(accessors, "0", { get() { throw new Error("no"); } });
  invalid(capabilitiesDecode({ schemaVersion: "superbee.document-presentation-capabilities.v1", states: accessors }));
});
test("retryable errors only permit busy/unavailable and disclose no extra detail", () => {
  const base = { schemaVersion: receipt.schemaVersion, operation: receipt.operation, target, invocationId: request.invocationId, ok: false };
  for (const code of ["invalid_input", "unsupported_version", "unsupported_operation", "unsupported_host", "unavailable", "unavailable_stale_target", "context_changed", "presentation_disabled", "busy"]) {
    valid(receiptDecode({ ...base, error: { code, retryable: false } }, request));
    const result = receiptDecode({ ...base, error: { code, retryable: true } }, request);
    if (code === "busy" || code === "unavailable") valid(result); else invalid(result);
  }
  invalid(receiptDecode({ ...base, error: { code: "busy", retryable: true, message: "private" } }, request));
  invalid(receiptDecode({ ...base, error: { code: "unknown", retryable: false } }, request));
});
test("cross-surface fixtures exercise codecs only, without claiming client adoption", () => {
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/artifact-contract/surfaces.json", import.meta.url), "utf8"));
  for (const fixture of fixtures) {
    const expected = valid(requestDecode(fixture.request));
    assert.equal(valid(receiptDecode(fixture.receipt, expected)).ok, true, fixture.surface);
    valid(capabilitiesDecode(fixture.capabilities));
  }
});
