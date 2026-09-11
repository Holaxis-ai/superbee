/** Browser-safe client adapter for the Superbee wire protocol. */

export { RemoteBackend, RemoteError } from "./remote-backend.js";
export type {
  FetchLike,
  HeadsOptions,
  HeadsResult,
  RemoteBackendOptions,
  RemoteSnapshot,
  SnapshotDocument,
  SnapshotHeader,
  WireCapabilities,
} from "./remote-backend.js";
export { headsDigest, isHeadsDigest, sortHeads } from "./heads-digest.js";
export type { DocumentHead } from "./heads-digest.js";
