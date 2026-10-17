/**
 * A per-run `sources[]` identity index built from one head read.
 *
 * Bounded to one run: build it after the run starts, pass it to every plan and apply of that run,
 * and discard it. Overlay writes never create overlays, and the apply's `replace` keeps the
 * versions it changes current, so the run's own writes cannot make it stale. An edited or deleted
 * overlay is still caught at write time by the compare-and-swap and the identity guard. A second
 * document given an indexed identity during the run is not seen: the write lands on the first
 * claimant and the next run, with a fresh index, refuses both as ambiguous.
 */
import { queryHeads } from "../bundle-ops.js";
import { sourceIdentityOf } from "../query-filter.js";
import type { Bundle, ConceptId, HeadResult, OkfDocument, QueryFilter, Version } from "../types.js";

const byId = (a: HeadResult, b: HeadResult): number => a.id.localeCompare(b.id);

/** The `(resource, id)` pairs a frontmatter carries, once per entry naming both, by core's identity rule. */
function identities(frontmatter: Record<string, unknown>): Array<{ resource: string; id: string }> {
  const sources = frontmatter.sources;
  if (!Array.isArray(sources)) return [];
  const out: Array<{ resource: string; id: string }> = [];
  for (const entry of sources) {
    const own = sourceIdentityOf(entry);
    if (own?.resource !== undefined && own.id !== undefined) out.push({ resource: own.resource, id: own.id });
  }
  return out;
}

export class SourceIndex {
  readonly #entries = new Map<string, Map<string, HeadResult[]>>();
  readonly #documents = new Map<ConceptId, HeadResult>();

  static fromHeads(heads: Iterable<HeadResult>): SourceIndex {
    const index = new SourceIndex();
    for (const head of heads) index.#add(head);
    for (const ids of index.#entries.values()) for (const rows of ids.values()) rows.sort(byId);
    return index;
  }

  /**
   * Heads whose `sources` carry `(resource, id)`, in id order. A document carrying the identity
   * twice is returned twice, so the caller sees it as ambiguous.
   */
  lookup(resource: string, id: string, opts: { type?: string } = {}): readonly HeadResult[] {
    const rows = this.#entries.get(resource)?.get(id) ?? [];
    return opts.type === undefined ? [...rows] : rows.filter((head) => head.frontmatter.type === opts.type);
  }

  /** Re-derive one document's entries from a write's result. */
  replace(doc: OkfDocument, version: Version): void {
    this.#remove(doc.id);
    const head: HeadResult = { id: doc.id, frontmatter: doc.frontmatter, version };
    this.#add(head);
    for (const { resource, id } of identities(head.frontmatter as unknown as Record<string, unknown>)) {
      this.#entries.get(resource)?.get(id)?.sort(byId);
    }
  }

  /** Documents carrying at least one well-formed identity. */
  get size(): number {
    return this.#documents.size;
  }

  #add(head: HeadResult): void {
    const pairs = identities(head.frontmatter as unknown as Record<string, unknown>);
    if (pairs.length === 0) return;
    this.#documents.set(head.id, head);
    for (const { resource, id } of pairs) {
      let ids = this.#entries.get(resource);
      if (!ids) this.#entries.set(resource, ids = new Map());
      let rows = ids.get(id);
      if (!rows) ids.set(id, rows = []);
      rows.push(head);
    }
  }

  #remove(docId: ConceptId): void {
    const old = this.#documents.get(docId);
    if (!old) return;
    this.#documents.delete(docId);
    for (const { resource, id } of identities(old.frontmatter as unknown as Record<string, unknown>)) {
      const ids = this.#entries.get(resource);
      const rows = ids?.get(id);
      if (!ids || !rows) continue;
      const kept = rows.filter((head) => head.id !== docId);
      if (kept.length) ids.set(id, kept);
      else ids.delete(id);
    }
  }
}

/** One head read of `bundle` (optionally narrowed by type or prefix), indexed by identity. */
export async function buildSourceIndex(bundle: Bundle, filter: Pick<QueryFilter, "type" | "prefix"> = {}): Promise<SourceIndex> {
  const narrowed: QueryFilter = {};
  if (filter.type !== undefined) narrowed.type = filter.type;
  if (filter.prefix !== undefined) narrowed.prefix = filter.prefix;
  return SourceIndex.fromHeads(await queryHeads(bundle, narrowed));
}
