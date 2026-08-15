/**
 * CLI-neutral document mutation policy.
 *
 * This is the document-specific layer above {@link versionedMutation}: create-only,
 * overwrite, and patch postures share fresh-read/CAS coupling, kind validation,
 * timestamp ordering, semantic no-op detection, attribution, and final receipts.
 * Consumers own their transport and presentation errors; this module throws typed
 * core failures and never imports CLI or browser concerns.
 */

import { InvalidInputError } from "./errors.js";
import { applyV02MutationMetadata } from "./document-write-policy.js";
import { persistMutationActor } from "./mutation-attribution.js";
import { defaultTimestampAndValidateAgainstRegistry, validateAgainstKind } from "./kinds.js";
import { versionedMutation } from "./mutation.js";
import { VersionConflict } from "./versioning.js";
import {
  readBundleOkfVersion,
  readDocVersioned,
  writeDocVersionedForEdition,
} from "./bundle.js";
import type { KindRegistry, RegistryValidationResult } from "./kinds.js";
import type { ValidationWarning } from "./content-type.js";
import type {
  Bundle,
  ConceptId,
  Frontmatter,
  OkfDocument,
  Version,
} from "./types.js";

const DEFAULT_MAX_ATTEMPTS = 5;

export type DocumentMutationMode = "create-only" | "overwrite" | "patch";

/** The frontmatter and body a caller wants persisted; the service supplies the id. */
export interface DocumentMutationCandidate {
  frontmatter: Frontmatter;
  body: string;
}

/** Root-derived bundle facts supplied by the mutation authority to candidate construction. */
export interface DocumentMutationContext {
  okfVersion: "0.1" | "0.2";
}

/** Typed strict-kind rejection for trusted consumers to translate at their own boundary. */
export class KindConformanceError extends InvalidInputError {
  readonly id: ConceptId;
  readonly governs: string;
  readonly violations: ValidationWarning[];
  readonly okfVersion?: "0.1" | "0.2";

  constructor(
    id: ConceptId,
    governs: string,
    violations: ValidationWarning[],
    okfVersion?: "0.1" | "0.2",
  ) {
    super(`'${id}' does not satisfy the '${governs}' kind: ${violations.map((warning) => warning.message).join("; ")}`);
    this.name = "KindConformanceError";
    this.id = id;
    this.governs = governs;
    this.violations = violations;
    this.okfVersion = okfVersion;
  }
}

/** Typed missing-document result for patch callers that require an existing target. */
export class DocumentNotFoundError extends Error {
  readonly id: ConceptId;

  constructor(id: ConceptId) {
    super(`no concept document at id '${id}'`);
    this.name = "DocumentNotFoundError";
    this.id = id;
  }
}

export interface MutateDocumentOptions {
  bundle: Bundle;
  id: ConceptId;
  mode: DocumentMutationMode;
  /** Loaded once by the trusted caller; the service never performs registry discovery implicitly. */
  registry: KindRegistry;
  /** Reject rather than return a non-empty kind warning set. */
  strict: boolean;
  /** Recomputed against every fresh CAS attempt. */
  buildCandidate: (
    existing: OkfDocument | undefined,
    context: DocumentMutationContext,
  ) => DocumentMutationCandidate | Promise<DocumentMutationCandidate>;
  /** Patch only: require an existing target or allow an expect-absent create. */
  onAbsent?: "fail" | "create";
  /** Retry budget for overwrite and ordinary patch. */
  maxAttempts?: number;
  /** Patch only: include timestamp in semantic no-op comparison. */
  compareTimestamp?: boolean;
  /** Advisory backend-history attribution, applied only when a write occurs. */
  actor?: string;
  /** Also persist the advisory actor in the edition-appropriate frontmatter field after no-op detection. */
  persistActor?: boolean;
  /** Patch only: a caller-supplied token makes the operation a single-shot hard CAS. */
  expectedVersion?: Version;
  /** Test seam for edition-specific clocks; production defaults to the current ISO instant. */
  now?: () => string;
}

export interface DocumentMutationResult {
  doc: OkfDocument;
  changed: boolean;
  version: Version;
  warnings: ValidationWarning[];
}

/** Structural equality through plain objects and arrays, independent of object key order. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((value, index) => valuesEqual(value, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    const bKeys = Object.keys(bRecord);
    return aKeys.length === bKeys.length && aKeys.every((key) => valuesEqual(aRecord[key], bRecord[key]));
  }
  return false;
}

function isNoopPatch(
  existing: OkfDocument,
  candidate: DocumentMutationCandidate,
  compareTimestamp: boolean,
  okfVersion: string,
): boolean {
  if (candidate.body !== existing.body) return false;
  if (okfVersion === "0.2") {
    const withoutGeneratedAt = (frontmatter: Frontmatter): Frontmatter => {
      const generated = frontmatter.generated;
      if (generated === null || typeof generated !== "object" || Array.isArray(generated)) {
        return frontmatter;
      }
      const { at: _at, ...generatedRest } = generated as Record<string, unknown>;
      return { ...frontmatter, generated: generatedRest };
    };
    return valuesEqual(withoutGeneratedAt(existing.frontmatter), withoutGeneratedAt(candidate.frontmatter));
  }
  if (compareTimestamp) return valuesEqual(existing.frontmatter, candidate.frontmatter);
  const { timestamp: _existingTimestamp, ...existingRest } = existing.frontmatter;
  const { timestamp: _candidateTimestamp, ...candidateRest } = candidate.frontmatter;
  return valuesEqual(existingRest, candidateRest);
}

function attributeCandidate(
  candidate: DocumentMutationCandidate,
  actor: string | undefined,
  persistActor: boolean,
  okfVersion: "0.1" | "0.2",
  registry: KindRegistry,
): DocumentMutationCandidate {
  if (!persistActor) return candidate;
  const kind = registry.kinds.get(String(candidate.frontmatter.type));
  return {
    ...candidate,
    frontmatter: persistMutationActor(candidate.frontmatter, {
      actor,
      okfVersion,
      kindRequiresActor: kind?.fields.required.includes("actor") ?? false,
    }),
  };
}

/**
 * Validate `candidate` against its own (possibly retyped) governing kind, defaulting its
 * timestamp first. Returns the kind alongside the warnings so overwrite's ratchet (below) can
 * reuse this ONE validation pass instead of re-deriving the candidate's kind separately.
 */
function validateCandidate(
  id: ConceptId,
  candidate: DocumentMutationCandidate,
  registry: KindRegistry,
  strict: boolean,
  okfVersion: "0.1" | "0.2",
  now: () => string,
): RegistryValidationResult {
  const result = defaultTimestampAndValidateAgainstRegistry(
    { id, ...candidate },
    registry,
    { okfVersion, now },
  );
  if (strict && result.kind && result.warnings.length > 0) {
    throw new KindConformanceError(id, result.kind.governs, result.warnings, okfVersion);
  }
  return result;
}

function withV02Metadata(
  candidate: DocumentMutationCandidate,
  existing: OkfDocument | undefined,
  okfVersion: string,
  now: () => string,
): DocumentMutationCandidate {
  if (okfVersion !== "0.2") return candidate;
  return applyV02MutationMetadata({
    existing,
    candidate,
    meaningfulChangeAt: now(),
  });
}

/** One stable instant per CAS decision, shared by every clock a bundle Kind explicitly carries. */
function onceNow(now: () => string): () => string {
  let value: string | undefined;
  return () => (value ??= now());
}

/**
 * True when `existing` already satisfies ITS OWN governing kind — the monotone ratchet's
 * precondition (probe: tasks/overwrite-ratchet-survey). Validates the RAW existing
 * frontmatter — no timestamp defaulting — because the existing doc IS its raw bytes; nothing
 * normalizes it unless written. This keeps the ratchet in agreement with `status`'s
 * `conformance_debt` (both call `validateAgainstKind` on the same unmodified frontmatter;
 * see tasks/conforms-raw-alignment). `validateAgainstKind` only reads `doc.frontmatter`, so
 * passing `existing` directly is safe — no defensive clone needed.
 */
function conforms(existing: OkfDocument, registry: KindRegistry): boolean {
  const kind = registry.kinds.get(String(existing.frontmatter.type));
  if (!kind) return false;
  return validateAgainstKind(existing, kind).length === 0;
}

export async function mutateDocument(opts: MutateDocumentOptions): Promise<DocumentMutationResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const onAbsent = opts.onAbsent ?? "fail";
  const compareTimestamp = opts.compareTimestamp ?? false;
  const persistActor = opts.persistActor ?? false;
  const okfVersion = await readBundleOkfVersion(opts.bundle) ?? "0.1";
  if (okfVersion !== "0.1" && okfVersion !== "0.2") {
    throw new InvalidInputError(
      `Unsupported OKF mutation version '${okfVersion}'. This build can mutate 0.1 and 0.2 bundles.`,
    );
  }
  const now = opts.now ?? (() => new Date().toISOString());
  const context: DocumentMutationContext = { okfVersion };

  if (opts.mode === "create-only") {
    const decisionNow = onceNow(now);
    const attributed = attributeCandidate(
      await opts.buildCandidate(undefined, context),
      opts.actor,
      persistActor,
      okfVersion,
      opts.registry,
    );
    const candidate = withV02Metadata(attributed, undefined, okfVersion, decisionNow);
    const { warnings } = validateCandidate(opts.id, candidate, opts.registry, opts.strict, okfVersion, decisionNow);
    const { doc, version } = await writeDocVersionedForEdition(opts.bundle, { id: opts.id, ...candidate }, okfVersion, {
      expectedVersion: null,
      actor: opts.actor,
    });
    return { doc, changed: true, version, warnings };
  }

  const readExisting = async (): Promise<{ state: OkfDocument | undefined; version: Version | null }> => {
    try {
      const { doc, version } = await readDocVersioned(opts.bundle, opts.id);
      return { state: doc, version };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { state: undefined, version: null };
      throw error;
    }
  };

  if (opts.mode === "overwrite") {
    let savedDoc: OkfDocument | undefined;
    let warnings: ValidationWarning[] = [];
    const outcome = await versionedMutation<OkfDocument, undefined>({
      read: readExisting,
      decide: async (existing) => {
        const decisionNow = onceNow(now);
        const attributed = attributeCandidate(
          await opts.buildCandidate(existing, context),
          opts.actor,
          persistActor,
          okfVersion,
          opts.registry,
        );
        const candidate = withV02Metadata(attributed, existing, okfVersion, decisionNow);
        const validated = validateCandidate(
          opts.id,
          candidate,
          opts.registry,
          opts.strict,
          okfVersion,
          decisionNow,
        );
        warnings = validated.warnings;

        // Monotone conformance ratchet (probe: tasks/overwrite-ratchet-survey, productionized
        // here): a doc that already satisfies its governing kind may not regress into
        // non-conformance through a lenient (non-strict) overwrite — once clean, always clean.
        // A doc that has NEVER conformed keeps today's lenient staging behavior (warn, don't
        // block), and dropping only OPTIONAL fields can't trip this (validateAgainstKind never
        // warns on those), so this only ever fires on a REAL regression. Retyping to an
        // ungoverned type is a documented escape: an ungoverned candidate carries zero
        // warnings by construction, so the `warnings.length > 0` guard below never sees it.
        // Every overwrite caller, including `promote`, inherits this rule from this shared boundary.
        if (!opts.strict && existing && warnings.length > 0 && conforms(existing, opts.registry)) {
          throw new KindConformanceError(opts.id, validated.kind!.governs, warnings, okfVersion);
        }

        return { action: "write", next: { id: opts.id, ...candidate }, result: undefined };
      },
      write: async (next, expectedVersion) => {
        const written = await writeDocVersionedForEdition(opts.bundle, next, okfVersion, {
          expectedVersion,
          actor: opts.actor,
        });
        savedDoc = written.doc;
        return written.version;
      },
      maxAttempts,
    });
    return { doc: savedDoc!, changed: true, version: outcome.version!, warnings };
  }

  let lastReadVersion: Version | null = null;
  let savedDoc: OkfDocument | undefined;
  const hardCas = opts.expectedVersion !== undefined;
  const outcome = await versionedMutation<OkfDocument, { doc?: OkfDocument; warnings: ValidationWarning[] }>({
    read: async () => {
      const read = await readExisting();
      lastReadVersion = read.version;
      if (read.state === undefined && onAbsent === "fail") throw new DocumentNotFoundError(opts.id);
      return read;
    },
    decide: async (existing) => {
      const decisionNow = onceNow(now);
      if (hardCas && lastReadVersion !== opts.expectedVersion) {
        throw new VersionConflict(opts.id, opts.expectedVersion!, lastReadVersion);
      }

      const rawCandidate = await opts.buildCandidate(existing, context);
      const candidateForComparison = withV02Metadata(rawCandidate, existing, okfVersion, decisionNow);
      if (existing && isNoopPatch(existing, candidateForComparison, compareTimestamp, okfVersion)) {
        return { action: "done", result: { doc: existing, warnings: [] } };
      }

      const attributed = attributeCandidate(
        rawCandidate,
        opts.actor,
        persistActor,
        okfVersion,
        opts.registry,
      );
      const candidate = withV02Metadata(attributed, existing, okfVersion, decisionNow);
      const { warnings } = validateCandidate(
        opts.id,
        candidate,
        opts.registry,
        opts.strict,
        okfVersion,
        decisionNow,
      );
      return { action: "write", next: { id: opts.id, ...candidate }, result: { warnings } };
    },
    write: async (next, expectedVersion) => {
      const written = await writeDocVersionedForEdition(opts.bundle, next, okfVersion, {
        expectedVersion: hardCas ? opts.expectedVersion! : expectedVersion,
        actor: opts.actor,
      });
      savedDoc = written.doc;
      return written.version;
    },
    maxAttempts: hardCas ? 1 : maxAttempts,
  });

  return outcome.wrote
    ? { doc: savedDoc!, changed: true, version: outcome.version!, warnings: outcome.result.warnings }
    : { doc: outcome.result.doc!, changed: false, version: outcome.version!, warnings: [] };
}
