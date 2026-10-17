/**
 * Source Feed policy: which fields a feed owns and what each change kind may do. Reads the feed's
 * frontmatter and decides per change, purely.
 */
import type { ConceptId, Frontmatter } from "../types.js";
import { same } from "./canonical.js";
import { OverlayRefusal, REFUSAL_CODES } from "./errors.js";
import type { ChangeDecision, OverlayPolicy, PolicyContext, RecordChange, Tell, TextGate } from "./types.js";

export const DEFAULT_AUTO_APPLY: readonly string[] = Object.freeze(["changed"]);
export const DEFAULT_NEEDS_REVIEW: readonly string[] = Object.freeze(["new", "canceled", "disappeared", "page-changed"]);
/** Fields a feed may never own: identity, provenance and trust stay with Superbee and editors. */
export const NEVER_OWNED: ReadonlySet<string> = new Set([
  "type", "sources", "verified", "generated", "status", "stale_after", "tags", "superbee_updated_by",
]);

const list = (v: unknown): string[] | undefined => (
  Array.isArray(v) ? v.map(String).filter(Boolean)
    : typeof v === "string" && v ? v.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined
);

const identityGate: TextGate = (text) => ({ text, ok: true, tells: [], changed: false });

/**
 * Read the generic keys of a Source Feed document. Every refusal is `POLICY_INVALID`. A
 * presentation-only feed never writes documents, so names a document could never own (a
 * Condition's `status`) are plain record fields there, and its policy carries no `target_kind`.
 */
export function readOverlayPolicy(doc: { id: ConceptId; frontmatter: Frontmatter }, ctx: PolicyContext = {}): OverlayPolicy {
  const fm = (doc.frontmatter ?? {}) as unknown as Record<string, unknown>;
  const refuse = (message: string, details: Record<string, unknown> = {}): never => {
    throw new OverlayRefusal(REFUSAL_CODES.POLICY_INVALID, `${doc.id}: ${message}`, { feed: doc.id, ...details });
  };
  if (ctx.targetKind !== undefined && ctx.presentationFields !== undefined) refuse("a target Kind and presentation fields are mutually exclusive");
  const presentation = ctx.presentationFields !== undefined;
  const owned = list(fm.owned_fields);
  if (!owned || owned.length === 0) refuse("owned_fields is required");
  const ownedFields = owned!;
  const bad = presentation ? [] : ownedFields.filter((f) => NEVER_OWNED.has(f));
  if (bad.length) refuse(`fields can never be feed-owned: ${bad.join(", ")}`, { fields: bad });
  if (ctx.targetKind) {
    const declared = new Set([...ctx.targetKind.fields.required, ...ctx.targetKind.fields.optional, "title"]);
    const undeclared = ownedFields.filter((f) => !declared.has(f));
    if (undeclared.length) refuse(`owned_fields not declared by ${ctx.targetKind.governs}: ${undeclared.join(", ")}`, { fields: undeclared });
  }
  if (presentation) {
    const allowed = new Set(ctx.presentationFields);
    const undeclared = ownedFields.filter((f) => !allowed.has(f));
    if (undeclared.length) refuse(`owned_fields not part of the presentation kind: ${undeclared.join(", ")}`, { fields: undeclared });
  }
  const threshold = fm.missing_threshold === undefined || fm.missing_threshold === null ? undefined : Number(fm.missing_threshold);
  if (threshold !== undefined && !(Number.isInteger(threshold) && threshold >= 1)) refuse("missing_threshold must be a whole number >= 1");
  if (typeof fm.url !== "string" || !fm.url) refuse("url (provider identity) is required");
  const zone = fm.wall_time_zone === undefined || fm.wall_time_zone === null ? undefined : String(fm.wall_time_zone).trim();
  const targetKind = !presentation && typeof fm.target_kind === "string" && fm.target_kind ? fm.target_kind : undefined;
  return {
    feed: doc.id,
    provider: fm.url as string,
    ...(targetKind ? { target_kind: targetKind } : {}),
    owned_fields: ownedFields,
    auto_apply: list(fm.auto_apply) ?? [...DEFAULT_AUTO_APPLY],
    needs_review: list(fm.needs_review) ?? [...DEFAULT_NEEDS_REVIEW],
    exclude: excludeOf(doc.id, fm.exclude_pattern),
    ...(threshold !== undefined ? { missing_threshold: threshold } : {}),
    ...(fm.completeness === "complete" || fm.completeness === "partial" ? { completeness: fm.completeness } : {}),
    ...(zone ? { time_zone: zone } : {}),
  };
}

/** Optional editorial exclusion: a case-insensitive pattern on the record title. */
function excludeOf(feed: ConceptId, pattern: unknown): RegExp | null {
  if (pattern === undefined || pattern === null || pattern === "") return null;
  try { return new RegExp(String(pattern), "i"); }
  catch { throw new OverlayRefusal(REFUSAL_CODES.POLICY_INVALID, `${feed}: exclude_pattern is not a valid pattern`, { feed }); }
}

/**
 * Whether a record is editorially excluded: its title matches `exclude`, or its source id (or, for
 * a recurrence occurrence `<series id>#<date>`, its series id) is in `exclude_ids`. Excluded records
 * are never projected and never raise Signals.
 */
export function isExcludedRecord(policy: OverlayPolicy, externalId: string | undefined, title: unknown): boolean {
  if (policy.exclude && policy.exclude.test(String(title ?? ""))) return true;
  if (!policy.exclude_ids || externalId === undefined || externalId === null) return false;
  const id = String(externalId);
  if (policy.exclude_ids.has(id)) return true;
  const hash = id.indexOf("#");
  return hash > 0 && policy.exclude_ids.has(id.slice(0, hash));
}

const SEVERITY: Record<string, number> = { new: 1, changed: 2, "page-changed": 2, disappeared: 3, canceled: 4 };
export const severity = (kind: unknown): number => SEVERITY[kind as string] ?? 0;
const PRIORITY_RANK: Record<string, number> = { low: 1, normal: 2, urgent: 3 };
export const maxPriority = <T>(a: T, b: T): T => ((PRIORITY_RANK[a as string] ?? 0) >= (PRIORITY_RANK[b as string] ?? 0) ? a : b);

/**
 * Decide one change. Per owned field, with B the last accepted feed value (`change.before`), N the
 * new feed value and C the overlay document's value: C equal to N is converged (nothing to write);
 * C equal to B writes N; anything else is `OVERLAY_DOC_CONFLICT`. Changes to fields the feed does
 * not own are never written; on an overlay document they need judgment.
 *
 * A value is written as the text gate words it, and C is compared with B and N as gated too, so a
 * document that already says the normalized value converges. A value the gate still refuses is
 * not written: it is listed in `wording` and raises a low-priority Signal.
 */
export function decideChange(
  policy: OverlayPolicy,
  change: RecordChange,
  { overlay = null, featured = false, textGate }: { overlay?: { frontmatter: Record<string, unknown> } | null; featured?: boolean; textGate?: TextGate } = {},
): ChangeDecision {
  const owned = new Set(policy.owned_fields);
  const apply: ChangeDecision["apply"] = {};
  const conflicts: ChangeDecision["conflicts"] = [];
  const wording: ChangeDecision["wording"] = [];
  let editorFields: string[] = [];
  const reasons: string[] = [];
  const autoApply = policy.auto_apply.includes(change.change_kind);
  const kind = policy.target_kind;

  if (overlay && change.after && change.before && autoApply) {
    for (const f of change.changed_fields) {
      if (!owned.has(f)) continue;
      const C = overlay.frontmatter[f], B = change.before[f], N = change.after[f];
      const n = gateSafeValue(N, f, kind, textGate), b = gateSafeValue(B, f, kind, textGate);
      if (same(C, N) || same(C, n.value)) continue;
      if (same(C, B) || same(C, b.value)) {
        if (n.ok) apply[f] = { from: C, to: n.value };
        else wording.push({ field: f, text: typeof N === "string" ? N : JSON.stringify(N), tells: n.tells });
      } else conflicts.push({ field: f, doc_value: C, feed_before: B, feed_after: N });
    }
  }
  // An editor-owned change needs judgment only when the document does not already say the new value.
  if (overlay && change.before && change.after) {
    const after = change.after;
    editorFields = change.changed_fields.filter((f) => !owned.has(f) && !same(overlay.frontmatter[f], after[f]));
  }

  if (policy.needs_review.includes(change.change_kind)) reasons.push(`needs_review:${change.change_kind}`);
  if (conflicts.length) reasons.push(REFUSAL_CODES.OVERLAY_DOC_CONFLICT);
  if (editorFields.length) reasons.push("editor-owned-field-changed");
  if (overlay && !autoApply && !policy.needs_review.includes(change.change_kind) && change.changed_fields.some((f) => owned.has(f))) {
    reasons.push("owned-field-changed-without-auto-apply");
  }
  if (wording.length) reasons.push("needs-human-safe-wording");

  let signal: ChangeDecision["signal"] = null;
  if (reasons.length) {
    // Text held back for a wording is not news: alone, it is a low-priority Signal.
    let priority = wording.length && reasons.length === 1 ? "low" : "normal";
    if (change.change_kind === "new" && !overlay) priority = "low";
    if (change.change_kind === "canceled" && (overlay || featured)) priority = "urgent";
    signal = { priority, reasons };
  }
  return { apply, conflicts, editorFields, wording, signal };
}

/**
 * A feed value as an overlay document may carry it. A string goes through the text gate for its
 * field and the overlay's Kind; any other value passes when every string inside it passes as it is.
 */
export function gateSafeValue(
  value: unknown,
  field: string,
  kind: string | undefined,
  textGate: TextGate = identityGate,
): { value: unknown; ok: boolean; tells: Tell[] } {
  if (typeof value === "string") {
    const r = textGate(value, { field, kind });
    return { value: r.text, ok: r.ok, tells: r.tells };
  }
  const strings: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  const tells = strings.flatMap((s) => {
    const r = textGate(s, { field, kind });
    return r.changed || !r.ok ? (r.tells.length ? r.tells : [{ code: "NEEDS_NORMALIZING", match: s.slice(0, 80) }]) : [];
  });
  return { value, ok: tells.length === 0, tells };
}
