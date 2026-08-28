import { createHash } from "node:crypto";

import { BridgeService, type BridgeLaunchAuthority } from "@superbee/view-runtime/bridge";

import { PublicationError } from "./errors.js";
import { PublicationSnapshotBackend } from "./snapshot-backend.js";
import {
  PUBLICATION_BRIDGE_V0,
  type PublicationBridgeAdmissionV1,
  type PublicationBridgeV1,
  type PublicationSnapshotHandleV1,
} from "./types.js";

const STATIC_LAUNCH_ID = "publication-snapshot";

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export interface CreatePublicationBridgeOptionsV1 {
  protocol: typeof PUBLICATION_BRIDGE_V0;
  snapshot: PublicationSnapshotHandleV1;
  admittedView: PublicationBridgeAdmissionV1;
}

/** Create the canonical read-only View bridge over one immutable publication snapshot. */
export function createPublicationBridge(options: CreatePublicationBridgeOptionsV1): PublicationBridgeV1 {
  if (options.protocol !== PUBLICATION_BRIDGE_V0) {
    throw new PublicationError("CAPABILITY_UNAVAILABLE", "the requested publication bridge protocol is unsupported");
  }
  const registration = options.snapshot.manifest.views.find((view) => view.id === options.admittedView.id);
  if (registration?.access === "bundle-propose") {
    throw new PublicationError("INVALID_BRIDGE_ADMISSION", "static publication cannot admit a bundle-propose View");
  }
  if (
    !registration ||
    registration.entry !== options.admittedView.entry ||
    registration.access !== options.admittedView.access ||
    registration.entryObject.digest !== options.admittedView.entryDigest
  ) {
    throw new PublicationError("INVALID_BRIDGE_ADMISSION", "the admitted View does not exactly match the snapshot");
  }

  const capability = registration.access;
  const launches: BridgeLaunchAuthority = {
    async resolve(launchId) {
      return launchId === STATIC_LAUNCH_ID ? { launchId, capability } : null;
    },
    revoke() {
      // One immutable publication launch cannot be invalidated by source mutation.
    },
  };
  const documents = new Map(options.snapshot.manifest.documents.map((row) => [row.id, row]));
  const backend = new PublicationSnapshotBackend(options.snapshot);
  return {
    async handle(rawRequest) {
      // BridgeService's renderer callback is intentionally synchronous. Resolve the one possible
      // rendered document before dispatch and make its immutable HTML available to that callback.
      let rendered: { id: string; html: string; bounded: boolean } | undefined;
      if (
        typeof rawRequest === "object" && rawRequest !== null &&
        (rawRequest as Record<string, unknown>).type === "render-document" &&
        typeof (rawRequest as Record<string, unknown>).docId === "string"
      ) {
        const id = (rawRequest as Record<string, unknown>).docId as string;
        const row = documents.get(id);
        if (row) {
          const bytes = await options.snapshot.readObject(row.rendered.html);
          if (digest(bytes) !== row.rendered.html.digest) {
            throw new PublicationError("OBJECT_DIGEST_MISMATCH", "rendered document digest mismatch", { subject: id });
          }
          rendered = {
            id,
            html: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            bounded: row.rendered.bounded,
          };
        }
      }
      const dynamic = new BridgeService({
        bundle: { root: "/publication-snapshot", backend },
        launches,
        config: async () => ({ root: null, name: "Published Superbee bundle", mode: "snapshot" }),
        renderDocument: ({ id }) => {
          if (!rendered || rendered.id !== id) throw new Error(`document '${id}' is not available`);
          return { html: rendered.html, bounded: rendered.bounded };
        },
        allowActionProtocol: false,
        enablePolling: false,
        consumeOpenPage: false,
      });
      const outcome = await dynamic.handle(STATIC_LAUNCH_ID, rawRequest);
      return {
        reply: outcome.reply,
        ...(outcome.subscribed === undefined ? {} : { subscribed: outcome.subscribed }),
        ...(outcome.openPageId === undefined ? {} : { openViewId: outcome.openPageId }),
      };
    },
  };
}
