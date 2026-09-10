/**
 * The uncertain-write transport over a wire authority: one {@link OperationTransport} that
 * delivers a `document.write` intent as an identified `PUT` through {@link RemoteBackend} and
 * reads the authority's recorded outcome back through the lookup route.
 *
 * The intent's `base` becomes the write's compare-and-swap premise (`If-Match`, or
 * `If-None-Match: *` for a create) and its `requestId` travels as `Idempotency-Key`, so the
 * authority applies the write at most once under that identity and a duplicate delivery, a
 * transient retry included, is answered from the record. The wire's three answers map onto the
 * primitive's {@link Outcome}: a version is `committed`, a `412` is `conflict` with the
 * authority's current version, and any other 4xx refusal is `refused` with the wire code. A
 * carrier failure and a 5xx response both propagate unchanged: a 502 or 504 from an intermediary,
 * or the authority's own runtime failure, says nothing about whether the write was applied, so
 * the primitive classifies it as unknown and resolves it by lookup, which is the whole reason
 * the identity exists. Only a 4xx is final: the authority answered and declined.
 *
 * This module imports nothing from Node so a browser working copy and a Node consumer share
 * one transport over one client adapter.
 */

import { parseMarkdown } from "./frontmatter.js";
import { pathFromConceptId } from "./paths.js";
import { RemoteBackend, RemoteError } from "./remote-backend.js";
import type { OperationIntent, OperationTransport, Outcome } from "./uncertain-write.js";
import { VersionConflict } from "./version-transport.js";

export interface RemoteOperationTransportOptions {
  /** Write attribution sent as `X-Actor`; omitted when absent (the authority attributes as it sees fit). */
  actor?: string;
}

/** Build the transport that carries intents to the authority behind `remote`. */
export function createRemoteOperationTransport(remote: RemoteBackend, options: RemoteOperationTransportOptions = {}): OperationTransport {
  return {
    async submit(intent: OperationIntent): Promise<Outcome> {
      if (intent.kind !== "document.write") {
        throw new Error(`remote operation transport: unsupported intent kind '${intent.kind}'`);
      }
      const { frontmatter, body } = parseMarkdown(intent.content, pathFromConceptId(intent.target));
      const writeOptions = {
        expectedVersion: intent.base,
        requestId: intent.requestId,
        ...(options.actor === undefined ? {} : { actor: options.actor }),
      };
      try {
        const version = await remote.write(intent.target, { id: intent.target, frontmatter, body }, writeOptions);
        return { kind: "committed", version };
      } catch (error) {
        if (error instanceof VersionConflict) return { kind: "conflict", actual: error.actual };
        if (error instanceof RemoteError && error.status < 500) return { kind: "refused", code: error.code, message: error.message };
        throw error;
      }
    },
    lookup(requestId: string): Promise<Outcome | null> {
      return remote.lookupOperation(requestId);
    },
  };
}
