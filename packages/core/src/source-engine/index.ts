/**
 * `@superbee/core/source-engine`: the portable half of the integration source engine.
 *
 * A {@link SourceProfile} turns a bound Source Feed, a cursor and a transport into pages of
 * normalized records; it never opens a socket, never sees a credential and never writes. A
 * {@link Transport} is the one network port: it never follows a redirect and refuses a body over
 * its byte bound. {@link observeSource} wraps the transport before a profile sees it and owns the
 * host guard (every URL and redirect hop within the profile's hosts, the auth kind's credential
 * hosts and the declared keyless domains, plus the address rule), robots.txt for keyless hosts,
 * the method rule and header allowlist, the budget and deadline, the status-to-outcome mapping,
 * the cursor rule (a cursor is stored only after its page commits), completeness, and the diff into
 * record-overlay changes, with disappearance only from a complete observation.
 *
 * Finite local inputs use bindSnapshotSource/decodeSnapshot/admitSnapshot/observeSnapshot;
 * admission precedes reconciliation and the same internal driver owns state transitions.
 *
 * Storage-neutral and Worker-free: no Node globals or builtins, and nothing here calls `fetch`.
 */
export {
  canonicalRobotsPath,
  fetchIdentity,
  parseRobots,
  refusedAddress,
  robotsDecision,
  robotsRuleMatches,
} from "./robots.js";
export type { FetchIdentity, RobotsGroup } from "./robots.js";
export { DEFAULT_SOURCE_BUDGET, DEFAULT_STATUS_RULES, sourceHostSet } from "./guard.js";
export type { HostSet } from "./guard.js";
export { DEFAULT_MISSING_THRESHOLD, MAX_CURSOR_CHARS, MAX_REPLAY_FAILURES, observeSource, unsupportedContent } from "./observe.js";
export { isSourceState, MachineStateConflict, MemoryMachineState } from "./machine-state.js";
export type { MachineState, PendingChange, RecordEntry, SourceState } from "./machine-state.js";
export type {
  CommitResult,
  HttpMethod,
  NormalizedRecord,
  ObserveContext,
  ObservePage,
  ObserveSourceOptions,
  PageCommit,
  ProfileDiagnostic,
  ProfileRequest,
  ProfileResponse,
  ProfileTransport,
  RequestRules,
  SourceBudget,
  SourceOutcome,
  SourceProfile,
  SourceRequestRow,
  SourceRunReceipt,
  SpecResult,
  StatusRules,
  Transport,
  TransportRequest,
  TransportResult,
} from "./types.js";
export { createSourceOverlayAdapter, isSourceOverlaySnapshot, MAX_SOURCE_OVERLAY_ENTRIES } from "./overlay.js";
export type { SourceOverlayAdapter, SourceOverlayEntry, SourceOverlayOptions, SourceOverlayResult, SourceOverlaySnapshot } from "./overlay.js";
export { SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_RECORDS, SNAPSHOT_PROFILE, SNAPSHOT_REFUSAL_CODES, SnapshotRefusal,
  bindSnapshotSource, decodeSnapshot, admitSnapshot, observeSnapshot } from "./snapshot.js";
export type { BoundSnapshotSource, SnapshotDocument, DecodedSnapshot, SnapshotRefusalCode, SnapshotCapacityInput, SnapshotCapacityFacts,
  SnapshotAdmissionOptions, SnapshotAdmission, ObserveSnapshotOptions, SnapshotRunReceipt } from "./snapshot.js";
export { SnapshotEvidenceRefusal, parseSnapshotEvidence, assessSnapshotFreshness } from "./evidence.js";
export type { SnapshotEvidenceIdentity, SnapshotEvidence, SnapshotEvidenceObservation, SnapshotFreshnessRow, SnapshotFreshness } from "./evidence.js";

export { sourceTargetId, createSourceTargetAdapter } from "./target.js";
export type { SourceTargetNamespace, SourceTargetLimits, SourceTargetAdmission, SourceTargetDelivery, SourceTargetAdapterOptions, SourceEstablishment, SourceCommitPreparation } from "./target.js";
