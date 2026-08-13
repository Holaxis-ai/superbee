// `superbee kind field "<Kind>" <add|remove> <name> …` — EDIT a kind convention's declared
// schema (add/remove a field, restrict it to an enum). The plural `kinds` command LISTS what a bundle
// declares; this SINGULAR `kind` command MUTATES one convention doc — the same plural-lists /
// singular-mutates split as `recipes`/`recipe`.
//
// Before this, evolving a kind's schema meant hand-editing the convention's markdown frontmatter (or
// pull→edit→promote over --remote) — the recurring maintenance-journey gap the cold-start usability
// study surfaced in every round (C3). This closes it: it reads the governing convention doc (its id
// comes from `loadKinds`), edits the raw `fields.{required,optional,values}` in place while preserving
// everything else (governs/path/sections/body, and any `fields.*` sibling key it doesn't own — e.g.
// `terminal` — carried through verbatim), and writes it back through the ordinary engine. Works
// over `--dir` and `--remote` alike (it is just a doc read + write). Idempotent: adding an
// already-declared field, or removing an absent one, is a no-op that exits 0.
import { parseArgs } from "node:util";
import { loadKinds, RESERVED_KIND_FIELD_NAMES, type Frontmatter } from "@superbee/core";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { CliError } from "../errors.js";
import { parseSelectorOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode } from "../output.js";
import { cliInvocation } from "../invocation.js";
import { mutateDoc } from "../mutate.js";

/** The core parser owns the one authoritative set of field names reserved by mutation surfaces. */
const RESERVED_FIELD_NAMES = new Set<string>(RESERVED_KIND_FIELD_NAMES);

export const KIND_USAGE = `superbee kind — edit a bundle's kind conventions (a kind's schema)

Usage:
  superbee kind field "<Kind>" add <name> [--required] [--values <a,b,c>] [options]
  superbee kind field "<Kind>" remove <name> [options]

Adds or removes a DECLARED field on the '<Kind>' kind's governing convention doc. The plural
'kinds' command LISTS what a bundle declares; this singular 'kind' command EDITS one (mirroring
'recipes'/'recipe'). A field added without --required is OPTIONAL; --values restricts it to an
enumerated set. Idempotent: adding an already-declared field (or removing an absent one) is a
no-op that exits 0. Preserves everything else on the convention (governs/path/sections/body, and
any fields.* sibling key this command does not own — e.g. a declared 'terminal' set).

Options:
  --required            Add the field as REQUIRED (default: optional). Ignored by 'remove'.
  --values <a,b,c>      Restrict the field to this comma-separated enum ('add' only)
  --dir <path>          Bundle directory (default: discovered from the cwd)
  --remote <url>        Talk to a wire-protocol server instead of a local bundle
  --actor <name>        Attribute this write
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help
`;

/** Injectable seam so the parse→edit wiring is unit-testable. */
export interface KindCliDeps {
  stdout: (s: string) => void;
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

export async function kind(argv: string[], deps: Partial<KindCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const { values, selection } = parseSelectorOrUsage(
    () =>
      parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          required: { type: "boolean" },
          values: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          actor: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      }),
    "kind",
    (positionals) => {
      if (positionals[0]?.trim() !== "field") return { kind: "unknown", token: positionals[0], reason: "subresource" } as const;
      const action = positionals[2]?.trim();
      if (action !== "add" && action !== "remove") return { kind: "unknown", token: action, reason: "action" } as const;
      const kindName = positionals[1];
      const fieldName = positionals[3];
      const data = [kindName, fieldName, ...positionals.slice(4)].filter((value): value is string => value !== undefined);
      return {
        kind: "selected",
        leaf: action === "add" ? CLI_LEAVES.kindFieldAdd : CLI_LEAVES.kindFieldRemove,
        data,
        payload: { kindName, action, fieldName },
      } as const;
    },
  );
  if (selection.kind === "help" || selection.kind === "navigation") {
    stdout(KIND_USAGE);
    return;
  }

  const helpHint = `${cliInvocation()} kind field "<Kind>" add <name>`;
  if (selection.kind === "unknown") {
    const message = selection.reason === "action"
      ? `kind field <Kind> <action>: action must be 'add' or 'remove', got '${selection.token ?? ""}'`
      : `kind: unknown or missing sub-resource '${selection.token ?? ""}' — only 'field' is supported (edit a kind's declared fields)`;
    throw new CliError(
      "USAGE",
      message,
      { help: helpHint },
    );
  }
  const kindName = selection.payload!.kindName?.trim();
  const action = selection.payload!.action;
  const fieldName = selection.payload!.fieldName?.trim();
  if (!kindName) {
    throw new CliError("USAGE", 'kind field requires a "<Kind>"', { help: helpHint });
  }
  if (!fieldName) {
    throw new CliError("USAGE", `kind field "${kindName}" ${action} requires a <name>`, { help: helpHint });
  }
  // Reject new collisions, but keep `remove` available as the supported migration path for a
  // convention authored before a name became reserved.
  if (action === "add" && RESERVED_FIELD_NAMES.has(fieldName)) {
    throw new CliError(
      "USAGE",
      `'${fieldName}' is reserved by the CLI and cannot be added as a kind field.`,
      { help: helpHint },
    );
  }
  if (action === "remove" && (values.required || values.values !== undefined)) {
    throw new CliError("USAGE", "--required/--values apply to 'add', not 'remove'", { help: helpHint });
  }
  if (values.actor !== undefined && values.actor.trim() === "") {
    throw new CliError("USAGE", "--actor was given an empty value — pass an actor identity or omit the flag.", {
      help: helpHint,
    });
  }

  let enumVals: string[] | undefined;
  if (values.values !== undefined) {
    enumVals = values.values
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (enumVals.length === 0) {
      throw new CliError("USAGE", "--values was empty — pass a comma-separated list (e.g. --values todo,doing,done)", {
        help: helpHint,
      });
    }
  }

  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));
  const registry = await loadKinds(bundle);
  const target = registry.kinds.get(kindName);
  if (!target) {
    const known = [...registry.kinds.keys()].sort();
    throw new CliError(
      "USAGE",
      known.length > 0
        ? `unknown kind '${kindName}' (declared: ${known.join(", ")})`
        : `unknown kind '${kindName}' (no kinds declared in this bundle)`,
      { help: `${cliInvocation()} kinds` },
    );
  }

  // Edit the governing convention doc's RAW frontmatter.fields, preserving
  // governs/path/sections/timestamp/body. `target.id` is the convention's own concept id.
  //
  // Routed through `mutateDoc`'s "patch" mode (fixes a live lost-update bug: the old unversioned
  // readDoc -> in-memory edit -> unconditional writeDoc silently lost one edit whenever two
  // `kind field` edits raced, or a concurrent `doc update` to the SAME convention landed between
  // the read and the write). `mutateDoc` does the versioned-read -> build -> idempotency -> validate
  // -> CAS-write-with-bounded-retry itself (the exact shape `link add`/`doc update` already prove for
  // this seam, now over the shared `versionedMutation` primitive) and throws NOT_FOUND before
  // `buildCandidate` ever runs on an absent doc (`onAbsent: "fail"`, the default), so `existing`
  // below is guaranteed defined. Two concurrent field edits now MERGE: the loser's retry re-reads
  // the winner's write and re-applies its OWN edit on top, instead of one silently clobbering the
  // other. `buildCandidate` re-runs this computation against EVERY attempt's fresh read — never a
  // decision computed once and blindly retried with a newer token.
  let computedRequired: string[] = [];
  let computedOptional: string[] = [];
  let computedValues: Record<string, unknown> = {};

  const result = await mutateDoc({
    bundle,
    id: target.id,
    mode: "patch",
    registry,
    strict: false, // this command EDITS the schema itself — it never validates against one
    helpOnKindReject: `${cliInvocation()} kinds`,
    actor: values.actor?.trim(),
    buildCandidate: (existingDoc) => {
      const existing = existingDoc!;
      const fm = existing.frontmatter;

      // Domain-invariant re-check: the
      // primitive's CAS pairing guarantees this attempt's `existing` is a version-matched fresh
      // read — it does NOT guarantee the doc still means what we assumed when we looked it up via
      // `loadKinds` above. A concurrent writer could rename this SAME convention's `governs` (e.g.
      // 'Context Note' -> 'Renamed Kind') between attempts; re-reading and re-splicing the field
      // lists would then silently edit the RENAMED convention under the OLD kind name, reporting
      // success. Re-verify the invariant this command depends on — `governs === kindName` — against
      // EVERY attempt's fresh read, not just the one `loadKinds` saw before the loop started.
      const currentGoverns = typeof fm.governs === "string" ? fm.governs.trim() : "";
      if (currentGoverns !== kindName) {
        throw new CliError(
          "STALE_HEAD",
          `'${target.id}' no longer governs '${kindName}' — it was concurrently renamed to govern ` +
            `'${currentGoverns || "(missing)"}'. Refusing to edit the wrong kind's schema; re-run ` +
            `'${cliInvocation()} kinds' to see the current declarations and retry against the right name.`,
          { help: `${cliInvocation()} kinds` },
        );
      }

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

      if (action === "add") {
        const targetList = values.required ? required : optional;
        const otherList = values.required ? optional : required;
        // Re-classifying an existing field (e.g. `add --required` a currently-optional field) moves it.
        const otherIdx = otherList.indexOf(fieldName);
        if (otherIdx >= 0) otherList.splice(otherIdx, 1);
        if (!targetList.includes(fieldName)) targetList.push(fieldName);
        if (enumVals) {
          const vals = enumVals;
          const prev = hasOwn(valuesMap, fieldName) && Array.isArray(valuesMap[fieldName])
            ? (valuesMap[fieldName] as unknown[]).map(String)
            : undefined;
          // Collision-resistant comparison: `prev.join(" ") !==
          // vals.join(" ")` conflated DIFFERENT enum lists that happen to join to the same string
          // — e.g. ["a b","c"] and ["a","b c"] BOTH become "a b c" — so `--values "a,b c"` over an
          // existing ["a b","c"] wrongly reported changed:false. Length + element-wise instead; no
          // delimiter choice can ever collide.
          const same = !!prev && prev.length === vals.length && prev.every((v, i) => v === vals[i]);
          if (!same) setOwn(valuesMap, fieldName, vals);

          if (isRecord(rawValueDescriptions) && hasOwn(rawValueDescriptions, fieldName)) {
            const rawFieldDescriptions = rawValueDescriptions[fieldName];
            if (isRecord(rawFieldDescriptions)) {
              const retained: Record<string, unknown> = {};
              for (const [value, description] of Object.entries(rawFieldDescriptions)) {
                if (vals.includes(value)) setOwn(retained, value, description);
              }
              if (Object.keys(retained).length !== Object.keys(rawFieldDescriptions).length) {
                valueDescriptionsMap = cloneRecord(rawValueDescriptions);
                if (Object.keys(retained).length > 0) setOwn(valueDescriptionsMap, fieldName, retained);
                else deleteOwn(valueDescriptionsMap, fieldName);
                valueDescriptionsChanged = true;
              }
            }
          }
        }
      } else {
        for (const list of [required, optional]) {
          const idx = list.indexOf(fieldName);
          if (idx >= 0) list.splice(idx, 1);
        }
        deleteOwn(valuesMap, fieldName);
        if (descriptionsMap) descriptionDeleted = deleteOwn(descriptionsMap, fieldName);
        if (isRecord(rawValueDescriptions) && hasOwn(rawValueDescriptions, fieldName)) {
          const rawFieldDescriptions = rawValueDescriptions[fieldName];
          if (isRecord(rawFieldDescriptions)) {
            valueDescriptionsMap = cloneRecord(rawValueDescriptions);
            deleteOwn(valueDescriptionsMap, fieldName);
            valueDescriptionsChanged = true;
          }
        }
      }

      computedRequired = required;
      computedOptional = optional;
      computedValues = valuesMap;

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
    },
    errors: {
      notFound: () =>
        new CliError(
          "NOT_FOUND",
          `the '${kindName}' kind's governing convention doc ('${target.id}') is declared by the registry but missing`,
          { help: `${cliInvocation()} kinds` },
        ),
    },
  });

  const changed = result.changed ?? false;
  // Report the RESULTING schema (reload so the derived KindConvention reflects the write).
  const after = changed ? (await loadKinds(bundle)).kinds.get(kindName) : target;
  const receipt: Record<string, unknown> = {
    kind: kindName,
    changed,
    action,
    field: fieldName,
    convention: target.id,
    required: after?.fields.required ?? computedRequired,
    optional: after?.fields.optional ?? computedOptional,
  };
  const resultValues = after?.fields.values ?? computedValues;
  if (Object.keys(resultValues).length > 0) receipt.values = resultValues;
  receipt.help = [`${cliInvocation()} kinds`];
  stdout(render(receipt, resolveMode(values)));
}
