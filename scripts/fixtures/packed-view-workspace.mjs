import { appendFile, cp, rename, rm } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {
  createBundlelessViewHost,
  createViewWorkspaceCatalog,
  openViewWorkspace,
} from "@superbee/cli/view-workspace/v1";

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

const catalog = createViewWorkspaceCatalog({ actor: "process:host-proof" });
const entries = await catalog.list();
const local = entries.find(({ label }) => label === "proof-reader");
const hosted = entries.find(({ label }) => label === "notes.a");
assert.equal(local.home, "local");
assert.equal(hosted.home, "hosted");
assert.deepEqual(Object.keys(local).sort(), [
  "available",
  "displayName",
  "home",
  "id",
  "label",
]);
assert.equal(
  (await (await catalog.open(local.id)).document(docId)).version,
  (await workspace.document(docId)).version,
);
await assert.rejects(catalog.open("missing-workspace"));
assert.deepEqual(await catalog.listOperations(local.label), {
  stop: "no_host_operations",
  home: "local",
});
assert.deepEqual(
  await catalog.runOperation(local.id, "documents.history.v1", {}),
  { stop: "no_host_operations", home: "local" },
);

// Different working copies can contain identical registrations, HTML and document bytes.
const viewId = "views-registry/editor";
const receipt = await workspace.captureRegisteredView(viewId);
const target = await catalog.open(local.id);
const reopened = await target.reopenRegisteredView(JSON.parse(JSON.stringify(receipt)));
assert.equal(reopened.contentVersion, receipt.contentVersion);
assert.equal(reopened.authorized, false);
await target.approve(reopened.id);
assert.equal((await target.request(reopened.id, request)).reply.type, "render-document:result");
const editor = await target.reopenRegisteredView(receipt);
const targetDocument = await target.document(docId);
const pending = await target.prepare(editor.id, {
  ...action,
  value: targetDocument.frontmatter.state === "todo" ? "done" : "todo",
  expectedVersion: targetDocument.version,
});
assert.equal(pending.status, "prepared");
const copy = process.argv[2] + "-identical";
await cp(process.argv[2], copy, { recursive: true });
const otherCopy = await openViewWorkspace("directory", copy, { actor: "process:host-proof" });
await assert.rejects(otherCopy.reopenRegisteredView(receipt), /working copy changed/);

// Replace the original folder at the same path after the handoff, keeping all bytes identical.
const original = process.argv[2] + "-original";
await rename(process.argv[2], original);
await rename(copy, process.argv[2]);
try {
  assert.equal((await target.request(reopened.id, request)).reply.type, "error");
  assert.notEqual((await target.finish(editor.id, pending.approvalToken, "commit")).status, "committed");
  assert.equal((await target.document(docId)).version, targetDocument.version);
  await assert.rejects(
    (await catalog.open(local.id)).reopenRegisteredView(receipt),
    /working copy changed/,
  );
} finally {
  await rm(process.argv[2], { recursive: true });
  await rename(original, process.argv[2]);
}
target.close(reopened.id);

let requests = 0;
globalThis.fetch = async () => {
  requests++;
  throw new Error("Unexpected network request");
};
assert.deepEqual(
  await catalog.runOperation(hosted.id, "documents.read.v1", {}),
  { stop: "folder_answers", operationId: "documents.read.v1" },
);
const refused = await catalog.runOperation(
  hosted.label,
  "documents.history.v1",
  { bundleId: "elsewhere" },
);
assert.equal(refused.ok, false);
assert.equal(refused.refusal.code, "invalid_input");
assert.equal(requests, 0);
const reachable = await catalog.reachable();
assert.ok(Array.isArray(reachable.workspaces));
assert.ok(Array.isArray(reachable.notes));

const host = createBundlelessViewHost();
assert.deepEqual(Object.keys(host).sort(), [
  "close",
  "inspect",
  "open",
  "poll",
  "request",
  "resume",
]);
const input = {
  title: "Standalone",
  html: "<!doctype html><p>Offline</p>",
  access: "none",
};
await assert.rejects(
  host.open({ ...input, access: "bundle-read" }),
  /access none/,
);
await assert.rejects(
  host.open({ ...input, access: "bundle-propose" }),
  /access none/,
);
await assert.rejects(
  host.open({ ...input, viewId: "views-registry/editor" }),
  /access none/,
);
const standalone = await host.open(input);
assert.equal(standalone.access, "none");
assert.equal((await host.inspect(standalone.id)).html, input.html);
assert.equal(
  (await host.request(standalone.id, request)).reply.error.code,
  "FORBIDDEN",
);
assert.equal(await createBundlelessViewHost().inspect(standalone.id), null);
const replacement = await host.resume(standalone.id);
assert.notEqual(replacement.id, standalone.id);
assert.equal(replacement.access, "none");
host.close(standalone.id);
assert.equal(await host.inspect(standalone.id), null);
await assert.rejects(host.resume(standalone.id));
host.close(replacement.id);
