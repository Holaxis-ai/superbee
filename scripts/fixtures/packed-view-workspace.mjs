import { appendFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { openViewWorkspace } from "@superbee/cli/view-workspace/v1";

const workspace = await openViewWorkspace("catalog", "proof-reader", {
  actor: "process:host-proof",
});
const docId = "tickets/one";
const before = await workspace.document(docId);
const next = before.frontmatter.state === "todo" ? "done" : "todo";
const launch = await workspace.open({
  title: "Host proof",
  html: "<!doctype html><title>Reader</title>",
  access: "bundle-propose",
});
const action = {
  kind: "document.set-field",
  docId,
  field: "state",
  value: next,
  expectedVersion: before.version,
};
const request = { bridge: "v0", type: "render-document", id: "read", docId };
assert.equal((await workspace.request(launch.id, request)).reply.type, "error");
await workspace.approve(launch.id);
const proposal = await workspace.prepare(launch.id, action);
assert.equal(proposal.status, "prepared");
assert.equal((await workspace.document(docId)).version, before.version);
const other = await workspace.open({
  title: "Second",
  html: "<!doctype html><title>Second</title>",
  access: "bundle-read",
});
await workspace.approve(other.id);
assert.notEqual(
  (await workspace.finish(other.id, proposal.approvalToken, "commit")).status,
  "committed",
);
assert.equal((await workspace.document(docId)).version, before.version);
const confirmed = await workspace.prepare(launch.id, action);
assert.equal(
  (await workspace.finish(launch.id, confirmed.approvalToken, "commit")).status,
  "committed",
);
workspace.close(launch.id);
assert.equal((await workspace.request(launch.id, request)).reply.type, "error");
workspace.close(other.id);

const registered = await workspace.open({ viewId: "views-registry/editor" });
await workspace.approve(registered.id);
await appendFile(
  path.join(process.argv[2], "views/editor.html"),
  "<!-- new source -->",
);
const resumed = await workspace.resume(registered.id);
assert.notEqual(resumed.contentVersion, registered.contentVersion);
assert.equal(resumed.authorized, false);
assert.equal(
  (await workspace.request(resumed.id, request)).reply.type,
  "error",
);
workspace.close(resumed.id);
workspace.close(registered.id);
