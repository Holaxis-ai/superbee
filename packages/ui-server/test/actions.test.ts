import test from "node:test";
import assert from "node:assert/strict";

import {
  MemoryBackend,
  readDocVersioned,
  writeBlob,
  writeDoc,
  writeDocVersioned,
  type Bundle,
} from "@superbee/core";
import { mintActiveViewLaunch } from "@superbee/view-runtime";
import {
  PageActionLaunchAuthority,
  PageLaunchRegistry,
  SessionViewAuthorizationStore,
  TrustedActionService,
  pageLaunchAuthorizationSubject,
  type TrustedActionLaunchAuthority,
} from "../src/index.js";

const T = "2026-07-18T12:00:00.000Z";
const HTML = new TextEncoder().encode("<!doctype html><button>done</button>");

async function fixture(actor: string | undefined = "mike/test") {
  const bundle: Bundle = { root: "mem://trusted-actions", backend: new MemoryBackend() };
  await writeDoc(bundle, {
    id: "conventions/task",
    frontmatter: {
      type: "Convention",
      title: "Task",
      governs: "Task",
      path: "tasks/",
      fields: {
        required: ["title", "status"],
        optional: [],
        values: { status: ["todo", "done"] },
      },
      timestamp: T,
    },
    body: "",
  });
  await writeDoc(bundle, {
    id: "tasks/alpha",
    frontmatter: { type: "Task", title: "Alpha", status: "todo", timestamp: T },
    body: "",
  });
  await writeDoc(bundle, {
    id: "views-registry/actions",
    frontmatter: { type: "View", title: "Actions", entry: "views/actions.html", access: "bundle-propose", timestamp: T },
    body: "",
  });
  await writeBlob(bundle, "views/actions.html", HTML, "text/html; charset=utf-8");

  const launches = new PageLaunchRegistry();
  const launch = await mintActiveViewLaunch(bundle, launches, "views-registry/actions");
  const authorizations = new SessionViewAuthorizationStore();
  await authorizations.authorize(pageLaunchAuthorizationSubject(launch));
  return {
    bundle,
    launches,
    launch,
    authorizations,
    service: new TrustedActionService(
      bundle,
      new PageActionLaunchAuthority(bundle, launches, authorizations),
      actor,
    ),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("trusted action: human-confirmed scalar update uses hard CAS and returns the final receipt", async () => {
  const { bundle, launch, service } = await fixture();
  const before = await readDocVersioned(bundle, "tasks/alpha");
  const prepared = await service.prepare(launch.launchId, {
    kind: "document.set-field",
    docId: "tasks/alpha",
    field: "status",
    value: "done",
    expectedVersion: before.version,
  });
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  assert.deepEqual(
    { before: prepared.confirmation.before, after: prepared.confirmation.after, actor: prepared.confirmation.actor },
    { before: "todo", after: "done", actor: "mike/test" },
  );

  const committed = await service.commit(prepared.approvalToken);
  assert.equal(committed.status, "committed");
  const after = await readDocVersioned(bundle, "tasks/alpha");
  assert.equal(after.doc.frontmatter.status, "done");
  assert.equal(after.doc.frontmatter.actor, "mike/test");
  assert.equal(committed.version, after.version, "the receipt is the final persisted version");
  assert.equal((await service.commit(prepared.approvalToken)).status, "expired", "approval tokens are one-shot");
});

test("trusted action: target races conflict and changed View bytes revoke without retrying", async () => {
  const raced = await fixture();
  const target = await readDocVersioned(raced.bundle, "tasks/alpha");
  const prepared = await raced.service.prepare(raced.launch.launchId, {
    kind: "document.set-field",
    docId: "tasks/alpha",
    field: "status",
    value: "done",
    expectedVersion: target.version,
  });
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  await writeDocVersioned(
    raced.bundle,
    { ...target.doc, frontmatter: { ...target.doc.frontmatter, title: "Concurrent edit" } },
    { expectedVersion: target.version },
  );
  assert.equal((await raced.service.commit(prepared.approvalToken)).status, "conflict");

  const changedView = await fixture();
  const current = await readDocVersioned(changedView.bundle, "tasks/alpha");
  const viewPrepared = await changedView.service.prepare(changedView.launch.launchId, {
    kind: "document.set-field",
    docId: "tasks/alpha",
    field: "status",
    value: "done",
    expectedVersion: current.version,
  });
  assert.equal(viewPrepared.status, "prepared");
  if (viewPrepared.status !== "prepared") return;
  await writeBlob(changedView.bundle, "views/actions.html", new TextEncoder().encode("changed"), "text/html; charset=utf-8");
  assert.equal((await changedView.service.commit(viewPrepared.approvalToken)).status, "revoked");
  assert.equal((await readDocVersioned(changedView.bundle, "tasks/alpha")).doc.frontmatter.status, "todo");
});

test("trusted action: View bytes changing after the first commit check revoke before mutation", async () => {
  const state = await fixture();
  const base = new PageActionLaunchAuthority(
    state.bundle,
    state.launches,
    state.authorizations,
  );
  const initialCommitCheckReached = deferred();
  const releaseCommit = deferred();
  let resolveCount = 0;
  const authority: TrustedActionLaunchAuthority = {
    resolve: async (launchId) => {
      const result = await base.resolve(launchId);
      resolveCount++;
      // prepare is call 1; commit's initial source check is call 2.
      if (resolveCount === 2) {
        initialCommitCheckReached.resolve();
        await releaseCommit.promise;
      }
      return result;
    },
    revoke: (launchId) => base.revoke(launchId),
  };
  const service = new TrustedActionService(state.bundle, authority, "mike/test");
  const target = await readDocVersioned(state.bundle, "tasks/alpha");
  const prepared = await service.prepare(state.launch.launchId, {
    kind: "document.set-field",
    docId: "tasks/alpha",
    field: "status",
    value: "done",
    expectedVersion: target.version,
  });
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;

  const committing = service.commit(prepared.approvalToken);
  await initialCommitCheckReached.promise;
  await writeBlob(
    state.bundle,
    "views/actions.html",
    new TextEncoder().encode("<!doctype html><p>changed during commit</p>"),
    "text/html; charset=utf-8",
  );
  releaseCommit.resolve();

  assert.equal((await committing).status, "revoked");
  assert.equal(
    (await readDocVersioned(state.bundle, "tasks/alpha")).doc.frontmatter.status,
    "todo",
  );
});

test("trusted action: rejects absent actor, undeclared fields, non-scalar replacement, and semantic no-ops", async () => {
  const noActor = await fixture("");
  const target = await readDocVersioned(noActor.bundle, "tasks/alpha");
  const action = { kind: "document.set-field", docId: "tasks/alpha", field: "status", value: "done", expectedVersion: target.version };
  assert.equal((await noActor.service.prepare(noActor.launch.launchId, action)).status, "rejected");

  const governed = await fixture();
  const governedTarget = await readDocVersioned(governed.bundle, "tasks/alpha");
  assert.equal(
    (await governed.service.prepare(governed.launch.launchId, { ...action, field: "surprise", expectedVersion: governedTarget.version })).status,
    "rejected",
  );
  await writeDoc(governed.bundle, {
    ...governedTarget.doc,
    frontmatter: { ...governedTarget.doc.frontmatter, status: ["todo"] },
  });
  const structuredTarget = await readDocVersioned(governed.bundle, "tasks/alpha");
  const structured = await governed.service.prepare(governed.launch.launchId, {
    ...action,
    expectedVersion: structuredTarget.version,
  });
  assert.equal(structured.status, "rejected");
  assert.match(structured.message ?? "", /non-scalar value/);

  await writeDoc(governed.bundle, governedTarget.doc);
  const restoredTarget = await readDocVersioned(governed.bundle, "tasks/alpha");
  const unchanged = await governed.service.prepare(governed.launch.launchId, {
    ...action,
    value: "todo",
    expectedVersion: restoredTarget.version,
  });
  assert.equal(unchanged.status, "unchanged");
  assert.equal(governed.service.size(), 0);
});
