import type { StorageBackend } from "../types.js";
import { headsDigest } from "../heads-digest.js";
import { memorySearchSource, memorySearchBounds, type MemorySearchSourceOptionsV1, type MemorySearchSourceV1 } from "./memory-source.js";
import { SearchLimitError, stopIfAsked } from "./errors.js";
import { documentSourceBytes } from "./row-text.js";
import type { SearchDocumentV1 } from "./contract.js";

/** Read a complete backend corpus in bounded batches. Failed reads refuse the whole search;
 * the cursor key describes the versions actually read, including unsent working-copy edits. */
export async function searchSourceFromBackend(
  backend: StorageBackend,
  options: Omit<MemorySearchSourceOptionsV1, "key"> = {},
): Promise<MemorySearchSourceV1> {
  const { maxDocuments, maxSourceBytes } = memorySearchBounds(options);
  stopIfAsked(options.stop);
  const ids = await backend.list();
  if (ids.length > maxDocuments.max) throw new SearchLimitError(maxDocuments.name, maxDocuments.max, ids.length);
  const documents: SearchDocumentV1[] = [];
  let sourceBytes = 0;
  for (let start = 0; start < ids.length; start += 128) {
    stopIfAsked(options.stop);
    const batch = ids.slice(start, start + 128);
    const results = await backend.readMany(batch);
    if (results.length !== batch.length) throw new TypeError("Search backend returned an incomplete batch.");
    for (const [index, { doc, version }] of results.entries()) {
      if (doc.id !== batch[index]) throw new TypeError("Search backend returned a different document identity.");
      const document = { ...doc, version };
      sourceBytes += documentSourceBytes(document);
      if (sourceBytes > maxSourceBytes.max) throw new SearchLimitError(maxSourceBytes.name, maxSourceBytes.max, sourceBytes);
      documents.push(document);
    }
  }
  return memorySearchSource(documents, { ...options, key: headsDigest(documents) });
}
