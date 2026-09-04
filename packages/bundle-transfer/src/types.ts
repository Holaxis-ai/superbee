import type { ReservedFilename, Version } from "@superbee/core/storage";

export const BUNDLE_TRANSFER_MANIFEST_V1 =
  "https://getsuperbee.com/schemas/bundle-transfer-manifest-v1.schema.json" as const;

export const BUNDLE_TRANSFER_LIMITS_V1 = Object.freeze({
  maxRows: 20_000,
  maxObjectBytes: 32 * 1024 * 1024,
  maxUniqueBytes: 512 * 1024 * 1024,
  maxManifestBytes: 16 * 1024 * 1024,
});

export type Sha256Digest = `sha256:${string}`;
export type SourceAuthorityId = `src_${string}`;

export interface TransferObjectRefV1 {
  digest: Sha256Digest;
  size: number;
}

export interface FilesystemTransferSourceV1 {
  authority_id: SourceAuthorityId;
  kind: "filesystem";
  revision: { kind: "filesystem" };
}

export interface GitTransferSourceV1 {
  authority_id: SourceAuthorityId;
  kind: "git";
  revision: {
    kind: "git";
    provider: "github";
    requested_ref: "refs/heads/board";
    commit: string;
    tree: string;
    root: "";
  };
}

export type BundleTransferSourceV1 = FilesystemTransferSourceV1 | GitTransferSourceV1;

export interface TransferDocumentRowV1 {
  id: string;
  version: Version;
  object: TransferObjectRefV1;
}

export interface TransferReservedRowV1 {
  dir: string;
  name: ReservedFilename;
  version: Version;
  object: TransferObjectRefV1;
}

export interface TransferBlobRowV1 {
  key: string;
  version: Version;
  content_type: string;
  object: TransferObjectRefV1;
}

export interface BundleTransferManifestV1 {
  schema: typeof BUNDLE_TRANSFER_MANIFEST_V1;
  schema_version: 1;
  source: BundleTransferSourceV1;
  okf: {
    edition: string;
    root_index_version: Version;
  };
  documents: TransferDocumentRowV1[];
  reserved: TransferReservedRowV1[];
  blobs: TransferBlobRowV1[];
  counts: {
    documents: number;
    reserved: number;
    blobs: number;
    unique_objects: number;
    unique_bytes: number;
  };
  content_digest: Sha256Digest;
  manifest_digest: Sha256Digest;
}

export interface RawDocumentV1 {
  id: string;
  version: Version;
  bytes: Uint8Array;
}

export interface RawReservedV1 {
  dir: string;
  name: ReservedFilename;
  version: Version;
  bytes: Uint8Array;
}

export interface RawBlobV1 {
  key: string;
  version: Version;
  content_type: string;
  bytes: Uint8Array;
}

export interface BundleTransferSnapshotV1 {
  source: BundleTransferSourceV1;
  okf_edition: string;
  documents: RawDocumentV1[];
  reserved: RawReservedV1[];
  blobs: RawBlobV1[];
}

export interface BundleTransferArtifactV1 {
  manifest: BundleTransferManifestV1;
  objects: ReadonlyMap<Sha256Digest, Uint8Array>;
}

export interface BundleTransferSourceReaderV1 {
  readSnapshot(): Promise<BundleTransferSnapshotV1>;
}

export type TransferObjectReaderV1 = (digest: Sha256Digest) => Promise<Uint8Array>;
