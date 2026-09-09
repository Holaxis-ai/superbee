/** Byte-format admission only. Callers own bounded retrieval, registration,
 * exact-version checks, isolation and authorization; this grants no execution authority. */
export const MAX_ACTIVE_VIEW_BYTES = 512 * 1024;
export const ACTIVE_VIEW_CONTENT_TYPE = "text/html; charset=utf-8";

export function admitActiveView(
  bytes: Uint8Array,
  contentType: string,
): { bytes: Uint8Array; contentType: typeof ACTIVE_VIEW_CONTENT_TYPE } {
  if (bytes.byteLength > MAX_ACTIVE_VIEW_BYTES) {
    throw new Error("active View HTML must be at most 512 KiB");
  }
  const [mediaType, ...parameters] = contentType
    .split(";")
    .map((part) => part.trim().toLowerCase());
  if (mediaType !== "text/html") throw new Error("active View entries must use text/html");
  for (const parameter of parameters) {
    if (parameter && parameter !== "charset=utf-8" && parameter !== 'charset="utf-8"') {
      throw new Error("active View entries may declare only UTF-8 HTML");
    }
  }
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { bytes: bytes.slice(), contentType: ACTIVE_VIEW_CONTENT_TYPE };
}

