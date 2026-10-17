/**
 * The multi-document plan: read, classify or refuse, and emit steps that carry the exact version
 * they were decided against. Pure apart from bundle reads.
 *
 * Two bundles: ops holds Source Feeds and Signals, content holds the overlay documents. They may be
 * the same bundle.
 */
import { queryHeads, readDocVersioned } from "../bundle-ops.js";
import type { Bundle, HeadResult } from "../types.js";
import { parseIsoInstant } from "../verification.js";
import { shortHash } from "./digest.js";
import { OverlayRefusal, REFUSAL_CODES } from "./errors.js";
import { decideChange, isExcludedRecord, maxPriority, severity } from "./policy.js";
import { redactUrl } from "./redact.js";
import { resolveAttentionKind } from "./signal-kind.js";
import { adoptionHint, linkLine, observationLine, oneLine, overlayLine, relatedLine, signalBody, signalLinkTexts } from "./signal-text.js";
import { buildSourceIndex, type SourceIndex } from "./source-index.js";
import type {
  ChangeDecision,
  CorrelateHook,
  DisappearedPhase,
  IntervalHook,
  OverlayPlan,
  OverlayStep,
  PlanInput,
  RecordChange,
  RefusalRow,
} from "./types.js";

const LABEL: Record<string, string> = { new: "New", changed: "Changed", canceled: "Canceled", disappeared: "Disappeared", "page-changed": "Page changed" };
const PRIORITIES = new Set(["low", "normal", "urgent"]);

const short = (v: unknown): string => {
  if (v === undefined) return "∅";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
};

function lastKnownInterval(fields: unknown, timeZone: string | undefined, interval: IntervalHook | undefined): readonly [number, number] | null {
  return interval && fields && typeof fields === "object" ? interval(fields as Record<string, unknown>, timeZone) : null;
}

/**
 * Where a disappeared record stood at `observedAt`: `ended` (its last known end has passed),
 * `before-start` (it vanished before it began: possibly canceled), `ongoing`, or null when its
 * dates are unknown. Without an interval hook the phase is always unknown, so the record is raised.
 */
export function disappearedPhase(
  fields: Record<string, unknown> | null,
  observedAt: string,
  timeZone: string | undefined,
  interval: IntervalHook | undefined,
): DisappearedPhase {
  const span = lastKnownInterval(fields, timeZone, interval);
  const at = parseIsoInstant(observedAt);
  if (!span || at === null) return null;
  return at >= span[1] ? "ended" : at < span[0] ? "before-start" : "ongoing";
}

export function summarizeChange(
  change: RecordChange,
  decision: ChangeDecision | null,
  ownedFields: readonly string[] = [],
  { phase = null }: { phase?: DisappearedPhase } = {},
): string {
  const parts: string[] = [];
  if (change.change_kind === "new") {
    parts.push(`new record${change.after?.start ? ` @ ${change.after.start}` : ""}`);
    // The values the feed would own, so the claimant can judge without opening the store.
    for (const f of ownedFields.filter((k) => k !== "start" && change.after?.[k] !== undefined).slice(0, 6)) parts.push(`${f}: ${short(change.after![f])}`);
  }
  else if (change.change_kind === "disappeared") {
    parts.push(`missing from ${change.missing_count} consecutive complete observations`);
    if (phase === "before-start") parts.push("vanished before its start: possibly canceled, check the organizer's page");
    else if (phase === "ended") parts.push("ended: gone after its last known end");
    // The last known facts, so triage needs no store or history.
    for (const f of ["title", "start", "end"]) parts.push(`last ${f}: ${short(change.before?.[f])}`);
  }
  else for (const f of change.changed_fields) parts.push(`${f}: ${short(change.before?.[f])} → ${short(change.after?.[f])}`);
  for (const c of decision?.conflicts ?? []) parts.push(`CONFLICT ${c.field}: doc has ${short(c.doc_value)}, feed was ${short(c.feed_before)}`);
  if (decision?.editorFields?.length) parts.push(`not applied (editor-owned): ${decision.editorFields.join(", ")}`);
  // Feed text the publication gate would refuse even normalized: not written, named for a person.
  for (const w of decision?.wording ?? []) parts.push(`not applied, needs a human-safe wording: ${w.field}: ${short(w.text)} (${[...new Set(w.tells.map((t) => `${t.code} "${t.match}"`))].join(", ")})`);
  const s = parts.join("; ");
  return s.length > 600 ? s.slice(0, 599) + "…" : s;
}

/** Scalar `sources` properties from the hook, refused when they would name the identity or hold a list. */
function sourcePropertiesOf(hook: PlanInput["hooks"], change: RecordChange): Record<string, string | number | boolean> | undefined {
  const props = hook?.sourceProperties?.(change);
  if (props === undefined) return undefined;
  if (props === null || typeof props !== "object" || Array.isArray(props)) {
    throw new OverlayRefusal(REFUSAL_CODES.INVALID_INPUT, "sourceProperties must return a mapping of scalar properties", { external_id: change.external_id });
  }
  for (const [key, value] of Object.entries(props)) {
    if (key === "resource" || key === "id") {
      throw new OverlayRefusal(REFUSAL_CODES.INVALID_INPUT, `sourceProperties may not set the identity property ${key}`, { external_id: change.external_id, field: key });
    }
    if (typeof value !== "string" && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0))) {
      throw new OverlayRefusal(REFUSAL_CODES.INVALID_INPUT, `sourceProperties property ${key} must be a string, finite number or boolean`, { external_id: change.external_id, field: key });
    }
  }
  return Object.keys(props).length ? { ...props } : undefined;
}

export async function planRecordOverlay(input: PlanInput): Promise<OverlayPlan> {
  const { ops, content, policy, changes, observedAt, records = {}, observation = {}, sameBundle = false, hooks = {} } = input;
  const timeZone = input.timeZone ?? policy.time_zone;
  const steps: OverlayStep[] = [];
  const refusals: RefusalRow[] = [];
  const provider = policy.provider;
  const providerOut = redactUrl(provider);
  const attention = resolveAttentionKind(ops.registry, ops.okfVersion, input.signals?.kind ?? "Signal", policy.target_kind);
  if (!attention.ok) throw new OverlayRefusal(REFUSAL_CODES.POLICY_INVALID, attention.reason, { feed: policy.feed });
  const { name: signalName, kind: signalKind, prefix: signalPrefix, stateField: progressField, ownerField } = attention.value;
  const { fromFeed, about } = signalLinkTexts(signalKind, policy.target_kind, input.signals?.feedKind ?? "Source Feed");
  const feedSlug = policy.feed.split("/").pop()!.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();

  const overlays: SourceIndex | null = policy.target_kind
    ? input.overlays ?? await buildSourceIndex(content.bundle, { type: policy.target_kind })
    : null;
  const existingSignals = (await queryHeads(ops.bundle, { type: signalName }))
    .filter((h) => h.frontmatter.provider === providerOut);

  // Records superseded by a record of this same observation (`collapse_with`): their successor
  // carries the news, so their own disappearance needs no Signal activity.
  const related = await correlationIndex(content.bundle, hooks.correlate);

  const supersededNow = new Set(changes.filter((c) => c.after).flatMap((c) => c.collapse_with ?? []));
  const touchedSignals = new Set<string>();
  const isOpen = (h: HeadResult): boolean => h.frontmatter[progressField] === "todo" && !h.frontmatter[ownerField];

  for (const change of changes) {
    if (change.change_kind === "disappeared" && supersededNow.has(change.external_id)) {
      steps.push({ op: "record-only", external_id: change.external_id, change_kind: change.change_kind, superseded: true });
      continue;
    }
    // A record that drops out after its last known end has ended: no Signal. One that vanishes
    // before its start may be canceled and is still raised. The phase is judged when it first went
    // missing; without that time the phase is unknown and the record is raised.
    const phase = change.change_kind === "disappeared" && change.first_missing_at ? disappearedPhase(change.before, change.first_missing_at, timeZone, hooks.interval) : null;
    // A record with an open, unclaimed Signal is not retired quietly: that Signal is told it ended.
    const hasOpen = existingSignals.some((h) => h.frontmatter.external_id === change.external_id && isOpen(h));
    if (phase === "ended" && !hasOpen) {
      const [, endMs] = lastKnownInterval(change.before, timeZone, hooks.interval)!;
      steps.push({ op: "record-only", external_id: change.external_id, change_kind: change.change_kind, ended: true, reason: "ended", last_known_end: new Date(endMs).toISOString() });
      continue;
    }
    const matches = overlays ? overlays.lookup(provider, change.external_id, { type: policy.target_kind }) : [];
    const recTitle = change.after?.title ?? change.before?.title ?? records[change.external_id]?.fields?.title;
    if (matches.length > 1) {
      refusals.push({ code: REFUSAL_CODES.OVERLAY_IDENTITY_AMBIGUOUS, external_id: change.external_id, targets: matches.map((m) => m.id), message: "more than one document claims this provider identity; merge or rebind needs review" });
    }
    const overlay = matches.length === 1 ? matches[0]! : null;
    // Editorially excluded records are observed and stored but never presented, so they never need judgment either.
    if (isExcludedRecord(policy, change.external_id, recTitle)) {
      steps.push({ op: "record-only", external_id: change.external_id, change_kind: change.change_kind, excluded: true });
      continue;
    }
    const decision = decideChange(policy, change, { overlay, textGate: hooks.textGate });
    // An ended record with an open Signal only tells that Signal so: it keeps its kind, title and
    // priority (expiry is not news), with a low-priority observation line.
    const endedOpen = phase === "ended" && hasOpen;
    if (endedOpen) decision.signal = { priority: "low", reasons: ["update-open-signal", "ended"] };
    if (matches.length > 1) decision.signal ??= { priority: "normal", reasons: [REFUSAL_CODES.OVERLAY_IDENTITY_AMBIGUOUS] };

    if (Object.keys(decision.apply).length) {
      const fields = decision.apply;
      const props = sourcePropertiesOf(hooks, change);
      // A removal cannot be expressed by a field action, so a step that removes keeps the patch shape.
      const removes = Object.values(fields).some((v) => v.to === undefined);
      steps.push({
        op: "apply-owned-fields", target: overlay!.id, expected_version: overlay!.version, external_id: change.external_id, change_kind: change.change_kind, fields,
        ...(props && !removes ? { sources: props } : {}),
      });
    }
    for (const c of decision.conflicts) {
      refusals.push({ code: REFUSAL_CODES.OVERLAY_DOC_CONFLICT, external_id: change.external_id, target: overlay!.id, field: c.field, message: "owned field was edited in the document since the last accepted feed value" });
    }

    const mine = existingSignals.filter((h) => h.frontmatter.external_id === change.external_id);
    // A record that supersedes another (`collapse_with`) joins that record's open Signal.
    const predecessors = new Set(change.collapse_with ?? []);
    const open = mine.find(isOpen) ?? existingSignals.find((h) => predecessors.has(h.frontmatter.external_id as string) && isOpen(h));
    // A record with an open, unclaimed Signal keeps that Signal current even for changes that
    // would otherwise be record-only, so the eventual claimant sees the latest facts.
    if (!decision.signal && open) decision.signal = { priority: "low", reasons: ["update-open-signal"] };
    if (!decision.signal) {
      if (!Object.keys(decision.apply).length) steps.push({ op: "record-only", external_id: change.external_id, change_kind: change.change_kind });
      continue;
    }
    const signal = decision.signal;
    if (change.signal_priority !== undefined && PRIORITIES.has(change.signal_priority)) signal.priority = maxPriority(signal.priority, change.signal_priority);
    const links = related(change.after ?? change.before ?? records[change.external_id]?.fields ?? {}, change.external_id);
    for (const r of links) {
      signal.priority = maxPriority(signal.priority, r.priority !== undefined && PRIORITIES.has(r.priority) ? r.priority : "normal");
      signal.reasons.push(`related:${r.id}`);
    }
    const aboutDoc = links.length === 1 ? { about_doc: links[0]!.id } : {};

    const summary = withRelated(summarizeChange(change, decision, policy.owned_fields, { phase }), links);
    const line = observationLine(observedAt, change.change_kind, change.content_digest, summary);
    // Dedupe on (feed, external_id, change_kind, content_digest): any Signal whose observation log
    // names that change of that digest. The kind matters: a disappearance carries the digest of the
    // record's last presence, which a `new` Signal may already have logged.
    let duplicate: HeadResult | null = null;
    for (const h of mine) {
      const { doc } = await readDocVersioned(ops.bundle, h.id);
      if (doc.body.includes(` · ${change.change_kind} · ${change.content_digest} · `)) { duplicate = h; break; }
    }
    if (duplicate) {
      steps.push({ op: "signal-duplicate", target: duplicate.id, external_id: change.external_id, content_digest: change.content_digest });
      continue;
    }
    if (open && touchedSignals.has(open.id)) {
      // One CAS write per Signal per run: a second change for the same open Signal is recorded
      // but not logged on the Signal, rather than losing the first write to STALE_VERSION.
      steps.push({ op: "record-only", external_id: change.external_id, change_kind: change.change_kind, collapsed_into: open.id });
      continue;
    }
    if (open) {
      touchedSignals.add(open.id);
      const prevKind = open.frontmatter.change_kind;
      const kind = endedOpen ? prevKind : severity(change.change_kind) >= severity(prevKind) ? change.change_kind : prevKind;
      steps.push({
        op: "collapse-signal", target: open.id, expected_version: open.version, external_id: change.external_id, content_digest: change.content_digest,
        progress_field: progressField, observation_line: line,
        set: { change_kind: kind, priority: maxPriority(open.frontmatter.priority, signal.priority), observed_at: observedAt, diff_summary: summary, title: signalTitle(kind, recTitle, change.external_id), external_id: change.external_id, ...aboutDoc },
      });
      continue;
    }
    // A disappearance reuses the last digest, so its Signal id also names the kind.
    const id = `${signalPrefix}${feedSlug}-${change.change_kind === "disappeared" ? shortHash(policy.feed, change.external_id, change.content_digest, "disappeared") : shortHash(policy.feed, change.external_id, change.content_digest)}`;
    const linkLines: string[] = [];
    if (fromFeed) linkLines.push(linkLine(fromFeed, id, policy.feed));
    if (overlay && about && sameBundle) linkLines.push(linkLine(about, id, overlay.id));
    else if (overlay) linkLines.push(overlayLine(overlay.id));
    for (const r of links) linkLines.push(relatedLine(r.id, r.reason));
    // Record-only feeds have nothing to overlay; the claimant decides what to author from the record.
    const hint = overlay || !policy.target_kind ? undefined : adoptionHint(policy.target_kind, providerOut, change.external_id);
    const frontmatter = {
      type: signalName,
      title: signalTitle(change.change_kind, recTitle, change.external_id),
      [progressField]: "todo",
      change_kind: change.change_kind,
      observed_at: observedAt,
      provider: providerOut,
      external_id: change.external_id,
      diff_summary: summary,
      priority: signal.priority,
      ...aboutDoc,
      // A source entry's title is text on OKF v0.2; a numeric or boolean record title is written as its text.
      sources: [{ resource: providerOut, id: change.external_id, ...(recTitle ? { title: typeof recTitle === "number" || typeof recTitle === "boolean" ? String(recTitle) : recTitle } : {}) }],
    };
    const body = signalBody(linkLines, hint, line);
    steps.push({ op: "create-signal", target: id, external_id: change.external_id, content_digest: change.content_digest, reasons: signal.reasons, candidate: { frontmatter, body } });
  }
  return {
    feed: policy.feed,
    provider: providerOut,
    observed_at: observedAt,
    baseline: observation.baseline,
    replay: observation.replay,
    stats: observation.stats,
    steps,
    refusals,
  };
}

type Related = { id: string; reason: string; priority?: string };

/** Build the correlation lookup once per plan: (fields, externalId) -> related documents. */
async function correlationIndex(contentBundle: Bundle, correlate: CorrelateHook | undefined): Promise<(fields: Record<string, unknown>, externalId: string) => Related[]> {
  if (!correlate || typeof correlate.match !== "function" || typeof correlate.kind !== "string") return () => [];
  const heads = await queryHeads(contentBundle, { type: correlate.kind });
  return (fields, externalId) => {
    const out: Related[] = [];
    for (const h of heads) {
      const m = correlate.match(fields, h.frontmatter, externalId);
      // The reason sits on the related line of a Signal body, so it is kept to one line.
      if (m && m.reason) out.push({ id: h.id, reason: oneLine(String(m.reason).slice(0, 120)), priority: m.priority });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 5);
  };
}

function withRelated(summary: string, links: Related[]): string {
  if (!links.length) return summary;
  const s = `${summary}; related: ${links.map((r) => `${r.id} (${r.reason})`).join(", ")}`;
  return s.length > 600 ? s.slice(0, 599) + "…" : s;
}

function signalTitle(kind: unknown, title: unknown, externalId: string): string {
  const t = `${LABEL[kind as string] ?? kind}: ${title ?? externalId}`;
  return t.length > 140 ? t.slice(0, 139) + "…" : t;
}
