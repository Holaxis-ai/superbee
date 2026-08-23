/** Pure document-shape policies applied before a normalized document reaches storage. */

import { InvalidInputError } from "./errors.js";
import type { Frontmatter, OkfDocument } from "./types.js";

type Generated = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** OKF v0.2 actor spellings: human/process identities or a producer/version pair. */
export function isOkfActor(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || /\s/.test(value)) {
    return false;
  }
  if (/^(?:human|process):[^\s:]+$/.test(value)) return true;
  return /^[^\s/:]+\/[^\s/]+$/.test(value);
}

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
  if (a === b) return true;
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

function withoutV02GenerationClock(frontmatter: Frontmatter): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...frontmatter };
  const generated = copy.generated;
  if (isRecord(generated)) {
    const { at: _at, ...rest } = generated;
    copy.generated = rest;
  }
  return copy;
}

/** Whether content/provenance changed, excluding verification history and the generation clock. */
export function v02MeaningfulContentChanged(
  existing: Pick<OkfDocument, "frontmatter" | "body">,
  candidate: Pick<OkfDocument, "frontmatter" | "body">,
): boolean {
  if (existing.body !== candidate.body) return true;
  const existingFrontmatter = withoutV02GenerationClock(existing.frontmatter);
  const candidateFrontmatter = withoutV02GenerationClock(candidate.frontmatter);
  delete existingFrontmatter.verified;
  delete candidateFrontmatter.verified;
  return !sameValue(existingFrontmatter, candidateFrontmatter);
}

export interface V02MutationMetadataOptions {
  existing?: Pick<OkfDocument, "frontmatter" | "body">;
  candidate: { frontmatter: Frontmatter; body: string };
  meaningfulChangeAt: string;
  /** Seed standard generation metadata when the core mutation policy requires a clock. */
  requireGenerationClock?: boolean;
}

/**
 * Apply the v0.2 mutation clock without conflating storage attribution with provenance.
 * `generated` is optional; when present its producer is preserved unless explicitly replaced.
 */
export function applyV02MutationMetadata(opts: V02MutationMetadataOptions): {
  frontmatter: Frontmatter;
  body: string;
} {
  const existingGenerated = generatedRecord(opts.existing?.frontmatter.generated, "existing generated");
  const declaredCandidateGenerated = generatedRecord(opts.candidate.frontmatter.generated, "generated");
  const candidateGenerated = opts.requireGenerationClock && !declaredCandidateGenerated
    ? { by: "process:superbee" }
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
  if (!existingGenerated && !candidateGenerated) return { ...opts.candidate, frontmatter };

  const candidateHasBy = candidateGenerated ? hasOwn(candidateGenerated, "by") : false;
  const existingBy = existingGenerated?.by;
  const candidateBy = candidateGenerated?.by;

  if (candidateHasBy && candidateBy !== existingBy && !isOkfActor(candidateBy)) {
    throw new InvalidInputError(
      "OKF v0.2 generated.by must be human:<id>, process:<id>, or <producer>/<version>",
    );
  }

  const resolvedBy = candidateHasBy ? candidateBy : existingBy;
  if (typeof resolvedBy !== "string" || resolvedBy.trim() === "") {
    throw new InvalidInputError("OKF v0.2 generated.by is required when generated is present");
  }

  const generated: Generated = { ...existingGenerated, ...candidateGenerated, by: resolvedBy };
  if (!opts.existing) {
    if (generated.at === undefined) generated.at = opts.meaningfulChangeAt;
    else if (typeof generated.at !== "string" || Number.isNaN(Date.parse(generated.at))) {
      throw new InvalidInputError("OKF v0.2 generated.at must be an ISO-8601 date/time when present");
    }
  } else if (v02MeaningfulContentChanged(opts.existing, {
    ...opts.candidate,
    frontmatter: { ...frontmatter, generated },
  })) {
    generated.at = opts.meaningfulChangeAt;
  } else if (existingGenerated && hasOwn(existingGenerated, "at")) {
    generated.at = existingGenerated.at;
  }

  return {
    ...opts.candidate,
    frontmatter: { ...frontmatter, generated },
  };
}
