// Copied into the isolated npm consumer. All Superbee imports go through installed public exports.
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { openRegisteredViewActions } from "@superbee/cli/view-actions/v1";
import { openWorkspaceReader } from "@superbee/cli/workspace-reader/v1";

const [bundle, phase] = process.argv.slice(2);
const options = { viewId: "views-registry/editor", actor: "process:external-proof" };
const open = () => openRegisteredViewActions("directory", bundle, options);

if (phase === "unapproved") {
  await assert.rejects(open, /local approval/);
} else {
  const session = await open();
  assert.match(session.html, /Fixture editor/);
  const other = await openRegisteredViewActions("catalog", "proof-reader", options);
  const reader = await openWorkspaceReader("directory", bundle);
  const read = () => reader.read("tickets/one");
  const proposed = async value => {
    const current = await read();
    const prepared = await session.prepare({
      kind: "document.set-field", docId: current.id, expectedVersion: current.version,
      field: "state", value,
    });
    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.confirmation.before, current.frontmatter.state);
    assert.equal(prepared.confirmation.after, value);
    assert.equal(prepared.confirmation.actor, options.actor);
    assert.equal(prepared.confirmation.source.contentVersion, session.contentVersion);
    assert.equal(prepared.confirmation.target.version, current.version);
    assert.equal((await read()).version, current.version);
    return prepared.approvalToken;
  };

  const cancelled = await proposed("done");
  await assert.rejects(() => session.finish(cancelled, true), /decision/);
  assert.equal((await session.finish(cancelled, "cancel")).status, "cancelled");
  assert.equal((await session.finish(cancelled, "commit")).status, "expired");
  const confirmed = await proposed("done");
  assert.equal((await other.finish(confirmed, "commit")).status, "expired");
  assert.equal((await session.finish(confirmed, "commit")).status, "committed");
  assert.equal((await read()).frontmatter.state, "done");

  const stale = await proposed("todo");
  await appendFile(path.join(bundle, "tickets/one.md"), "Concurrent edit.\n");
  const concurrent = await read();
  const conflict = await session.finish(stale, "commit");
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.actualVersion, concurrent.version);
  assert.equal((await read()).version, concurrent.version);

  const withdrawn = await proposed("todo");
  const closed = await open();
  const pending = await closed.prepare({
    kind: "document.set-field", docId: concurrent.id, expectedVersion: concurrent.version,
    field: "state", value: "todo",
  });
  assert.equal(pending.status, "prepared");
  closed.close();
  assert.equal((await closed.finish(pending.approvalToken, "commit")).status, "revoked");
  await appendFile(path.join(bundle, "views/editor.html"), "<!-- updated -->");
  assert.equal((await session.finish(withdrawn, "commit")).status, "revoked");
  assert.equal((await read()).version, concurrent.version);
  await assert.rejects(open, /local approval/);
  session.close();
  other.close();
}
