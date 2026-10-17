/**
 * What one document contributes to any search index.
 */
import { documentDescription, documentTags, documentTitle, documentType, type SearchDocumentV1 } from "./contract.js";
import { utf8 } from "./text.js";

/** UTF-8 bytes of the text one document contributes to an index: id, title, description, type, tags, body. */
export function documentSourceBytes(document: SearchDocumentV1): number {
  return (
    utf8(document.id).byteLength +
    utf8(documentTitle(document) ?? "").byteLength +
    utf8(documentDescription(document) ?? "").byteLength +
    utf8(documentType(document) ?? "").byteLength +
    documentTags(document).reduce((total, tag) => total + utf8(tag).byteLength, 0) +
    utf8(document.body).byteLength
  );
}
