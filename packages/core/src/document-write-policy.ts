/** Pure document-shape policies applied before a normalized document reaches storage. */

import { InvalidInputError } from "./errors.js";
import { staleAfterInstant } from "./freshness.js";
import { isOkfActor } from "./okf-actor.js";
import { normalizeDocumentBodyForStorage } from "./frontmatter.js";
import { SUPERBEE_UPDATED_BY_FIELD } from "./mutation-attribution.js";
import type { Frontmatter, OkfDocument } from "./types.js";

type Generated = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export { isOkfActor } from "./okf-actor.js";

/**
 * Normalize one document according to Superbee's OKF v0.1 write contract.
 * The caller supplies one evaluated preserve-or-fallback timestamp decision, keeping this policy
 * deterministic and free of I/O.
 */
export function normalizeV01DocumentForWrite(
  doc: OkfDocument,
  validatedType: string,
  timestamp: { preserveExisting: true; existingTimestamp: string }
    | { preserveExisting: false; fallbackTimestamp: string },
): OkfDocument {
  const normalizedTimestamp = timestamp.preserveExisting
    ? timestamp.existingTimestamp
    : timestamp.fallbackTimestamp;

  // `type` leads and `timestamp` trails, matching OKF sample documents and historical bytes.
  const { type: _type, timestamp: _timestamp, ...rest } = doc.frontmatter;
  const frontmatter: Frontmatter = { type: validatedType, ...rest, timestamp: normalizedTimestamp };
  return { id: doc.id, frontmatter, body: doc.body ?? "" };
}

/**
 * Normalize a v0.2 document without inventing optional provenance or legacy clock fields.
 * Unknown fields and any existing top-level `timestamp` remain byte-semantically preserved.
 */
export function normalizeV02DocumentForWrite(doc: OkfDocument, validatedType: string): OkfDocument {
  const { type: _type, ...rest } = doc.frontmatter;
  return { id: doc.id, frontmatter: { type: validatedType, ...rest }, body: doc.body ?? "" };
}

function generatedRecord(value: unknown, label: string): Generated | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new InvalidInputError(`OKF v0.2 ${label} must be a mapping when present`);
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b || Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length
      && a.every((value, index) => sameValue(value, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => sameValue(a[key], b[key]));
  }
  return false;
}

function withoutV02AutomaticMetadata(
  frontmatter: Frontmatter,
  kindRequiresActor: boolean,
  compareTimestamp: boolean,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...frontmatter };
  delete copy[SUPERBEE_UPDATED_BY_FIELD];
  if (kindRequiresActor) delete copy.actor;
  if (compareTimestamp && typeof copy.timestamp === "string") {
    const instant = Date.parse(copy.timestamp);
    if (!Number.isNaN(instant)) copy.timestamp = new Date(instant).toISOString();
  }
  const generated = copy.generated;
  if (isRecord(generated)) {
    const { at: _at, ...rest } = generated;
    if (Object.keys(rest).length === 0) delete copy.generated;
    else copy.generated = rest;
  }
  return copy;
}

/** Whether content/provenance changed, excluding verification history and the generation clock. */
export function v02MeaningfulContentChanged(
  existing: Pick<OkfDocument, "frontmatter" | "body">,
  candidate: Pick<OkfDocument, "frontmatter" | "body">,
  options: { kindRequiresActor?: boolean; compareTimestamp?: boolean } = {},
): boolean {
  if (
    normalizeDocumentBodyForStorage(existing.body)
    !== normalizeDocumentBodyForStorage(candidate.body)
  ) return true;
  const existingFrontmatter = withoutV02AutomaticMetadata(
    existing.frontmatter,
    options.kindRequiresActor ?? false,
    options.compareTimestamp ?? false,
  );
  const candidateFrontmatter = withoutV02AutomaticMetadata(
    candidate.frontmatter,
    options.kindRequiresActor ?? false,
    options.compareTimestamp ?? false,
  );
  delete existingFrontmatter.verified;
  delete candidateFrontmatter.verified;
  return !sameValue(existingFrontmatter, candidateFrontmatter);
}

export interface V02MutationMetadataOptions {
  existing?: Pick<OkfDocument, "frontmatter" | "body">;
  candidate: { frontmatter: Frontmatter; body: string };
  meaningfulChangeAt: string;
  /** Resolved mutation actor. When present, v0.2 requires the OKF actor convention. */
  actor?: string;
  /** Whether the governing Kind uses legacy `actor` as an automatic attribution projection. */
  kindRequiresActor?: boolean;
  /** Compare explicit legacy timestamp spellings by instant, matching mutation no-op policy. */
  compareTimestamp?: boolean;
  /** Allow an absent generated block to be seeded for a create or meaningful content update. */
  allowGeneratedProvenanceSeed?: boolean;
  /** Seed standard generation metadata when a newly created governed document needs a clock. */
  requireGenerationClock?: boolean;
}

/**
 * Apply v0.2 content provenance without conflating it with storage attribution.
 * `generated` is optional. When present, a create or meaningful content change records the
 * resolved mutation actor; an unattributed engine mutation records `process:superbee`.
 */
export function applyV02MutationMetadata(opts: V02MutationMetadataOptions): {
  frontmatter: Frontmatter;
  body: string;
} {
  if (opts.actor !== undefined && !isOkfActor(opts.actor)) {
    throw new InvalidInputError(
      `OKF v0.2 mutation actor '${opts.actor}' must be human:<id>, process:<id>, or <producer>/<version>`,
    );
  }
  // Imported legacy values remain editable, but authored changes must supply a usable deadline.
  const candidateDeadline = opts.candidate.frontmatter.stale_after;
  if (
    hasOwn(opts.candidate.frontmatter, "stale_after")
    && staleAfterInstant(candidateDeadline) === null
    && !(opts.existing && hasOwn(opts.existing.frontmatter, "stale_after")
      && sameValue(candidateDeadline, opts.existing.frontmatter.stale_after))
  ) {
    throw new InvalidInputError(
      "OKF v0.2 stale_after requires a valid ISO-8601 date and time with a zone (e.g. 2026-09-07T12:00:00Z)",
    );
  }
  const existingGenerated = generatedRecord(opts.existing?.frontmatter.generated, "existing generated");
  const declaredCandidateGenerated = generatedRecord(opts.candidate.frontmatter.generated, "generated");
  let candidateGenerated = !opts.existing
    && opts.allowGeneratedProvenanceSeed !== false
    && (opts.requireGenerationClock || opts.actor !== undefined)
    && !declaredCandidateGenerated
    ? { by: opts.actor ?? "process:superbee" }
    : declaredCandidateGenerated;
  const frontmatter: Frontmatter = candidateGenerated === declaredCandidateGenerated
    ? { ...opts.candidate.frontmatter }
    : { ...opts.candidate.frontmatter, generated: candidateGenerated };
  if (
    opts.existing
    && !hasOwn(frontmatter, "verified")
    && hasOwn(opts.existing.frontmatter, "verified")
  ) {
    frontmatter.verified = opts.existing.frontmatter.verified;
  }
  const candidateHasBy = candidateGenerated ? hasOwn(candidateGenerated, "by") : false;
  const existingBy = existingGenerated?.by;
  const candidateBy = candidateGenerated?.by;

  if (candidateHasBy && candidateBy !== existingBy && !isOkfActor(candidateBy)) {
    throw new InvalidInputError(
      "OKF v0.2 generated.by must be human:<id>, process:<id>, or <producer>/<version>",
    );
  }

  // Compare with the caller's declared/inherited provenance before applying automatic actor
  // metadata. Otherwise an actor-only change would manufacture the "meaningful change" needed to
  // justify itself. A genuinely explicit generated.by edit still counts as meaningful.
  const comparisonBy = candidateHasBy ? candidateBy : existingBy;
  const comparisonGenerated: Generated = {
    ...existingGenerated,
    ...candidateGenerated,
    ...(comparisonBy === undefined ? {} : { by: comparisonBy }),
  };
  const meaningfulChange = opts.existing === undefined || v02MeaningfulContentChanged(opts.existing, {
    ...opts.candidate,
    frontmatter: existingGenerated || candidateGenerated
      ? { ...frontmatter, generated: comparisonGenerated }
      : frontmatter,
  }, {
    kindRequiresActor: opts.kindRequiresActor,
    compareTimestamp: opts.compareTimestamp,
  });
  if (
    !meaningfulChange
    && !existingGenerated
    && candidateGenerated
    && Object.keys(candidateGenerated).every((key) => key === "at")
  ) {
    const { generated: _generated, ...withoutGenerated } = frontmatter;
    return { ...opts.candidate, frontmatter: withoutGenerated };
  }
  if (!existingGenerated && !candidateGenerated) {
    if (
      opts.existing === undefined
      || !meaningfulChange
      || opts.allowGeneratedProvenanceSeed === false
    ) return { ...opts.candidate, frontmatter };
    candidateGenerated = {};
  }
  const preserveDeclaredSourceBy = opts.existing === undefined
    && opts.allowGeneratedProvenanceSeed === false
    && candidateHasBy;
  const resolvedBy = meaningfulChange
    ? preserveDeclaredSourceBy ? candidateBy : opts.actor ?? "process:superbee"
    : comparisonBy;
  if (typeof resolvedBy !== "string" || resolvedBy.trim() === "") {
    throw new InvalidInputError("OKF v0.2 generated.by is required when generated is present");
  }

  const generated: Generated = { ...existingGenerated, ...candidateGenerated, by: resolvedBy };
  if (!opts.existing) {
    if (generated.at === undefined) {
      if (
        opts.requireGenerationClock
        || (declaredCandidateGenerated !== undefined && opts.allowGeneratedProvenanceSeed !== false)
      ) {
        generated.at = opts.meaningfulChangeAt;
      }
    } else if (typeof generated.at !== "string" || Number.isNaN(Date.parse(generated.at))) {
      throw new InvalidInputError("OKF v0.2 generated.at must be an ISO-8601 date/time when present");
    }
  } else if (meaningfulChange) {
    generated.at = opts.meaningfulChangeAt;
  } else if (existingGenerated) {
    if (hasOwn(existingGenerated, "at")) generated.at = existingGenerated.at;
    else delete generated.at;
  }

  return {
    ...opts.candidate,
    frontmatter: { ...frontmatter, generated },
  };
}
