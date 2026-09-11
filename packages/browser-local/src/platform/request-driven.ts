/**
 * The request-driven implementation of the platform contract: every verb is a request to the
 * shared authority through a `RemoteBackend`, and every answer is `shared-confirmed` at the
 * version the authority returned, because the authority itself produced it. There is no
 * working copy, so nothing is ever pending: a commit that cannot reach the authority rejects
 * with the carrier error, and the authority is unchanged.
 *
 * Every answer is `shared-confirmed` with `version` and `acknowledged` the same token, the
 * authority's: this mode has one token space. The factory is async because construction reads
 * the authority's wire capabilities once: this mode has no offline capability to protect, so a
 * construction that cannot reach the authority rejects with the carrier error rather than
 * handing out a runtime whose every verb would fail.
 */

import type { Bundle, ConceptId, QueryFilter, RemoteBackend, ValidationWarning } from "@superbee/core";
import { queryHeads, readDocVersioned } from "@superbee/core/bundle-ops";
import { mutateDocument } from "@superbee/core/document-mutation";
import type { KindRegistry } from "@superbee/core/kinds";
import {
  sharedConfirmed,
  type PlatformCapabilities,
  type PlatformCommit,
  type PlatformDocument,
  type PlatformEdit,
  type PlatformQueryRow,
  type PlatformRuntime,
  type PlatformSyncStatus,
  type PlatformValidation,
} from "@superbee/core/platform";

import { isAuthorityAnswer, isInputError, kindWarningsFor } from "./shared.js";

export interface RequestDrivenRuntimeOptions {
  remote: RemoteBackend;
  /** Write attribution for commits; omitted, the authority attributes as it sees fit. */
  actor?: string;
  /** Clock for the edition metadata a commit stamps; the contract kit fixes it so both modes mint one version. */
  now?: () => string;
}

/** Commits validate against no kinds, as the working copy's `commitLocal` does by default; `validate` is the one kind surface. */
const EMPTY_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };

export async function createRequestDrivenRuntime(options: RequestDrivenRuntimeOptions): Promise<PlatformRuntime> {
  const { remote, actor, now } = options;
  const bundle: Bundle = { root: remote.origin, backend: remote };
  await remote.wireCapabilities();
  const capabilities: PlatformCapabilities = { mode: "request-driven", offlineCommits: false, localPersistence: false };
  let online: boolean | null = true;

  /** Run one authority round trip, recording whether the authority answered. */
  const request = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      const result = await work();
      online = true;
      return result;
    } catch (error) {
      if (!isInputError(error)) online = isAuthorityAnswer(error);
      throw error;
    }
  };

  const status = (): PlatformSyncStatus => ({ mode: "request-driven", online, pending: 0, conflicts: 0, refused: 0, unconfirmed: 0, paused: false, complete: true });

  return {
    capabilities: () => ({ ...capabilities }),

    read: (id: ConceptId): Promise<PlatformDocument> =>
      request(async () => {
        const { doc, version } = await readDocVersioned(bundle, id);
        return { doc, provenance: sharedConfirmed(version) };
      }),

    query: (filter: QueryFilter = {}): Promise<PlatformQueryRow[]> =>
      request(async () => {
        const heads = await queryHeads(bundle, filter);
        return heads.map((head) => ({ id: head.id, version: head.version, frontmatter: head.frontmatter, provenance: sharedConfirmed(head.version) }));
      }),

    validate: (id: ConceptId): Promise<PlatformValidation> =>
      request(async () => {
        const { doc, version } = await readDocVersioned(bundle, id);
        const warnings: ValidationWarning[] = await kindWarningsFor(bundle, doc);
        return { id, warnings, provenance: sharedConfirmed(version) };
      }),

    commit: (id: ConceptId, edit: PlatformEdit): Promise<PlatformCommit> =>
      request(async () => {
        const result = await mutateDocument({
          bundle,
          id,
          mode: "patch",
          registry: EMPTY_REGISTRY,
          strict: false,
          ...(edit.expectedVersion === undefined ? {} : { expectedVersion: edit.expectedVersion }),
          ...(actor === undefined ? {} : { actor }),
          ...(now === undefined ? {} : { now }),
          buildCandidate: (existing) => ({ frontmatter: existing!.frontmatter, body: edit.body }),
        });
        // The version is the authority's answer to the write (or, unchanged, to the read).
        return { id, changed: result.changed, provenance: sharedConfirmed(result.version) };
      }),

    syncStatus: async () => status(),

    /** Nothing is pending in this mode; the status is the whole answer. */
    sync: async () => status(),
  };
}
