/**
 * What the two runtimes share: the one kind-validation derivation, so the contract kit proves
 * the model semantics equal rather than assuming it, and the one classification of errors into
 * authority answers and carrier failures, so both report `online` by the same rule.
 *
 * Validation reads the bundle's own conventions through the runtime's bundle (the authority for
 * request-driven, the working copy for browser-local), builds the registry with core's
 * `buildKindRegistry`, and projects one document's warnings with core's
 * `projectKindValidationWarnings`. Neither runtime carries a second rule.
 */

import type { Bundle, OkfDocument, ValidationWarning } from "@superbee/core";
import { query, readBundleOkfVersion } from "@superbee/core/bundle-ops";
import { InvalidInputError } from "@superbee/core/storage";
import { buildKindRegistry, CONVENTION_TYPE, CONVENTIONS_PREFIX, projectKindValidationWarnings, validateAgainstKind } from "@superbee/core/kinds";

/** Kind warnings for `doc` against the conventions `bundle` holds; empty when no kind governs its type. */
export async function kindWarningsFor(bundle: Bundle, doc: OkfDocument): Promise<ValidationWarning[]> {
  const conventions = await query(bundle, { prefix: CONVENTIONS_PREFIX, type: CONVENTION_TYPE });
  const okfVersion = await readBundleOkfVersion(bundle);
  const registry = buildKindRegistry(conventions, [], { okfVersion });
  const kind = registry.kinds.get(String(doc.frontmatter.type));
  if (!kind) return [];
  return projectKindValidationWarnings(okfVersion, kind, validateAgainstKind(doc, kind));
}

/** Raised before any request leaves; says nothing about the authority or the carrier. */
export function isInputError(error: unknown): boolean {
  return error instanceof InvalidInputError || (error as { name?: unknown })?.name === "InvalidInputError";
}

/**
 * An error the authority answered with (an absence, a conflict, a typed refusal with a status),
 * as opposed to a carrier failure that says nothing about whether the request arrived.
 */
export function isAuthorityAnswer(error: unknown): boolean {
  const err = error as { name?: unknown; code?: unknown; status?: unknown };
  if (err?.code === "ENOENT") return true;
  if (typeof err?.status === "number") return true;
  return err?.name === "VersionConflict" || err?.name === "DocumentNotFoundError";
}
