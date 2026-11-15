import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FilesystemBackend } from "@superbee/core";
import Ajv2020 from "ajv/dist/2020.js";

import {
  PUBLICATION_BRIDGE_V0,
  PUBLICATION_SNAPSHOT_SCHEMA_V1,
  PUBLICATION_SNAPSHOT_V1,
  PublicationError,
  capturePublicationSnapshot,
  createPublicationBridge,
} from "../dist/index.js";

function hash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "superbee-publication-")));
  await mkdir(path.join(root, "notes"), { recursive: true });
  await mkdir(path.join(root, "views-registry"), { recursive: true });
  await mkdir(path.join(root, "views"), { recursive: true });
  await writeFile(path.join(root, "index.md"), "---\nokf_version: '0.2'\n---\n# Fixture\n", "utf8");
  await writeFile(
    path.join(root, "notes", "alpha.md"),
    "---\ntype: Note\ntitle: Alpha\nscore: 3\n---\n# Alpha\n\nSee [Beta](./beta.md).\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "notes", "beta.md"),
    "---\ntype: Note\ntitle: Beta\n---\n# Beta\n",
    "utf8",
  );
  const viewBytes = Buffer.from("<!doctype html><title>Fixture</title><main>Fixture View</main>", "utf8");
  await writeFile(path.join(root, "views", "fixture.html"), viewBytes);
  await writeFile(
    path.join(root, "views-registry", "fixture.md"),
    "---\ntype: View\ntitle: Fixture View\nentry: views/fixture.html\naccess: bundle-read\npresentation: workspace\n---\n",
    "utf8",
  );
  return { root, viewDigest: hash(viewBytes) };
}

test("capture is deterministic and preserves exact objects and canonical projections", async () => {
  const { root, viewDigest } = await fixture();
  try {
    const first = await capturePublicationSnapshot({
      schema: PUBLICATION_SNAPSHOT_V1,
      source: { kind: "filesystem", root },
    });
    const second = await capturePublicationSnapshot({
      schema: PUBLICATION_SNAPSHOT_V1,
      source: { kind: "filesystem", root },
    });
    assert.deepEqual(second.manifest, first.manifest);
    const validate = new Ajv2020({ strict: true }).compile(PUBLICATION_SNAPSHOT_SCHEMA_V1);
    assert.equal(validate(first.manifest), true, JSON.stringify(validate.errors));
    assert.deepEqual(second.serializeManifest(), first.serializeManifest());
    assert.equal(first.manifest.source.okfEdition, "0.2");
    assert.deepEqual(first.manifest.documents.map((row) => row.id), [
      "notes/alpha",
      "notes/beta",
      "views-registry/fixture",
    ]);
    assert.deepEqual(first.manifest.relationships, [{
      from: "notes/alpha",
      to: "notes/beta",
      text: "Beta",
      href: "./beta.md",
    }]);
    assert.equal(first.manifest.views[0].entryObject.digest, viewDigest);
    const alpha = first.manifest.documents[0];
    const source = await first.readObject(alpha.source);
    assert.match(new TextDecoder().decode(source), /score: 3/);
    assert.equal(hash(source), alpha.source.digest);
    const manifest = JSON.parse(new TextDecoder().decode(first.serializeManifest()));
    assert.equal(manifest.snapshotDigest, first.manifest.snapshotDigest);
    await first.close();
    await assert.rejects(() => first.readObject(alpha.source), (error) => {
      assert.equal(error.code, "HANDLE_CLOSED");
      return true;
    });
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("documents over the parse limit are captured as bounded", async () => {
  const { root } = await fixture();
  try {
    const bodies = {
      brackets: "[a".repeat(15000) + "](https://x)".repeat(12000),
      quotes: "> ".repeat(25000) + "x",
    };
    for (const [name, body] of Object.entries(bodies)) {
      await writeFile(path.join(root, "notes", `${name}.md`), `---\ntype: Note\n---\n${body}\n`, "utf8");
    }
    const snapshot = await capturePublicationSnapshot({
      schema: PUBLICATION_SNAPSHOT_V1,
      source: { kind: "filesystem", root },
    });
    const rendered = (id) => snapshot.manifest.documents.find((row) => row.id === id).rendered;
    assert.equal(rendered("notes/brackets").bounded, true);
    assert.equal(rendered("notes/quotes").bounded, true);
    assert.equal(rendered("notes/alpha").bounded, false);
    await snapshot.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captured manifests are deeply immutable and serialization is identity-stable", async () => {
  const { root } = await fixture();
  try {
    const snapshot = await capturePublicationSnapshot({
      schema: PUBLICATION_SNAPSHOT_V1,
      source: { kind: "filesystem", root },
    });
    const before = snapshot.serializeManifest();
    assert.equal(Object.isFrozen(snapshot.manifest), true);
    assert.equal(Object.isFrozen(snapshot.manifest.documents), true);
    assert.equal(Object.isFrozen(snapshot.manifest.documents[0].frontmatter), true);
    assert.throws(() => { snapshot.manifest.documents[0].body = "tampered"; }, TypeError);
    assert.deepEqual(snapshot.serializeManifest(), before);
    const callerBytes = snapshot.serializeManifest();
    callerBytes[0] = 0;
    assert.deepEqual(snapshot.serializeManifest(), before);
    await snapshot.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("capture detects a source change between inventory phases", async () => {
  const { root } = await fixture();
  const original = FilesystemBackend.prototype.list;
  let calls = 0;
  FilesystemBackend.prototype.list = async function (...args) {
    calls += 1;
    if (calls === 2) {
      await writeFile(
        path.join(root, "notes", "alpha.md"),
        "---\ntype: Note\ntitle: Changed\n---\nChanged during capture.\n",
        "utf8",
      );
    }
    return original.apply(this, args);
  };
  try {
    await assert.rejects(
      () => capturePublicationSnapshot({
        schema: PUBLICATION_SNAPSHOT_V1,
        source: { kind: "filesystem", root },
        maxAttempts: 1,
      }),
      (error) => {
        assert.ok(error instanceof PublicationError);
        assert.equal(error.code, "SOURCE_CHANGED");
        assert.equal(error.retryable, true);
        return true;
      },
    );
  } finally {
    FilesystemBackend.prototype.list = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("capture rejects atomic substitution of the authorized source root", async () => {
  const { root } = await fixture();
  const { root: substitute } = await fixture();
  await writeFile(path.join(substitute, "notes", "alpha.md"), "---\ntype: Note\ntitle: Substituted\n---\n# Substituted\n");
  const authorized = `${root}-authorized`;
  const original = FilesystemBackend.prototype.list;
  let swapped = false;
  FilesystemBackend.prototype.list = async function (...args) {
    if (!swapped) {
      await rename(root, authorized);
      await rename(substitute, root);
      swapped = true;
    }
    return original.apply(this, args);
  };
  try {
    await assert.rejects(() => capturePublicationSnapshot({
      schema: PUBLICATION_SNAPSHOT_V1,
      source: { kind: "filesystem", root },
      maxAttempts: 1,
    }), (error) => error instanceof PublicationError && error.code === "SOURCE_CHANGED");
  } finally {
    FilesystemBackend.prototype.list = original;
    await rm(root, { recursive: true, force: true });
    await rm(authorized, { recursive: true, force: true });
    await rm(substitute, { recursive: true, force: true });
  }
});

test("permission-shaped inventory failures are reclassified only after proven root substitution", async () => {
  for (const row of [
    { name: "unchanged root", substituteRoot: false, expectedCode: "IO_ERROR" },
    { name: "substituted root", substituteRoot: true, expectedCode: "SOURCE_CHANGED" },
  ]) {
    const { root } = await fixture();
    const replacement = row.substituteRoot ? await fixture() : undefined;
    const authorized = `${root}-authorized`;
    const original = FilesystemBackend.prototype.list;
    let injected = false;
    FilesystemBackend.prototype.list = async function (...args) {
      if (!injected) {
        injected = true;
        if (replacement) {
          await rename(root, authorized);
          await rename(replacement.root, root);
        }
        const error = new Error(`simulated permission failure for ${row.name}`);
        error.code = "EPERM";
        throw error;
      }
      return original.apply(this, args);
    };
    try {
      await assert.rejects(() => capturePublicationSnapshot({
        schema: PUBLICATION_SNAPSHOT_V1,
        source: { kind: "filesystem", root },
        maxAttempts: 1,
      }), (error) => {
        assert.ok(error instanceof PublicationError);
        assert.equal(error.code, row.expectedCode, row.name);
        return true;
      });
    } finally {
      FilesystemBackend.prototype.list = original;
      await rm(root, { recursive: true, force: true });
      await rm(authorized, { recursive: true, force: true });
      if (replacement) await rm(replacement.root, { recursive: true, force: true });
    }
  }
});

test("an unchanged authorized root that becomes inaccessible remains an IO_ERROR", async () => {
  const { root: fixtureRoot } = await fixture();
  const container = `${fixtureRoot}-permission-gate`;
  const root = path.join(container, "bundle");
  await mkdir(container);
  await rename(fixtureRoot, root);
  const original = FilesystemBackend.prototype.list;
  let injected = false;
  FilesystemBackend.prototype.list = async function (...args) {
    if (!injected) {
      injected = true;
      await chmod(container, 0o000);
      const error = new Error("simulated inventory denial after the authorized root became inaccessible");
      error.code = "EACCES";
      throw error;
    }
    return original.apply(this, args);
  };
  try {
    await assert.rejects(() => capturePublicationSnapshot({
      schema: PUBLICATION_SNAPSHOT_V1,
      source: { kind: "filesystem", root },
      maxAttempts: 1,
    }), (error) => {
      assert.ok(error instanceof PublicationError);
      assert.equal(error.code, "IO_ERROR");
      assert.equal(error.retryable, false);
      return true;
    });
  } finally {
    FilesystemBackend.prototype.list = original;
    await chmod(container, 0o700).catch(() => {});
    await rm(container, { recursive: true, force: true });
  }
});

test("entry-level symlink substitution remains SOURCE_CHANGED when realpath would fail", async () => {
  const { root } = await fixture();
  const authorized = `${root}-authorized`;
  const original = FilesystemBackend.prototype.list;
  let injected = false;
  FilesystemBackend.prototype.list = async function (...args) {
    if (!injected) {
      injected = true;
      await rename(root, authorized);
      await symlink(root, root);
      const error = new Error("simulated inventory failure after symlink-loop substitution");
      error.code = "EPERM";
      throw error;
    }
    return original.apply(this, args);
  };
  try {
    await assert.rejects(() => capturePublicationSnapshot({
      schema: PUBLICATION_SNAPSHOT_V1,
      source: { kind: "filesystem", root },
      maxAttempts: 1,
    }), (error) => {
      assert.ok(error instanceof PublicationError);
      assert.equal(error.code, "SOURCE_CHANGED");
      assert.equal(error.retryable, true);
      return true;
    });
  } finally {
    FilesystemBackend.prototype.list = original;
    await rm(root, { recursive: true, force: true });
    await rm(authorized, { recursive: true, force: true });
  }
});

test("capture rejects structurally invalid documents and nested symlinks", async () => {
  for (const mode of ["missing-type", "symlink"]) {
    const { root } = await fixture();
    try {
      if (mode === "missing-type") {
        await writeFile(path.join(root, "notes", "alpha.md"), "---\ntitle: Untyped\n---\n# Untyped\n");
      } else {
        await symlink(path.join(root, "notes", "alpha.md"), path.join(root, "notes", "alias.md"));
      }
      await assert.rejects(() => capturePublicationSnapshot({
        schema: PUBLICATION_SNAPSHOT_V1,
        source: { kind: "filesystem", root },
      }), (error) => {
        assert.ok(error instanceof PublicationError);
        assert.ok(["MALFORMED_DOCUMENT", "INVALID_BUNDLE"].includes(error.code));
        return true;
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("static View bridge reuses canonical read semantics and rejects mismatched admission", async () => {
  const { root } = await fixture();
  try {
    const snapshot = await capturePublicationSnapshot({
      schema: PUBLICATION_SNAPSHOT_V1,
      source: { kind: "filesystem", root },
    });
    const view = snapshot.manifest.views[0];
    assert.throws(
      () => createPublicationBridge({
        protocol: PUBLICATION_BRIDGE_V0,
        snapshot,
        admittedView: { id: view.id, entry: view.entry, access: view.access, entryDigest: `sha256:${"0".repeat(64)}` },
      }),
      (error) => error instanceof PublicationError && error.code === "INVALID_BRIDGE_ADMISSION",
    );
    const bridge = createPublicationBridge({
      protocol: PUBLICATION_BRIDGE_V0,
      snapshot,
      admittedView: { id: view.id, entry: view.entry, access: view.access, entryDigest: view.entryObject.digest },
    });
    const hello = await bridge.handle({ bridge: "v0", type: "hello", id: "h" });
    assert.equal(hello.reply.type, "hello:result");
    assert.equal(hello.reply.result.mode, "snapshot");
    assert.deepEqual(hello.reply.result.host, {
      kind: "oss",
      capabilities: [
        "edges",
        "graph",
        "open-page",
        "query.count",
        "query.field-or",
        "query.kind-projection",
        "query.newest",
        "query.open",
        "render-document",
      ],
      limits: { query: 500, edges: 1000, graphDocuments: 1000, graphRelationships: 10_000, replyBytes: 2 * 1024 * 1024 },
    }, "a static snapshot never declares subscribe-deltas");
    const versioned = await bridge.handle({ bridge: "v1", type: "read-versioned", id: "rv", docId: "notes/alpha" });
    assert.equal(versioned.reply.type, "read-versioned:result", "the read-only host forwards the v1 read");
    assert.equal(versioned.reply.result.doc.id, "notes/alpha");
    assert.match(versioned.reply.result.version, /^sha256:/);
    const proposal = await bridge.handle({
      bridge: "v1",
      type: "action.propose",
      requestId: "p",
      action: { kind: "document.set-field", docId: "notes/alpha", field: "title", value: "x", expectedVersion: versioned.reply.result.version },
    });
    assert.equal(proposal.reply.type, "error");
    assert.equal(proposal.reply.id, "p");
    assert.equal(proposal.reply.error.code, "FORBIDDEN", "a write on the static host is refused, never dropped");
    const extension = await bridge.handle({ bridge: "v0", type: "host", id: "x", capability: "record.open", input: {} });
    assert.equal(extension.reply.error.code, "FORBIDDEN");
    const portal = createPublicationBridge({
      protocol: PUBLICATION_BRIDGE_V0,
      snapshot,
      admittedView: { id: view.id, entry: view.entry, access: view.access, entryDigest: view.entryObject.digest },
      host: { kind: "portal" },
    });
    const portalHello = await portal.handle({ bridge: "v0", type: "hello", id: "h2" });
    assert.equal(portalHello.reply.result.host.kind, "portal");
    assert.deepEqual(portalHello.reply.result.host.capabilities, hello.reply.result.host.capabilities);
    const query = await bridge.handle({ bridge: "v0", type: "query", id: "q", params: { prefix: "notes/" } });
    assert.equal(query.reply.type, "query:result");
    assert.equal(query.reply.result.count, 2);
    const read = await bridge.handle({ bridge: "v0", type: "read", id: "r", docId: "notes/alpha" });
    assert.equal(read.reply.result.id, "notes/alpha");
    const rendered = await bridge.handle({ bridge: "v0", type: "render-document", id: "m", docId: "notes/alpha" });
    assert.equal(rendered.reply.type, "render-document:result");
    assert.match(rendered.reply.result.html, /<h1[^>]*>Alpha<\/h1>/);
    const edges = await bridge.handle({ bridge: "v0", type: "edges", id: "e", params: {} });
    assert.deepEqual(edges.reply.result.edges, [{ from: "notes/alpha", to: "notes/beta", text: "Beta" }]);
    const graph = await bridge.handle({ bridge: "v0", type: "graph", id: "g" });
    assert.equal(graph.reply.type, "graph:result", "the static bridge inherits graph from the shared service");
    assert.equal(graph.reply.result.okfVersion, "0.2");
    assert.deepEqual(
      graph.reply.result.documents.map((row) => row.id),
      ["notes/alpha", "notes/beta", "views-registry/fixture"],
    );
    assert.equal(graph.reply.result.documents.some((row) => Object.hasOwn(row, "body")), false);
    assert.deepEqual(graph.reply.result.relationships, [{ from: "notes/alpha", to: "notes/beta", text: "Beta" }]);
    assert.deepEqual(graph.reply.result.counts, { documents: 3, relationships: 1 });
    assert.equal(Object.hasOwn(graph.reply.result, "model"), false);
    const graphBodies = await bridge.handle({ bridge: "v0", type: "graph", id: "gb", includeBodies: true });
    assert.equal(graphBodies.reply.type, "graph:result");
    const alpha = graphBodies.reply.result.documents.find((row) => row.id === "notes/alpha");
    assert.equal(alpha.body, read.reply.result.body, "snapshot bodies match the read request byte for byte");
    const subscribed = await bridge.handle({ bridge: "v0", type: "subscribe", id: "s" });
    assert.equal(subscribed.subscribed, true);
    const open = await bridge.handle({ bridge: "v0", type: "open-page", pageId: "views-registry/fixture" });
    assert.equal(open.openViewId, "views-registry/fixture");
    const invalid = await bridge.handle({ bridge: "v0", type: "explode", id: "x" });
    assert.equal(invalid.reply.type, "error");
    assert.equal(invalid.reply.error.code, "FORBIDDEN", "an unknown request type is refused, not dropped");
    await snapshot.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function linkFixture() {
  const { root } = await fixture();
  await writeFile(
    path.join(root, "notes", "links.md"),
    "---\ntype: Note\ntitle: Links\n---\n# Links\n\n[web](https://EXAMPLE.com:443/a) [other](https://other.example/b) " +
      "[plain](http://example.com/c) [script](javascript:alert(1)) [peer](./beta.md)\n",
    "utf8",
  );
  const snapshot = await capturePublicationSnapshot({ schema: PUBLICATION_SNAPSHOT_V1, source: { kind: "filesystem", root } });
  return { root, snapshot };
}

const anchorHrefs = (html) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) => match[1]);

test("a captured handle renders from verified source with the caller's policy and leaves the snapshot alone", async () => {
  const { root, snapshot } = await linkFixture();
  try {
    const manifestBefore = snapshot.serializeManifest();
    for (const row of snapshot.manifest.documents) {
      const stored = new TextDecoder().decode(await snapshot.readObject(row.rendered.html));
      for (const options of [undefined, {}, { externalLinks: "none" }, { externalLinks: "unknown" }, { externalLinks: ["example.com"] }]) {
        assert.deepEqual(await snapshot.renderDocument(row.id, options), { html: stored, bounded: row.rendered.bounded }, row.id);
      }
    }
    const https = await snapshot.renderDocument("notes/links", { externalLinks: "https" });
    assert.deepEqual(anchorHrefs(https.html), ["https://example.com/a", "https://other.example/b"]);
    assert.match(https.html, /<a href="https:\/\/example\.com\/a" rel="noopener noreferrer" target="_blank" class="doc-link-external">web<\/a>/);
    assert.match(https.html, /data-aslite-doc-id="notes\/beta"/);
    assert.doesNotMatch(https.html, /javascript:|http:\/\//);
    const hosts = await snapshot.renderDocument("notes/links", { externalLinks: { hosts: ["example.com"] } });
    assert.deepEqual(anchorHrefs(hosts.html), ["https://example.com/a"]);
    assert.deepEqual(snapshot.serializeManifest(), manifestBefore, "rendering again changes no snapshot bytes");
    const row = snapshot.manifest.documents.find((document) => document.id === "notes/links");
    assert.deepEqual(anchorHrefs(new TextDecoder().decode(await snapshot.readObject(row.rendered.html))), [], "the stored HTML stays inert");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a captured handle refuses an unknown document, a tampered source and a closed handle", async () => {
  const { root, snapshot } = await linkFixture();
  try {
    await assert.rejects(
      () => snapshot.renderDocument("constructor", { externalLinks: "https" }),
      (error) => error instanceof PublicationError && error.code === "OBJECT_MISSING" && error.subject === "constructor",
    );
    const row = snapshot.manifest.documents.find((document) => document.id === "notes/links");
    const objects = snapshot.objects;
    const original = objects.get(row.source.digest);
    const tampered = original.slice();
    tampered[tampered.length - 2] ^= 1;
    objects.set(row.source.digest, tampered);
    await assert.rejects(
      () => snapshot.renderDocument("notes/links"),
      (error) => error instanceof PublicationError && error.code === "OBJECT_DIGEST_MISMATCH",
    );
    objects.set(row.source.digest, original);
    await snapshot.close();
    await assert.rejects(
      () => snapshot.renderDocument("notes/links"),
      (error) => error instanceof PublicationError && error.code === "HANDLE_CLOSED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bundle-read View's render-document has no anchors, whatever the handle or the request says", async () => {
  const { root, snapshot } = await linkFixture();
  try {
    const view = snapshot.manifest.views[0];
    assert.equal(view.access, "bundle-read");
    const bridge = createPublicationBridge({
      protocol: PUBLICATION_BRIDGE_V0,
      snapshot,
      admittedView: { id: view.id, entry: view.entry, access: view.access, entryDigest: view.entryObject.digest },
    });
    const row = snapshot.manifest.documents.find((document) => document.id === "notes/links");
    const stored = new TextDecoder().decode(await snapshot.readObject(row.rendered.html));
    assert.deepEqual(anchorHrefs((await snapshot.renderDocument("notes/links", { externalLinks: "https" })).html).length, 2, "the document does hold web links");
    const requests = [
      { bridge: "v0", type: "render-document", id: "plain", docId: "notes/links" },
      { bridge: "v0", type: "render-document", id: "asks", docId: "notes/links", externalLinks: "https" },
      { bridge: "v0", type: "render-document", id: "options", docId: "notes/links", options: { externalLinks: "https" } },
      { bridge: "v0", type: "render-document", id: "params", docId: "notes/links", params: { externalLinks: "https" } },
    ];
    for (const request of requests) {
      const { reply } = await bridge.handle(request);
      if (request.id === "plain") {
        assert.equal(reply.type, "render-document:result", request.id);
        assert.equal(reply.result.html, stored, request.id);
        assert.doesNotMatch(reply.result.html, /<a[\s>]/, request.id);
      } else {
        assert.equal(reply.type, "error", request.id);
        assert.equal(reply.error.code, "USAGE", request.id);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an aliased or symlinked root is refused with the resolved path to pass instead", async () => {
  const { root } = await fixture();
  const holder = await realpath(await mkdtemp(path.join(os.tmpdir(), "superbee-publication-alias-")));
  try {
    const linkedParent = path.join(holder, "parent-link");
    await symlink(path.dirname(root), linkedParent);
    const linkedRoot = path.join(holder, "root-link");
    await symlink(root, linkedRoot);
    const cases = [
      { given: path.join(linkedParent, path.basename(root)), shape: /is not in canonical form \(it resolves to / },
      { given: linkedRoot, shape: /is a symlink to / },
    ];
    for (const { given, shape } of cases) {
      await assert.rejects(
        capturePublicationSnapshot({ schema: PUBLICATION_SNAPSHOT_V1, source: { kind: "filesystem", root: given } }),
        (error) => {
          assert.ok(error instanceof PublicationError);
          assert.equal(error.code, "INVALID_OBJECT_IDENTITY");
          assert.equal(error.actual, given);
          assert.equal(error.expected, root);
          assert.match(error.message, shape);
          assert.ok(error.message.includes(JSON.stringify(root)));
          assert.match(error.message, /pass the resolved path \(await fs\.realpath\(root\)\)/);
          return true;
        },
      );
    }
    const handle = await capturePublicationSnapshot({ schema: PUBLICATION_SNAPSHOT_V1, source: { kind: "filesystem", root } });
    await handle.close();
  } finally {
    await rm(holder, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
