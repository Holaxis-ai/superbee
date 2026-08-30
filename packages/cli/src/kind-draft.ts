// Pure inference/forecast/token logic for `kind draft` and `kind dismiss` (design:
// designs/agent-proposed-kinds — PR 1 of the modeling-signal plan). Everything here is a pure
// derivation over already-read documents so the command handlers stay thin and the predicates
// stay unit-testable without a bundle on disk.
//
// The one invariant this module exists to protect: an INFERRED draft applies with zero new
// conformance warnings ("zero-debt by construction"). That holds only because the inference
// predicates below are pinned to core's OWN validation predicates — presence is core's
// `isPresent` (never bare key existence: a `title: ""` on one instance must not become a
// required field), and enum proposal is scalar-string-only (an array-valued key would fire
// KIND_FIELD_ARITY on every instance). The apply-then-validate property test in
// kind-draft.test.ts pins this predicate equality; drift there fails the suite loudly.
import { createHash } from "node:crypto";
import {
  isPresent,
  RESERVED_KIND_FIELD_NAMES,
  splitSections,
  SUPERBEE_UPDATED_BY_FIELD,
  validateAgainstKind,
  type KindConvention,
  type OkfDocument,
} from "@superbee/core";

/** Enum inference gates: 100% presence, at least this many instances, 2-6 distinct scalar strings. */
export const ENUM_MIN_INSTANCES = 10;
export const ENUM_MIN_DISTINCT = 2;
export const ENUM_MAX_DISTINCT = 6;
/**
 * Floor for a sub-100% H1 heading to appear as a PRICED promotion (mirrors the 60% descriptive
 * threshold the modeling signal's status block uses). Headings below it are noise, not candidates.
 */
export const SECTION_PROMOTION_FLOOR = 0.6;

/** Fields the inference never proposes: CLI-reserved names plus engine-owned attribution. */
const EXCLUDED_FIELDS = new Set<string>([...RESERVED_KIND_FIELD_NAMES, SUPERBEE_UPDATED_BY_FIELD]);

/**
 * Whether `kind` declares ANY schema obligation or behavior. The ONE predicate shared by
 * `kind draft`'s refusal (a declaration-bearing kind is never silently redrafted), `kind
 * dismiss`'s idempotency check, and `new`'s registry-lookup guard (a declaration-free kind — a
 * dismissal record — must leave `new`'s command surface exactly as it was before the dismissal).
 */
export function kindDeclaresAnything(kind: KindConvention): boolean {
  return (
    kind.fields.required.length > 0 ||
    kind.fields.optional.length > 0 ||
    Object.keys(kind.fields.values).length > 0 ||
    Object.keys(kind.fields.terminal).length > 0 ||
    (kind.sections !== undefined && kind.sections.length > 0) ||
    (kind.links !== undefined && Object.keys(kind.links).length > 0) ||
    (kind.expectsInbound !== undefined && Object.keys(kind.expectsInbound).length > 0) ||
    kind.freshnessHorizon !== undefined ||
    kind.claim !== undefined
  );
}

/** `"Context Note"` -> `"context-note"` — the same slug shape the builtin conventions use. */
export function conventionSlugForType(type: string): string {
  const slug = type
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "kind" : slug;
}

/** Per-key/per-heading presence over one type's instances — the stats the token binds. */
export interface DraftInstanceStats {
  count: number;
  /** key -> number of instances where the value passes core's `isPresent`. Sorted by key. */
  keyPresence: Record<string, number>;
  /** H1 heading -> number of instances whose body carries it. Sorted by heading. */
  headingPresence: Record<string, number>;
}

function sortedRecord(entries: Iterable<[string, number]>): Record<string, number> {
  return Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

/** Fold `instances` into the presence stats. Presence is core's `isPresent`, never key existence. */
export function collectInstanceStats(instances: readonly OkfDocument[]): DraftInstanceStats {
  const keys = new Map<string, number>();
  const headings = new Map<string, number>();
  for (const doc of instances) {
    for (const [key, value] of Object.entries(doc.frontmatter)) {
      if (!isPresent(value)) continue;
      keys.set(key, (keys.get(key) ?? 0) + 1);
    }
    for (const heading of Object.keys(splitSections(doc.body))) {
      headings.set(heading, (headings.get(heading) ?? 0) + 1);
    }
  }
  return {
    count: instances.length,
    keyPresence: sortedRecord(keys),
    headingPresence: sortedRecord(headings),
  };
}

/** True when every observed value for `key` across `instances` is a scalar string. */
function everyValueScalarString(instances: readonly OkfDocument[], key: string): boolean {
  for (const doc of instances) {
    const value = (doc.frontmatter as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return false;
  }
  return true;
}

/** Distinct observed (string) values for `key`, in first-seen order. */
function distinctValues(instances: readonly OkfDocument[], key: string): string[] {
  const seen = new Set<string>();
  for (const doc of instances) {
    const value = (doc.frontmatter as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim() !== "") seen.add(value);
  }
  return [...seen];
}

/**
 * Infer the candidate convention for `type` from its instances:
 * - required  = keys `isPresent` on 100% of instances (minus reserved + attribution)
 * - optional  = every other key `isPresent` on >=1 instance
 * - values    = only at 100% presence, >= {@link ENUM_MIN_INSTANCES} instances, 2-6 distinct
 *               values, every observed value a scalar string
 * - sections  = H1 headings on 100% of instances (H1-only: core's ONE heading splitter)
 * - path      = the common leading id segment, only when ALL instances share exactly one — a
 *               split (`plans/` + `designs/`) is the finding; silently blessing one prefix
 *               would orphan the rest, so no `path` is proposed there
 */
export function inferKindCandidate(
  type: string,
  instances: readonly OkfDocument[],
  stats: DraftInstanceStats = collectInstanceStats(instances),
): KindConvention {
  const count = stats.count;
  const required: string[] = [];
  const optional: string[] = [];
  const values: Record<string, string[]> = {};
  for (const [key, present] of Object.entries(stats.keyPresence)) {
    if (EXCLUDED_FIELDS.has(key)) continue;
    if (present === count && count > 0) {
      required.push(key);
      if (count >= ENUM_MIN_INSTANCES && everyValueScalarString(instances, key)) {
        const distinct = distinctValues(instances, key);
        if (distinct.length >= ENUM_MIN_DISTINCT && distinct.length <= ENUM_MAX_DISTINCT) {
          values[key] = distinct.sort((a, b) => a.localeCompare(b));
        }
      }
    } else {
      optional.push(key);
    }
  }
  const sections = Object.entries(stats.headingPresence)
    .filter(([, present]) => present === count && count > 0)
    .map(([heading]) => heading);

  const prefixes = new Set<string>();
  let allPrefixed = instances.length > 0;
  for (const doc of instances) {
    const slash = doc.id.indexOf("/");
    if (slash <= 0) {
      allPrefixed = false;
      break;
    }
    prefixes.add(doc.id.slice(0, slash));
  }
  const path = allPrefixed && prefixes.size === 1 ? `${[...prefixes][0]!}/` : undefined;

  return {
    id: `conventions/${conventionSlugForType(type)}`,
    title: type,
    governs: type,
    description: `Drafted by 'kind draft' from ${count} existing instance${count === 1 ? "" : "s"}.`,
    ...(path === undefined ? {} : { path }),
    fields: { required, optional, values, terminal: {}, descriptions: {} },
    ...(sections.length > 0 ? { sections } : {}),
  };
}

/** One priced promotion row: a declaration the human MAY add, with its measured cost. */
export interface DraftPromotion {
  declaration: string;
  present: string;
  warnings_if_added: number;
}

/**
 * Price the candidate promotions: every sub-100% optional field, plus every H1 heading at or
 * above {@link SECTION_PROMOTION_FLOOR} but below 100%. `warnings_if_added` is exactly the
 * instances the added declaration would newly warn on.
 */
export function draftPromotions(kind: KindConvention, stats: DraftInstanceStats): DraftPromotion[] {
  const rows: DraftPromotion[] = [];
  for (const key of kind.fields.optional) {
    const present = stats.keyPresence[key] ?? 0;
    rows.push({
      declaration: `field ${key} (optional -> required)`,
      present: `${present}/${stats.count}`,
      warnings_if_added: stats.count - present,
    });
  }
  for (const [heading, present] of Object.entries(stats.headingPresence)) {
    if (present === stats.count) continue; // already in the draft
    if (present / stats.count < SECTION_PROMOTION_FLOOR) continue;
    rows.push({
      declaration: `section "# ${heading}"`,
      present: `${present}/${stats.count}`,
      warnings_if_added: stats.count - present,
    });
  }
  rows.sort((a, b) => a.warnings_if_added - b.warnings_if_added || a.declaration.localeCompare(b.declaration));
  return rows;
}

/**
 * The MEASURED post-apply warning count: run core's validator over every instance against the
 * candidate and sum the violations. Zero by construction for an inferred candidate (see module
 * comment); the true — possibly large — number for an adopted catalog candidate. Never assumed.
 */
export function warningsAfterApply(kind: KindConvention, instances: readonly OkfDocument[]): number {
  let total = 0;
  for (const doc of instances) total += validateAgainstKind(doc, kind).length;
  return total;
}

/**
 * The state-bound plan token `--apply` must present: sha256 of the canonical JSON of everything
 * the human inspected — the exact candidate document, the bundle edition, and the instance stats
 * it was inferred from. Any change to WHAT THE TOKEN BINDS between draft and apply refuses:
 * a presence-stat change (new/removed instances, a key appearing or emptying), an edition
 * change, or a candidate difference. An instance edit that alters none of those (e.g. one title
 * VALUE changing) deliberately keeps the token valid — the written candidate is unchanged and
 * `warnings_after_apply` is re-measured at apply (the `recipe evolve` discipline,
 * recipe-evolution.ts's `evolutionPlanToken`).
 */
export function draftPlanToken(input: {
  target: string;
  candidate: { id: string; frontmatter: unknown; body: string };
  okfVersion: string;
  stats: DraftInstanceStats;
}): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex")}`;
}
