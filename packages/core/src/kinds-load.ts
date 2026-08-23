/**
 * The backend-touching half of the kind-convention registry: {@link loadKinds}
 * queries a bundle's `conventions/` prefix and builds the registry out of `kinds.ts`'s pure
 * parsing/derivation. Split from `kinds.ts` ONLY by dependency weight — `kinds.ts` is the
 * browser-safe `@superbee/core/kinds` subpath (zero value imports), while this module may
 * pull the engine (`query` -> backends -> node built-ins). One registry, two entry weights.
 */
import { query } from "./bundle.js";
import {
  CONVENTIONS_PREFIX,
  CONVENTION_TYPE,
  RESERVED_KIND_FIELD_NAMES,
  parseConventionDoc,
  freshnessHorizonMs,
} from "./kinds.js";
import type { KindConvention, KindRegistry } from "./kinds.js";
import type { ValidationWarning } from "./validation.js";
import type { Bundle } from "./types.js";

/**
 * Build the {@link KindRegistry} for `bundle`: every `Convention` doc under
 * {@link CONVENTIONS_PREFIX}, keyed by the `type` it governs. A Convention doc OUTSIDE
 * the prefix is NOT discovered — that is the documented contract (CONTRIBUTING.md, "Kind conventions"),
 * not a bug. Malformed docs are skipped with a collected warning (never thrown); a
 * duplicate `governs` keeps the first-by-id declaration (query's results are
 * id-sorted) and warns about the shadowed one. Callers build this ONCE per invocation
 * and pass it down — no engine path calls this on its own.
 */
export async function loadKinds(bundle: Bundle): Promise<KindRegistry> {
  const kinds = new Map<string, KindConvention>();
  const warnings: ValidationWarning[] = [];

  // A convention doc whose YAML frontmatter is itself corrupt must not crash the WHOLE registry
  // load (which every `kinds`/`status`/`new`/`doc write` invocation runs) — it is reported as a
  // registry warning, exactly like a semantically-malformed convention, and the rest still load.
  const docs = await query(bundle, { prefix: CONVENTIONS_PREFIX, type: CONVENTION_TYPE }, {
    onSkip: ({ id, reason }) =>
      warnings.push({
        code: "KIND_CONVENTION_MALFORMED",
        message: `skipped kind convention '${id}' with unparseable frontmatter: ${reason}`,
        field: id,
        severity: "warning",
      }),
  });

  for (const doc of docs) {
    const parsed = parseConventionDoc(doc);
    if (!parsed.ok) {
      warnings.push({
        code: "KIND_CONVENTION_MALFORMED",
        message: `skipped malformed kind convention '${doc.id}': ${parsed.reason}`,
        field: doc.id,
        severity: "warning",
      });
      continue;
    }
    const { kind, reservedFieldsIgnored, reservedFieldPaths } = parsed;
    warnings.push(...parsed.warnings);
    if (reservedFieldsIgnored.length > 0) {
      warnings.push({
        code: "KIND_RESERVED_FIELD",
        message: `kind convention '${doc.id}' declares reserved field name(s) ${reservedFieldsIgnored.join(", ")} (reserved by the CLI: ${RESERVED_KIND_FIELD_NAMES.join("/")}); ignoring them — rename those domain fields before authoring instances.`,
        field: reservedFieldPaths.join(","),
        severity: "warning",
      });
    }
    if (kinds.has(kind.governs)) {
      warnings.push({
        code: "KIND_DUPLICATE_GOVERNS",
        message: `duplicate kind convention for '${kind.governs}': '${doc.id}' ignored, keeping the first-declared '${kinds.get(kind.governs)!.id}'.`,
        field: kind.governs,
        severity: "warning",
      });
      continue;
    }
    if (kind.freshnessHorizon !== undefined && freshnessHorizonMs(kind) === undefined) {
      warnings.push({
        code: "KIND_HORIZON_MALFORMED",
        message: `kind convention '${doc.id}' has a malformed freshness_horizon '${kind.freshnessHorizon}' (expected <n>(m|h|d)); ignoring it.`,
        field: "freshness_horizon",
        severity: "warning",
      });
    }
    kinds.set(kind.governs, kind);
  }

  return { kinds, warnings };
}
