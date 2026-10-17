/**
 * The text of a Signal: its observation line and its body. One rendering for the planner, which
 * writes it, and for the apply's Signal guards, which accept a Signal's text only when it is what
 * this rendering produces from the Signal's own fields and the run, so every honest plan passes and
 * free text does not.
 */
import type { KindConvention } from "../kinds.js";
import { relativeHref } from "../links.js";
import { assertSafeConceptId } from "../paths.js";

const LINE_BREAKS = /\r\n|[\r\n\u0085\u2028\u2029]/g;
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;
const OVERLAY_PREFIX = "Overlay document (content bundle): `";
const RELATED_PREFIX = "Related document (content bundle): `";

/** Text kept on one line: every line break becomes a space. */
export function oneLine(text: string): string {
  return text.replace(LINE_BREAKS, " ");
}

export function isConceptId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { assertSafeConceptId(value); return true; } catch { return false; }
}

/** The attention Kind's link vocabulary, derived from its convention, never hard-coded. */
export function signalLinkTexts(signalKind: KindConvention | undefined, targetKind: string | undefined, feedKind = "Source Feed"): { fromFeed?: string; about?: string } {
  const links = signalKind?.links ?? {};
  const fromFeed = Object.keys(links).find((t) => links[t] === feedKind);
  const about = targetKind ? Object.keys(links).find((t) => links[t] === targetKind) : undefined;
  return { fromFeed, about };
}

export function observationLine(observedAt: unknown, changeKind: unknown, digest: unknown, summary: unknown): string {
  return `- ${observedAt} · ${changeKind} · ${digest} · ${summary}`;
}

export const linkLine = (text: string, fromId: string, targetId: string): string => `[${text}](${relativeHref(fromId, targetId)})`;
export const overlayLine = (id: string): string => `${OVERLAY_PREFIX}${id}\``;
export const relatedLine = (id: string, reason?: string): string => `${RELATED_PREFIX}${id}\`${reason === undefined ? "" : ` (${reason})`}`;
export const adoptionHint = (targetKind: unknown, provider: unknown, externalId: unknown): string =>
  `To overlay this record, give a document of Kind "${targetKind}" the source entry \`resource: ${provider}\`, \`id: ${externalId}\`.`;

export function signalBody(links: readonly string[], hint: string | undefined, line: string): string {
  return `${links.join("\n")}\n${hint === undefined ? "" : `\n${hint}\n`}\n# Observations\n\n${line}\n`;
}

/** The concept id a relative link from `fromId` names, or null. */
function linkTarget(fromId: string, href: string): string | null {
  const slash = fromId.lastIndexOf("/");
  const parts = slash >= 0 ? fromId.slice(0, slash).split("/") : [];
  for (const segment of href.split("/")) {
    if (segment === "..") { if (parts.length === 0) return null; parts.pop(); }
    else if (segment === "" || segment === ".") return null;
    else parts.push(segment);
  }
  const path = parts.join("/");
  return path.endsWith(".md") ? path.slice(0, -3) : null;
}

export interface SignalTextContext {
  /** The Signal's id. */
  target: string;
  /** The feed its plan was made for, when the plan names one. */
  feed: string | null | undefined;
  /** The run's target Kind, for the adoption hint and the typed overlay link. */
  targetKind: string | undefined;
  links: { fromFeed?: string; about?: string };
}

function plannedLink(text: string, context: SignalTextContext): boolean {
  const { target, feed, links } = context;
  if (links.fromFeed !== undefined && isConceptId(feed) && isConceptId(target) && text === linkLine(links.fromFeed, target, feed)) return true;
  if (links.about !== undefined && text.startsWith(`[${links.about}](`) && text.endsWith(")")) {
    const id = linkTarget(target, text.slice(links.about.length + 3, -1));
    if (isConceptId(id) && isConceptId(target) && text === linkLine(links.about, target, id)) return true;
  }
  if (text.startsWith(OVERLAY_PREFIX) && text.endsWith("`") && isConceptId(text.slice(OVERLAY_PREFIX.length, -1))) return true;
  if (text.startsWith(RELATED_PREFIX)) {
    const rest = text.slice(RELATED_PREFIX.length);
    if (rest.endsWith("`") && isConceptId(rest.slice(0, -1))) return true;
    if (rest.endsWith(")")) {
      for (let at = rest.indexOf("` ("); at > 0; at = rest.indexOf("` (", at + 1)) {
        const reason = rest.slice(at + 3, -1);
        if (isConceptId(rest.slice(0, at)) && reason.length <= 120 && !LINE_BREAK.test(reason)) return true;
      }
    }
  }
  return false;
}

/**
 * A created Signal's body is the planner's: its link lines, the adoption hint for this record when
 * present, and the observation line rendered from the Signal's own `observed_at`, `change_kind`,
 * `diff_summary` and the step's digest.
 */
export function isPlannedSignalBody(
  body: string,
  frontmatter: Record<string, unknown>,
  digest: string,
  context: SignalTextContext,
): boolean {
  const suffix = `# Observations\n\n${observationLine(frontmatter.observed_at, frontmatter.change_kind, digest, frontmatter.diff_summary)}\n`;
  if (!body.endsWith(suffix)) return false;
  const preamble = body.slice(0, -suffix.length);
  const hint = context.targetKind === undefined ? undefined : adoptionHint(context.targetKind, frontmatter.provider, frontmatter.external_id);
  let links: string;
  if (hint !== undefined && preamble.endsWith(`\n\n${hint}\n\n`)) links = preamble.slice(0, preamble.length - hint.length - 4);
  else if (preamble.endsWith("\n\n")) links = preamble.slice(0, -2);
  else return false;
  return links === "" || links.split("\n").every((text) => plannedLink(text, context));
}

/**
 * A collapse's observation line is the planner's: rendered from the update's own `observed_at`,
 * `diff_summary` and the step's digest, around the change kind it records.
 */
export function isPlannedObservation(line: string, set: Record<string, unknown>, digest: string): boolean {
  if (typeof set.observed_at !== "string" || typeof set.diff_summary !== "string") return false;
  const prefix = `- ${set.observed_at} · `;
  const suffix = ` · ${digest} · ${set.diff_summary}`;
  if (line.length <= prefix.length + suffix.length || !line.startsWith(prefix) || !line.endsWith(suffix)) return false;
  const kind = line.slice(prefix.length, line.length - suffix.length);
  return kind === set.change_kind || !LINE_BREAK.test(kind);
}
