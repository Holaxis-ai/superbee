import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { CODE_UNIT_ORDER } from "@superbee/core/string-identity-agreement";
import { capturePublicationSnapshot, PUBLICATION_SNAPSHOT_V1, PUBLICATION_SNAPSHOT_SCHEMA_V1 } from "../dist/index.js";
import { PublicationSnapshotBackend } from "../dist/snapshot-backend.js";
import { canonicalJson } from "../dist/canonical-json.js";

// These shared rows have distinct filesystem folds, including on case-insensitive hosts.
const names = CODE_UNIT_ORDER.filter(id => ["a-b", "a.b", "a2", "a_b", "ab", "\u00e9", "\u{1f41d}", "\ue000"].includes(id));

test("publication identity arrays and digest are independent of locale collation", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "publication-order-")));
  let first;
  let second;
  try {
    await mkdir(path.join(root, "views-registry"));
    await mkdir(path.join(root, "views"));
    await writeFile(path.join(root, "index.md"), "---\nokf_version: '0.2'\n---\n");
    for (const name of [...names].reverse()) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, "index.md"), `# ${name}\n`);
      await writeFile(path.join(root, name, "log.md"), `# ${name}\n`);
      await writeFile(path.join(root, `${name}.md`), `---\ntype: Note\n---\n${[...names].reverse().flatMap(to => [...names].reverse().flatMap(text => [`[${text}](${to}.md)`, `[${text}](./${to}.md)`])).join("\n")}\n`);
      await writeFile(path.join(root, "views", `${name}.html`), "<!doctype html><title>View</title>");
      if (/^[A-Za-z0-9._-]+$/.test(name)) {
        await writeFile(path.join(root, "views-registry", `${name}.md`), "---\ntype: View\nentry: views/a-b.html\n---\n");
      }
    }
    const options = { schema: PUBLICATION_SNAPSHOT_V1, source: { kind: "filesystem", root } };
    first = await capturePublicationSnapshot(options);
    const original = String.prototype.localeCompare;
    try {
      String.prototype.localeCompare = function (other) { return this < other ? 1 : this > other ? -1 : 0; };
      second = await capturePublicationSnapshot(options);
    } finally {
      String.prototype.localeCompare = original;
    }
    const manifest = first.manifest;
    assert.equal(second.manifest.snapshotDigest, manifest.snapshotDigest);
    assert.deepEqual(second.serializeManifest(), first.serializeManifest());
    assert.deepEqual(manifest.documents.map(row => row.id), [...names.slice(0, 5), ...names.slice(0, 5).map(name => `views-registry/${name}`), ...names.slice(5)]);
    assert.deepEqual(manifest.blobs.map(row => row.key), names.map(name => `views/${name}.html`));
    assert.deepEqual(manifest.views.map(row => row.id), names.slice(0, 5).map(name => `views-registry/${name}`));
    assert.deepEqual(manifest.reserved.map(row => `${row.dir}/${row.name}`), ["/index.md", ...names.flatMap(name => [`${name}/index.md`, `${name}/log.md`])]);
    assert.deepEqual(manifest.relationships, names.flatMap(from => names.flatMap(to => names.flatMap(text =>
      [`./${to}.md`, `${to}.md`].map(href => ({ from, to, text, href }))))));

    // Historical v1 array order is valid data, not a request to normalize or rehash it.
    const legacy = JSON.parse(new TextDecoder().decode(first.serializeManifest()));
    for (const key of ["documents", "blobs", "views", "reserved", "relationships"]) legacy[key].reverse();
    const { snapshotDigest: ignored, ...withoutDigest } = legacy;
    legacy.snapshotDigest = `sha256:${createHash("sha256").update(canonicalJson(withoutDigest)).digest("hex")}`;
    const bytes = new TextEncoder().encode(canonicalJson(legacy));
    const retained = JSON.parse(new TextDecoder().decode(bytes));
    const validate = new Ajv2020({ strict: true }).compile(PUBLICATION_SNAPSHOT_SCHEMA_V1);
    assert.equal(validate(retained), true, JSON.stringify(validate.errors));
    const oldHandle = { manifest: retained, readObject: ref => first.readObject(ref), serializeManifest: () => bytes, close: async () => {} };
    const backend = new PublicationSnapshotBackend(oldHandle);
    for (const row of retained.documents) assert.equal((await backend.read(row.id)).version, row.version);
    for (const row of retained.blobs) assert.deepEqual((await backend.readBlob(row.key)).bytes, await first.readObject(row.object));
    for (const row of retained.reserved) assert.equal((await backend.readReserved(row.dir, row.name)).version, row.version);
    assert.deepEqual(new TextEncoder().encode(canonicalJson(oldHandle.manifest)), bytes, "reading did not normalize stored arrays or rehash the manifest");
    assert.deepEqual(oldHandle.serializeManifest(), bytes);
    assert.equal(oldHandle.manifest.snapshotDigest, legacy.snapshotDigest);
    assert.notEqual(legacy.snapshotDigest, manifest.snapshotDigest, "array order remains part of the v1 digest");
  } finally {
    await second?.close();
    await first?.close();
    await rm(root, { recursive: true, force: true });
  }
});
