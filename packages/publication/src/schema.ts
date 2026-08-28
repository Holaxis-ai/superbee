import snapshotSchema from "../schema/publication-snapshot-v1.schema.json" with { type: "json" };

/** The one serialized v1 schema authority, generated types are checked against this file. */
export const PUBLICATION_SNAPSHOT_SCHEMA_V1: Readonly<Record<string, unknown>> =
  Object.freeze(snapshotSchema);
