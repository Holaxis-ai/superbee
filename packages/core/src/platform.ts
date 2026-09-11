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
 * - `shared-confirmed`: the authority acknowledged or served exactly this content at the
 *   runtime's last exchange with it. It may only be produced from an authority acknowledgement
 *   (a write the authority answered, or an intent it acknowledged under its request identity)
 *   or from an authority read (a request-driven read, or a working copy refreshed from the
 *   authority with no local edit outstanding). A local write never produces it, so no
 *   presentation can report shared confirmation without an acknowledgement. It says nothing
 *   about what the authority holds now: request-driven's last exchange is the request itself,
 *   browser-local's is its last sync, and the authority may have moved (or deleted the document)
 *   since. A document the authority deleted disappears from a browser-local working copy at
 *   its next sync (pull reconciles deletions against the authority's heads) unless a local
 *   edit holds it, in which case pull retains the local content and rewrites its base to an
 *   absent shared version, and the document reads `local-pending` until push delivers the edit
 *   and settles the authority's conflict answer (a 412 whose actual version is `null`) as a
 *   conflict against an absent remote, from which point it reads `local-conflict` with
 *   `remote: null`; request-driven answers absence directly. Between syncs a deleted document
 *   still reads `shared-confirmed` at its last served version, so a presentation must not read
 *   `shared-confirmed` as proof of present existence.
 * - `local-pending`: the working copy holds a local edit the authority has not accepted;
 *   `requestId` names the journaled intent that will deliver it and `base` the shared version
 *   the edit was made against.
 * - `local-conflict`: the authority's head moved under a local edit; `remote` is the version the
 *   authority held when the conflict was recorded, and the local content is retained. Any
 *   conflict intent on a document decides its provenance, even after further local edits
 *   chained behind it.
 *
 * One token space per runtime. In every provenance state `version` is the runtime's own premise
 * token: the value an application may pass back as `expectedVersion`, equal to the `version` of
 * a query row for the same document. For browser-local that is the working copy's document
 * version; for request-driven it is the authority's. `shared-confirmed` also carries
 * `acknowledged`, the token the authority mints for the same content, which differs from
 * `version` whenever the authority hashes bytes the working copy normalizes differently (a
 * filesystem authority over hand-authored files). An application compares `acknowledged` to the
 * authority and `version` to its own runtime, never one to the other.
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
  | { state: "shared-confirmed"; version: Version; acknowledged: Version }
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
   * The version the edit was made against: the `version` a read, query row, or commit of this
   * runtime reported. Omitted, the runtime reads, decides and writes with its own retry. Given,
   * the commit is a single compare-and-swap at that premise: request-driven
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
  /**
   * Working-copy documents whose bytes neither a recorded shared base nor an intent accounts
   * for: a defect in the working copy, since every local write journals an intent. `query`
   * omits such a document and `read` rejects it; this count is where it surfaces. Always 0 in
   * request-driven mode, which has no working copy.
   */
  unconfirmed: number;
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

/** True only when the authority acknowledged or served this content at the runtime's last exchange with it. */
export function isSharedConfirmed(provenance: Provenance): provenance is Extract<Provenance, { state: "shared-confirmed" }> {
  return provenance.state === "shared-confirmed";
}

/**
 * A confirmation from an authority answer; callers must hold that answer, never infer it from a
 * local write. `version` is the runtime's own premise token and `acknowledged` the authority's
 * token for the same content; omitted, the two are the same token space.
 */
export function sharedConfirmed(version: Version, acknowledged: Version = version): Provenance {
  return { state: "shared-confirmed", version, acknowledged };
}

export function localPending(version: Version, base: Version | null, requestId: string): Provenance {
  return { state: "local-pending", version, base, requestId };
}

export function localConflict(version: Version, base: Version | null, remote: Version | null, requestId: string): Provenance {
  return { state: "local-conflict", version, base, remote, requestId };
}
