import { InvalidInputError } from "./errors.js";
import type { ValidationWarning } from "./content-type.js";
import type { ConceptId } from "./types.js";

/**
 * Typed strict-kind rejection for trusted consumers to translate at their own boundary. Its own
 * module so field actions can refuse with it without importing the mutation service.
 */
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
