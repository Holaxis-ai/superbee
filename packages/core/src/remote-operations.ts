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
 * The transport is only sound against an authority that implements identity. A host that
 * predates it ignores the header, applies every retry as a fresh write, and answers the lookup
 * route with a route-miss `404` the client reads as "never recorded". So the transport reads the
 * authority's capabilities once before the first submission or lookup leaves and refuses both
 * with {@link OperationsUnsupportedError} when `operations` is false; nothing identified is
 * ever sent to a host that would apply it unidentified. The check is lazy so a working copy can
 * attach to its authority while offline; a check that cannot reach the authority fails like any
 * carrier error and is retried on the next call. {@link openRemoteOperationTransport} runs the
 * same check eagerly for a caller that is online at construction and wants the answer up front.
 *
 * Two limits of the lazy check. The uncertain-write primitive classifies every thrown error
 * from `submit` or `lookup` as unknown, so the lazy variant's negative verdict shows up as an
 * intent that stays pending on every push, not as a named refusal; a product caller that wants
 * the verdict visible uses {@link openRemoteOperationTransport} or reads `wireCapabilities()`
 * itself. And the check is memoized on success: a host downgraded afterwards is not detected,
 * so one unidentified resubmission can reach it. Because every identified write is guarded by
 * its base, that exposure is bounded to a spurious conflict at a moved head, never a double
 * application.
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

/** The authority behind a remote does not record outcomes by request identity. */
export class OperationsUnsupportedError extends Error {
  readonly code = "OPERATIONS_UNSUPPORTED";
  constructor(baseUrl: string) {
    super(`remote operation transport: the authority at ${baseUrl} does not record operation outcomes; identified writes would be applied unidentified`);
    this.name = "OperationsUnsupportedError";
  }
}

/**
 * Build the transport after confirming the authority records outcomes by request identity.
 * Rejects with {@link OperationsUnsupportedError} before the transport is handed out.
 */
export async function openRemoteOperationTransport(remote: RemoteBackend, options: RemoteOperationTransportOptions = {}): Promise<OperationTransport> {
  const built = buildTransport(remote, options);
  await built.ensureSupported();
  return built.transport;
}

/**
 * Build the transport that carries intents to the authority behind `remote`. Support is
 * confirmed lazily, before the first submission or lookup leaves.
 */
export function createRemoteOperationTransport(remote: RemoteBackend, options: RemoteOperationTransportOptions = {}): OperationTransport {
  return buildTransport(remote, options).transport;
}

function buildTransport(remote: RemoteBackend, options: RemoteOperationTransportOptions): { transport: OperationTransport; ensureSupported: () => Promise<void> } {
  let supported = false;
  const ensureSupported = async (): Promise<void> => {
    if (supported) return;
    const capabilities = await remote.wireCapabilities();
    if (!capabilities.operations) throw new OperationsUnsupportedError(remote.origin);
    supported = true;
  };
  const transport: OperationTransport = {
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
        // Inside the mapping so a 4xx from the capabilities route (a gated host answering 401
        // or 403 there) is classified like a 4xx from the write and can pause the bundle.
        await ensureSupported();
        const version = await remote.write(intent.target, { id: intent.target, frontmatter, body }, writeOptions);
        return { kind: "committed", version };
      } catch (error) {
        if (error instanceof VersionConflict) return { kind: "conflict", actual: error.actual };
        if (error instanceof RemoteError && error.status < 500) return { kind: "refused", code: error.code, message: error.message };
        throw error;
      }
    },
    async lookup(requestId: string): Promise<Outcome | null> {
      await ensureSupported();
      return remote.lookupOperation(requestId);
    },
  };
  return { transport, ensureSupported };
}
