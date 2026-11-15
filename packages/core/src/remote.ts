/** Browser-safe wire protocol answer shapes, parsers and typed rejection. */

export { RemoteError } from "./remote-error.js";
// The heads and snapshot grammar's reference validators, for a host that serves the same grammar
// through routes of its own.
export { SNAPSHOT_DIGEST_MISMATCH, SNAPSHOT_TRUNCATED, parseHeadsAnswer, readSnapshotStream } from "./remote-parsers.js";
export type { HeadsOptions, WireCapabilities, HeadsResult, ReadSnapshotStreamOptions, RemoteSnapshot, SnapshotDocument, SnapshotHeader } from "./remote-parsers.js";
export { headsDigest, isHeadsDigest, sortHeads } from "./heads-digest.js";
export type { DocumentHead } from "./heads-digest.js";
