import test from "node:test";
import assert from "node:assert/strict";
// v1 View actions through the operation-mapped View bridge host.
import {
  createViewBridgeHost,
  type ViewBridgeFrame,
} from "../dist/view-bridge-host.js";
const version = "sha256:" + "a".repeat(64);
const action = {
  kind: "document.update",
  docId: "notes/sample",
  field: "document",
  value: { fields: { title: "Changed" }, body: "Draft\n" },
  expectedVersion: version,
};
function fixture() {
  const replies: any[] = [],
    proposals: any[] = [];
  let resolve: ((value: unknown) => void) | undefined;
  let admitted = true;
  const source = {
    postMessage(value: unknown) {
      replies.push(value);
    },
  } as unknown as ViewBridgeFrame;
  const execute = async () => {
    throw new Error("Unexpected direct mutation");
  };
  const host = createViewBridgeHost(source, { id: "test", name: "Test" }, execute, {
    operations: ["documents.read.v1", "documents.update.v1"],
    admitted: () => admitted,
    invalidate: () => host.stop(),
    proposeAction: async (proposal, signal) => {
      proposals.push({ proposal, signal });
      return await new Promise((r) => {
        resolve = r;
      });
    },
  });
  return {
    replies,
    proposals,
    host,
    send: (data: unknown, from = source, origin = "null") => host.receive({ data, source: from, origin }),
    finish: (value: unknown) => resolve!(value),
    revoke: () => {
      admitted = false;
      host.stop();
    },
  };
}
test("host explicitly advertises v1 and binds only its own frame to one pending confirmation", async () => {
  const f = fixture();
  await f.send({ bridge: "v0", type: "hello", id: "hello" });
  assert.equal(f.replies[0].result.grant, "propose");
  assert.equal(f.replies[0].result.actionProtocol, "v1");
  assert.deepEqual(f.replies[0].result.actions, ["document.set-field", "document.set-body", "document.update"]);
  const request = { bridge: "v1", type: "action.propose", requestId: "one", action };
  await f.send(request, {} as ViewBridgeFrame);
  assert.equal(f.proposals.length, 0);
  const pending = f.send(request);
  assert.equal(f.proposals.length, 1);
  assert.equal(f.replies.length, 1);
  await f.send({ ...request, requestId: "two" });
  assert.equal(f.proposals.length, 1);
  assert.equal(f.replies.at(-1).result.status, "rejected");
  f.finish({ status: "cancelled" });
  await pending;
  assert.equal(f.replies.at(-1).requestId, "one");
  assert.equal(f.replies.at(-1).result.status, "cancelled");
  await f.send(request);
  assert.equal(f.proposals.length, 1);
});
test("malformed or excessive actions never mount confirmation; revoked pending action never releases success", async () => {
  const f = fixture();
  for (const candidate of [
    { ...action, extra: true },
    { ...action, value: { fields: { title: "x" }, body: "x".repeat(65537) } },
  ])
    await f.send({ bridge: "v1", type: "action.propose", requestId: "bad", action: candidate });
  assert.equal(f.proposals.length, 0);
  assert.ok(f.replies.every((r) => r.result.status === "rejected"));
  const pending = f.send({ bridge: "v1", type: "action.propose", requestId: "allowed", action });
  f.revoke();
  assert.equal(f.proposals[0].signal.aborted, true);
  const count = f.replies.length;
  f.finish({ status: "committed", version });
  await pending;
  assert.equal(f.replies.length, count);
});
