/**
 * The seam is real: the sync runtime runs over an adapter that is not the IndexedDB class. The
 * in-memory test adapter passes the core kit's journal rows through the built `@superbee/core`
 * (the graph `local-bundle.ts` resolves), and one existing sync row, lost acknowledgement, runs
 * end to end over `openLocalBundle(name, { backend })`. On the parent commit that row cannot
 * exist: `LocalBundle.backend` was the class, `openLocalBundle` took no adapter, and every verb
 * narrowed its target with `instanceof IndexedDbBackend`, so a structural adapter was a type
 * error at the call and a wrong branch at runtime.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { OkfDocument } from "@superbee/core";
import { IntentHoldConflict, IntentStateConflict } from "@superbee/core/journaled-backend";
import { performUncertainWrite } from "@superbee/core/uncertain-write";
import { VersionConflict } from "@superbee/core/versioning";

import { registerJournaledBackendContract } from "../../core/test/journaled-backend-contract.ts";
import { bootstrap, commitLocal, openLocalBundle, pushWithRole, settleIntent, syncStatus } from "../src/local-bundle.ts";
import { MemoryJournaledBackend } from "./fixtures/memory-journaled-backend.ts";
import { createRemoteFixture, type RemoteFixture } from "./fixtures/remote-fixture.ts";

const NOW = "2026-09-10T12:00:00.000Z";
const immediate = { sleep: async () => {}, lookupDelayMs: 0 };

registerJournaledBackendContract({
  name: "MemoryJournaledBackend",
  create: () => ({ backend: new MemoryJournaledBackend(), cleanup: async () => undefined }),
  seam: { IntentStateConflict, IntentHoldConflict, VersionConflict },
});

function doc(id: string, body: string): OkfDocument {
  return { id, frontmatter: { type: "Note", title: `Note ${id}` }, body };
}

async function seededFixture(): Promise<RemoteFixture> {
  const fixture = await createRemoteFixture();
  for (const value of [doc("notes/alpha", "alpha v1\n"), doc("notes/beta", "beta v1\n"), doc("notes/gamma", "gamma v1\n")]) {
    await fixture.authority.write(value.id, value);
  }
  return fixture;
}

function edit(body: string) {
  return { buildCandidate: (existing: OkfDocument | undefined) => ({ frontmatter: existing!.frontmatter, body }), now: () => NOW };
}

test("lost acknowledgement over the in-memory journaled adapter: the runtime bootstraps, commits, looks up, and settles through the seam alone", async () => {
  const fixture = await seededFixture();
  const local = openLocalBundle("memory-working-copy", { backend: new MemoryJournaledBackend() });
  try {
    assert.equal(local.bundle.root, "local://memory-working-copy");
    const marker = await bootstrap(fixture.remote, local);
    assert.equal(marker.complete, true);
    assert.equal(marker.documentCount, 3);
    const committed = await commitLocal(local, "notes/gamma", edit("gamma v2\n"));
    assert.equal(committed.changed, true);
    assert.equal((await syncStatus(local)).counts.pending, 1);
    fixture.knobs.dropAfterApply = true;

    // The primitive alone: the submission is unknown, the lookup settles it, no resubmission.
    const claimed = await local.backend.updateIntent(committed.intent!.requestId, "pending", { state: "in_flight" });
    const result = await performUncertainWrite(fixture.transport, claimed, immediate);
    assert.deepEqual(result.outcome, { kind: "committed", version: committed.version });
    assert.equal(result.lookups, 1);
    assert.equal(result.intent.attempts, 1);
    assert.equal(fixture.history.length, 1);
    assert.deepEqual(fixture.deduplicated, []);

    const settled = await settleIntent(local, claimed.requestId, result.outcome, result.intent.attempts);
    assert.equal(settled.state, "acknowledged");
    assert.equal((await fixture.authority.read("notes/gamma")).version, committed.version);
    assert.equal((await fixture.authority.versions("notes/gamma")).length, 2);

    // The runtime's own delivery path under the push role, named by the working copy, over the same adapter.
    fixture.knobs.dropAfterApply = false;
    const again = await commitLocal(local, "notes/alpha", edit("alpha v2\n"));
    const delivered = await pushWithRole(local, fixture.transport, { remote: fixture.remote, write: immediate });
    assert.ok(delivered.held);
    assert.deepEqual(delivered.result.settled.map((row) => [row.requestId, row.state]), [[again.intent!.requestId, "acknowledged"]]);
    assert.deepEqual((await syncStatus(local)).counts, { pending: 0, in_flight: 0, acknowledged: 2, conflict: 0, refused: 0, unknown: 0 });
  } finally {
    local.close();
  }
});
