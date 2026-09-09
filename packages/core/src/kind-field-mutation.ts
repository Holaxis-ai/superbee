/** Pure Kind schema editing. The mutation engine supplies the fresh convention. */
import { RESERVED_KIND_FIELD_NAMES } from "./kinds.js";
import { InvalidInputError } from "./errors.js";
import type { Frontmatter, OkfDocument } from "./types.js";
import type { DocumentMutationCandidate } from "./document-mutation.js";
export class KindFieldMutationConflict extends InvalidInputError {}
export interface KindFieldMutation {
  governs: string;
  field: string;
  action: "add" | "remove";
  required?: boolean;
  values?: string[];
  okfVersion: "0.1" | "0.2";
}
/** Normalize a possibly-absent/malformed `fields.<list>` into a fresh string[]. */
function toStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) setOwn(clone, key, value);
  return clone;
}

function deleteOwn(record: Record<string, unknown>, key: string): boolean {
  return hasOwn(record, key) && delete record[key];
}


export function prepareKindFieldMutation(existing: OkfDocument, input: KindFieldMutation, okfVersion: "0.1" | "0.2"): DocumentMutationCandidate {
  if (typeof input.field !== "string" || input.field.trim() === "" || !["add", "remove"].includes(input.action)) throw new InvalidInputError("A Kind field mutation requires add/remove and a nonempty field name.");
  if (input.action === "add" && (RESERVED_KIND_FIELD_NAMES as readonly string[]).includes(input.field)) throw new InvalidInputError(`'${input.field}' is reserved and cannot be added as a Kind field.`);
  if (input.values !== undefined && (!Array.isArray(input.values) || input.values.length === 0 || input.values.some(value => typeof value !== "string" || value.trim() === ""))) throw new InvalidInputError("Kind enum values must be nonempty strings.");
  if (input.action === "remove" && (input.required || input.values !== undefined)) throw new InvalidInputError("required/values apply to Kind field add, not remove.");
  const fm = existing.frontmatter;
  if (okfVersion !== input.okfVersion) throw new KindFieldMutationConflict("The bundle format changed while editing the Kind; reload the Kind.");
  const currentGoverns = typeof fm.governs === "string" ? fm.governs.trim() : "";
  if (currentGoverns !== input.governs) throw new KindFieldMutationConflict(`'${existing.id}' no longer governs '${input.governs}'; it now governs '${currentGoverns}'. Reload the Kind.`);
      const fieldsObj = isRecord(fm.fields) ? cloneRecord(fm.fields) : {};
      const required = toStringList(fieldsObj.required);
      const optional = toStringList(fieldsObj.optional);
      const valuesMap: Record<string, unknown> =
        hasOwn(fieldsObj, "values") && isRecord(fieldsObj.values)
          ? cloneRecord(fieldsObj.values)
          : {};
      const descriptionsMap: Record<string, unknown> | undefined =
        hasOwn(fieldsObj, "descriptions") && isRecord(fieldsObj.descriptions)
          ? cloneRecord(fieldsObj.descriptions)
          : undefined;
      const rawValueDescriptions = hasOwn(fieldsObj, "value_descriptions")
        ? fieldsObj.value_descriptions
        : undefined;
      let valueDescriptionsMap: Record<string, unknown> | undefined;
      let valueDescriptionsChanged = false;
      let descriptionDeleted = false;

      if (input.action === "add") {
        const targetList = input.required ? required : optional;
        const otherList = input.required ? optional : required;
        // Re-classifying an existing field (e.g. `add --required` a currently-optional field) moves it.
        const otherIdx = otherList.indexOf(input.field);
        if (otherIdx >= 0) otherList.splice(otherIdx, 1);
        if (!targetList.includes(input.field)) targetList.push(input.field);
        if (input.values) {
          const vals = input.values;
          const prev = hasOwn(valuesMap, input.field) && Array.isArray(valuesMap[input.field])
            ? (valuesMap[input.field] as unknown[]).map(String)
            : undefined;
          // Collision-resistant comparison: `prev.join(" ") !==
          // vals.join(" ")` conflated DIFFERENT enum lists that happen to join to the same string
          // — e.g. ["a b","c"] and ["a","b c"] BOTH become "a b c" — so `--values "a,b c"` over an
          // existing ["a b","c"] wrongly reported changed:false. Length + element-wise instead; no
          // delimiter choice can ever collide.
          const same = !!prev && prev.length === vals.length && prev.every((v, i) => v === vals[i]);
          if (!same) setOwn(valuesMap, input.field, vals);

          if (isRecord(rawValueDescriptions) && hasOwn(rawValueDescriptions, input.field)) {
            const rawFieldDescriptions = rawValueDescriptions[input.field];
            if (isRecord(rawFieldDescriptions)) {
              const retained: Record<string, unknown> = {};
              for (const [value, description] of Object.entries(rawFieldDescriptions)) {
                if (vals.includes(value)) setOwn(retained, value, description);
              }
              if (Object.keys(retained).length !== Object.keys(rawFieldDescriptions).length) {
                valueDescriptionsMap = cloneRecord(rawValueDescriptions);
                if (Object.keys(retained).length > 0) setOwn(valueDescriptionsMap, input.field, retained);
                else deleteOwn(valueDescriptionsMap, input.field);
                valueDescriptionsChanged = true;
              }
            }
          }
        }
      } else {
        for (const list of [required, optional]) {
          const idx = list.indexOf(input.field);
          if (idx >= 0) list.splice(idx, 1);
        }
        deleteOwn(valuesMap, input.field);
        if (descriptionsMap) descriptionDeleted = deleteOwn(descriptionsMap, input.field);
        if (isRecord(rawValueDescriptions) && hasOwn(rawValueDescriptions, input.field)) {
          const rawFieldDescriptions = rawValueDescriptions[input.field];
          if (isRecord(rawFieldDescriptions)) {
            valueDescriptionsMap = cloneRecord(rawValueDescriptions);
            deleteOwn(valueDescriptionsMap, input.field);
            valueDescriptionsChanged = true;
          }
        }
      }


      // Rebuild `fields` FROM the original raw object, replacing only the three keys this command
      // owns (required/optional/values, omitted when now-empty so the convention stays clean).
      // Every OTHER sibling key — `terminal` today, any future declaration key — passes through
      // VERBATIM, matching the registry's lenient-parse posture: an unrelated `kind field` edit
      // must never destroy a declaration it doesn't understand (regression-pinned in
      // kind.test.ts). `changed`/no-op detection is `mutateDoc`'s job (structural comparison
      // against the existing doc, ignoring timestamp — this command never refreshes it).
      const newFields: Record<string, unknown> = { ...fieldsObj };
      if (required.length > 0) newFields.required = required;
      else delete newFields.required;
      if (optional.length > 0) newFields.optional = optional;
      else delete newFields.optional;
      if (Object.keys(valuesMap).length > 0) newFields.values = valuesMap;
      else delete newFields.values;
      if (descriptionsMap && descriptionDeleted) {
        if (Object.keys(descriptionsMap).length > 0) newFields.descriptions = descriptionsMap;
        else delete newFields.descriptions;
      }
      if (valueDescriptionsMap && valueDescriptionsChanged) {
        if (Object.keys(valueDescriptionsMap).length > 0) newFields.value_descriptions = valueDescriptionsMap;
        else delete newFields.value_descriptions;
      }
      const newFm: Frontmatter = { ...fm };
      if (Object.keys(newFields).length > 0) newFm.fields = newFields;
      else delete newFm.fields;

      return { frontmatter: newFm, body: existing.body };
}
