/** Read-only measurements over canonical documents and the already-loaded Kind registry. */
import { isStandardDocumentSetField } from "./document-field-actions.js";
import { freshnessHorizonMs, projectKindForAuthoring, readKindField, resolveKindFieldCoordinate, type KindConvention, type KindRegistry } from "./kinds.js";
import { extractMarkdownLinks, parseLinksFromDoc } from "./links.js";
import { isManagedDocumentMetadataField } from "./managed-document-metadata.js";
import { parseTimestamp } from "./freshness.js";
import type { OkfDocument } from "./types.js";

const SENTINELS = new Set(["unknown", "n/a", "na", "none", "tbd", "null", "-", "?"]);
const EXAMPLES = 3;
const DOMAIN_LIMIT = 15;
const DAY = 86400000;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const ratio = (n: number, total: number) => total ? Math.round(n / total * 10000) / 10000 : null;
const empty = (value: unknown) => value == null || (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) ? value.length === 0 : typeof value === "object" && Object.keys(value).length === 0);
const sentinel = (value: unknown) => typeof value === "string" && SENTINELS.has(value.trim().toLowerCase());
const filled = (value: unknown) => !empty(value) && !sentinel(value);
const envelope = (key: string) => isManagedDocumentMetadataField(key) || isStandardDocumentSetField(key, "0.2") || key === "sources" || key === "tags";

function bodyProse(body: string): boolean {
  // Lossless line measurement, not Markdown rendering: every ATX heading is ignored;
  // a Related heading excludes its descendants until the next same/higher-level heading.
  let relatedLevel: number | undefined;
  for (const line of body.split("\n")) {
    const text = line.trim();
    const heading = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(text);
    if (heading) {
      const level = heading[1]!.length;
      if (relatedLevel !== undefined && level <= relatedLevel) relatedLevel = undefined;
      if (heading[2]!.trim().toLowerCase() === "related" && relatedLevel === undefined) relatedLevel = level;
      continue;
    }
    if (relatedLevel !== undefined) continue;
    const prose = text.replace(/^[-*] +/, "");
    if (!prose) continue;
    const links = extractMarkdownLinks(prose);
    if (!(links.length === 1 && prose === `[${links[0]!.text}](${links[0]!.href})`)) return true;
  }
  return false;
}

function fieldStats(docs: OkfDocument[], value: (doc: OkfDocument) => unknown) {
  let present = 0, sentinels = 0, used = 0;
  for (const doc of docs) {
    const v = value(doc);
    if (v !== undefined) used++;
    if (filled(v)) present++;
    else if (sentinel(v)) sentinels++;
  }
  return { present: used, filled: present, sentinel: sentinels, empty: docs.length - present - sentinels, rate: ratio(present, docs.length) };
}

function checkedOn(kind: KindConvention, docs: OkfDocument[], now: Date) {
  const buckets = { future: 0, "0-7d": 0, "8-30d": 0, "31-90d": 0, "91-180d": 0, "181-365d": 0, ">365d": 0 };
  let missing = 0, invalid = 0, older = 0;
  const horizon = freshnessHorizonMs(kind);
  for (const doc of docs) {
    const value = doc.frontmatter.checked_on;
    if (!filled(value)) { missing++; continue; }
    // checked_on is domain date metadata, not the edition's meaningful-change clock.
    const ms = typeof value === "string" ? parseTimestamp(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value, "0.2") : null;
    if (ms === null) { invalid++; continue; }
    const ageMs = now.getTime() - ms;
    const days = Math.floor(ageMs / DAY);
    const bucket = days < 0 ? "future" : days <= 7 ? "0-7d" : days <= 30 ? "8-30d" : days <= 90 ? "31-90d" : days <= 180 ? "91-180d" : days <= 365 ? "181-365d" : ">365d";
    buckets[bucket]++;
    if (horizon !== undefined && ageMs > horizon) older++;
  }
  return { clock: "checked_on", horizon: kind.freshnessHorizon ?? null, horizon_ms: horizon ?? null, missing, invalid, buckets, older_than_horizon: horizon === undefined ? null : older };
}

function sourceStats(docs: OkfDocument[]) {
  const domains = new Map<string, number>();
  const distribution = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5+": 0 };
  let total = 0, zero = 0, invalid = 0, nonUrl = 0;
  for (const doc of docs) {
    const raw = doc.frontmatter.sources;
    const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    let count = 0;
    for (const item of list) {
      const resource = typeof item === "string" ? item : item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>).resource : undefined;
      if (typeof resource !== "string" || !filled(resource)) { invalid++; continue; }
      count++;
      try {
        const domain = new URL(resource).hostname.toLowerCase().replace(/^www\./, "");
        if (!domain) { nonUrl++; continue; }
        domains.set(domain, (domains.get(domain) ?? 0) + 1);
      } catch { nonUrl++; }
    }
    if (!count) zero++;
    total += count;
    distribution[count >= 5 ? "5+" : String(count) as "0" | "1" | "2" | "3" | "4"]++;
  }
  const ordered = [...domains].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]));
  return { zero, total, invalid_entries: invalid, non_url_resources: nonUrl, per_record: distribution, distinct_domains: domains.size, domains_shown: Math.min(domains.size, DOMAIN_LIMIT), top_domains: ordered.slice(0, DOMAIN_LIMIT).map(([domain, sources]) => ({ domain, sources })) };
}

/** All records are grouped by actual type; path prefixes never infer a Kind or hide nested records. */
export function kindCoverage(registry: KindRegistry, documents: readonly OkfDocument[], options: { now: Date; okfVersion?: string; kind?: string }) {
  if (!Number.isFinite(options.now.getTime())) throw new TypeError("Coverage now must be a valid date");
  const docs = [...documents].sort((a, b) => compare(a.id, b.id));
  const index = new Map(docs.map((doc) => [doc.id, doc]));
  const edges = new Map(docs.map((doc) => [doc.id, parseLinksFromDoc(doc)]));
  const inbound = new Set([...edges.values()].flat().map((link) => link.to));
  const groups = new Map<string, OkfDocument[]>();
  for (const doc of docs) {
    const type = doc.frontmatter.type;
    const group = groups.get(type) ?? [];
    group.push(doc); groups.set(type, group);
  }
  const kinds = [...registry.kinds.values()].filter((kind) => options.kind === undefined || kind.governs === options.kind).map((kind) => {
    const records = groups.get(kind.governs) ?? [];
    const authoring = projectKindForAuthoring(options.okfVersion, kind);
    const fields = [...new Set([...authoring.fields.required, ...authoring.fields.optional])].sort(compare);
    const stats = fields.map((field) => ({ field, required: authoring.fields.required.includes(field), ...fieldStats(records, (doc) => readKindField(options.okfVersion, kind, doc.frontmatter, field)) }));
    const declaredStorage = new Set(fields.map((field) => resolveKindFieldCoordinate(options.okfVersion, kind, field)?.storageField ?? field));
    const undeclared = new Map<string, string[]>(), envelopes = new Map<string, number>();
    for (const doc of records) for (const key of Object.keys(doc.frontmatter)) {
      if (envelope(key)) { envelopes.set(key, (envelopes.get(key) ?? 0) + 1); continue; }
      if (!declaredStorage.has(key)) { const ids = undeclared.get(key) ?? []; ids.push(doc.id); undeclared.set(key, ids); }
    }
    const relations = new Map<string, { relation: string; target_kind: string | null; target_matches: boolean | null; records: Set<string>; links: number }>();
    let citations = 0, dangling = 0, withLinks = 0;
    const danglingExamples: string[] = [];
    for (const doc of records) {
      const links = edges.get(doc.id)!;
      if (links.length) withLinks++;
      for (const link of links) {
        const target = index.get(link.to);
        if (!target) { dangling++; if (danglingExamples.length < EXAMPLES) danglingExamples.push(doc.id); }
        if (!Object.hasOwn(kind.links ?? {}, link.text)) { citations++; continue; }
        const targetKind = target?.frontmatter.type ?? null;
        const key = JSON.stringify([link.text, targetKind]);
        const row = relations.get(key) ?? { relation: link.text, target_kind: targetKind, target_matches: targetKind === null ? null : targetKind === kind.links![link.text], records: new Set<string>(), links: 0 };
        row.records.add(doc.id); row.links++; relations.set(key, row);
      }
    }
    const used = new Set([...relations.values()].map((row) => row.relation));
    return { governs: kind.governs, records: records.length,
      coverage: { fields: stats, body_prose: { filled: records.filter((doc) => bodyProse(doc.body)).length, rate: ratio(records.filter((doc) => bodyProse(doc.body)).length, records.length) } },
      drift: { undeclared: [...undeclared].sort(([a], [b]) => compare(a, b)).map(([key, ids]) => ({ key, records: ids.length, rate: ratio(ids.length, records.length), examples: ids.slice(0, EXAMPLES), examples_total: ids.length })), declared_unused: stats.filter((row) => row.present === 0).map((row) => row.field), envelope: [...envelopes].sort(([a], [b]) => compare(a, b)).map(([key, records]) => ({ key, records })) },
      links: { with_links: withLinks, typed: [...relations.values()].sort((a, b) => compare(a.relation, b.relation) || compare(a.target_kind ?? "", b.target_kind ?? "")).map((row) => ({ relation: row.relation, target_kind: row.target_kind, target_matches: row.target_matches, records: row.records.size, links: row.links, rate: ratio(row.records.size, records.length) })), untyped_citations: citations, declared_never_used: Object.keys(kind.links ?? {}).filter((relation) => !used.has(relation)).sort(compare), dangling, dangling_examples: danglingExamples, no_inbound: records.filter((doc) => !inbound.has(doc.id)).length },
      freshness: checkedOn(kind, records, options.now), sources: sourceStats(records) };
  });
  return { now: options.now.toISOString(), documents: docs.length, undeclared_kinds: [...groups.keys()].filter((type) => !registry.kinds.has(type)).sort(compare), kinds };
}
