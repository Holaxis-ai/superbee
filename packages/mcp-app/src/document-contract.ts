export const DOCUMENT_PRESENTATION_SCHEMA_VERSION = "superbee.document-presentation.v1";

export interface DocumentPresentationPayload {
  schemaVersion: typeof DOCUMENT_PRESENTATION_SCHEMA_VERSION;
  document: {
    id: string;
    version: string;
    title: string;
    type?: string;
    html: string;
    bounded: boolean;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail-closed parser for the fixed document-reader App's invocation payload. */
export function parseDocumentPresentationPayload(
  value: unknown,
): DocumentPresentationPayload | null {
  if (!isRecord(value) || value.schemaVersion !== DOCUMENT_PRESENTATION_SCHEMA_VERSION) {
    return null;
  }
  const document = value.document;
  if (
    !isRecord(document) ||
    typeof document.id !== "string" ||
    typeof document.version !== "string" ||
    typeof document.title !== "string" ||
    typeof document.html !== "string" ||
    typeof document.bounded !== "boolean" ||
    (document.type !== undefined && typeof document.type !== "string")
  ) {
    return null;
  }
  return {
    schemaVersion: DOCUMENT_PRESENTATION_SCHEMA_VERSION,
    document: {
      id: document.id,
      version: document.version,
      title: document.title,
      ...(document.type ? { type: document.type } : {}),
      html: document.html,
      bounded: document.bounded,
    },
  };
}
