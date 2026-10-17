/** Shared fixtures for the record-overlay suites: inline Kinds over MemoryBackend and the test hooks. */
import { mutateDocument, type DocumentMutationCandidate } from "../src/document-mutation.js";
import { readDocVersioned } from "../src/bundle-ops.js";
import type { KindRegistry } from "../src/kinds.js";
import { loadKinds } from "../src/kinds-load.js";
import { MemoryBackend } from "../src/memory-backend.js";
import type { Bundle, ConceptId, DeleteOptions, Frontmatter, OkfDocument, Version, WriteOptions } from "../src/types.js";
import { parseIsoInstant } from "../src/verification.js";
import { overlayCanonicalJson } from "../src/record-overlay/canonical.js";
import { readOverlayPolicy, type IntervalHook, type OverlayBundle, type OverlayHooks, type OverlayPolicy, type RecordChange, type TextGate } from "../src/record-overlay/index.js";

export const PROVIDER = "https://calendar.example.org/feed.ics";
export const OTHER = "https://other.example.org/feed.ics";
export const FEED = "source-feeds/synthetic-library";
export const ACTOR = "process:overlay-test";
export const EDITOR = "human:editor";
export const UID = (n: string): string => `evt-${n}@calendar.example.org`;
export const DIGEST = (c: string): string => `sha256:${c.repeat(64).slice(0, 64)}`;

export const EVENT_CONVENTION = {
  type: "Convention", title: "Event", governs: "Event", path: "events/",
  fields: {
    required: ["title", "start"],
    optional: ["end", "event_status", "event_url", "venue_text", "cost_text", "updated_at", "note", "streets", "revision"],
    values: { event_status: ["scheduled", "canceled", "postponed"] },
    types: { start: "datetime", end: "datetime", event_url: "https-url", updated_at: "datetime" },
  },
};
export function signalConvention(progress: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "Convention", title: "Signal", governs: "Signal", path: "signals/",
    links: { "from feed": "Source Feed", "about event": "Event" },
    claim: { owner_field: "assignee", state_field: "progress_status" },
    fields: {
      required: ["title", progress, "change_kind", "observed_at"],
      optional: ["provider", "external_id", "diff_summary", "priority", "assignee", "expires_at", "content_digest", "about_doc"],
      values: { [progress]: ["todo", "in_progress", "done", "dismissed"], priority: ["low", "normal", "urgent"] },
    },
    ...over,
  };
}
/** A board Task: claimable, but not an attention record. */
export function taskConvention(progress: string): Record<string, unknown> {
  return {
    type: "Convention", title: "Task", governs: "Task", path: "tasks/",
    claim: { owner_field: "assignee", state_field: "progress_status" },
    fields: { required: ["title", progress], optional: ["assignee", "priority", "description", "sources"], values: { [progress]: ["todo", "in_progress", "done"] } },
  };
}
export const SOURCE_FEED_CONVENTION = {
  type: "Convention", title: "Source Feed", governs: "Source Feed", path: "source-feeds/",
  fields: { required: ["title", "feed_kind", "url", "owned_fields"], optional: ["target_kind", "auto_apply", "needs_review", "missing_threshold", "completeness", "exclude_pattern", "wall_time_zone"] },
};

export const FEED_FRONTMATTER = {
  type: "Source Feed", title: "Synthetic library calendar (fictional)", feed_kind: "ics", url: PROVIDER, target_kind: "Event",
  owned_fields: ["start", "end", "event_status", "event_url", "venue_text"],
  auto_apply: ["changed", "canceled"], needs_review: ["new", "canceled", "disappeared"],
};

/** A MemoryBackend that records every write and delete. */
export class RecordingBackend extends MemoryBackend {
  writes: ConceptId[] = [];
  deletes: ConceptId[] = [];
  override async write(id: ConceptId, doc: OkfDocument, options?: WriteOptions): Promise<Version> {
    const version = await super.write(id, doc, options);
    this.writes.push(id);
    return version;
  }
  override async delete(id: ConceptId, options?: DeleteOptions): Promise<boolean> {
    this.deletes.push(id);
    return super.delete(id, options);
  }
}

export interface World {
  content: OverlayBundle;
  ops: OverlayBundle;
  contentBackend: RecordingBackend;
  opsBackend: RecordingBackend;
  policy: OverlayPolicy;
  put(id: ConceptId, frontmatter: Record<string, unknown>, body?: string, where?: "content" | "ops"): Promise<Version>;
  edit(id: ConceptId, patch: Record<string, unknown>, where?: "content" | "ops", body?: string): Promise<Version>;
  read(id: ConceptId, where?: "content" | "ops"): Promise<{ doc: OkfDocument; version: Version }>;
  /** Every document id and version in a bundle. */
  snapshot(where?: "content" | "ops"): Promise<Record<string, Version>>;
}

async function bundleOf(name: string, edition: string): Promise<{ bundle: Bundle; backend: RecordingBackend }> {
  const backend = new RecordingBackend();
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n# ${name}\n`);
  return { bundle: { root: `mem://${name}`, backend }, backend };
}

async function seed(bundle: Bundle, registry: KindRegistry, id: ConceptId, frontmatter: Record<string, unknown>, body: string): Promise<Version> {
  const result = await mutateDocument({
    bundle, id, mode: "patch", onAbsent: "create", registry, strict: false, actor: EDITOR,
    buildCandidate: () => ({ frontmatter: structuredClone(frontmatter) as unknown as Frontmatter, body }),
  });
  return result.version;
}

const NO_KINDS: KindRegistry = { kinds: new Map(), warnings: [] };

export async function overlayWorld(options: {
  edition?: "0.1" | "0.2";
  /** The ops bundle's edition when it differs from the content bundle's (implies separate bundles). */
  opsEdition?: "0.1" | "0.2";
  separate?: boolean;
  signal?: Record<string, unknown> | null;
  conventions?: Record<string, Record<string, unknown>>;
  feed?: Record<string, unknown>;
} = {}): Promise<World> {
  const edition = options.edition ?? "0.2";
  const opsEdition = options.opsEdition ?? edition;
  const progress = opsEdition === "0.1" ? "status" : "superbee_progress_status";
  const content = await bundleOf("overlay-content", edition);
  const ops = options.separate || opsEdition !== edition ? await bundleOf("overlay-ops", opsEdition) : content;
  await seed(content.bundle, NO_KINDS, "conventions/event", EVENT_CONVENTION, "# Event\n");
  if (options.signal !== null) await seed(ops.bundle, NO_KINDS, "conventions/signal", options.signal ?? signalConvention(progress), "# Signal\n");
  await seed(ops.bundle, NO_KINDS, "conventions/source-feed", SOURCE_FEED_CONVENTION, "# Source Feed\n");
  for (const [id, fm] of Object.entries(options.conventions ?? {})) await seed(ops.bundle, NO_KINDS, id, fm, `# ${String(fm.title)}\n`);
  const contentRegistry = await loadKinds(content.bundle);
  const opsRegistry = ops === content ? contentRegistry : await loadKinds(ops.bundle);
  const contentOverlay: OverlayBundle = { bundle: content.bundle, registry: contentRegistry, okfVersion: edition };
  const opsOverlay: OverlayBundle = ops === content ? contentOverlay : { bundle: ops.bundle, registry: opsRegistry, okfVersion: opsEdition };
  const feed = { ...FEED_FRONTMATTER, ...options.feed };
  await seed(ops.bundle, opsRegistry, FEED, feed, "Synthetic feed.\n");
  const pick = (where: "content" | "ops" = "content"): OverlayBundle => (where === "ops" ? opsOverlay : contentOverlay);
  content.backend.writes = []; ops.backend.writes = [];
  return {
    content: contentOverlay,
    ops: opsOverlay,
    contentBackend: content.backend,
    opsBackend: ops.backend,
    policy: readOverlayPolicy({ id: FEED, frontmatter: feed as unknown as Frontmatter }, { targetKind: contentRegistry.kinds.get("Event")! }),
    put: (id, fm, body = "", where = "content") => seed(pick(where).bundle, pick(where).registry, id, fm, body),
    edit: async (id, patch, where = "content", body) => (await mutateDocument({
      bundle: pick(where).bundle, id, mode: "patch", registry: pick(where).registry, strict: false, actor: EDITOR,
      buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter, ...patch } as Frontmatter, body: body ?? existing!.body }),
    })).version,
    read: (id, where = "content") => readDocVersioned(pick(where).bundle, id),
    snapshot: async (where = "content") => {
      const backend = where === "ops" ? ops.backend : content.backend;
      const out: Record<string, Version> = {};
      for (const id of await backend.list()) out[id] = (await backend.read(id)).version;
      return out;
    },
  };
}

export const event = (n: string, fm: Record<string, unknown>, provider = PROVIDER): Record<string, unknown> => ({
  type: "Event", event_status: "scheduled", ...fm,
  sources: [{ resource: provider, id: UID(n), title: "feed record" }],
});
export const EDITOR_BODY = "Editor-written description. Not feed-owned.\n";

export const change = (
  externalId: string,
  kind: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  digest: string,
  extra: Partial<RecordChange> = {},
): RecordChange => ({
  external_id: externalId,
  change_kind: kind,
  changed_fields: kind === "new" ? Object.keys(after ?? {}) : kind === "disappeared" ? []
    : Object.keys({ ...before, ...after }).filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])),
  before, after, content_digest: digest, ...extra,
});

/** The reference interval rule on offset datetimes: a stated end, else start plus three hours. */
export const statedEndElseThreeHours: IntervalHook = (fields) => {
  const start = typeof fields.start === "string" ? parseIsoInstant(fields.start) : null;
  if (start === null) return null;
  const end = typeof fields.end === "string" ? parseIsoInstant(fields.end) : null;
  return [start, end ?? start + 3 * 60 * 60 * 1000];
};

const NON_SUBSTANTIVE = new Set(["generated", "verified", "timestamp", "superbee_updated_by", "actor", "updated_at", "sources", "tags"]);
const substance = (doc: { frontmatter: object; body: string }): string | undefined => overlayCanonicalJson({
  fm: Object.fromEntries(Object.entries(doc.frontmatter).filter(([key]) => !NON_SUBSTANTIVE.has(key))),
  body: doc.body.replace(/\s+$/, ""),
});

/** The reference `updated_at` rule: stamp when the Kind declares it and the substance changed. */
export function updatedAtStamp(registry: KindRegistry, now: () => string = () => new Date().toISOString()): NonNullable<OverlayHooks["deriveFields"]> {
  return {
    fields: ["updated_at"],
    derive: (existing: OkfDocument, next: DocumentMutationCandidate) => {
      const kind = registry.kinds.get(String(next.frontmatter.type));
      if (!kind || ![...kind.fields.required, ...kind.fields.optional].includes("updated_at")) return {};
      if (overlayCanonicalJson(existing.frontmatter.updated_at) !== overlayCanonicalJson(next.frontmatter.updated_at)) return {};
      if (substance(existing) === substance(next)) return {};
      return { updated_at: now() };
    },
  };
}

/** A text gate double: a spaced dash becomes a colon; the word "Nestled" is a tell that cannot be normalized. */
export const dashGate: TextGate = (text) => {
  const normalized = text.replace(/\s+[\u2014\u2013-]\s+/g, ": ");
  const tells = /\bnestled\b/i.test(normalized) ? [{ code: "TELL_PHRASE", match: normalized.match(/\bnestled\b/i)![0] }] : [];
  return { text: normalized, ok: tells.length === 0, tells, changed: normalized !== text };
};
