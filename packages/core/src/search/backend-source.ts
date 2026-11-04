import type { StorageBackend } from "../types.js";
import { readManyExisting, type SkippedDoc } from "../document-scan.js";
import { sha256HexOfUtf8 } from "../sha256.js";
import { canonicalJson, codeUnitCompare } from "./identity.js";
import { headsDigest } from "../heads-digest.js";
import { memorySearchSource, memorySearchBounds, type MemorySearchSourceOptionsV1, type MemorySearchSourceV1 } from "./memory-source.js";
import { SearchLimitError, stopIfAsked } from "./errors.js";
import { documentSourceBytes } from "./row-text.js";
import type { SearchDocumentV1 } from "./contract.js";

/** Read bounded batches through Core's resilient scan policy. Unreadable documents are
 * reported; storage failures and incomplete backend responses still refuse the search. */
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
  const skipped: SkippedDoc[] = [];
  for (let start = 0; start < ids.length; start += 128) {
    stopIfAsked(options.stop);
    const batch = ids.slice(start, start + 128);
    const omitted = new Set<string>();
    const results = await readManyExisting(backend, batch, skip => { skipped.push(skip); omitted.add(skip.id); });
    const expected = batch.filter(id => !omitted.has(id));
    if (results.length !== expected.length) throw new TypeError("Search backend returned an incomplete batch.");
    for (const [index, { doc, version }] of results.entries()) {
      if (doc.id !== expected[index]) throw new TypeError("Search backend returned a different document identity.");
      const document = { ...doc, version };
      sourceBytes += documentSourceBytes(document);
      if (sourceBytes > maxSourceBytes.max) throw new SearchLimitError(maxSourceBytes.name, maxSourceBytes.max, sourceBytes);
      documents.push(document);
    }
  }
  skipped.sort((a, b) => codeUnitCompare(a.id, b.id));
  const heads = headsDigest(documents);
  const key = skipped.length === 0 ? heads : sha256HexOfUtf8(canonicalJson({ heads, skipped }));
  const source = memorySearchSource(documents, { ...options, key });
  if (skipped.length === 0) return source;
  const diagnostics = Object.freeze(skipped.map(row => Object.freeze({ ...row })));
  return Object.freeze({
    key,
    get indexDigest() { return source.indexDigest; },
    async evidence(...args: Parameters<typeof source.evidence>) {
      const batch = await source.evidence(...args);
      return { ...batch, skipped: diagnostics, size: { ...batch.size,
        documents: batch.size.documents + diagnostics.length,
        skipped: batch.size.skipped + diagnostics.length,
      } };
    },
    text: source.text,
  });
}
