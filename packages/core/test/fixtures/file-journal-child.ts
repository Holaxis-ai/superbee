/**
 * Child for the kill row of `file-journaled-backend.test.ts`: opens the store, then records one
 * journaled write after another and reports each one only after it resolved. The parent kills
 * this process with SIGKILL mid-stream, so the last append may be torn or fsynced but unreported.
 */
import { FileJournaledBackend } from "../../src/file-journaled-backend.js";

const [directory, lockRoot] = process.argv.slice(2);
const backend = await FileJournaledBackend.open({ directory: directory!, lock: { lockRoot: lockRoot!, waitMs: 0 } });
process.send!({ type: "open" });
for (let index = 0; ; index++) {
  const id = `kill/doc-${index % 7}`;
  const body = `write ${index} ${"x".repeat(index % 13 * 97)}`;
  const written = await backend.writeJournaled(id, { id, frontmatter: { type: "Note" }, body }, {
    intent: { requestId: `kill-${index}`, kind: "document.write", target: id, base: null, baseContent: null, createdAt: "2026-09-22T00:00:00.000Z" },
    meta: [{ key: "last", value: index }],
  });
  process.send!({ type: "ack", index, id, version: written.version, sequence: written.intent!.sequence });
}
