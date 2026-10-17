/**
 * The Kind problems a strict host write would refuse a bundle over, before the bundle exists. A
 * strict write refuses while the Kind registry has any warning, and it prepares and validates its
 * candidate with `prepareDocumentMutationCandidate`, which supplies the timestamp, actor and v0.2
 * metadata a write adds. This is the one rule for "what would the host refuse": the CLI's publish
 * preview runs it, and a host's bundle creation runs it with its own producer.
 *
 * It asks a different question from the health report's Kind lint (`kindLint`,
 * `conformanceDebt`), which reports what is wrong with each stored document as advice. Both run
 * core's one validator, `validateAgainstKind`.
 */
import { KindConformanceError, prepareDocumentMutationCandidate } from "../document-mutation.js";
import { InvalidInputError, OkfActorError } from "../errors.js";
import { buildKindRegistry, CONVENTION_TYPE, CONVENTIONS_PREFIX, type KindRegistry } from "../kinds.js";
import { matchesFilter } from "../query-filter.js";
import type { OkfDocument } from "../types.js";
import type { ValidationWarning } from "../validation.js";

/** Who the checked first edit is attributed to. `producer` defaults to `actor`, as a write's does. */
export interface KindWriteIdentity {
  actor: string;
  producer?: string;
}

export interface KindFinding {
  readonly id: string;
  readonly governs: string;
  readonly violations: readonly ValidationWarning[];
  /** Core's own sentence: `'<id>' does not satisfy the '<Kind>' kind: …`. */
  readonly message: string;
}

export interface BundleKindFindings {
  /** Registry warnings: every strict write to the bundle refuses while any is present. */
  readonly conventions: readonly ValidationWarning[];
  /** Documents whose first strict edit would refuse for their Kind. */
  readonly documents: readonly KindFinding[];
}

/** Whether `loadKinds` builds the Kind registry from this document: a `Convention` under `conventions/`. */
export function isRegistryConvention(doc: OkfDocument): boolean {
  return matchesFilter(doc, { prefix: CONVENTIONS_PREFIX, type: CONVENTION_TYPE });
}

/** The Kind registry a bundle holding `documents` loads, built with `loadKinds`' own filter and builder. */
export function bundleKindRegistry(documents: readonly OkfDocument[], okfVersion: "0.1" | "0.2"): KindRegistry {
  return buildKindRegistry(documents.filter(isRegistryConvention), [], { okfVersion });
}

/**
 * The Kind problem a strict write would refuse the first edit of one stored document over, or
 * null. The document is prepared as its first edit: the stored document as the existing one and a
 * body one line longer as the candidate, so unchanged values keep the leniency an edit gives them.
 * An edit refused for another reason (a malformed standard field it changes) is not a Kind problem.
 */
export function documentKindFinding(
  doc: OkfDocument,
  registry: KindRegistry,
  okfVersion: "0.1" | "0.2",
  write: KindWriteIdentity,
): KindFinding | null {
  try {
    prepareDocumentMutationCandidate(
      doc,
      { frontmatter: doc.frontmatter, body: `${doc.body ?? ""}\n` },
      {
        strict: true,
        persistActor: true,
        ...(write.producer === undefined ? {} : { producer: write.producer }),
        id: doc.id,
        registry,
        okfVersion,
        actor: write.actor,
      },
    );
  } catch (error) {
    if (error instanceof KindConformanceError) {
      return { id: doc.id, governs: error.governs, violations: error.violations, message: error.message };
    }
    if (error instanceof InvalidInputError && !(error instanceof OkfActorError)) return null;
    throw error;
  }
  return null;
}

/**
 * The Kind problems in `documents` (as stored) that strict writes would refuse over: the warnings
 * of the registry their conventions build, and each document's own finding against it, in input
 * order. Each document is checked on its own, so a bundle checked in parts against the same
 * registry finds exactly this.
 */
export function bundleKindFindings(
  documents: readonly OkfDocument[],
  okfVersion: "0.1" | "0.2",
  write: KindWriteIdentity,
): BundleKindFindings {
  const registry = bundleKindRegistry(documents, okfVersion);
  const found: KindFinding[] = [];
  for (const doc of documents) {
    const finding = documentKindFinding(doc, registry, okfVersion, write);
    if (finding) found.push(finding);
  }
  return { conventions: registry.warnings, documents: found };
}
