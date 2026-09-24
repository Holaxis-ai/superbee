/**
 * A runtime's syncs never overlap, and a sync that finds the push role held elsewhere does not
 * pull. A pull whose heads listing was taken while a push was in flight predates the
 * acknowledgement that push records; applied afterwards, it removes the acknowledged create
 * from the working copy as a document the authority no longer lists. The carrier here holds
 * identified writes and the listings requested meanwhile at gates the test opens, so the
 * interleaving is fixed rather than timed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { RemoteBackend } from "@superbee/core";
import { openRemoteOperationTransport } from "@superbee/core/remote-operations";

import { bootstrap, commitLocal, openLocalBundle } from "../src/local-bundle.ts";
import { createBrowserLocalRuntime } from "../src/platform/browser-local.ts";
import type { LockManagerLike } from "../src/push-role.ts";
import { BASE_URL, BUNDLE, createRemoteFixture } from "./fixtures/remote-fixture.ts";

const immediate = { sleep: async () => {}, lookupDelayMs: 0 };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * The fixture's handler behind two gates. While writes are held, an identified write waits
 * before it reaches the router, and a heads listing requested meanwhile is answered by the
 * router at once but handed back only when listings are released.
 */
function gatedCarrier(hosted: (request: Request) => Promise<Response>) {
  let writes: ReturnType<typeof deferred> | null = null;
  const listings = deferred();
  const writeArrived = deferred();
  const listingHeld = deferred();
  const counts = { listings: 0 };
  const fetch = async (request: Request): Promise<Response> => {
    const isListing = request.method === "GET" && new URL(request.url).pathname.endsWith("/heads");
    if (isListing) counts.listings += 1;
    if (writes !== null && request.headers.get("Idempotency-Key") !== null) {
      writeArrived.resolve();
      await writes.promise;
    }
    const heldListing = isListing && writes !== null;
    const response = await hosted(request);
    if (heldListing) {
      listingHeld.resolve();
      await listings.promise;
    }
    return response;
  };
  return {
    fetch,
    counts,
    writeArrived: writeArrived.promise,
    listingHeld: listingHeld.promise,
    holdWrites: () => { writes = deferred(); },
    releaseWrites: () => { writes?.resolve(); writes = null; },
    releaseListings: () => listings.resolve(),
  };
}

async function setup(name: string) {
  const fixture = await createRemoteFixture();
  await fixture.authority.write("notes/x", { id: "notes/x", frontmatter: { type: "Note", title: "x" }, body: "v1\n" });
  const carrier = gatedCarrier(fixture.hosted);
  const remote = new RemoteBackend({ baseUrl: BASE_URL, bundle: BUNDLE, fetchImpl: carrier.fetch, maxRetries: 0 });
  const transport = await openRemoteOperationTransport(remote);
  const local = openLocalBundle(name, { indexedDB: new IDBFactory() });
  await bootstrap(remote, local);
  await commitLocal(local, "notes/new", { mode: "create-only", buildCandidate: () => ({ frontmatter: { type: "Note", title: "new" }, body: "n\n" }) });
  carrier.counts.listings = 0;
  return { fixture, carrier, remote, transport, local };
}

test("syncs called while one is mid-push share one follow-up run, and the create that push acknowledges stays in the working copy", async () => {
  const { fixture, carrier, remote, transport, local } = await setup("overlapping-sync");
  try {
    // A colleague's edit moves the listing's digest, so the pull applies a listing rather than a 304.
    await fixture.authority.write("notes/x", { id: "notes/x", frontmatter: { type: "Note", title: "x" }, body: "v2 by a colleague\n" });
    const runtime = createBrowserLocalRuntime({ local, remote, transport, write: immediate, locks: null });
    carrier.holdWrites();
    const first = runtime.sync();
    await carrier.writeArrived;
    const second = runtime.sync();
    const third = runtime.sync();
    // A pull the second call started now would list the authority before the create lands.
    await Promise.race([carrier.listingHeld, new Promise((done) => setTimeout(done, 100))]);
    carrier.releaseWrites();
    const firstStatus = await first;
    carrier.releaseListings();
    const [secondStatus, thirdStatus] = await Promise.all([second, third]);

    assert.equal((await fixture.authority.read("notes/new")).doc.body, "n\n", "the authority applied the create");
    assert.ok((await local.backend.list()).includes("notes/new"), "the acknowledged create is still in the working copy");
    assert.equal((await runtime.read("notes/new")).provenance.state, "shared-confirmed");
    assert.equal((await runtime.read("notes/x")).doc.body, "v2 by a colleague\n", "the pulls applied the listing");
    for (const status of [firstStatus, secondStatus, thirdStatus]) {
      assert.equal(status.pending, 0);
      assert.equal(status.lastSync?.ok, true);
    }
    assert.deepEqual(thirdStatus, secondStatus, "the calls made during the first share its follow-up's result");
    assert.equal(carrier.counts.listings, 2, "three calls, two pulls: the first sync's and one follow-up");
  } finally { local.close(); }
});

test("a sync that finds the push role held by another realm neither pushes nor pulls", async () => {
  const { fixture, carrier, remote, transport, local } = await setup("push-role-held-elsewhere");
  try {
    await fixture.authority.write("notes/x", { id: "notes/x", frontmatter: { type: "Note", title: "x" }, body: "v2 by a colleague\n" });
    const heldElsewhere: LockManagerLike = { request: async (_name, _options, callback) => callback(null) };
    const runtime = createBrowserLocalRuntime({ local, remote, transport, write: immediate, locks: heldElsewhere });
    const status = await runtime.sync();

    assert.deepEqual(fixture.submissions, [], "nothing was delivered");
    assert.equal(carrier.counts.listings, 0, "nothing was listed");
    assert.equal((await runtime.read("notes/x")).doc.body, "v1\n", "the working copy was not refreshed");
    assert.equal(status.pending, 1);
    assert.equal(status.online, null, "no exchange with the authority is reported");
    assert.ok((await local.backend.list()).includes("notes/new"));
  } finally { local.close(); }
});
