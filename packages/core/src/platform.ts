/**
 * The platform contract an application programs against, above the two execution
 * implementations: request-driven (every verb is a request to the shared authority) and
 * browser-local (every verb runs against the page's own working copy, related to the authority
 * by synchronization). A presentation receives a {@link PlatformRuntime} and nothing else; it
 * never touches a backend, a transport, or a store.
 *
 * Provenance is the explicit result difference the two implementations are allowed to have.
 * Every read, query row, validation, and commit states where its answer stands with respect to
 * the shared authority:
 *
 * - `shared-confirmed`: the authority holds exactly this version. It may only be produced from
 *   an authority acknowledgement (a write the authority answered, or an intent it acknowledged
 *   under its request identity) or from an authority read (a request-driven read, or a working
 *   copy refreshed from the authority with no local edit outstanding). A local write never
 *   produces it, so no presentation can report shared confirmation without an acknowledgement.
 * - `local-pending`: the working copy holds a local edit the authority has not accepted;
 *   `requestId` names the journaled intent that will deliver it and `base` the shared version
 *   the edit was made against.
 * - `local-conflict`: the authority's head moved under a local edit; `remote` is the version the
 *   authority holds now, and the local content is retained.
 *
 * Model semantics (what a document is, how a query filters, what a kind warns about, when a
 * commit changes nothing) are identical across implementations; the contract kit in
 * `@superbee/browser-local` proves that by running one row table against both.
 *
 * This module carries types and pure helpers only: no behaviour, no Node builtins, so it
 * bundles for the browser (see `test/browser-bundle.test.ts`).
 */

import type { ConceptId, Frontmatter, OkfDocument, QueryFilter, Version } from "./types.js";
import type { ValidationWarning } from "./validation.js";

/** Which execution implementation answers a runtime's verbs. */
export type ExecutionMode = "request-driven" | "browser-local";

/** Where a result stands with respect to the shared authority. */
export type Provenance =
  | { state: "shared-confirmed"; version: Version }
  | { state: "local-pending"; version: Version; base: Version | null; requestId: string }
  | { state: "local-conflict"; version: Version; base: Version | null; remote: Version | null; requestId: string };

/** The three words a presentation shows for a provenance. */
export type ProvenanceLabel = "shared" | "pending" | "conflict";

/** What an implementation can do; a presentation adapts its affordances to these, never to the mode name. */
export interface PlatformCapabilities {
  mode: ExecutionMode;
  /** Commits succeed without the authority reachable. */
  offlineCommits: boolean;
  /** Documents and pending edits survive a reload of the host. */
  localPersistence: boolean;
  /** The authority records outcomes by request identity (wire `operations`). */
  operations: boolean;
}

export interface PlatformDocument {
  doc: OkfDocument;
  provenance: Provenance;
}

export interface PlatformQueryRow {
  id: ConceptId;
  version: Version;
  frontmatter: Frontmatter;
  provenance: Provenance;
}

export interface PlatformValidation {
  id: ConceptId;
  /** Kind warnings for this document against the bundle's own conventions; empty when it conforms or no kind governs it. */
  warnings: ValidationWarning[];
  provenance: Provenance;
}

/** A body edit; `expectedVersion` is the version the application read and is editing over. */
export interface PlatformEdit {
  body: string;
  /**
   * The version the edit was made against. Omitted, the runtime reads, decides and writes with
   * its own retry. Given, the commit is a single compare-and-swap at that premise: request-driven
   * rejects a stale premise with `VersionConflict` at commit time; browser-local applies the edit
   * to the working copy at that local premise and surfaces a moved shared head as
   * `local-conflict` when it synchronizes.
   */
  expectedVersion?: Version;
}

export interface PlatformCommit {
  id: ConceptId;
  /** False when the engine found nothing to change; the provenance is then the document's existing one. */
  changed: boolean;
  provenance: Provenance;
}

export interface PlatformSyncStatus {
  mode: ExecutionMode;
  /** Whether the last request to the authority succeeded; `null` before any was made. */
  online: boolean | null;
  /** Local edits the authority has not yet acknowledged (pending, in flight, or of unknown outcome). */
  pending: number;
  conflicts: number;
  refused: number;
  /** Delivery is paused (an authorization refusal); `pausedReason` says why. */
  paused: boolean;
  pausedReason?: string;
  /** The runtime's working set is complete: the authority's for request-driven, a finished bootstrap for browser-local. */
  complete: boolean;
}

export interface PlatformRuntime {
  capabilities(): PlatformCapabilities;
  /** Rejects ENOENT-shaped for an absent id and with `InvalidInputError` for an invalid one. */
  read(id: ConceptId): Promise<PlatformDocument>;
  /** Rows ordered by id, as the engine orders them. */
  query(filter?: QueryFilter): Promise<PlatformQueryRow[]>;
  validate(id: ConceptId): Promise<PlatformValidation>;
  commit(id: ConceptId, edit: PlatformEdit): Promise<PlatformCommit>;
  syncStatus(): Promise<PlatformSyncStatus>;
  /** Push pending work and pull the authority's changes; a no-op returning the status in request-driven mode. */
  sync(): Promise<PlatformSyncStatus>;
}

/** The word a presentation shows for a provenance. */
export function provenanceLabel(provenance: Provenance): ProvenanceLabel {
  switch (provenance.state) {
    case "shared-confirmed":
      return "shared";
    case "local-pending":
      return "pending";
    case "local-conflict":
      return "conflict";
  }
}

/** True only when the authority is known to hold this version. */
export function isSharedConfirmed(provenance: Provenance): provenance is Extract<Provenance, { state: "shared-confirmed" }> {
  return provenance.state === "shared-confirmed";
}

/** A confirmation from an authority answer; callers must hold that answer, never infer it from a local write. */
export function sharedConfirmed(version: Version): Provenance {
  return { state: "shared-confirmed", version };
}

export function localPending(version: Version, base: Version | null, requestId: string): Provenance {
  return { state: "local-pending", version, base, requestId };
}

export function localConflict(version: Version, base: Version | null, remote: Version | null, requestId: string): Provenance {
  return { state: "local-conflict", version, base, remote, requestId };
}
