import type {
  JsonValue,
  ObjectRef,
  PublicationSnapshotV1,
} from "./generated/publication-snapshot-v1.js";

export const PUBLICATION_SNAPSHOT_V1 =
  "https://getsuperbee.com/schemas/publication-snapshot/v1" as const;
export const PUBLICATION_BRIDGE_V0 = "v0" as const;

export type PublicationJsonValue = JsonValue;
export type PublicationObjectRefV1 = ObjectRef;
export type { PublicationSnapshotV1 };

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
