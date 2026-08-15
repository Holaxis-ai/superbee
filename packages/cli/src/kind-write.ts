// CLI translation for kind-conformance failures. Core owns timestamp defaulting,
// registry lookup, and validation; this module owns strict-mode CLI presentation.
import {
  defaultTimestampAndValidateAgainstRegistry,
  KindConformanceError,
  progressStatusStorageField,
  type ConceptId,
  type KindConvention,
  type KindRegistry,
  type OkfDocument,
  type ValidationWarning,
} from "@superbee/core";
import { CliError } from "./errors.js";
import { cliInvocation } from "./invocation.js";

/**
 * Build a literal, ready-to-run `doc update <id>` argv that addresses every FIELD-level violation
 * (missing/out-of-enum/wrong-arity) in `violations` — one `--<field> <placeholder>` per distinct
 * DECLARED field (a member of `kind.fields.required`/`optional`), deduplicated in first-seen order.
 * An enum-restricted field's placeholder lists its allowed values (`<a|b|c>`) instead of the generic
 * `<value>` token, so the agent picks a real one rather than guessing. A violation naming something
 * other than a declared field — `KIND_SECTION_MISSING` names a missing BODY HEADING, not a
 * `doc update --<field>`-settable frontmatter key — has no flag that can complete it, so it is
 * filtered out by the declared-field membership check; the caller falls back to its generic help
 * when NOTHING is left. Returns `undefined` when `kind` is absent or no violation names a completable
 * field, so the caller can fall back cleanly.
 */
function buildCompletingUpdateCommand(
  id: ConceptId,
  violations: ValidationWarning[],
  kind: KindConvention | undefined,
  okfVersion?: "0.1" | "0.2",
): string | undefined {
  if (!kind) return undefined;
  const declaredFields = new Set([...kind.fields.required, ...kind.fields.optional]);
  const seen = new Set<string>();
  const flags: string[] = [];
  for (const violation of violations) {
    const field = violation.field;
    if (!field || seen.has(field) || !declaredFields.has(field)) continue;
    seen.add(field);
    const allowed = kind.fields.values[field];
    const placeholder = allowed && allowed.length > 0 ? `<${allowed.join("|")}>` : "<value>";
    const authoringField = field === progressStatusStorageField(okfVersion) ? "progress_status" : field;
    flags.push(`--${authoringField} ${placeholder}`);
  }
  if (flags.length === 0) return undefined;
  return `${cliInvocation()} doc update ${id} ${flags.join(" ")}`;
}

/**
 * Translate a typed core rejection into the established strict-mode CLI contract: `help` becomes a
 * literal completing `doc update` command (placeholder values filled in by the caller) naming every
 * violated field, falling back to `fallbackHelp` (the generic `kinds` pointer) when no violation
 * names a completable field (e.g. only a body-section violation) OR when `docExists` is false — a
 * `doc update <id>` command is only ever runnable against an EXISTING doc (`doc update`'s `onAbsent:
 * "fail"`); a kind refusal on a doc that was never persisted (a rejected CREATE) has no id for
 * `doc update` to patch, so emitting one there would be a completing command that 404s. Callers on a
 * mutation mode that can create (`create-only`/`overwrite`) must determine `docExists` themselves —
 * `patch` mode callers (the doc is a precondition of patching at all) may always pass `true`.
 */
export function kindConformanceCliError(
  error: KindConformanceError,
  registry: KindRegistry,
  fallbackHelp: string,
  docExists: boolean,
): CliError {
  const kind = registry.kinds.get(error.governs);
  const completing = docExists
    ? buildCompletingUpdateCommand(error.id, error.violations, kind, error.okfVersion)
    : undefined;
  return new CliError("USAGE", error.message, {
    help: completing ?? fallbackHelp,
    details: { violations: error.violations },
  });
}

/** Options for {@link defaultTimestampAndValidateKind}. */
export interface KindValidateOptions {
  /** Upgrade a non-empty warning set to a thrown USAGE CliError instead of returning it (no write happens). */
  strict: boolean;
  /** Fallback `help` for a `--strict` rejection whose violations name no completable field (see `kindConformanceCliError`). */
  helpOnReject: string;
  /**
   * Whether `candidate.id` already exists in the bundle — gates whether a `--strict` rejection's
   * `help` may safely be a completing `doc update` command (see `kindConformanceCliError`). Callers
   * writing via an expect-absent CREATE should pass `false`.
   */
  docExists: boolean;
}

/**
 * Default `candidate.frontmatter.timestamp` to now (in place) if it is still absent, look up the
 * kind governing `candidate.frontmatter.type` in `registry`, and validate the candidate against it.
 *
 * Warn-by-default: returns the (possibly empty) warning list for the caller to attach to its
 * receipt. `opts.strict: true` upgrades a non-empty warning list to a thrown `CliError("USAGE", …)`
 * instead — the caller must not write in that case. An ungoverned `type` (no kind declares it, or a
 * conventions-free bundle) is a no-op: `[]`, timestamp still defaulted.
 *
 * Mutates `candidate.frontmatter` in place (matching `doc write`'s original mutation-based style) —
 * callers that pass the SAME object into a subsequent write see the defaulted timestamp too.
 */
export function defaultTimestampAndValidateKind(
  candidate: OkfDocument,
  registry: KindRegistry,
  opts: KindValidateOptions,
): ValidationWarning[] {
  const { kind, warnings } = defaultTimestampAndValidateAgainstRegistry(candidate, registry);
  if (kind && warnings.length > 0 && opts.strict) {
    throw kindConformanceCliError(
      new KindConformanceError(candidate.id, kind.governs, warnings),
      registry,
      opts.helpOnReject,
      opts.docExists,
    );
  }
  return warnings;
}
