/** Browser-safe client adapter for the Superbee wire protocol. */

export { RemoteBackend } from "./remote-backend.js";
export type { FetchLike, HeadsOptions, RemoteBackendOptions, WireCapabilities } from "./remote-backend.js";
export { RemoteError } from "./remote-error.js";
// The heads and snapshot grammar's reference validators, for a host that serves the same grammar
// through routes of its own; `RemoteBackend.heads` and `RemoteBackend.snapshot` call these.
export { SNAPSHOT_DIGEST_MISMATCH, SNAPSHOT_TRUNCATED, parseHeadsAnswer, readSnapshotStream } from "./remote-parsers.js";
export type { HeadsResult, ReadSnapshotStreamOptions, RemoteSnapshot, SnapshotDocument, SnapshotHeader } from "./remote-parsers.js";
export { headsDigest, isHeadsDigest, sortHeads } from "./heads-digest.js";
export type { DocumentHead } from "./heads-digest.js";
