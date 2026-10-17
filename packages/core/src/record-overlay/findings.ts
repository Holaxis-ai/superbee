/**
 * Assessment findings as Signal steps. A caller compares the current state of records with
 * documents and returns findings: conditions that need a person's judgment, not record changes.
 * They become the same create, collapse and duplicate steps as change Signals, so
 * `applyRecordOverlay` writes them under the same guards.
 *
 * A finding's `facts` with its `key` are its digest: the same finding on a later run is
 * `signal-duplicate`, also after the Signal was closed, so a dismissed finding stays dismissed
 * until its facts change. A Signal whose `expires_at` has passed no longer counts, so a still-true
 * finding is raised again after expiry. An open, unclaimed Signal with the same provider and
 * `external_id` (default: the key) whose facts changed is updated in place, never duplicated.
 */
import { queryHeads } from "../bundle-ops.js";
import { overlayCanonicalJson } from "./canonical.js";
import { sha256, shortHash } from "./digest.js";
import { OverlayRefusal, REFUSAL_CODES } from "./errors.js";
import { maxPriority } from "./policy.js";
import { redactUrl } from "./redact.js";
import { isConceptId, linkLine, observationLine, relatedLine, signalBody, signalLinkTexts } from "./signal-text.js";
import { resolveAttentionKind } from "./signal-kind.js";
import type { Finding, FindingsInput, OverlayStep } from "./types.js";

export const FINDING_CHANGE_KIND = "status-check";
const PRIORITIES = new Set(["low", "normal", "urgent"]);
const clip = (s: unknown, n: number): string => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

export function findingDigest(f: Pick<Finding, "key" | "facts">): string {
  return sha256(overlayCanonicalJson({ key: f.key, facts: f.facts ?? {} })!);
}

export async function planFindings({ ops, provider, feed, slug, findings, observedAt, signals }: FindingsInput): Promise<OverlayStep[]> {
  const steps: OverlayStep[] = [];
  const attention = resolveAttentionKind(ops.registry, ops.okfVersion, signals?.kind ?? "Signal", undefined);
  if (!attention.ok) throw new OverlayRefusal(REFUSAL_CODES.POLICY_INVALID, attention.reason, {});
  const { name: signalName, kind: signalKind, prefix, stateField: progressField, ownerField } = attention.value;
  const { fromFeed } = signalLinkTexts(signalKind, undefined, signals?.feedKind ?? "Source Feed");
  const providerOut = redactUrl(provider);
  const mine = (await queryHeads(ops.bundle, { type: signalName })).filter((h) => h.frontmatter.provider === providerOut);
  const live = (h: { frontmatter: Record<string, unknown> }): boolean => !(typeof h.frontmatter.expires_at === "string" && h.frontmatter.expires_at <= observedAt);
  const touched = new Set<string>();
  const seenKeys = new Set<string>();
  for (const f of findings ?? []) {
    if (!f || typeof f.key !== "string" || !f.key || seenKeys.has(f.key)) continue;
    seenKeys.add(f.key);
    const digest = findingDigest(f);
    const externalId = f.external_id ?? f.key;
    const priority = f.priority !== undefined && PRIORITIES.has(f.priority) ? f.priority : "normal";
    const summary = clip(f.summary ?? f.title, 600);
    const line = observationLine(observedAt, f.change_kind ?? FINDING_CHANGE_KIND, digest, summary);
    const dup = mine.find((h) => h.frontmatter.content_digest === digest && live(h));
    if (dup) { steps.push({ op: "signal-duplicate", target: dup.id, external_id: externalId, content_digest: digest, finding: f.key }); continue; }
    const open = mine.find((h) => h.frontmatter.external_id === externalId && h.frontmatter[progressField] === "todo" && !h.frontmatter[ownerField] && live(h));
    const set = {
      title: clip(f.title, 140), change_kind: f.change_kind ?? FINDING_CHANGE_KIND, observed_at: observedAt, diff_summary: summary,
      content_digest: digest, external_id: externalId, ...(f.about_doc ? { about_doc: f.about_doc } : {}), ...(f.expires_at ? { expires_at: f.expires_at } : {}),
    };
    if (open && !touched.has(open.id)) {
      touched.add(open.id);
      steps.push({ op: "collapse-signal", target: open.id, expected_version: open.version, external_id: externalId, content_digest: digest, finding: f.key,
        progress_field: progressField, observation_line: line, set: { ...set, priority: maxPriority(open.frontmatter.priority ?? "low", priority) } });
      continue;
    }
    // An expiring finding raised again after expiry is a new Signal, so its id names the expiry too.
    const id = `${prefix}${slug}-${f.expires_at ? shortHash(slug, f.key, digest, f.expires_at) : shortHash(slug, f.key, digest)}`;
    const linkLines: string[] = [];
    if (fromFeed && feed) linkLines.push(linkLine(fromFeed, id, feed));
    // Related documents are linked by id; a value that is not a document id has no line.
    for (const r of [...new Set([f.about_doc, ...(f.related ?? [])].filter(isConceptId))]) linkLines.push(relatedLine(r));
    const frontmatter = {
      type: signalName, title: set.title, [progressField]: "todo", change_kind: set.change_kind, observed_at: observedAt,
      provider: providerOut, external_id: externalId, diff_summary: summary, priority, content_digest: digest,
      ...(f.about_doc ? { about_doc: f.about_doc } : {}), ...(f.expires_at ? { expires_at: f.expires_at } : {}),
      sources: (f.sources?.length ? f.sources : [{ resource: providerOut }]).map((s) => ({ ...s, resource: redactUrl(s.resource) })),
    };
    steps.push({ op: "create-signal", target: id, external_id: externalId, content_digest: digest, finding: f.key, reasons: ["finding"],
      candidate: { frontmatter, body: signalBody(linkLines, undefined, line) } });
  }
  return steps;
}
