import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, MAX_EXPORT_BYTES, ExportArchiveError, ExportPageChain, exportProvenance, joinExportPages, materializeExport, readStoredZip, verifyExport } from "../src/portable-export.js";

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

test("mutating a joined result cannot alter accepted pages or subsequent joins", () => {
  const first = page("first"); const last = page("last");
  const chain = new ExportPageChain(); chain.add(first); chain.add(last);
  const joined = chain.joined();
  (joined.source as { revision: number }).revision = 900;
  joined.entries[0]!.bytes.fill(0);
  for (const repeated of [chain.joined(), joinExportPages([first, last])]) {
    assert.deepEqual(repeated.source, whole().source);
    assert.deepEqual(repeated.entries.map((entry) => Buffer.from(entry.bytes)), whole().entries.map((entry) => Buffer.from(entry.bytes)));
    assert.equal(exportProvenance(repeated).inventorySha256, exportProvenance(whole()).inventorySha256);
  }
});

/** Fixture writer: stored ZIP records let the test charge real headers and padded manifests. */
function zip(entries: readonly { name: string; bytes: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = []; const directory: Uint8Array[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(entry.bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(entry.bytes.length, 20); central.writeUInt32LE(entry.bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    parts.push(local, entry.bytes); directory.push(central); offset += local.length + entry.bytes.length;
  }
  const end = Buffer.alloc(22); const size = directory.reduce((sum, record) => sum + record.length, 0);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...directory, end]);
}

test("page-chain aggregate ZIP budget includes manifests and refuses before retaining the excess page", () => {
  const chain = new ExportPageChain(); let acceptedZipBytes = 0; const count = 129;
  for (let from = 0; from < count; from++) {
    const name = `notes/page-${from}.md`; const bytes = Buffer.from("a");
    const manifest = Buffer.from(JSON.stringify({ format: "superbee-export/1", source: { tenantId: "tenant:a", bundleId: "notes.a", revision: 2, okfEdition: null }, exportedAt: "2030-01-01T00:00:00.000Z",
      counts: { documents: count, reserved: 0, blobs: 0 }, entries: [{ path: name, bytes: bytes.length, sha256: sha(bytes) }],
      page: { from, count: 1, total: count, ...(from + 1 < count ? { next: String(from + 1) } : {}) }, padding: "x".repeat(1024 * 1024) }));
    const raw = zip([{ name, bytes }, { name: "superbee-export.json", bytes: manifest }]);
    const next = verifyExport(raw, "notes.a", { paged: true });
    if (acceptedZipBytes + raw.byteLength <= MAX_EXPORT_BYTES) {
      chain.add(next); acceptedZipBytes += raw.byteLength;
    } else {
      assert.ok(acceptedZipBytes <= MAX_EXPORT_BYTES);
      assert.throws(() => chain.add(next), (error: unknown) => error instanceof ExportArchiveError && error.problem === "malformed");
      assert.throws(() => chain.add(next), ExportArchiveError);
      assert.throws(() => chain.joined(), ExportArchiveError);
      const compact = JSON.parse(manifest.toString()); delete compact.padding;
      assert.equal(chain.add(verifyExport(zip([{ name, bytes }, { name: "superbee-export.json", bytes: Buffer.from(JSON.stringify(compact)) }]), "notes.a", { paged: true })), String(from + 1));
      const lastName = `notes/page-${from + 1}.md`;
      compact.entries[0].path = lastName; compact.page.from += 1; delete compact.page.next;
      assert.equal(chain.add(verifyExport(zip([{ name: lastName, bytes }, { name: "superbee-export.json", bytes: Buffer.from(JSON.stringify(compact)) }]), "notes.a", { paged: true })), undefined);
      assert.equal(chain.joined().entries.length, count);
      assert.equal(chain.joined().bytes, count);
      return;
    }
  }
  assert.fail("the aggregate fixture must exceed the budget while every individual ZIP is valid");
});

/** A whole (unpaged) export of `docs` for `notes.a`, with a manifest that names every entry. */
function wholeArchive(docs: readonly string[]): Uint8Array {
  const entries = docs.map((name) => ({ name, bytes: Buffer.from(`---\ntitle: ${name}\n---\n`) }));
  const manifest = { format: "superbee-export/1", source: { tenantId: "tenant:a", bundleId: "notes.a", revision: 2, okfEdition: null }, exportedAt: "2030-01-01T00:00:00.000Z",
    counts: { documents: entries.length, reserved: 0, blobs: 0 }, entries: entries.map((entry) => ({ path: entry.name, bytes: entry.bytes.length, sha256: sha(entry.bytes) })) };
  return zip([...entries, { name: "superbee-export.json", bytes: Buffer.from(JSON.stringify(manifest)) }]);
}

test("the verifier refuses two entries that meet only under the full path fold", () => {
  // Control: entries that stay apart on every disk verify, so the refusals below are the fold's.
  assert.equal(verifyExport(wholeArchive(["notes/a-b.md", "notes/a_b.md"]), "notes.a").entries.length, 2);
  // Long s (U+017F) uppercases to S, so NTFS holds `referenceſ.md` and `references.md` as one file.
  const pairs = [["notes/references.md", "notes/reference\u017F.md"], ["notes/k.md", "notes/\u212A.md"], ["notes/i.md", "notes/\u0131.md"], ["notes/references/a.md", "notes/reference\u017F/b.md"]] as const;
  for (const [first, second] of pairs) {
    assert.throws(() => verifyExport(wholeArchive([first, second]), "notes.a"), (error: unknown) => error instanceof ExportArchiveError && error.problem === "unsafe_path" && error.message.includes("cannot keep apart"), `${first} and ${second}`);
  }
});
