import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { capturePublicationSnapshot, PUBLICATION_SNAPSHOT_V1 } from "../dist/index.js";
import { PublicationSnapshotBackend } from "../dist/snapshot-backend.js";

for (const edition of ["0.1", "0.2"]) {
  test(`publication preserves edition ${edition} legacy clocks in snapshot reads and heads`, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "superbee-publication-clock-")));
    try {
      await writeFile(path.join(root, "index.md"), `---\nokf_version: '${edition}'\n---\n`);
      const rows = [
        ["2026-01-02", "2026-01-02", "2026-01-02T00:00:00.000Z"],
        ["'2026-01-02'", "2026-01-02", "2026-01-02T00:00:00.000Z"],
        ["2026-01-02T03:04:05", "2026-01-02T03:04:05", "2026-01-02T03:04:05.000Z"],
        ["'2026-01-02T03:04:05'", "2026-01-02T03:04:05", "2026-01-02T03:04:05.000Z"],
        ["0", 0, "1970-01-01T00:00:00.000Z"],
      ];
      const sources = rows.map(([scalar]) => `---\ntype: Note\ntimestamp: ${scalar}\n---\nBody\n`);
      for (const [index, raw] of sources.entries()) await writeFile(path.join(root, `clock-${index}.md`), raw);
      const snapshot = await capturePublicationSnapshot({ schema: PUBLICATION_SNAPSHOT_V1, source: { kind: "filesystem", root } });
      try {
        const backend = new PublicationSnapshotBackend(snapshot);
        const heads = await backend.queryHeads();
        assert.equal(snapshot.manifest.source.okfEdition, edition);
        for (const [index, row] of snapshot.manifest.documents.entries()) {
          const expected = rows[index][edition === "0.2" ? 1 : 2];
          assert.equal(row.frontmatter.timestamp, expected);
          assert.equal((await backend.read(row.id)).doc.frontmatter.timestamp, expected);
          assert.equal(heads[index].frontmatter.timestamp, expected);
          const source = await snapshot.readObject(row.source);
          assert.equal(new TextDecoder().decode(source), sources[index]);
          assert.equal(row.source.digest, `sha256:${createHash("sha256").update(sources[index]).digest("hex")}`);
        }
      } finally { await snapshot.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
