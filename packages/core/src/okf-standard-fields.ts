/** OKF v0.2 authoring rules, independent of bundle-specific Kind conventions and raw imports. */
import { InvalidInputError } from "./errors.js";
import { isOkfActor } from "./okf-actor.js";
import { assertAuthoredOkfTimestamps } from "./okf-timestamps.js";
import { authoredOkfRows, isOkfRecord, okfValuesEqual, type OkfRecord } from "./okf-authored-values.js";

const string = (value: unknown): boolean => typeof value === "string";
const nonempty = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
const count = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
function fail(path: string, expected: string): never {
  throw new InvalidInputError(`OKF v0.2 ${path} must be ${expected}`);
}

/**
 * Existing imported scalar values survive unchanged. Collection exemptions apply to exact rows
 * once each, so a row edit validates all standard children without losing producer extensions.
 * Input may omit generated.by for engine completion; final newly authored records require it.
 */
export function assertAuthoredOkfStandardFields(
  frontmatter: OkfRecord,
  existing?: OkfRecord,
  options: { phase?: "input" | "final" } = {},
): void {
  const field = (owner: OkfRecord, key: string, path: string, valid: (value: unknown) => boolean, expected: string, previous?: OkfRecord, required = false): void => {
    if (!Object.hasOwn(owner, key)) {
      if (required && !(previous && !Object.hasOwn(previous, key))) fail(path, expected);
      return;
    }
    if (previous && Object.hasOwn(previous, key) && okfValuesEqual(owner[key], previous[key])) return;
    if (!valid(owner[key])) fail(path, expected);
  };
  const strings = (value: unknown, path: string): void => {
    if (!Array.isArray(value)) fail(path, "a list of strings");
    Array.from(value).forEach((entry, index) => { if (!string(entry)) fail(`${path}[${index}]`, "a string"); });
  };
  const mapping = (owner: OkfRecord, key: string, path: string, previous?: OkfRecord): OkfRecord | undefined => {
    if (!Object.hasOwn(owner, key)) return undefined;
    if (!isOkfRecord(owner[key])) {
      if (previous && Object.hasOwn(previous, key) && okfValuesEqual(owner[key], previous[key])) return undefined;
      fail(path, "a mapping when present");
    }
    return owner[key];
  };
  const list = (key: string, previous: OkfRecord | undefined, validate: (entry: OkfRecord, path: string) => void, allowBare = false): void => {
    if (!Object.hasOwn(frontmatter, key)) return;
    const value = frontmatter[key];
    if (!Array.isArray(value) && !(allowBare && isOkfRecord(value))) {
      if (previous && Object.hasOwn(previous, key) && okfValuesEqual(value, previous[key])) return;
      fail(key, allowBare ? "a list of events or one event mapping" : "a list");
    }
    for (const { entry, index } of authoredOkfRows(value, previous?.[key], allowBare)) {
      const path = allowBare && !Array.isArray(value) ? key : `${key}[${index}]`;
      if (!isOkfRecord(entry)) fail(path, "a mapping");
      validate(entry, path);
    }
  };
  field(frontmatter, "type", "type", nonempty, "a nonempty string", undefined, true);
  for (const key of ["title", "description", "resource"]) field(frontmatter, key, key, string, "a string", existing);
  if (Object.hasOwn(frontmatter, "tags") && !(existing && Object.hasOwn(existing, "tags") && okfValuesEqual(frontmatter.tags, existing.tags))) strings(frontmatter.tags, "tags");
  field(frontmatter, "status", "status", value => typeof value === "string" && ["draft", "stable", "deprecated"].includes(value), "draft, stable, or deprecated", existing);
  mapping(frontmatter, "usage_window", "usage_window", existing);
  const generated = mapping(frontmatter, "generated", "generated", existing);
  if (generated) {
    const previous = isOkfRecord(existing?.generated) ? existing.generated : undefined;
    // A missing actor is grandfathered only on an entirely unchanged imported record.
    const required = options.phase !== "input" && !(previous && okfValuesEqual(generated, previous));
    field(generated, "by", "generated.by", isOkfActor, "human:<id>, process:<id>, or <producer>/<version>", previous, false);
    if (required && !Object.hasOwn(generated, "by")) fail("generated.by", "present when generated is authored");
  }
  list("verified", existing, (entry, path) => {
    field(entry, "by", `${path}.by`, isOkfActor, "human:<id>, process:<id>, or <producer>/<version>", undefined, true);
    field(entry, "at", `${path}.at`, string, "an ISO-8601 datetime with an explicit UTC offset", undefined, true);
  }, true);
  list("sources", existing, (entry, path) => {
    field(entry, "resource", `${path}.resource`, nonempty, "a nonempty string", undefined, true);
    for (const key of ["id", "title"]) field(entry, key, `${path}.${key}`, string, "a string");
    field(entry, "author", `${path}.author`, nonempty, "a nonempty string");
    field(entry, "usage_count", `${path}.usage_count`, count, "a finite nonnegative integer");
    mapping(entry, "usage_window", `${path}.usage_window`);
  });
  if (frontmatter.type === "Attested Computation") {
    const previous = existing?.type === frontmatter.type ? existing : undefined;
    field(frontmatter, "runtime", "runtime", nonempty, "a nonempty string", previous, true);
    field(frontmatter, "computation", "computation", string, "a string", previous);
    list("parameters", previous, (entry, path) => {
      for (const key of ["name", "type"]) field(entry, key, `${path}.${key}`, string, "a string", undefined, true);
      field(entry, "required", `${path}.required`, value => typeof value === "boolean", "a boolean");
    });
    for (const key of ["executor", "attester"]) {
      const entry = mapping(frontmatter, key, key, previous);
      if (!entry) continue;
      const prior = isOkfRecord(previous?.[key]) ? previous[key] : undefined;
      field(entry, "resource", `${key}.resource`, string, "a string", prior);
      if (key === "executor" && Object.hasOwn(entry, "receipt") && !(prior && Object.hasOwn(prior, "receipt") && okfValuesEqual(entry.receipt, prior.receipt))) strings(entry.receipt, "executor.receipt");
    }
  }
  assertAuthoredOkfTimestamps(frontmatter, existing);
}
