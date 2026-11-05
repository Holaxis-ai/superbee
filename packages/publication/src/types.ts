import type { ExternalLinkPolicy } from "@superbee/markdown-renderer";

import type {
  JsonValue,
  ObjectRef,
  PublicationSnapshotV1 as GeneratedPublicationSnapshotV1,
} from "./generated/publication-snapshot-v1.js";

type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[]
      : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export const PUBLICATION_SNAPSHOT_V1 =
  "https://getsuperbee.com/schemas/publication-snapshot/v1" as const;
export const PUBLICATION_BRIDGE_V0 = "v0" as const;

export type { ExternalLinkPolicy };

export type PublicationJsonValue = DeepReadonly<JsonValue>;
export type PublicationObjectRefV1 = DeepReadonly<ObjectRef>;
export type PublicationSnapshotV1 = DeepReadonly<GeneratedPublicationSnapshotV1>;

export interface CapturePublicationSnapshotOptionsV1 {
  schema: typeof PUBLICATION_SNAPSHOT_V1;
  source: { kind: "filesystem"; root: string };
  maxAttempts?: 1 | 2 | 3;
  limits?: {
    maxObjects?: number;
    maxObjectBytes?: number;
    maxTotalBytes?: number;
  };
}

export interface PublicationSnapshotHandleV1 {
  readonly manifest: PublicationSnapshotV1;
  readObject(ref: PublicationObjectRefV1): Promise<Uint8Array>;
  serializeManifest(): Uint8Array;
  close(): Promise<void>;
}

export interface PublicationRenderDocumentOptionsV1 {
  /** Set by the caller's own code. Absent or unknown means `none`. */
  externalLinks?: ExternalLinkPolicy;
}

export interface PublicationRenderedDocumentV1 {
  html: string;
  bounded: boolean;
}

/**
 * The handle capture returns. Handles that only serve stored bytes, such as a deployed site's
 * reader, implement {@link PublicationSnapshotHandleV1} and need no renderer.
 */
export interface PublicationCapturedSnapshotHandleV1 extends PublicationSnapshotHandleV1 {
  /**
   * Render one document again from its digest-checked source with the caller's link policy. The
   * snapshot and its stored inert HTML do not change, and the View bridge never calls this.
   * With no policy the HTML equals the stored object byte for byte.
   */
  renderDocument(id: string, options?: PublicationRenderDocumentOptionsV1): Promise<PublicationRenderedDocumentV1>;
}

export interface PublicationBridgeAdmissionV1 {
  id: string;
  entry: string;
  access: "none" | "bundle-read";
  entryDigest: `sha256:${string}`;
}

export interface PublicationBridgeOutcomeV1 {
  reply: Record<string, unknown> | null;
  subscribed?: boolean;
  openViewId?: string;
}

export interface PublicationBridgeV1 {
  handle(rawRequest: unknown): Promise<PublicationBridgeOutcomeV1>;
}
