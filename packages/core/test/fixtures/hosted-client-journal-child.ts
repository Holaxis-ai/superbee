/**
 * Child for the lock rows of `hosted-client-journal.test.ts`: opens the journal, records one held
 * write, reports `open`, and then holds the directory until the parent kills it.
 */
import { openHostedClientJournalWith } from "../../src/hosted-client/journal.js";

const [directory, lockRoot, requestId] = process.argv.slice(2);
const journal = await openHostedClientJournalWith({ directory: directory!, lock: { waitMs: 0 } }, { lockRoot: lockRoot! });
await journal.put({
  requestId: requestId!,
  binding: "sha256:" + "0".repeat(64),
  bundleId: "notes.a",
  workspace: null,
  operation: "create",
  documentId: "notes/child",
  document: "---\ntype: Note\n---\nchild",
  digest: "sha256:" + "1".repeat(64),
  expectedVersion: null,
  okfVersion: "0.2",
  createdAt: "2026-10-17T00:00:00.000Z",
  attempts: 1,
  state: "unknown",
});
process.send!({ type: "open" });
setInterval(() => {}, 60_000);
