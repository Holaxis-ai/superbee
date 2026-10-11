import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExportArchiveError, ExportPageChain, exportProvenance, joinExportPages, materializeExport, readStoredZip, verifyExport } from "../src/portable-export.js";

const archive = (name: string) => Buffer.from(JSON.parse(readFileSync(new URL(`./fixtures/hosted-sync-v1/${name}.json`, import.meta.url), "utf8")).response.bodyBase64, "base64");
const whole = () => verifyExport(archive("export-200"), "notes.a");
const page = (name: string) => verifyExport(archive(`export-200-page-${name}`), "notes.a", { paged: true });
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

test("whole and joined page provenance bind raw manifests and one exact inventory", () => {
  const verified = whole();
  const provenance = exportProvenance(verified);
  const raw = readStoredZip(archive("export-200")).find((entry) => entry.name === "superbee-export.json")!;
  assert.deepEqual(provenance.manifests, [{ sha256: sha(raw.data), bytes: raw.data.byteLength }]);
  const chain = new ExportPageChain();
  const first = page("first"); const last = page("last");
  assert.equal(chain.add(first), "2.1"); assert.equal(chain.add(last), undefined);
  const joined = chain.joined();
  assert.deepEqual(exportProvenance(joined).manifests, [...exportProvenance(first).manifests, ...exportProvenance(last).manifests]);
  assert.equal(exportProvenance(joined).inventorySha256, provenance.inventorySha256);
  assert.deepEqual(exportProvenance(joined).source, provenance.source);
  const rows = verified.entries.map((entry) => ({ path: entry.path, kind: entry.kind, bytes: entry.bytes.byteLength, sha256: sha(entry.bytes) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.equal(provenance.inventorySha256, sha(JSON.stringify(rows)));
  (provenance.source as { revision: number }).revision = 99;
  assert.equal(exportProvenance(verified).source.revision, 2);
});

test("only complete unmodified verifier-owned values may become a fresh directory", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "sb-materialize-"));
  try {
    const verified = whole();
    const directory = await materializeExport(verified, parent);
    assert.equal(path.dirname(directory), await realpath(parent));
    assert.deepEqual((await readdir(directory)).sort(), ["index.md", "notes"]);
    for (const entry of verified.entries) assert.deepEqual(await readFile(path.join(directory, entry.path)), Buffer.from(entry.bytes));
    const second = await materializeExport(verified, parent);
    assert.notEqual(second, directory);
    await rm(directory, { recursive: true }); await rm(second, { recursive: true });
    const invalid = [ { ...whole() }, page("first"), whole(), whole(), whole() ];
    invalid[2]!.entries[0]!.bytes[0] ^= 1;
    (invalid[3]!.source as { revision: number }).revision = 100;
    (invalid[4]!.entries[0] as { path: string }).path = "../outside";
    for (const value of invalid) await assert.rejects(materializeExport(value, parent), ExportArchiveError);
    assert.deepEqual(await readdir(parent), []);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("materialization takes its own bytes before asynchronous work", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "sb-materialize-snapshot-"));
  try {
    const verified = whole();
    const expected = Buffer.from(verified.entries[0]!.bytes);
    const pending = materializeExport(verified, parent);
    verified.entries[0]!.bytes.fill(0);
    const folder = await pending;
    assert.deepEqual(await readFile(path.join(folder, "index.md")), expected);
    assert.throws(() => exportProvenance(verified), ExportArchiveError);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("page-chain refuses incomplete, repeated, reversed and changed verified pages", () => {
  assert.throws(() => joinExportPages([page("first")]), ExportArchiveError);
  assert.throws(() => joinExportPages([page("last"), page("first")]), ExportArchiveError);
  assert.throws(() => joinExportPages([page("first"), page("first"), page("last")]), ExportArchiveError);
  const first = page("first"); const last = page("last");
  (last.source as { revision: number }).revision = 3;
  assert.throws(() => joinExportPages([first, last]), ExportArchiveError);
});
