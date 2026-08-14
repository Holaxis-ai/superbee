/**
 * Kind conventions — the bundle-declared document-kind mechanism (CLAUDE.md gate 3,
 * decision 5: "the mechanism is core and non-negotiable; usage is opt-in per bundle").
 *
 * A bundle MAY declare document kinds as plain OKF convention docs: a normal concept
 * document with `frontmatter.type: "Convention"`, living under the `conventions/`
 * prefix (the ONE documented discovery contract — see {@link CONVENTIONS_PREFIX}), that
 * names the `type` value it governs plus its required/optional fields, allowed enum
 * values, expected body sections, and an optional freshness horizon. A convention doc
 * is NOT a schema fork: it is a plain OKF doc with a well-known `type`, read by this
 * ONE registry (consumed by the CLI's `kinds`/`new`/`doc write`, and additively by any
 * future consumer — server/MCP).
 *
 * Registry discovery is PREFIX-SCOPED and built ONCE per invocation, in the COMMAND
 * layer — no engine path (`readDoc`, `writeDoc`, …) loads it implicitly, so
 * a conventions-free bundle (every external OKF bundle today) pays only a cheap
 * list-of-nothing and behaves byte-for-byte as before.
 *
 * Pure derivation logic (`validateAgainstKind`, `freshnessHorizonMs`, `isTerminal`, the
 * convention-doc (de)serialization) is dependency-free — this module carries ONLY that, and is
 * exported as the browser-safe `@superbee/core/kinds` subpath (the ui shell's bridge
 * `open` filter consumes `isTerminal` there; a browser bundler must never be dragged through the
 * engine's node built-ins for a pure predicate). The one backend-touching entry point,
 * `loadKinds`, lives in `kinds-load.ts` — same ONE registry, split only by dependency weight.
 */
import { isUsableTimestamp } from "./frontmatter.js";
import type { ValidationWarning } from "./validation.js";
import type { ConceptId, Frontmatter, OkfDocument } from "./types.js";

/** The bundle-relative prefix a kind convention doc MUST live under to be discovered. */
export const CONVENTIONS_PREFIX = "conventions/";

/** The OKF `type` value a kind convention doc itself carries. */
export const CONVENTION_TYPE = "Convention";

/** A kind's declared required/optional fields and any enum-restricted field values. */
export interface KindFields {
  /** Field names that MUST be present and non-empty on an instance. */
  required: string[];
  /** Field names that MAY be present on an instance. */
  optional: string[];
  /** `fieldName -> allowed values` for fields restricted to an enumerated set. */
  values: Record<string, string[]>;
  /** Human guidance for allowed enum values: `fieldName -> value -> description`. */
  valueDescriptions?: Record<string, Record<string, string>>;
  /**
   * `fieldName -> terminal values` (a subset of that field's `values` enum, when declared) — the
   * states past which an instance is "done" (task board `tasks/status-terminal-declaration.md`).
   * Consumed via {@link isTerminal}, the ONE derivation every consumer (list's `--open`, the
   * `status` sweep's exclusion + sort) calls. Empty map when the kind declares no terminal set.
   */
  terminal: Record<string, string[]>;
  /** Human guidance for declared fields: `fieldName -> description`. */
  descriptions: Record<string, string>;
}

/** A parsed kind convention: the governed `type` plus its declared shape. */
export interface KindConvention {
  /** Concept id of the convention doc itself (e.g. `conventions/roadmap-item`). */
  id: ConceptId;
  /** Display title (defaults to `governs` when the convention doc omits one). */
  title: string;
  /** The `type` value this convention governs (required, non-empty — malformed docs are skipped). */
  governs: string;
  /** Human-readable purpose and intended use of this kind. */
  description?: string;
  /** Canonical bundle-relative path prefix for instances of this kind, if declared. */
  path?: string;
  fields: KindFields;
  /**
   * The typed-edge vocabulary this kind declares as link SOURCE: `link type name -> allowed
   * target kind` (decision `decisions/typed-links-carrier`, 2026-07-07: a link whose display
   * text exactly matches a declared type is a typed edge; every other link is an untyped
   * citation). Discovery-only at this layer — write-time validation is a future consumer.
   */
  links?: Record<string, string>;
  /** Human guidance for declared outbound relationships: `link type name -> description`. */
  linkDescriptions?: Record<string, string>;
  /**
   * Inbound-link expectations this kind declares on ITSELF as link TARGET: `link type name ->
   * expected SOURCE kind` (e.g. a `Task` declaring `expects_inbound: {contains: "Roadmap Item"}`
   * means every Task instance is expected to carry at least one inbound edge whose text is
   * exactly `contains` from a doc of type `Roadmap Item`). Discovery-only at this layer — the
   * `status` graph-lint sweep (`missing_expected_links`) is the write-side consumer; write-time
   * validation is never enforced by this key.
   */
  expectsInbound?: Record<string, string>;
  /** Expected body-section headings (level-1 `# Heading`), if declared. Scaffold + lint only. */
  sections?: string[];
  /** Raw declared horizon string (`<n>(m|h|d)`), if present — parse via {@link freshnessHorizonMs}. */
  freshnessHorizon?: string;
  /**
   * Browse/listing display hint: when `true`, a browse UI collapses this kind's instances behind a
   * toggle by default — for a transient/background kind (e.g. Context Note) whose volume would
   * otherwise swamp durable knowledge. Absent → expanded. Bundle-DECLARED so the shell never
   * privileges a kind by name (gate 3); display-only, no engine behavior. Set from `browse_collapsed: true`.
   */
  browseCollapsed?: boolean;
}

/** The result of {@link loadKinds}: the built registry plus any non-fatal warnings collected along the way. */
export interface KindRegistry {
  /** `governs -> KindConvention`. On a duplicate `governs`, the first-by-id declaration wins. */
  kinds: Map<string, KindConvention>;
  /** Malformed/duplicate/unparseable conventions are SKIPPED, never thrown — collected here instead. */
  warnings: ValidationWarning[];
}

/** Stable product-level name for a Kind's workflow progress field. */
export const PROGRESS_STATUS_FIELD = "progress_status";

/** Producer-qualified v0.2 storage coordinate for Superbee workflow progress. */
export const SUPERBEE_PROGRESS_STATUS_FIELD = "superbee_progress_status";

/** A logical Kind field and the concrete frontmatter key that stores it in this OKF edition. */
export interface KindFieldCoordinate {
  logicalField: string;
  storageField: string;
}

function declaresField(kind: KindConvention, field: string): boolean {
  return kind.fields.required.includes(field) || kind.fields.optional.includes(field);
}

/**
 * Compile the declaration-driven workflow-progress coordinate for one Kind. Missing root version
 * means v0.1 (OKF's compatibility default). Values never activate this mapping.
 */
export function progressStatusCoordinate(
  okfVersion: string | undefined,
  kind: KindConvention,
): KindFieldCoordinate | undefined {
  const version = okfVersion?.trim() || "0.1";
  if (version === "0.1" && declaresField(kind, "status")) {
    return { logicalField: PROGRESS_STATUS_FIELD, storageField: "status" };
  }
  if (version === "0.2" && declaresField(kind, SUPERBEE_PROGRESS_STATUS_FIELD)) {
    return {
      logicalField: PROGRESS_STATUS_FIELD,
      storageField: SUPERBEE_PROGRESS_STATUS_FIELD,
    };
  }
  return undefined;
}

/** Resolve an agent-facing Kind field to its declared storage coordinate. */
export function resolveKindFieldCoordinate(
  okfVersion: string | undefined,
  kind: KindConvention,
  field: string,
): KindFieldCoordinate | undefined {
  const progress = progressStatusCoordinate(okfVersion, kind);
  if (field === PROGRESS_STATUS_FIELD && progress) return progress;
  return declaresField(kind, field) ? { logicalField: field, storageField: field } : undefined;
}

/** Declared authoring names plus the logical progress alias, when this Kind proves one exists. */
export function kindInputFieldNames(okfVersion: string | undefined, kind: KindConvention): string[] {
  const fields = [...new Set([...kind.fields.required, ...kind.fields.optional])];
  if (progressStatusCoordinate(okfVersion, kind) && !fields.includes(PROGRESS_STATUS_FIELD)) {
    fields.push(PROGRESS_STATUS_FIELD);
  }
  return fields;
}

/** Read a declared logical or physical Kind field without changing the stored frontmatter. */
export function readKindField(
  okfVersion: string | undefined,
  kind: KindConvention,
  frontmatter: Frontmatter,
  field: string,
): unknown {
  const coordinate = resolveKindFieldCoordinate(okfVersion, kind, field);
  return coordinate
    ? (frontmatter as Record<string, unknown>)[coordinate.storageField]
    : undefined;
}

/**
 * Add logical field aliases to a product-facing projection while preserving every raw key. Generic
 * document reads remain raw; only Kind-aware product surfaces call this helper.
 */
export function projectLogicalKindFields(
  okfVersion: string | undefined,
  kind: KindConvention,
  frontmatter: Frontmatter,
): Frontmatter {
  const progress = progressStatusCoordinate(okfVersion, kind);
  if (!progress || !hasOwn(frontmatter, progress.storageField)) return frontmatter;
  const projected = { ...frontmatter } as Frontmatter;
  setOwn(
    projected as Record<string, unknown>,
    progress.logicalField,
    (frontmatter as Record<string, unknown>)[progress.storageField],
  );
  return projected;
}

/** True for a plain YAML/JSON map (excludes arrays, `null`, dates, and other object instances). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Prototype-safe own-key check for user-authored YAML maps. */
function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Define an arbitrary user-authored key without invoking the legacy `__proto__` setter. */
function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

/** True for a scalar YAML value (string/number/boolean) — the shape an enum/field-name member should be. */
function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Human-readable shape name for a warning message (`"an object"`, `"an array"`, `"null"`, …). */
function describeShape(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return typeof value;
}

/**
 * String-coerce every scalar element of an array-ish value (tolerating YAML 1.1 boolean/Date
 * coercion on unquoted enum members), WARNING and DROPPING any non-scalar member (an object or
 * nested array) instead of silently stringifying it to `"[object Object]"` — the exact silent
 * corruption caused by agents feeding a list of objects into `required`/`optional` or an enum's
 * `values` list. A present-but-non-array `value` warns (wrong shape); an
 * ABSENT (`undefined`) `value` does not, since "not declared" is normal, not a shape error.
 */
function toStringArrayLenient(
  value: unknown,
  path: string,
  docId: string,
  warnings: ValidationWarning[],
): string[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) {
      warnings.push({
        code: "KIND_CONVENTION_BAD_SHAPE",
        message: `kind convention '${docId}' has a non-list '${path}' (${describeShape(value)}; expected a list of strings); ignoring it.`,
        field: path,
        severity: "warning",
      });
    }
    return [];
  }
  const out: string[] = [];
  for (const v of value) {
    if (isScalar(v)) {
      out.push(String(v));
    } else {
      warnings.push({
        code: "KIND_CONVENTION_BAD_MEMBER",
        message: `kind convention '${docId}' has a non-scalar member (${describeShape(v)}) in '${path}'; skipping it.`,
        field: path,
        severity: "warning",
      });
    }
  }
  return out;
}

/**
 * Field names the CLI reserves for its own machinery and can never treat as a kind-declared
 * field: `type` is stamped from `kind.governs` (a kind declaring it as a field would let
 * `new --type <v>` silently overwrite the governed type it just validated against), and
 * `dir`/`remote`/`json`/`help` are consumed by every command's common flag handling before a
 * `--<field> <value>` pair ever reaches kind-field mapping. `body` and `body-file` are `new`'s
 * complete-body inline and file channels. Declaring any of them would make the field permanently
 * unreachable, not merely confusing. Filtered out of `required`/`optional`/`values` at parse time
 * with a collected warning — never silently accepted.
 */
export const RESERVED_KIND_FIELD_NAMES = ["type", "dir", "remote", "json", "help", "body", "body-file"] as const;
const RESERVED_FIELD_NAMES = new Set<string>(RESERVED_KIND_FIELD_NAMES);

/** The only recognized keys inside a convention doc's `fields:` block. */
const VALID_FIELDS_KEYS = new Set([
  "required",
  "optional",
  "values",
  "value_descriptions",
  "terminal",
  "descriptions",
]);

/**
 * Top-level convention-doc keys that are near-misses for the ONE correct enum-constraint shape
 * (`fields.values.<field>: [...]`) — the exact wrong shapes agents commonly reach for
 * reaching for (`enum:`, `enums:`, top-level `values:`, `constraints:`). This is a SMALL, DENY-
 * ADJACENT set, not a generic top-level-key linter: OKF §9 permits unknown frontmatter, and a
 * bundle producer may legitimately add other top-level keys to a convention doc (title, tags,
 * whatever) — those get NO warning. Strict inside the blocks we own (`fields:`), permissive
 * everywhere else.
 */
const MISPLACED_TOP_LEVEL_KEYS = new Set(["enum", "enums", "values", "constraints"]);

// Level-1 headings only: `# Foo` (not `## Foo`). The ONE heading splitter, reused by
// validateAgainstKind's section lint below and re-exported as public API from index.ts.
const H1_RE = /^#\s+(.+?)\s*$/gm;

/** Split a body into `{ headingText: sectionContent }` by its level-1 headings. */
export function splitSections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const matches = [...body.matchAll(H1_RE)];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]!;
    const name = (current[1] ?? "").trim();
    const start = (current.index ?? 0) + current[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? body.length) : body.length;
    setOwn(out, name, body.slice(start, end).trim());
  }
  return out;
}

/** Parse one convention doc into a {@link KindConvention}, or a reason it was skipped. */
export function parseConventionDoc(
  doc: OkfDocument,
): (
  | { ok: true; kind: KindConvention; reservedFieldsIgnored: string[]; reservedFieldPaths: string[] }
  | { ok: false; reason: string }
) & { warnings: ValidationWarning[] } {
  const fm = doc.frontmatter as Record<string, unknown>;
  const governs = typeof fm.governs === "string" ? fm.governs.trim() : "";
  if (governs === "") {
    return { ok: false, reason: "missing or empty 'governs' field", warnings: [] };
  }

  const warnings: ValidationWarning[] = [];

  // Top-level near-miss constraint keys (see MISPLACED_TOP_LEVEL_KEYS doc comment): warn ONLY on
  // this small deny-adjacent set — never on arbitrary other top-level keys.
  for (const key of MISPLACED_TOP_LEVEL_KEYS) {
    if (key in fm) {
      warnings.push({
        code: "KIND_CONVENTION_MISPLACED_KEY",
        message: `kind convention '${doc.id}' declares a top-level '${key}' key, which core does not read; enum constraints go under 'fields.values.<field>: [...]', not '${key}'.`,
        field: key,
        severity: "warning",
      });
    }
  }

  const fieldsSource = fm.fields;
  let fieldsRaw: Record<string, unknown> = {};
  if (fieldsSource === undefined) {
    // absent 'fields:' — nothing to declare, nothing to warn about.
  } else if (!isPlainObject(fieldsSource)) {
    warnings.push({
      code: "KIND_CONVENTION_BAD_SHAPE",
      message: `kind convention '${doc.id}' has a non-map 'fields' key (${describeShape(fieldsSource)}; expected a map with required/optional/values/value_descriptions/descriptions); ignoring it.`,
      field: "fields",
      severity: "warning",
    });
  } else {
    fieldsRaw = fieldsSource;
    for (const key of Object.keys(fieldsRaw)) {
      if (!VALID_FIELDS_KEYS.has(key)) {
        warnings.push({
          code: "KIND_CONVENTION_UNKNOWN_FIELDS_KEY",
          message: `kind convention '${doc.id}' declares an unrecognized key 'fields.${key}' (valid keys: fields.required, fields.optional, fields.values, fields.value_descriptions, fields.terminal, fields.descriptions); ignoring it.`,
          field: `fields.${key}`,
          severity: "warning",
        });
      }
    }
  }

  const reservedFieldsIgnored = new Set<string>();
  const reservedFieldPaths = new Set<string>();
  const dropReserved = (name: string, semanticPath: string): boolean => {
    if (!RESERVED_FIELD_NAMES.has(name)) return false;
    reservedFieldsIgnored.add(name);
    reservedFieldPaths.add(semanticPath);
    return true;
  };
  const required = toStringArrayLenient(fieldsRaw.required, "fields.required", doc.id, warnings).filter(
    (f) => !dropReserved(f, `fields.required.${f}`),
  );
  const optional = toStringArrayLenient(fieldsRaw.optional, "fields.optional", doc.id, warnings).filter(
    (f) => !dropReserved(f, `fields.optional.${f}`),
  );

  const valuesSource = fieldsRaw.values;
  const values: Record<string, string[]> = {};
  if (valuesSource !== undefined) {
    if (!isPlainObject(valuesSource)) {
      warnings.push({
        code: "KIND_CONVENTION_BAD_SHAPE",
        message: `kind convention '${doc.id}' has a non-map 'fields.values' (${describeShape(valuesSource)}; expected a map of field name -> list of allowed values); ignoring it.`,
        field: "fields.values",
        severity: "warning",
      });
    } else {
      for (const [field, allowed] of Object.entries(valuesSource)) {
        if (dropReserved(field, `fields.values.${field}`)) continue;
        setOwn(values, field, toStringArrayLenient(allowed, `fields.values.${field}`, doc.id, warnings));
      }
    }
  }

  // A values-constrained field that names neither a required nor an optional field is almost
  // certainly a mistake (a declared constraint on an undeclared field can never fire, since
  // `validateAgainstKind` only sees fields the instance actually carries — but the AUTHOR meant
  // something).
  const declaredFieldNames = new Set([...required, ...optional]);
  for (const field of Object.keys(values)) {
    if (!declaredFieldNames.has(field)) {
      warnings.push({
        code: "KIND_CONVENTION_UNDECLARED_VALUES_FIELD",
        message: `kind convention '${doc.id}' declares 'fields.values.${field}' but '${field}' is not in fields.required or fields.optional.`,
        field: `fields.values.${field}`,
        severity: "warning",
      });
    }
  }

  const valueDescriptionsSource = fieldsRaw.value_descriptions;
  const valueDescriptions: Record<string, Record<string, string>> = {};
  if (valueDescriptionsSource !== undefined) {
    if (!isPlainObject(valueDescriptionsSource)) {
      warnings.push({
        code: "KIND_CONVENTION_BAD_SHAPE",
        message: `kind convention '${doc.id}' has a non-map 'fields.value_descriptions' (${describeShape(valueDescriptionsSource)}; expected a map of enum field -> allowed value -> non-empty description); ignoring it.`,
        field: "fields.value_descriptions",
        severity: "warning",
      });
    } else {
      for (const [field, rawValueDescriptions] of Object.entries(valueDescriptionsSource)) {
        const fieldPath = `fields.value_descriptions.${field}`;
        if (!isPlainObject(rawValueDescriptions)) {
          warnings.push({
            code: "KIND_CONVENTION_BAD_SHAPE",
            message: `kind convention '${doc.id}' has a non-map '${fieldPath}' (${describeShape(rawValueDescriptions)}; expected a map of allowed value -> non-empty description); ignoring it.`,
            field: fieldPath,
            severity: "warning",
          });
          continue;
        }
        if (!hasOwn(values, field)) {
          warnings.push({
            code: "KIND_CONVENTION_UNDECLARED_VALUE_DESCRIPTION_FIELD",
            message: `kind convention '${doc.id}' declares '${fieldPath}' but '${field}' has no 'fields.values.${field}' enum declared; skipping it.`,
            field: fieldPath,
            severity: "warning",
          });
          continue;
        }
        const allowed = values[field]!;
        const parsed: Record<string, string> = {};
        for (const [value, rawDescription] of Object.entries(rawValueDescriptions)) {
          const valuePath = `${fieldPath}.${value}`;
          if (typeof rawDescription !== "string" || rawDescription.trim() === "") {
            warnings.push({
              code: "KIND_CONVENTION_BAD_MEMBER",
              message: `kind convention '${doc.id}' has a malformed '${valuePath}' (${describeShape(rawDescription)}; expected a non-empty string); skipping it.`,
              field: valuePath,
              severity: "warning",
            });
            continue;
          }
          if (!allowed.includes(value)) {
            warnings.push({
              code: "KIND_CONVENTION_UNDECLARED_VALUE_DESCRIPTION_VALUE",
              message: `kind convention '${doc.id}' declares '${valuePath}' but '${value}' is not one of the declared 'fields.values.${field}' values (${allowed.join(", ")}); skipping it.`,
              field: valuePath,
              severity: "warning",
            });
            continue;
          }
          setOwn(parsed, value, rawDescription.trim());
        }
        if (Object.keys(parsed).length > 0) setOwn(valueDescriptions, field, parsed);
      }
    }
  }

  const descriptionsSource = fieldsRaw.descriptions;
  const descriptions: Record<string, string> = {};
  if (descriptionsSource !== undefined) {
    if (!isPlainObject(descriptionsSource)) {
      warnings.push({
        code: "KIND_CONVENTION_BAD_SHAPE",
        message: `kind convention '${doc.id}' has a non-map 'fields.descriptions' (${describeShape(descriptionsSource)}; expected a map of field name -> non-empty description); ignoring it.`,
        field: "fields.descriptions",
        severity: "warning",
      });
    } else {
      for (const [field, rawDescription] of Object.entries(descriptionsSource)) {
        if (dropReserved(field, `fields.descriptions.${field}`)) continue;
        if (typeof rawDescription !== "string" || rawDescription.trim() === "") {
          warnings.push({
            code: "KIND_CONVENTION_BAD_MEMBER",
            message: `kind convention '${doc.id}' has a malformed 'fields.descriptions.${field}' (${describeShape(rawDescription)}; expected a non-empty string); skipping it.`,
            field: `fields.descriptions.${field}`,
            severity: "warning",
          });
          continue;
        }
        setOwn(descriptions, field, rawDescription.trim());
        if (!declaredFieldNames.has(field)) {
          warnings.push({
            code: "KIND_CONVENTION_UNDECLARED_DESCRIPTION_FIELD",
            message: `kind convention '${doc.id}' declares 'fields.descriptions.${field}' but '${field}' is not in fields.required or fields.optional.`,
            field: `fields.descriptions.${field}`,
            severity: "warning",
          });
        }
      }
    }
  }

  // `fields.terminal` — the subset of values (per field) that mark an instance "done" (task board
  // `tasks/status-terminal-declaration.md`). EXACTLY the lenient posture of `fields.values` above:
  // absent is normal, a non-map shape warns+ignores, a non-scalar member warns+skips.
  const terminalSource = fieldsRaw.terminal;
  const terminal: Record<string, string[]> = {};
  if (terminalSource !== undefined) {
    if (!isPlainObject(terminalSource)) {
      warnings.push({
        code: "KIND_CONVENTION_BAD_SHAPE",
        message: `kind convention '${doc.id}' has a non-map 'fields.terminal' (${describeShape(terminalSource)}; expected a map of field name -> list of terminal values); ignoring it.`,
        field: "fields.terminal",
        severity: "warning",
      });
    } else {
      for (const [field, terminalValues] of Object.entries(terminalSource)) {
        if (dropReserved(field, `fields.terminal.${field}`)) continue;
        setOwn(terminal, field, toStringArrayLenient(terminalValues, `fields.terminal.${field}`, doc.id, warnings));
      }
    }
  }

  // Coherence warning 1: a terminal set declared over a field with no `fields.values` enum at all
  // (mirrors the UNDECLARED_VALUES_FIELD check above — the author probably meant to declare the
  // enum too). Coherence warning 2: a terminal VALUE that isn't one of that field's declared enum
  // values (only checked when the field's enum IS declared, to avoid double-warning the same
  // mistake two different ways).
  for (const field of Object.keys(terminal)) {
    if (!hasOwn(values, field)) {
      warnings.push({
        code: "KIND_CONVENTION_TERMINAL_UNDECLARED_FIELD",
        message: `kind convention '${doc.id}' declares 'fields.terminal.${field}' but '${field}' has no 'fields.values.${field}' enum declared.`,
        field: `fields.terminal.${field}`,
        severity: "warning",
      });
      continue;
    }
    const allowed = values[field]!;
    for (const v of terminal[field]!) {
      if (!allowed.includes(v)) {
        warnings.push({
          code: "KIND_CONVENTION_TERMINAL_VALUE",
          message: `kind convention '${doc.id}' declares terminal value '${v}' for field '${field}' but it is not one of the declared 'fields.values.${field}' values (${allowed.join(", ")}).`,
          field: `fields.terminal.${field}`,
          severity: "warning",
        });
      }
    }
  }

  // `links:` — the typed-edge vocabulary (see the KindConvention.links doc comment). Same
  // lenient posture as `fields`: absent is normal (no warning), a non-map shape warns and is
  // ignored, a malformed entry warns and is skipped — never thrown.
  const linksSource = fm.links;
  let links: Record<string, string> | undefined;
  if (linksSource !== undefined) {
    if (!isPlainObject(linksSource)) {
      warnings.push({
        code: "KIND_CONVENTION_BAD_SHAPE",
        message: `kind convention '${doc.id}' has a non-map 'links' key (${describeShape(linksSource)}; expected a map of link type name -> target kind); ignoring it.`,
        field: "links",
        severity: "warning",
      });
    } else {
      const parsed: Record<string, string> = {};
      for (const [linkType, target] of Object.entries(linksSource)) {
        const name = linkType.trim();
        if (name === "" || !isScalar(target) || String(target).trim() === "") {
          warnings.push({
            code: "KIND_CONVENTION_BAD_MEMBER",
            message: `kind convention '${doc.id}' has a malformed 'links' entry ('${linkType}': ${describeShape(target)}; expected 'link type name: target kind'); skipping it.`,
            field: `links.${linkType}`,
            severity: "warning",
          });
          continue;
        }
        setOwn(parsed, name, String(target).trim());
      }
      if (Object.keys(parsed).length > 0) links = parsed;
    }
  }

  // Relationship descriptions belong to the SOURCE kind's `links` declaration. They are
  // guidance only: malformed or undeclared entries warn and are skipped, never becoming a
  // second link vocabulary or changing validation/storage behavior.
  const linkDescriptionsSource = fm.link_descriptions;
  let linkDescriptions: Record<string, string> | undefined;
  if (linkDescriptionsSource !== undefined) {
    if (!isPlainObject(linkDescriptionsSource)) {
      warnings.push({
        code: "KIND_CONVENTION_BAD_SHAPE",
        message: `kind convention '${doc.id}' has a non-map 'link_descriptions' key (${describeShape(linkDescriptionsSource)}; expected a map of declared link type name -> non-empty description); ignoring it.`,
        field: "link_descriptions",
        severity: "warning",
      });
    } else {
      const parsed: Record<string, string> = {};
      for (const [linkType, rawDescription] of Object.entries(linkDescriptionsSource)) {
        const name = linkType.trim();
        const semanticPath = `link_descriptions.${linkType}`;
        if (name === "" || typeof rawDescription !== "string" || rawDescription.trim() === "") {
          warnings.push({
            code: "KIND_CONVENTION_BAD_MEMBER",
            message: `kind convention '${doc.id}' has a malformed '${semanticPath}' (${describeShape(rawDescription)}; expected a declared link type name with a non-empty string description); skipping it.`,
            field: semanticPath,
            severity: "warning",
          });
          continue;
        }
        if (!links || !hasOwn(links, name)) {
          warnings.push({
            code: "KIND_CONVENTION_UNDECLARED_LINK_DESCRIPTION",
            message: `kind convention '${doc.id}' declares '${semanticPath}' but '${name}' is not declared in links.`,
            field: semanticPath,
            severity: "warning",
          });
          continue;
        }
        setOwn(parsed, name, rawDescription.trim());
      }
      if (Object.keys(parsed).length > 0) linkDescriptions = parsed;
    }
  }

  // `expects_inbound:` — inbound-link expectations this kind declares on ITSELF as link TARGET
  // (see the KindConvention.expectsInbound doc comment). Same lenient posture as `links`: absent
  // is normal (no warning), a non-map shape warns and is ignored, a malformed entry warns and is
  // skipped — never thrown.
  const expectsInboundSource = fm.expects_inbound;
  let expectsInbound: Record<string, string> | undefined;
  if (expectsInboundSource !== undefined) {
    if (!isPlainObject(expectsInboundSource)) {
      warnings.push({
        code: "KIND_CONVENTION_BAD_SHAPE",
        message: `kind convention '${doc.id}' has a non-map 'expects_inbound' key (${describeShape(expectsInboundSource)}; expected a map of link type name -> expected source kind); ignoring it.`,
        field: "expects_inbound",
        severity: "warning",
      });
    } else {
      const parsed: Record<string, string> = {};
      for (const [linkType, source] of Object.entries(expectsInboundSource)) {
        const name = linkType.trim();
        if (name === "" || !isScalar(source) || String(source).trim() === "") {
          warnings.push({
            code: "KIND_CONVENTION_BAD_MEMBER",
            message: `kind convention '${doc.id}' has a malformed 'expects_inbound' entry ('${linkType}': ${describeShape(source)}; expected 'link type name: expected source kind'); skipping it.`,
            field: `expects_inbound.${linkType}`,
            severity: "warning",
          });
          continue;
        }
        setOwn(parsed, name, String(source).trim());
      }
      if (Object.keys(parsed).length > 0) expectsInbound = parsed;
    }
  }

  const sections = Array.isArray(fm.sections)
    ? fm.sections.filter((s): s is string => typeof s === "string" && s.trim() !== "")
    : undefined;

  const title = typeof fm.title === "string" && fm.title.trim() !== "" ? fm.title.trim() : governs;
  let description: string | undefined;
  if (fm.description !== undefined) {
    if (typeof fm.description === "string" && fm.description.trim() !== "") {
      description = fm.description.trim();
    } else {
      warnings.push({
        code: "KIND_CONVENTION_BAD_SHAPE",
        message: `kind convention '${doc.id}' has an invalid 'description' (${describeShape(fm.description)}; expected a non-empty string); ignoring it.`,
        field: "description",
        severity: "warning",
      });
    }
  }
  const path = typeof fm.path === "string" && fm.path.trim() !== "" ? fm.path.trim() : undefined;
  const freshnessHorizon =
    typeof fm.freshness_horizon === "string" && fm.freshness_horizon.trim() !== ""
      ? fm.freshness_horizon.trim()
      : undefined;
  // Strict boolean `true` only — an absent, false, or non-boolean value means "expanded" (the default).
  const browseCollapsed = fm.browse_collapsed === true ? true : undefined;

  const kind: KindConvention = {
    id: doc.id,
    title,
    governs,
    fields: { required, optional, values, valueDescriptions, terminal, descriptions },
  };
  if (description !== undefined) kind.description = description;
  if (path !== undefined) kind.path = path;
  if (links !== undefined) kind.links = links;
  if (linkDescriptions !== undefined) kind.linkDescriptions = linkDescriptions;
  if (expectsInbound !== undefined) kind.expectsInbound = expectsInbound;
  if (sections && sections.length > 0) kind.sections = sections;
  if (freshnessHorizon !== undefined) kind.freshnessHorizon = freshnessHorizon;
  if (browseCollapsed !== undefined) kind.browseCollapsed = browseCollapsed;
  return {
    ok: true,
    kind,
    reservedFieldsIgnored: [...reservedFieldsIgnored].sort(),
    reservedFieldPaths: [...reservedFieldPaths].sort(),
    warnings,
  };
}


const HORIZON_RE = /^(\d+)(m|h|d)$/;
const HORIZON_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parse a kind's declared `freshness_horizon` (`<n>(m|h|d)`) to milliseconds, or
 * `undefined` if the kind declares none or it is malformed. This FEEDS the existing
 * {@link FreshnessOptions.maxAgeMs} at the CLI layer — it does not fork `freshness()`.
 */
export function freshnessHorizonMs(kind: KindConvention): number | undefined {
  const raw = kind.freshnessHorizon;
  if (raw === undefined) return undefined;
  const m = HORIZON_RE.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  // A zero horizon (e.g. "0h") would make every instance instantly stale — reject it the same
  // way as a malformed string, rather than silently accepting a horizon that can never be met.
  if (n <= 0) return undefined;
  const unit = m[2]!;
  return n * HORIZON_UNIT_MS[unit]!;
}

/** True when a required-field value counts as "present" (non-empty string / non-empty array / any other defined value). */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Validate `doc` against `kind`: required fields present + non-empty, enum-restricted
 * field values within the declared allowed set, and declared body `sections` present
 * (reusing the ONE heading splitter, {@link splitSections} — no second heading parser).
 * Returns core's EXISTING {@link ValidationWarning} shape; never throws. Purely
 * additive derivation — callers (the CLI) decide whether a warning blocks a write.
 */
export function validateAgainstKind(doc: OkfDocument, kind: KindConvention): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const fm = doc.frontmatter as Record<string, unknown>;

  for (const field of kind.fields.required) {
    if (!hasOwn(fm, field) || !isPresent(fm[field])) {
      warnings.push({
        code: "KIND_FIELD_MISSING",
        message: `'${kind.governs}' requires a non-empty '${field}' field (declared by ${kind.id}).`,
        field,
        severity: "warning",
      });
    }
  }

  for (const [field, allowed] of Object.entries(kind.fields.values)) {
    if (!hasOwn(fm, field)) continue;
    const raw = fm[field];
    if (raw === undefined || raw === null) continue;
    // Arity: a `fields.values`-constrained field has SCALAR semantics by construction
    // (an enum picks ONE state — `status`), so an ARRAY value is a violation even when
    // every member passes the per-element membership check below. Without this,
    // `--status todo --status done` persists a two-status doc with ZERO warnings, even
    // strict (repeated-flag → array is a real FEATURE for non-enum fields like `tags`,
    // so the guard lives HERE on the enum constraint, not in any command's parser — one
    // validation locus, every consumer inherits: `new`, `doc update`, `doc write
    // --strict`, `status`'s bundle lint). A future kind wanting a multi-select enum
    // needs declared arity in the convention schema — not silently via arrays.
    if (Array.isArray(raw)) {
      warnings.push({
        code: "KIND_FIELD_ARITY",
        message:
          `'${field}' is enum-restricted and takes exactly ONE value for '${kind.governs}'; ` +
          `got ${raw.length} (${raw.map((v) => String(v)).join(", ")}).`,
        field,
        severity: "warning",
      });
    }
    const allowedStrs = allowed.map((v) => String(v));
    const actual = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v));
    for (const v of actual) {
      if (!allowedStrs.includes(v)) {
        warnings.push({
          code: "KIND_FIELD_VALUE",
          message: `'${field}' value '${v}' is not one of the allowed values for '${kind.governs}': ${allowedStrs.join(", ")}.`,
          field,
          severity: "warning",
        });
      }
    }
  }

  if (kind.sections && kind.sections.length > 0) {
    const sections = splitSections(doc.body ?? "");
    for (const heading of kind.sections) {
      if (!hasOwn(sections, heading)) {
        warnings.push({
          code: "KIND_SECTION_MISSING",
          message: `'${kind.governs}' expects a '# ${heading}' body section (declared by ${kind.id}).`,
          field: heading,
          severity: "warning",
        });
      }
    }
  }

  return warnings;
}

/** Result of validating a document through a bundle's already-loaded kind registry. */
export interface RegistryValidationResult {
  /** The governing kind, when the document's type is declared in this registry. */
  kind?: KindConvention;
  warnings: ValidationWarning[];
}

/**
 * Default a document timestamp before evaluating its governing kind. This ordering is
 * shared by every trusted document writer: a kind requiring `timestamp` validates the
 * value that will actually be persisted, never a still-missing pre-write candidate.
 * The registry is supplied by the caller so mutation does not perform hidden discovery.
 */
export function defaultTimestampAndValidateAgainstRegistry(
  doc: OkfDocument,
  registry: KindRegistry,
): RegistryValidationResult {
  if (!isUsableTimestamp(doc.frontmatter.timestamp)) {
    doc.frontmatter.timestamp = new Date().toISOString();
  }
  const kind = registry.kinds.get(String(doc.frontmatter.type));
  if (!kind) return { warnings: [] };
  return { kind, warnings: validateAgainstKind(doc, kind) };
}

/**
 * True iff `frontmatter` carries a terminal value on any field `kind.fields.terminal` declares
 * (task board `tasks/status-terminal-declaration.md`) — THE one derivation every consumer calls
 * (list's `--open`, the `status` sweep's exclusion + sort fallback). Coercion mirrors
 * `validateAgainstKind`'s enum check: `String(v)` per element, so an unquoted YAML scalar still
 * matches, and an array field matches on ANY-member semantics: ONE terminal value anywhere in an
 * array field marks the whole doc terminal (a doc with `status: [done, doing]` IS terminal), so
 * multi-valued fields should only declare terminal values whose mere presence means "closed". A
 * kind with an empty `fields.terminal` (no declaration), or a doc missing every declared terminal
 * field, is never terminal — not-terminal is the safe default.
 */
export function isTerminal(kind: KindConvention, frontmatter: Frontmatter): boolean {
  const fm = frontmatter as Record<string, unknown>;
  for (const [field, terminalValues] of Object.entries(kind.fields.terminal)) {
    if (!hasOwn(fm, field)) continue;
    const raw = fm[field];
    if (raw === undefined || raw === null) continue;
    const actual = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v));
    if (actual.some((v) => terminalValues.includes(v))) return true;
  }
  return false;
}

/**
 * Build the OKF concept document for a kind convention (the shape a `Convention` doc
 * takes on disk — used to serialize any KindConvention to its on-disk Convention-doc form
 * (e.g. by the CLI's recipe machinery)). `timestamp` is the caller's ISO instant (kept
 * explicit rather than defaulted here, since `writeDocVersioned` already guarantees one).
 */
export function kindConventionDoc(kind: KindConvention, prose: string, timestamp: string): OkfDocument {
  const fields: Record<string, unknown> = { required: kind.fields.required, optional: kind.fields.optional };
  if (Object.keys(kind.fields.values).length > 0) fields.values = kind.fields.values;
  const valueDescriptions = Object.fromEntries(
    Object.entries(kind.fields.valueDescriptions ?? {})
      .filter(([field]) => hasOwn(kind.fields.values, field))
      .map(([field, descriptions]) => {
        const allowed = kind.fields.values[field]!;
        const validDescriptions = Object.fromEntries(
          Object.entries(descriptions)
            .filter(
              ([value, description]) =>
                hasOwn(descriptions, value) &&
                allowed.includes(value) &&
                typeof description === "string" &&
                description.trim() !== "",
            )
            .map(([value, description]) => [value, description.trim()]),
        );
        return [field, validDescriptions] as const;
      })
      .filter(([, descriptions]) => Object.keys(descriptions).length > 0),
  );
  if (Object.keys(valueDescriptions).length > 0) fields.value_descriptions = valueDescriptions;
  if (Object.keys(kind.fields.terminal).length > 0) fields.terminal = kind.fields.terminal;
  const descriptions = Object.fromEntries(
    Object.entries(kind.fields.descriptions)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "")
      .map(([field, description]) => [field, description.trim()]),
  );
  if (Object.keys(descriptions).length > 0) fields.descriptions = descriptions;

  const frontmatter: Frontmatter = { type: CONVENTION_TYPE, title: kind.title, governs: kind.governs, timestamp };
  if (typeof kind.description === "string" && kind.description.trim() !== "") {
    frontmatter.description = kind.description.trim();
  }
  if (kind.path !== undefined) frontmatter.path = kind.path;
  if (kind.links && Object.keys(kind.links).length > 0) frontmatter.links = kind.links;
  const linkDescriptions = Object.fromEntries(
    Object.entries(kind.linkDescriptions ?? {})
      .filter(
        (entry): entry is [string, string] =>
          Boolean(kind.links && hasOwn(kind.links, entry[0])) &&
          typeof entry[1] === "string" &&
          entry[1].trim() !== "",
      )
      .map(([linkType, description]) => [linkType, description.trim()]),
  );
  if (Object.keys(linkDescriptions).length > 0) frontmatter.link_descriptions = linkDescriptions;
  if (kind.expectsInbound && Object.keys(kind.expectsInbound).length > 0) {
    frontmatter.expects_inbound = kind.expectsInbound;
  }
  frontmatter.fields = fields;
  if (kind.sections && kind.sections.length > 0) frontmatter.sections = kind.sections;
  if (kind.freshnessHorizon !== undefined) frontmatter.freshness_horizon = kind.freshnessHorizon;
  if (kind.browseCollapsed) frontmatter.browse_collapsed = true;

  return { id: kind.id, frontmatter, body: prose };
}
