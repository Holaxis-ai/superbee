/**
 * `@superbee/server` — the wire protocol (`docs/WIRE-PROTOCOL.md`) as a Web-standard
 * `fetch`-style router over the OKF engine. A pure consumer of `@superbee/core` — no
 * parsing/link/OKF logic lives here (see `router.ts` module doc). A host mounts the router from
 * `@superbee/server/router` with its own authenticating context resolver; this root carries the
 * route table and the reference in-memory outcome store.
 *
 * @packageDocumentation
 */

export { MemoryOperationOutcomeStore } from "./operation-outcomes.js";
export type {
  MemoryOperationOutcomeStoreOptions,
  OperationClaim,
  OperationOutcomeStore,
  RecordedOperation,
  RecordedOutcome,
  RecordedResponse,
} from "./operation-outcomes.js";
export { WIRE_ENDPOINTS } from "./router.js";
