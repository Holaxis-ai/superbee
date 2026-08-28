/* GENERATED from schema/publication-snapshot-v1.schema.json — do not edit. */

/**
 * This interface was referenced by `PublicationSnapshotV1`'s JSON-Schema
 * via the `definition` "sha256".
 */
export type Sha256 = string;
/**
 * This interface was referenced by `PublicationSnapshotV1`'s JSON-Schema
 * via the `definition` "jsonValue".
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [k: string]: JsonValue;
    };

export interface PublicationSnapshotV1 {
  schema: "https://getsuperbee.com/schemas/publication-snapshot/v1";
  schemaVersion: 1;
  snapshotDigest: Sha256;
  source: {
    okfEdition: string;
    rootDocumentVersion: string | null;
    [k: string]: unknown;
  };
  semantics: {
    rendererProfile: string;
    viewBridgeProtocol: "v0";
    [k: string]: unknown;
  };
  capabilities: string[];
  documents: Document[];
  reserved: Reserved[];
  blobs: Blob[];
  relationships: Relationship[];
  views: View[];
  warnings: Warning[];
  [k: string]: unknown;
}
/**
 * This interface was referenced by `PublicationSnapshotV1`'s JSON-Schema
 * via the `definition` "document".
 */
export interface Document {
  id: string;
  version: string;
  frontmatter: {
    [k: string]: JsonValue;
  };
  body: string;
  source: ObjectRef;
  rendered: {
    html: ObjectRef;
    bounded: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * This interface was referenced by `PublicationSnapshotV1`'s JSON-Schema
 * via the `definition` "objectRef".
 */
export interface ObjectRef {
  digest: Sha256;
  size: number;
  mediaType: string;
  representation: "exact" | "canonical";
  [k: string]: unknown;
}
/**
 * This interface was referenced by `PublicationSnapshotV1`'s JSON-Schema
 * via the `definition` "reserved".
 */
export interface Reserved {
  dir: string;
  name: "index.md" | "log.md";
  version: string;
  object: ObjectRef;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `PublicationSnapshotV1`'s JSON-Schema
 * via the `definition` "blob".
 */
export interface Blob {
  key: string;
  version: string;
  contentType: string;
  object: ObjectRef;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `PublicationSnapshotV1`'s JSON-Schema
 * via the `definition` "relationship".
 */
export interface Relationship {
  from: string;
  to: string;
  text: string;
  href: string;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `PublicationSnapshotV1`'s JSON-Schema
 * via the `definition` "view".
 */
export interface View {
  id: string;
  registrationVersion: string;
  title: string;
  description?: string;
  presentation?: "workspace" | "inline" | "adaptive";
  access: "none" | "bundle-read" | "bundle-propose";
  entry: string;
  entryVersion: string;
  entryObject: ObjectRef;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `PublicationSnapshotV1`'s JSON-Schema
 * via the `definition` "warning".
 */
export interface Warning {
  code: string;
  message: string;
  subject?: string;
  [k: string]: unknown;
}
