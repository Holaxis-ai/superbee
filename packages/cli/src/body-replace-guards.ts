/**
 * The CLI's body-replace guards, and the truncated-preview identity they key on.
 *
 * Two data-loss guards protect every whole-body replace of an EXISTING document: the
 * truncated-preview guard (a `doc read` body preview written back as though it were the whole
 * body) and the link-drop guard (outbound cross-links silently lost by a full-body replace). Both
 * are enforced by `mutateDoc` (mutate.ts) on every attempt's candidate whose body differs from the
 * version-matched stored body — see {@link guardBodyReplace}. A verb never calls a guard itself; it
 * declares its posture through `MutateDocOptions.bodyReplace` (its own `--accept-truncated-body` /
 * `--replace-links` opt-outs). That is why this module sits beside mutate.ts rather than inside a
 * command: the guards are mutation policy, not verb presentation, and a body-replace surface that
 * forgets them is exactly the shape that let `promote` ship without the link-drop guard.
 *
 * The preview EMITTER ({@link attachBodyPreview}) lives here too, next to the signature that
 * recognizes its notice, so the two cannot drift apart silently.
 */
import { parseLinks, type Bundle, type Link, type OkfDocument } from "@superbee/core";
import { CliError } from "./errors.js";
import { cliInvocation } from "./invocation.js";
import { commandToken } from "./command-text.js";

/** AXI §3 body-preview cap for `doc read` (no --out): beyond this, truncate + point at the byte channel. */
export const BODY_PREVIEW_LIMIT = 1000;

/**
 * The token every TRUNCATED body preview carries INSIDE its own value (see {@link attachBodyPreview}).
 * Fixed and interpolation-free so a reader can grep for it. It is NOT by itself the guard's
 * identity — see {@link BODY_PREVIEW_TRUNCATION_SIGNATURE}.
 */
export const BODY_PREVIEW_TRUNCATION_MARKER = "[superbee:body-preview-truncated]";

/**
 * The machine-generated truncation notice — the ONE emitter
 * {@link BODY_PREVIEW_TRUNCATION_SIGNATURE} must agree with. Kept as a named function so the
 * emitted sentence and the pattern that recognizes it cannot drift apart silently; `doc.test.ts`
 * proves the agreement executably rather than leaving it to this comment.
 */
function previewTruncationNotice(omitted: number): string {
  return `${BODY_PREVIEW_TRUNCATION_MARKER} ${omitted} more character(s) are NOT shown`;
}

/**
 * The TRAVEL identity of a truncated preview: the exact notice {@link previewTruncationNotice}
 * generates, never the bare {@link BODY_PREVIEW_TRUNCATION_MARKER} token.
 *
 * Matching the token alone would refuse any document that merely QUOTES it — prose explaining this
 * guard, a pasted help transcript, the project records describing the feature — and such a document
 * has no way out: the refusal's advertised read/edit/write-back recovery reproduces the same token
 * every time, so the caller loops until they reach for `--accept-truncated-body`, which is exactly
 * the reflex an override must never teach. The generated count and the `are NOT shown` clause
 * cannot appear together by accident in prose that discusses the marker, so the notice is the
 * narrowest identity that still travels everywhere a preview does (inline `--body`, stdin,
 * `--body-file`, a TOON scrape, another document's preview).
 *
 * Deliberately NOT end-anchored: an agent may append its own text after a pasted preview, and that
 * is still a preview being written as a body.
 *
 * TOLERANT of three specific drifts, and no more: elastic whitespace runs (`\s+`, which spans an
 * inserted newline), an optional plural parenthetical, and case. Those cover `character(s)` →
 * `characters`, `NOT` → `not`, and a line break at a space — three shapes that each escaped a
 * literal match and lost ~4 KB in probes.
 *
 * That is a SAMPLE of edits a caller may make to the sentence, not a closure over them. The class is
 * open-ended and other members are at least as likely: markdown-bolding or backticking the bracketed
 * token, a thousands separator in the count, spelling the count in words, dropping `more`. None of
 * those match, and each is a one-edit escape (see {@link guardTruncatedBodyPreview}'s residual
 * paragraph for the exact condition). Widening further trades directly against the false positive
 * this pattern exists to avoid, so the three landmarks stay REQUIRED — the bracket token, a digit
 * count, and the `more … are NOT shown` tail — which is what keeps prose that merely quotes the
 * token, having neither a count nor a tail, freely editable.
 *
 * Read this as an accident-prevention device, not a barrier: it stops a preview from being written
 * back unchanged, which is the failure that actually happened. Clause 2 of the guard, the
 * stored-prefix check, is the same-document backstop for a preview whose notice was removed
 * entirely.
 */
export const BODY_PREVIEW_TRUNCATION_SIGNATURE =
  /\[superbee:body-preview-truncated\]\s+\d+\s+more\s+characters?\(?s?\)?\s+are\s+NOT\s+shown/i;

/** The record key a TRUNCATED preview is published under — deliberately not `body`. */
export const BODY_PREVIEW_KEY = "body_preview";

/**
 * Every output key {@link attachBodyPreview} may write. Renders that also dump arbitrary frontmatter
 * spread this into their own reserved-key set, so a pathological frontmatter key can never clobber a
 * preview field AND a future preview key propagates to both renders without a second edit.
 */
export const BODY_PREVIEW_RESERVED_KEYS: readonly string[] = [
  "body",
  BODY_PREVIEW_KEY,
  "body_truncated",
  "body_chars",
  "help",
];

/**
 * THE one truncation identity for every render with `doc read` body semantics (`doc read`, `sync
 * --show-incoming`). A body within {@link BODY_PREVIEW_LIMIT} is published unchanged as `body`, so
 * the compact read is untouched. A body PAST the bound is published under
 * {@link BODY_PREVIEW_KEY} — not `body` — alongside `body_truncated`, the TRUE `body_chars`, a help
 * pointer at the complete-body channel, and {@link BODY_PREVIEW_TRUNCATION_MARKER} appended to the
 * value itself.
 *
 * Both the key name and the in-value marker are load-bearing, not decoration. A field called `body`
 * that holds 1,000 of 4,300 characters reads as the whole body and invites exactly one mistake:
 * feeding it back into a full-body write (AXI-05 — truncated data must be named, never masquerade as
 * complete truth). The notice then makes the value self-identifying as long as it travels intact,
 * which is what lets {@link guardTruncatedBodyPreview} refuse a preview captured from another
 * document or from a previous session, where no prefix comparison could. A caller who reshapes the
 * notice defeats that clause — see {@link BODY_PREVIEW_TRUNCATION_SIGNATURE} for how far the match
 * bends and {@link guardTruncatedBodyPreview} for the exact residual.
 */
export function attachBodyPreview(
  rec: Record<string, unknown>,
  body: string,
  fullBodyHelp: readonly string[],
): void {
  if (body.length <= BODY_PREVIEW_LIMIT) {
    rec.body = body;
    return;
  }
  const omitted = body.length - BODY_PREVIEW_LIMIT;
  rec[BODY_PREVIEW_KEY] =
    `${body.slice(0, BODY_PREVIEW_LIMIT)}\n\n${previewTruncationNotice(omitted)} — this value is a ` +
    `preview, not the document body; use this record's help to read the complete body before ` +
    `rewriting it.`;
  rec.body_truncated = true;
  rec.body_chars = body.length;
  rec.help = [...fullBodyHelp];
}

/**
 * True when `candidate` IS `preview`, ignoring TRAILING WHITESPACE only — a preview copied through a
 * file or an editor routinely gains or loses a final newline. Whitespace is the entire tolerance:
 * anything looser (a prefix test, a length test) would start matching a legitimate tail deletion,
 * which is an ordinary intentional edit. A whitespace-only preview never matches, so a deliberate
 * blank body cannot be mistaken for one.
 */
function matchesPreviewSlice(candidate: string, preview: string): boolean {
  if (candidate === preview) return true;
  const trimmed = preview.trimEnd();
  return trimmed !== "" && candidate.trimEnd() === trimmed;
}

/**
 * The first generated notice in `nextBody` that clause 1 of {@link guardTruncatedBodyPreview} must
 * treat as a paste, if any. EVERY occurrence is checked, not just the first, so a foreign preview
 * appended after a legitimately stored notice is still recognized. A notice is excused only when
 * BOTH hold: the candidate CONTAINS the whole stored body, trailing whitespace aside — an append, a
 * prepend, or a wrap, so nothing stored can be lost — AND the stored body already carries that exact
 * sentence. On any other candidate every notice counts, which is the pre-excusal behavior.
 */
function firstForeignNotice(storedBody: string, nextBody: string): string | undefined {
  const preservesStoredBody = nextBody.includes(storedBody.trimEnd());
  const every = new RegExp(BODY_PREVIEW_TRUNCATION_SIGNATURE.source, `${BODY_PREVIEW_TRUNCATION_SIGNATURE.flags}g`);
  for (const match of nextBody.matchAll(every)) {
    if (!(preservesStoredBody && storedBody.includes(match[0]))) return match[0];
  }
  return undefined;
}

/**
 * Truncated-preview guard (P1, data loss): a `doc read` detail render deliberately shows only the
 * first {@link BODY_PREVIEW_LIMIT} characters of a large body, and a caller that feeds that preview
 * straight back into a full-body replace DESTROYS everything past the cut with exit 0 and no trace.
 * (Live incident: a 4.3 KB documentation page rewritten as its own 1,000-character preview.)
 *
 * The guard keys on the two identities {@link attachBodyPreview} actually produces — never on a
 * heuristic about body size or shape, so a legitimately short replacement body cannot trip it:
 *
 *  1. NOTICE — the candidate still carries {@link BODY_PREVIEW_TRUNCATION_SIGNATURE}, the whole
 *     generated truncation sentence rather than its bare token (see that constant for why the token
 *     alone would body-lock any document that merely writes ABOUT this feature). It is the only
 *     identity that survives travel: it catches a preview reused across documents, or captured
 *     before the target changed.
 *  2. STORED PREFIX — the target's own stored body is past the bound and the candidate is exactly
 *     its preview slice (see {@link matchesPreviewSlice}). Matching means the write truncates the
 *     document to precisely the preview cut; nothing else produces that body. This clause still
 *     fires for a preview captured before this marker existed, or hand-copied without it.
 *
 * A candidate identical to the stored body returns early: it changes nothing, so it is never data
 * loss — and that also keeps a document whose stored body legitimately contains the marker (written
 * once with the override) patchable by every later field-only update.
 *
 * Clause 1 excuses exactly one shape: a candidate that CONTAINS the whole stored body (trailing
 * whitespace aside) — an append, a prepend, or a wrap. Nothing stored can be lost by such a write, so
 * a notice the stored body already carries verbatim is that notice travelling along, not a new
 * paste — see {@link firstForeignNotice}. The guarantee is therefore "no stored byte is lost", not
 * "no preview is ever persisted": a foreign preview appended to such a document is permitted.
 * That is what keeps a document written once with the override (its stored body legitimately holds
 * the generated sentence) open to `link add`, which has no override flag of its own. A candidate that
 * drops or rewrites any stored byte gets no such excuse: every notice it carries is treated as a
 * paste, exactly as before the excusal existed, so a foreign preview can never replace a document
 * merely because its omitted count happens to match a sentence quoted in the stored prose.
 *
 * RESIDUAL, stated exactly. A candidate escapes both clauses iff (a) it carries no tolerant-signature
 * notice that clause 1 treats as a paste — i.e. no notice at all, or only stored notices on an
 * append — AND (b) it is not byte-identical, trailing whitespace aside, to the target's stored
 * preview slice. Nothing further is required. In particular an untolerated perturbation of the
 * notice is sufficient ON ITS OWN, with the preview head left completely untouched: a pasted preview
 * carries notice text, so it is never byte-equal to the stored slice, and clause 2 therefore cannot
 * cover what clause 1 misses. QA demonstrated seven such single-edit escapes — a thousands separator
 * in the count, markdown-bolding or backticking the token, bolding `NOT`, spelling the count in
 * words, dropping `more`, re-punctuating — each destroying ~3 KB at exit 0. This guard prevents the
 * ACCIDENT it was built for; it is not a barrier against a caller who reshapes the notice.
 *
 * Enforced by `mutateDoc` inside every compare-and-swap attempt (see {@link guardBodyReplace}) so,
 * like the link-drop guard, it evaluates against the version-matched snapshot rather than a stale
 * upfront peek. `--accept-truncated-body` opts into the write deliberately.
 */
export function guardTruncatedBodyPreview(
  existing: OkfDocument,
  nextBody: string,
  acceptTruncatedBody: boolean,
): void {
  if (acceptTruncatedBody) return;
  if (nextBody === existing.body) return;

  const inv = cliInvocation();
  const help = `${inv} doc read ${commandToken(existing.id)} --body-out <path-outside-bundle>`;
  const recovery =
    `Read the COMPLETE body first — '${help} --json' (its receipt carries the version), edit that ` +
    `file, then '${inv} doc update ${commandToken(existing.id)} --body-file <path-outside-bundle> ` +
    `--expected-version <version>'. Pass --accept-truncated-body to write this body deliberately.`;

  const notice = firstForeignNotice(existing.body, nextBody);
  if (notice !== undefined) {
    throw new CliError(
      "USAGE",
      `the body given for '${existing.id}' still carries Superbee's generated truncation notice ` +
        `('${notice}') — it is a PREVIEW of a document body, not a complete body, so writing it ` +
        `would persist a truncated document. ${recovery}`,
      {
        help,
        details: { reason: "preview_marker", marker: BODY_PREVIEW_TRUNCATION_MARKER, notice },
      },
    );
  }

  if (existing.body.length <= BODY_PREVIEW_LIMIT) return;
  if (!matchesPreviewSlice(nextBody, existing.body.slice(0, BODY_PREVIEW_LIMIT))) return;
  const omitted = existing.body.length - BODY_PREVIEW_LIMIT;
  throw new CliError(
    "USAGE",
    `the body given for '${existing.id}' is exactly the TRUNCATED ${BODY_PREVIEW_LIMIT}-character ` +
      `preview 'doc read' shows for this document — writing it would DESTROY the ${omitted} ` +
      `character(s) beyond the cut, leaving ${BODY_PREVIEW_LIMIT} of its ${existing.body.length}-` +
      `character body. ${recovery}`,
    {
      help,
      details: {
        reason: "stored_body_preview",
        preview_limit: BODY_PREVIEW_LIMIT,
        supplied_body_chars: nextBody.length,
        stored_body_chars: existing.body.length,
      },
    },
  );
}

/**
 * Occurrence-aware drop detection: core deliberately allows multiple links from the
 * same source to the SAME target with DIFFERENT text — link text is the only relationship-type signal
 * OKF's untyped edges carry (see `backlinks`/`link show --text`), so `[supports](b.md)` and
 * `[contradicts](b.md)` in one doc are two distinct, independently meaningful edges, not duplicates. A
 * plain "is target `b` still linked ANYWHERE in the new body" check (a bare `some()` over target) would
 * therefore miss a drop when one of several same-target occurrences disappears but at least one
 * survives — old `[supports](b)`+`[contradicts](b)`, new `[supports](b)` alone silently loses
 * `contradicts` under a target-only check.
 *
 * Matches per target in two passes so a RETEXT (same target, new text — the destination survives) never
 * fires while a genuine occurrence loss always does: (1) EXACT (target,text) pairs are consumed first
 * — an old occurrence whose exact text still appears is kept, unambiguously; (2) any old occurrence
 * left over pairs with any UNCONSUMED same-target new occurrence, regardless of text (a retext); (3)
 * an old occurrence still unpaired after both passes is a genuine drop. This degrades to simple
 * target-presence for the single-occurrence-per-target case (the common one) and additionally catches
 * the multi-occurrence case a bare `some()` missed.
 */
function computeDroppedLinks(existingLinks: Link[], nextLinks: Link[]): Link[] {
  const nextByTarget = new Map<string, Link[]>();
  for (const l of nextLinks) {
    const bucket = nextByTarget.get(l.to);
    if (bucket) bucket.push(l);
    else nextByTarget.set(l.to, [l]);
  }
  const existingByTarget = new Map<string, Link[]>();
  for (const l of existingLinks) {
    const bucket = existingByTarget.get(l.to);
    if (bucket) bucket.push(l);
    else existingByTarget.set(l.to, [l]);
  }

  const dropped: Link[] = [];
  for (const [target, oldOccurrences] of existingByTarget) {
    const available = [...(nextByTarget.get(target) ?? [])]; // mutable, consumed as occurrences pair off
    const unmatchedExact: Link[] = [];

    // Pass 1: exact (target,text) — consume one matching new occurrence per old occurrence.
    for (const old of oldOccurrences) {
      const idx = available.findIndex((n) => n.text === old.text);
      if (idx >= 0) available.splice(idx, 1);
      else unmatchedExact.push(old);
    }
    // Pass 2: retext — any leftover old occurrence pairs with any leftover same-target occurrence,
    // regardless of text; anything still left over after that is a real drop.
    for (const old of unmatchedExact) {
      if (available.length > 0) available.shift();
      else dropped.push(old);
    }
  }
  return dropped;
}

/**
 * The outbound links `existing` carries that replacing its body with `nextBody` would drop —
 * occurrence-aware, see {@link computeDroppedLinks}. The link-drop guard refuses on a non-empty
 * result; a verb that has DECLARED the drop (`replaceLinks`) uses it to disclose what went on its
 * receipt, so a permitted drop is never a silent one.
 */
export function droppedLinks(bundle: Bundle, existing: OkfDocument, nextBody: string): Link[] {
  const existingLinks = parseLinks(bundle, existing);
  if (existingLinks.length === 0) return []; // nothing to lose
  return computeDroppedLinks(existingLinks, parseLinks(bundle, { ...existing, body: nextBody }));
}

/**
 * Data-loss guard (SHORT-TERM — see `roadmap-items/link-model-body-safe` for the proper
 * preserve-by-default fix this is standing in for): OKF cross-links are markdown links stored IN a
 * doc's body, so a `--body`/`--body-file` FULL-BODY REPLACE (`doc write`/`doc update`) silently drops
 * every outbound link the old body carried unless the new body happens to repeat it — the product's
 * signature graph feature, lost with no error and no trace. Fires ONLY on REAL loss: an existing link
 * survives (no refusal) when `nextBody` still contains a link to the SAME resolved target with ONE
 * FEWER OR EQUAL occurrences dropped — see `computeDroppedLinks`'s own comment for the exact
 * occurrence-aware matching. This guard deliberately protects destination presence, not typed-edge
 * identity: a RETEXT is explicit content in the replacement body, so it is not a silent drop. The
 * occurrence-aware check still catches a same-target partial drop that a bare target-only `some()`
 * would miss. Over-firing on relabeling would
 * train agents to reflexively pass `--replace-links`, which hollows the guard for the drop case that
 * actually matters. `replaceLinks` (the caller's `--replace-links` flag)
 * opts into a real drop deliberately — no separate `link remove` needed, since a full-body replace
 * already performs removal.
 *
 * Enforced by `mutateDoc` inside every compare-and-swap attempt (see {@link guardBodyReplace}), so
 * a concurrent writer landing between the read this guard evaluates and the eventual write can
 * never be silently clobbered — a refusal here always leaves the stored doc byte-for-byte unchanged,
 * and a retry after a conflict re-evaluates against the doc's CURRENT state, not a stale snapshot.
 */
export function guardDroppedLinks(
  bundle: Bundle,
  existing: OkfDocument,
  nextBody: string,
  replaceLinks: boolean,
): void {
  if (replaceLinks) return;
  const dropped = droppedLinks(bundle, existing, nextBody);
  if (dropped.length === 0) return;
  const named = dropped.map((l) => `'${l.text}' -> ${l.to}`).join(", ");
  throw new CliError(
    "USAGE",
    `this body replace would silently drop ${dropped.length} outbound link(s) from '${existing.id}': ${named}. ` +
      `OKF cross-links live in the document body, so a full-body replace removes any link the new body ` +
      `doesn't repeat. Pass --replace-links to drop them deliberately, or keep them by including the same ` +
      `markdown link(s) in the new body, or re-add them afterward with ` +
      `'${cliInvocation()} link add ${commandToken(existing.id)} <to>'.`,
    {
      help: `${cliInvocation()} link add ${commandToken(existing.id)} <to>`,
      details: { dropped_links: dropped.map((l) => ({ to: l.to, text: l.text })) },
    },
  );
}


/**
 * A caller's declared posture for a body replace — the verb's own opt-outs. Absent means both
 * guards are enforced; `mutateDoc` applies {@link guardBodyReplace} with it on every attempt.
 */
export interface BodyReplacePosture {
  /** The verb's `--accept-truncated-body`: write a `doc read` preview as the whole body deliberately. */
  acceptTruncatedBody?: boolean;
  /** The verb's `--replace-links`: drop outbound cross-links the stored body carried deliberately. */
  replaceLinks?: boolean;
}

/**
 * THE one body-replace check: both guards, in the one order that matters. The preview guard runs
 * FIRST because a preview body also drops links — diagnosing it as a link problem would send the
 * caller to --replace-links, authorizing the truncation instead. That ordering only helps WHEN THE
 * PREVIEW GUARD FIRES: a near-preview body matching neither of its identities (say, the preview
 * slice plus one character) is still only the link guard's concern, and --replace-links authorizes
 * its drop exactly as it always has.
 *
 * A candidate whose body equals the stored body is not a replace and returns before either guard,
 * so a field-only patch, an idempotent re-run, or a frontmatter-only verb never trips one.
 */
export function guardBodyReplace(
  bundle: Bundle,
  existing: OkfDocument,
  nextBody: string,
  posture: BodyReplacePosture | undefined,
): void {
  if (nextBody === existing.body) return;
  guardTruncatedBodyPreview(existing, nextBody, Boolean(posture?.acceptTruncatedBody));
  guardDroppedLinks(bundle, existing, nextBody, Boolean(posture?.replaceLinks));
}
