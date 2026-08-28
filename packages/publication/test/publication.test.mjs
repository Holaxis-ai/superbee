import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
    const subscribed = await bridge.handle({ bridge: "v0", type: "subscribe", id: "s" });
    assert.equal(subscribed.subscribed, true);
    const open = await bridge.handle({ bridge: "v0", type: "open-page", pageId: "views-registry/fixture" });
    assert.equal(open.openViewId, "views-registry/fixture");
    const invalid = await bridge.handle({ bridge: "v0", type: "explode", id: "x" });
    assert.equal(invalid.reply.type, "error");
    await snapshot.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
