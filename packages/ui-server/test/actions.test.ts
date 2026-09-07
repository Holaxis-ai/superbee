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

async function fixture(
  actor: string | undefined = "mike/test",
  options: { okfVersion?: "0.1" | "0.2"; progressField?: "status" | "superbee_progress_status" } = {},
) {
  const bundle: Bundle = { root: "mem://trusted-actions", backend: new MemoryBackend() };
  const progressField = options.progressField ?? "status";
  if (options.okfVersion === "0.2") {
    await bundle.backend!.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Bundle\n");
  }
  await writeDoc(bundle, {
    id: "conventions/task",
    frontmatter: {
      type: "Convention",
      title: "Task",
      governs: "Task",
      path: "tasks/",
      fields: {
        required: ["title", progressField],
        optional: [],
        values: { [progressField]: ["todo", "done"] },
      },
      timestamp: T,
    },
    body: "",
  });
  await writeDoc(bundle, {
    id: "tasks/alpha",
    frontmatter: {
      type: "Task",
      title: "Alpha",
      [progressField]: "todo",
      ...(options.okfVersion === "0.2" ? {} : { timestamp: T }),
    },
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

for (const row of [
  { label: "v0.1", options: {} },
  { label: "v0.2", options: { okfVersion: "0.2", progressField: "superbee_progress_status" } },
] as const) {
  test(`trusted action: logical progress_status uses the declared ${row.label} storage coordinate`, async () => {
    const { bundle, launch, service } = await fixture("mike/test", row.options);
    const before = await readDocVersioned(bundle, "tasks/alpha");
    const prepared = await service.prepare(launch.launchId, {
      kind: "document.set-field",
      docId: "tasks/alpha",
      field: "progress_status",
      value: "done",
      expectedVersion: before.version,
    });
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const expectedStorage = row.label === "v0.1" ? "status" : "superbee_progress_status";
    assert.equal(prepared.confirmation.field, "progress_status");
    assert.equal(prepared.confirmation.storageField, expectedStorage);

    const committed = await service.commit(prepared.approvalToken);
    assert.equal(committed.status, "committed");
    assert.equal(committed.field, "progress_status");
    assert.equal(committed.storageField, expectedStorage);
    const after = await readDocVersioned(bundle, "tasks/alpha");
    assert.equal(after.doc.frontmatter[expectedStorage], "done");
    assert.equal(Object.hasOwn(after.doc.frontmatter, "progress_status"), false);
    if (row.label === "v0.2") {
      assert.equal(Object.hasOwn(after.doc.frontmatter, "timestamp"), false);
      assert.equal(Object.hasOwn(after.doc.frontmatter, "actor"), false);
      assert.equal(Object.hasOwn(after.doc.frontmatter, "generated"), false);
      assert.equal((await bundle.backend!.versions("tasks/alpha"))[0]?.actor, "mike/test");
    }
  });
}

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

test("trusted action: unexpected storage diagnostics never cross the action response boundary", async () => {
  const state = await fixture();
  const target = await readDocVersioned(state.bundle, "tasks/alpha");
  const backend = state.bundle.backend!;
  const originalRead = backend.read.bind(backend);
  Object.defineProperty(backend, "read", {
    configurable: true,
    value: async (id: string) => {
      if (id === "tasks/alpha") throw new Error("SECRET_ACTION_SENTINEL /private/action/path");
      return originalRead(id);
    },
  });

  const result = await state.service.prepare(state.launch.launchId, {
    kind: "document.set-field",
    docId: "tasks/alpha",
    field: "status",
    value: "done",
    expectedVersion: target.version,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.message, "the target document could not be read");
  assert.equal(JSON.stringify(result).includes("SECRET_ACTION_SENTINEL"), false);
  assert.equal(JSON.stringify(result).includes("/private/action/path"), false);
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
