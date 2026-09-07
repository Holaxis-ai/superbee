/**
 * The OKF v0.2 actor convention (SPEC 7). One grammar owns every identity-bearing field
 * (`generated.by`, `verified[].by`, the resolved mutation actor) so trust classification and
 * provenance validation cannot drift apart.
 */

/** OKF v0.2 actor spellings: human/process identities or a producer/version pair. */
export function isOkfActor(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || /\s/.test(value)) {
    return false;
  }
  if (/^(?:human|process):[^\s:]+$/.test(value)) return true;
  return /^[^\s/:]+\/[^\s/]+$/.test(value);
}

/**
 * A person, per the `human:<id>` prefix consumers key trust tiers off (SPEC 5.3, 7).
 *
 * Prefix-only on purpose, unlike {@link isOkfActor}: classification is a READ rule, and a consumer
 * must surface a human signal even when a producer's spelling breaks the rest of the grammar
 * (`human:Jane Doe`) rather than silently downgrade it to machine-confirmed (SPEC 11). The write
 * path enforces the full grammar before any verifier is recorded. Case-sensitive, and the id must
 * be non-empty: `Human:x` and a bare `human:` name nobody.
 */
export function isHumanActor(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("human:") && value.length > "human:".length;
}

/** The three accepted forms, worded once for every help line, refusal, and orientation surface. */
export const OKF_ACTOR_FORMS =
  "human:<id> for a person, process:<id> for an automated job or a role-specific agent session, "
  + "or <producer>/<version> for an agent or tool (e.g. openai/codex, anthropic/claude)";

/** Trim leading/trailing dashes with a linear scan: `/^-+|-+$/` is polynomial on dash-heavy input. */
function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 45) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 45) end -= 1;
  return value.slice(start, end);
}

function slugSegment(value: string): string {
  return trimDashes(value.trim().replace(/[\s:/]+/g, "-"));
}

export interface OkfActorSuggestion {
  /** A conforming spelling derived from the rejected value; the value itself when it conforms. */
  primary: string;
  /** Other conforming readings of the same value, when the kind of actor is ambiguous. */
  alternatives: string[];
  /**
   * True when nothing usable could be derived (empty or punctuation-only input): `primary` and
   * `alternatives` are then the FORMS with `<id>` placeholders, to be shown, never pasted.
   */
  placeholder: boolean;
}

/**
 * Derive a conforming spelling from a rejected actor so a refusal can say what to type instead.
 * Deterministic and kind-preserving where the value already hints at a kind; ambiguous bare names
 * offer both the process and the human reading, because only the caller knows which they are.
 */
export function suggestOkfActor(value: string): OkfActorSuggestion {
  const raw: string = value.trim();
  // A boolean, not the type guard: the guard would narrow `raw` to `never` past this return.
  const conforming: boolean = isOkfActor(raw);
  if (conforming) return { primary: raw, alternatives: [], placeholder: false };
  // `[\s\S]` rather than `.`: an embedded line terminator must not demote a human: prefix to a bare name.
  const prefixed = /^(human|process):([\s\S]*)$/i.exec(raw);
  if (prefixed) {
    const kind = prefixed[1]!.toLowerCase();
    const id = slugSegment(prefixed[2] ?? "");
    if (id) return { primary: `${kind}:${id}`, alternatives: [], placeholder: false };
    return { primary: `${kind}:<id>`, alternatives: [], placeholder: true };
  }
  const segments = raw.split("/").filter((segment) => segment.trim() !== "");
  if (segments.length >= 3) {
    // A producer path with a role qualifier (openai/codex/root): keep the two-segment identity,
    // and offer the role as a process id for callers who need per-session attribution. A segment
    // that slugs to nothing (a/:/b) falls through to the bare-name rule below, so every emitted
    // spelling conforms.
    const producer = slugSegment(segments[0]!);
    const version = slugSegment(segments[1]!);
    const role = slugSegment(segments.slice(1).join("-"));
    if (producer && version) {
      return { primary: `${producer}/${version}`, alternatives: role ? [`process:${role}`] : [], placeholder: false };
    }
  }
  if (segments.length === 2) {
    const producer = slugSegment(segments[0]!);
    const version = slugSegment(segments[1]!);
    if (producer && version) return { primary: `${producer}/${version}`, alternatives: [], placeholder: false };
  }
  const id = slugSegment(raw);
  if (!id) return { primary: "process:<id>", alternatives: ["human:<id>", "<producer>/<version>"], placeholder: true };
  return { primary: `process:${id}`, alternatives: [`human:${id}`], placeholder: false };
}
