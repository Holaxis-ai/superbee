/**
 * A deterministic synthetic bundle for measurement: a small model (three kinds, each with one
 * required field beyond `title`), a chosen number of documents spread across the kinds, bodies
 * of mixed realistic size (a few hundred bytes to a few kilobytes of prose), one to three tags
 * from a fixed pool, and relative Markdown links between documents. Every byte is a function of
 * `(size, seed)`, so the same bundle can be seeded into a fresh authority for every cell of a
 * measurement and the same ids can be drawn for every mode.
 */

import type { OkfDocument, StorageBackend } from "@superbee/core";

export const SYNTHETIC_SIZES: readonly number[] = [100, 1000, 5000];

export interface SyntheticKind {
  type: string;
  directory: string;
  stem: string;
  required: string;
  values: readonly string[];
}

/** Three kinds, one required field each; the required value is drawn from a small enumeration. */
export const SYNTHETIC_KINDS: readonly SyntheticKind[] = [
  { type: "Note", directory: "notes", stem: "note", required: "status", values: ["draft", "final"] },
  { type: "Task", directory: "tasks", stem: "task", required: "owner", values: ["human:mike", "human:brian", "process:agent"] },
  { type: "Reference", directory: "references", stem: "reference", required: "source", values: ["paper", "book", "site", "dataset"] },
];

export const SYNTHETIC_TAGS: readonly string[] = [
  "astronomy",
  "pipeline",
  "review",
  "design",
  "measurement",
  "storage",
  "sync",
  "okf",
  "wire",
  "browser",
  "release",
  "roadmap",
  "draft",
  "archive",
  "evidence",
  "planning",
];

const WORDS = [
  "bundle", "document", "authority", "working", "copy", "intent", "journal", "version", "premise", "token",
  "shared", "pending", "conflict", "acknowledged", "refresh", "hydrate", "record", "field", "kind", "convention",
  "relative", "link", "index", "edition", "clock", "actor", "process", "human", "review", "evidence",
  "measure", "cold", "warm", "read", "query", "commit", "reconcile", "footprint", "latency", "request",
  "transaction", "store", "page", "presentation", "badge", "status", "online", "offline", "carrier", "route",
  "sequence", "order", "batch", "cursor", "head", "body", "frontmatter", "title", "tag", "prefix",
];

/** mulberry32: a small seeded generator, enough for reproducible picks. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function sentence(random: () => number): string {
  const length = 6 + Math.floor(random() * 10);
  const words: string[] = [];
  for (let index = 0; index < length; index += 1) words.push(pick(random, WORDS));
  words[0] = words[0]![0]!.toUpperCase() + words[0]!.slice(1);
  return `${words.join(" ")}.`;
}

/** Target body size in bytes: 40% short, 40% medium, 20% long, as a mixed bundle would carry. */
function targetBytes(random: () => number): number {
  const roll = random();
  if (roll < 0.4) return 300 + Math.floor(random() * 300);
  if (roll < 0.8) return 1024 + Math.floor(random() * 1024);
  return 3072 + Math.floor(random() * 2048);
}

export interface SyntheticDocumentRef {
  id: string;
  kind: SyntheticKind;
  title: string;
}

export function syntheticDocumentRefs(size: number): SyntheticDocumentRef[] {
  const refs: SyntheticDocumentRef[] = [];
  for (let index = 0; index < size; index += 1) {
    const kind = SYNTHETIC_KINDS[index % SYNTHETIC_KINDS.length]!;
    const ordinal = String(Math.floor(index / SYNTHETIC_KINDS.length) + 1).padStart(5, "0");
    refs.push({ id: `${kind.directory}/${kind.stem}-${ordinal}`, kind, title: `${kind.type} ${ordinal}` });
  }
  return refs;
}

function conventionDocuments(): OkfDocument[] {
  return SYNTHETIC_KINDS.map((kind) => ({
    id: `conventions/${kind.stem}`,
    frontmatter: {
      type: "Convention",
      title: kind.type,
      governs: kind.type,
      fields: { required: ["title", kind.required], optional: ["tags"], values: { [kind.required]: [...kind.values] } },
    },
    body: `A ${kind.stem} carries ${kind.required}.\n`,
  }));
}

/**
 * The bundle of `size` documents plus its three conventions. Bodies are prose with zero to
 * three relative links to other documents of the same bundle, so link parsing has real edges.
 */
export function generateSyntheticBundle(size: number, seed = 1): OkfDocument[] {
  const random = seededRandom(seed);
  const refs = syntheticDocumentRefs(size);
  const docs: OkfDocument[] = conventionDocuments();
  for (const ref of refs) {
    const tagCount = 1 + Math.floor(random() * 3);
    const tags = new Set<string>();
    while (tags.size < tagCount) tags.add(pick(random, SYNTHETIC_TAGS));
    const linkCount = Math.floor(random() * 4);
    const links: string[] = [];
    for (let index = 0; index < linkCount; index += 1) {
      const target = pick(random, refs);
      if (target.id === ref.id) continue;
      links.push(`[${target.title}](../${target.id}.md)`);
    }
    const target = targetBytes(random);
    const paragraphs: string[] = [];
    let bytes = 0;
    while (bytes < target) {
      const sentences: string[] = [];
      const count = 2 + Math.floor(random() * 4);
      for (let index = 0; index < count; index += 1) sentences.push(sentence(random));
      const link = links.shift();
      if (link) sentences.push(`See ${link}.`);
      const paragraph = sentences.join(" ");
      paragraphs.push(paragraph);
      bytes += paragraph.length + 2;
    }
    while (links.length > 0) paragraphs.push(`See ${links.shift()}.`);
    docs.push({
      id: ref.id,
      frontmatter: {
        type: ref.kind.type,
        title: ref.title,
        [ref.kind.required]: pick(random, ref.kind.values),
        tags: [...tags].sort(),
      },
      body: `${paragraphs.join("\n\n")}\n`,
    });
  }
  return docs;
}

export async function seedGeneratedBundle(authority: StorageBackend, docs: readonly OkfDocument[]): Promise<void> {
  for (const doc of docs) await authority.write(doc.id, doc);
}

/** Total body bytes of a generated bundle, for the record beside a storage estimate. */
export function bodyBytes(docs: readonly OkfDocument[]): number {
  let total = 0;
  for (const doc of docs) total += new TextEncoder().encode(doc.body).length;
  return total;
}
