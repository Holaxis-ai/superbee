/** Pure document-shape policies applied before a normalized document reaches storage. */

import { OkfActorError } from "./errors.js";
import { isOkfRecord as isRecord, okfValuesEqual as sameValue } from "./okf-authored-values.js";
import { assertAuthoredOkfStandardFields } from "./okf-standard-fields.js";
import { assertAuthoredOkfTimestamps } from "./okf-timestamps.js";
import { isOkfActor } from "./okf-actor.js";
import { normalizeDocumentBodyForStorage } from "./frontmatter.js";
import { SUPERBEE_UPDATED_BY_FIELD } from "./mutation-attribution.js";
import type { Frontmatter, OkfDocument } from "./types.js";

type Generated = Record<string, unknown>;

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
  /** Advisory mutation actor; also the content producer when producer is omitted. */
  actor?: string;
  /** Explicit content producer for generated.by. Defaults to actor when omitted;
   * when supplied, actor remains advisory and need not use OKF producer syntax. */
  producer?: string;
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
 * explicit producer or resolved mutation actor; an unattributed engine mutation records `process:superbee`.
 */
export function applyV02MutationMetadata(opts: V02MutationMetadataOptions): {
  frontmatter: Frontmatter;
  body: string;
} {
  assertAuthoredOkfStandardFields(opts.candidate.frontmatter, opts.existing?.frontmatter, { phase: "input" });
  const result = applyMetadata(opts);
  assertAuthoredOkfStandardFields(result.frontmatter, opts.existing?.frontmatter);
  return result;
}

function applyMetadata(opts: V02MutationMetadataOptions): {
  frontmatter: Frontmatter;
  body: string;
} {
  const producer = opts.producer !== undefined ? opts.producer : opts.actor;
  if (producer !== undefined && !isOkfActor(producer)) {
    throw new OkfActorError(
      producer,
      `OKF v0.2 mutation ${opts.producer !== undefined ? "producer" : "actor"} '${producer}' must be human:<id>, process:<id>, or <producer>/<version>`,
    );
  }
  const existingValue = opts.existing?.frontmatter.generated;
  const candidateValue = opts.candidate.frontmatter.generated;
  const existingGenerated = isRecord(existingValue) ? existingValue : undefined;
  const declaredCandidateGenerated = isRecord(candidateValue) ? candidateValue : undefined;
  // Invalid imported containers are opaque. Prevalidation already refused newly invalid input;
  // preserving or removing an old container must never spread it or manufacture its replacement.
  if ((hasOwn(opts.candidate.frontmatter, "generated") && !declaredCandidateGenerated)
    || (opts.existing && hasOwn(opts.existing.frontmatter, "generated") && !existingGenerated
      && !hasOwn(opts.candidate.frontmatter, "generated"))) {
    const frontmatter = { ...opts.candidate.frontmatter };
    if (!hasOwn(frontmatter, "verified") && opts.existing && hasOwn(opts.existing.frontmatter, "verified")) {
      frontmatter.verified = opts.existing.frontmatter.verified;
    }
    return { ...opts.candidate, frontmatter };
  }
  let candidateGenerated = !opts.existing
    && opts.allowGeneratedProvenanceSeed !== false
    && (opts.requireGenerationClock || producer !== undefined)
    && !declaredCandidateGenerated
    ? { by: producer ?? "process:superbee" }
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
    ? preserveDeclaredSourceBy ? candidateBy : producer ?? "process:superbee"
    : comparisonBy;
  const generated: Generated = {
    ...existingGenerated, ...candidateGenerated,
    ...(resolvedBy === undefined ? {} : { by: resolvedBy }),
  };
  let clockAuthored = false;
  if (!opts.existing) {
    if (generated.at === undefined) {
      if (
        opts.requireGenerationClock
        || (declaredCandidateGenerated !== undefined && opts.allowGeneratedProvenanceSeed !== false)
      ) {
        generated.at = opts.meaningfulChangeAt;
        clockAuthored = true;
      }
    }
  } else if (meaningfulChange) {
    generated.at = opts.meaningfulChangeAt;
    clockAuthored = true;
  } else if (existingGenerated) {
    if (hasOwn(existingGenerated, "at")) generated.at = existingGenerated.at;
    else delete generated.at;
  }

  // A newly produced clock is authored even when it repeats an invalid imported spelling.
  if (clockAuthored) assertAuthoredOkfTimestamps({ generated });
  return {
    ...opts.candidate,
    frontmatter: { ...frontmatter, generated },
  };
}
