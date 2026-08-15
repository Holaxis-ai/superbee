import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryBackend,
  docVersions,
  readBlob,
  readDocVersioned,
  writeBlob,
  writeDoc,
} from "@superbee/core";
import {
  PageLaunchRegistry,
  SessionViewAuthorizationStore,
  TransientViewSaveError,
  mintActiveViewLaunch,
  mintTransientViewLaunch,
  pageLaunchAuthorizationSubject,
  saveTransientView,
} from "../dist/index.js";

const HTML = "<!doctype html><title>Saved</title><script>parent.postMessage({bridge:'v0',type:'hello',id:'h'}, '*')</script>";

function fixture(backend = new MemoryBackend()) {
  const bundle = { root: "mem://transient-save", backend };
  const launches = new PageLaunchRegistry();
  const authorizations = new SessionViewAuthorizationStore();
  const launch = mintTransientViewLaunch(bundle, launches, {
    title: "Saved proof",
    html: HTML,
  });
  return { bundle, launches, authorizations, launch };
}

async function approve(f) {
  await f.authorizations.authorize(pageLaunchAuthorizationSubject(f.launch));
}

test("save persists exact transient bytes and creates a separately authorized durable identity", async () => {
  const f = fixture();
  await approve(f);

  const saved = await saveTransientView(
    f.bundle,
    f.launches,
    f.authorizations,
    {
      launchId: f.launch.launchId,
      viewId: "views-registry/saved-proof",
      description: "An exact-byte persistence proof.",
    },
    { actor: "openai/codex", now: "2026-08-02T19:30:00.000Z" },
  );

  assert.deepEqual(saved, {
    viewId: "views-registry/saved-proof",
    entry: "views/saved-proof.html",
    title: "Saved proof",
    access: "bundle-read",
    sourceVersion: f.launch.contentVersion,
    entryVersion: f.launch.contentVersion,
    registryVersion: saved.registryVersion,
    entryCreated: true,
    registryCreated: true,
  });
  const entry = await readBlob(f.bundle, saved.entry);
  assert.ok(entry);
  assert.equal(new TextDecoder().decode(entry.bytes), HTML);
  assert.equal(entry.version, f.launch.contentVersion);
  assert.equal(entry.contentType, f.launch.contentType);

  const registry = await readDocVersioned(f.bundle, saved.viewId);
  assert.deepEqual(registry.doc.frontmatter, {
    type: "View",
    title: "Saved proof",
    description: "An exact-byte persistence proof.",
    entry: "views/saved-proof.html",
    entry_version: f.launch.contentVersion,
    access: "bundle-read",
    actor: "openai/codex",
    timestamp: "2026-08-02T19:30:00.000Z",
  });
  assert.equal((await docVersions(f.bundle, saved.viewId))[0]?.actor, "openai/codex");

  const durable = await mintActiveViewLaunch(
    f.bundle,
    f.launches,
    saved.viewId,
  );
  assert.equal(durable.contentVersion, f.launch.contentVersion);
  assert.equal(new TextDecoder().decode(durable.bytes), HTML);
  const durableAuthorizations = new SessionViewAuthorizationStore();
  assert.equal(
    await durableAuthorizations.isAuthorized(pageLaunchAuthorizationSubject(durable)),
    false,
    "saving exact bytes does not transfer transient approval to the durable registry identity",
  );

  const repeated = await saveTransientView(
    f.bundle,
    f.launches,
    f.authorizations,
    {
      launchId: f.launch.launchId,
      viewId: "views-registry/saved-proof",
      description: "An exact-byte persistence proof.",
    },
    { now: "2026-08-02T20:00:00.000Z" },
  );
  assert.equal(repeated.entryCreated, false);
  assert.equal(repeated.registryCreated, false);
  assert.equal(repeated.sourceVersion, repeated.entryVersion);
  assert.equal(repeated.registryVersion, saved.registryVersion);
});

test("save on OKF v0.2 preserves storage attribution without inventing legacy document metadata", async () => {
  const f = fixture();
  await f.bundle.backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Bundle\n");
  await approve(f);

  const saved = await saveTransientView(
    f.bundle,
    f.launches,
    f.authorizations,
    { launchId: f.launch.launchId, viewId: "views-registry/v02-proof" },
    { actor: "openai/codex", now: "2026-08-02T19:30:00.000Z" },
  );

  const registry = await readDocVersioned(f.bundle, saved.viewId);
  assert.equal(Object.hasOwn(registry.doc.frontmatter, "timestamp"), false);
  assert.equal(Object.hasOwn(registry.doc.frontmatter, "actor"), false);
  assert.equal(Object.hasOwn(registry.doc.frontmatter, "generated"), false);
  assert.equal((await docVersions(f.bundle, saved.viewId))[0]?.actor, "openai/codex");
});

test("save requires process-local approval before writing either durable resource", async () => {
  const f = fixture();
  await assert.rejects(
    saveTransientView(f.bundle, f.launches, f.authorizations, {
      launchId: f.launch.launchId,
      viewId: "views-registry/unapproved",
    }),
    /must be locally approved/,
  );
  assert.equal(await readBlob(f.bundle, "views/unapproved.html"), null);
  await assert.rejects(readDocVersioned(f.bundle, "views-registry/unapproved"), { code: "ENOENT" });
});

test("different entry or registry occupants fail closed before creating their counterpart", async () => {
  const entryConflict = fixture();
  await approve(entryConflict);
  await writeBlob(
    entryConflict.bundle,
    "views/collision.html",
    new TextEncoder().encode("<p>different</p>"),
    "text/html; charset=utf-8",
  );
  await assert.rejects(
    saveTransientView(entryConflict.bundle, entryConflict.launches, entryConflict.authorizations, {
      launchId: entryConflict.launch.launchId,
      viewId: "views-registry/collision",
    }),
    /different View entry/,
  );
  await assert.rejects(readDocVersioned(entryConflict.bundle, "views-registry/collision"), { code: "ENOENT" });

  const registryConflict = fixture();
  await approve(registryConflict);
  await writeDoc(registryConflict.bundle, {
    id: "views-registry/collision",
    frontmatter: {
      type: "View",
      title: "Someone else's View",
      entry: "views/elsewhere.html",
      access: "bundle-read",
    },
    body: "",
  });
  await assert.rejects(
    saveTransientView(registryConflict.bundle, registryConflict.launches, registryConflict.authorizations, {
      launchId: registryConflict.launch.launchId,
      viewId: "views-registry/collision",
    }),
    /different View registration/,
  );
  assert.equal(await readBlob(registryConflict.bundle, "views/collision.html"), null);
});

test("a registration failure reports the exact inert entry retained after the first write", async () => {
  class FailingRegistryBackend extends MemoryBackend {
    async write(id, doc, options) {
      if (id === "views-registry/partial") throw new Error("injected registry failure");
      return super.write(id, doc, options);
    }
  }

  const f = fixture(new FailingRegistryBackend());
  await approve(f);
  await assert.rejects(
    saveTransientView(f.bundle, f.launches, f.authorizations, {
      launchId: f.launch.launchId,
      viewId: "views-registry/partial",
    }),
    (error) => {
      assert.ok(error instanceof TransientViewSaveError);
      assert.match(error.message, /registration could not be created: injected registry failure/);
      assert.deepEqual(error.retainedEntry, {
        key: "views/partial.html",
        version: f.launch.contentVersion,
      });
      return true;
    },
  );
  const retained = await readBlob(f.bundle, "views/partial.html");
  assert.ok(retained);
  assert.equal(retained.version, f.launch.contentVersion);
  await assert.rejects(readDocVersioned(f.bundle, "views-registry/partial"), { code: "ENOENT" });
});

test("create-only registry races converge only when the winner installed the same registration", async () => {
  class RacingRegistryBackend extends MemoryBackend {
    constructor(mode) {
      super();
      this.mode = mode;
      this.raced = false;
    }

    async write(id, doc, options) {
      if (
        id === "views-registry/race" &&
        options?.expectedVersion === null &&
        !this.raced
      ) {
        this.raced = true;
        const winner = this.mode === "same"
          ? doc
          : {
              ...doc,
              frontmatter: { ...doc.frontmatter, title: "Concurrent winner" },
            };
        await super.write(id, winner, options);
      }
      return super.write(id, doc, options);
    }
  }

  const same = fixture(new RacingRegistryBackend("same"));
  await approve(same);
  const converged = await saveTransientView(
    same.bundle,
    same.launches,
    same.authorizations,
    { launchId: same.launch.launchId, viewId: "views-registry/race" },
  );
  assert.equal(converged.entryCreated, true);
  assert.equal(converged.registryCreated, false);

  const different = fixture(new RacingRegistryBackend("different"));
  await approve(different);
  await assert.rejects(
    saveTransientView(
      different.bundle,
      different.launches,
      different.authorizations,
      { launchId: different.launch.launchId, viewId: "views-registry/race" },
    ),
    (error) => {
      assert.ok(error instanceof TransientViewSaveError);
      assert.match(error.message, /another writer created a different View registration/);
      assert.equal(error.retainedEntry?.key, "views/race.html");
      return true;
    },
  );
  assert.equal(
    (await readDocVersioned(different.bundle, "views-registry/race")).doc.frontmatter.title,
    "Concurrent winner",
  );
});

test("entry replacement during registry creation fails and leaves a version-pinned unlaunchable registration", async () => {
  class ReplacingEntryBackend extends MemoryBackend {
    replaced = false;

    async write(id, doc, options) {
      if (id === "views-registry/replaced" && !this.replaced) {
        this.replaced = true;
        await super.writeBlob(
          "views/replaced.html",
          new TextEncoder().encode("<p>replacement</p>"),
          "text/html; charset=utf-8",
          {},
        );
      }
      return super.write(id, doc, options);
    }
  }

  const f = fixture(new ReplacingEntryBackend());
  await approve(f);
  await assert.rejects(
    saveTransientView(
      f.bundle,
      f.launches,
      f.authorizations,
      { launchId: f.launch.launchId, viewId: "views-registry/replaced" },
    ),
    (error) => {
      assert.ok(error instanceof TransientViewSaveError);
      assert.match(error.message, /not reported as a successful save/);
      assert.equal(error.retainedRegistration?.id, "views-registry/replaced");
      assert.notEqual(error.retainedEntry?.version, f.launch.contentVersion);
      return true;
    },
  );
  const registry = await readDocVersioned(f.bundle, "views-registry/replaced");
  assert.equal(registry.doc.frontmatter.entry_version, f.launch.contentVersion);
  await assert.rejects(
    mintActiveViewLaunch(f.bundle, f.launches, "views-registry/replaced"),
    /no longer matches its pinned entry_version/,
  );
});

test("entry deletion during registry creation never produces a stale retained-entry receipt", async () => {
  class DeletingEntryBackend extends MemoryBackend {
    deleted = false;

    async write(id, doc, options) {
      if (id === "views-registry/deleted" && !this.deleted) {
        this.deleted = true;
        await super.deleteBlob("views/deleted.html");
      }
      return super.write(id, doc, options);
    }
  }

  const f = fixture(new DeletingEntryBackend());
  await approve(f);
  await assert.rejects(
    saveTransientView(
      f.bundle,
      f.launches,
      f.authorizations,
      { launchId: f.launch.launchId, viewId: "views-registry/deleted" },
    ),
    (error) => {
      assert.ok(error instanceof TransientViewSaveError);
      assert.equal(error.retainedEntry, undefined);
      assert.equal(error.retainedRegistration?.id, "views-registry/deleted");
      return true;
    },
  );
  assert.equal(await readBlob(f.bundle, "views/deleted.html"), null);
});

test("registration creation uses strict kind validation and preserves actor attribution", async () => {
  const f = fixture();
  await approve(f);
  await writeDoc(f.bundle, {
    id: "conventions/view",
    frontmatter: {
      type: "Convention",
      title: "View",
      governs: "View",
      path: "views-registry/",
      fields: {
        required: ["title", "entry", "entry_version", "access", "owner"],
        optional: [],
        values: {},
        terminal: {},
      },
    },
    body: "",
  });
  await assert.rejects(
    saveTransientView(
      f.bundle,
      f.launches,
      f.authorizations,
      { launchId: f.launch.launchId, viewId: "views-registry/nonconforming" },
      { actor: "openai/codex" },
    ),
    /does not satisfy the 'View' kind.*owner/,
  );
  await assert.rejects(readDocVersioned(f.bundle, "views-registry/nonconforming"), { code: "ENOENT" });
  assert.ok(await readBlob(f.bundle, "views/nonconforming.html"), "the inert exact blob is retained truthfully");
});

test("approval revocation immediately before registry creation retains only the inert exact entry", async () => {
  const f = fixture();
  let checks = 0;
  const authorizations = {
    async authorize() {},
    async isAuthorized() {
      checks += 1;
      return checks < 3;
    },
  };
  await assert.rejects(
    saveTransientView(
      f.bundle,
      f.launches,
      authorizations,
      { launchId: f.launch.launchId, viewId: "views-registry/revoked" },
    ),
    /changed or expired before registration creation/,
  );
  assert.ok(await readBlob(f.bundle, "views/revoked.html"));
  await assert.rejects(readDocVersioned(f.bundle, "views-registry/revoked"), { code: "ENOENT" });
});

test("lost write acknowledgements reconcile exact committed state without false creation claims", async () => {
  class CommitThenThrowBackend extends MemoryBackend {
    constructor(stage) {
      super();
      this.stage = stage;
      this.thrown = false;
    }

    async writeBlob(key, bytes, contentType, options) {
      const version = await super.writeBlob(key, bytes, contentType, options);
      if (this.stage === "entry" && !this.thrown) {
        this.thrown = true;
        throw new Error("entry acknowledgement lost");
      }
      return version;
    }

    async write(id, doc, options) {
      const version = await super.write(id, doc, options);
      if (this.stage === "registry" && id === "views-registry/ack" && !this.thrown) {
        this.thrown = true;
        throw new Error("registry acknowledgement lost");
      }
      return version;
    }
  }

  for (const stage of ["entry", "registry"]) {
    const f = fixture(new CommitThenThrowBackend(stage));
    await approve(f);
    const saved = await saveTransientView(
      f.bundle,
      f.launches,
      f.authorizations,
      { launchId: f.launch.launchId, viewId: "views-registry/ack" },
    );
    assert.equal(saved.entryCreated, stage !== "entry");
    assert.equal(saved.registryCreated, stage !== "registry");
    assert.equal(saved.entryVersion, f.launch.contentVersion);
    assert.equal(
      (await readDocVersioned(f.bundle, saved.viewId)).doc.frontmatter.entry_version,
      f.launch.contentVersion,
    );
  }
});
