/**
 * Kind field types — `fields.types` on a Convention (`../src/kinds.ts`).
 *
 * Covers: the closed vocabulary; parse warnings (bad shape, unknown type, undeclared field,
 * reserved field); per-type acceptance tables over values decoded by core's own YAML codec;
 * `validateAgainstKind`'s KIND_FIELD_TYPE warning and its absence/null posture; strict
 * `mutateDocument` rejection; command-line input conversion; serializer and authoring projection
 * round trips; field removal dropping its type; and a convention without types staying unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseMarkdown } from "../src/frontmatter.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { mutateDocument, KindConformanceError } from "../src/document-mutation.js";
import { prepareKindFieldMutation } from "../src/kind-field-mutation.js";
import {
  CONVENTION_TYPE,
  KIND_FIELD_TYPES,
  buildKindRegistry,
  isKindFieldType,
  kindConventionDoc,
  kindFieldInputValue,
  kindFieldTypeProblem,
  parseConventionDoc,
  projectKindForAuthoring,
  isKindFieldValidationWarning,
  projectKindValidationWarnings,
  validateAgainstKind,
  type KindConvention,
  type KindFieldType,
} from "../src/kinds.js";
import type { Bundle, OkfDocument } from "../src/types.js";

const T = "2026-10-03T00:00:00Z";

function convention(fields: Record<string, unknown>, governs = "Place"): OkfDocument {
  return { id: `conventions/${governs.toLowerCase()}`, frontmatter: { type: CONVENTION_TYPE, governs, fields, timestamp: T }, body: "" };
}

function parsed(fields: Record<string, unknown>): { kind: KindConvention; codes: string[] } {
  const result = parseConventionDoc(convention(fields), { okfVersion: "0.2" });
  assert.ok(result.ok);
  return { kind: result.kind, codes: result.warnings.map((w) => w.code) };
}

/** Decode one YAML scalar exactly as an authored bundle document would be decoded. */
function yaml(source: string): unknown {
  return parseMarkdown(`---\ntype: T\nv: ${source}\n---\n`, undefined, { okfVersion: "0.2" }).frontmatter.v;
}

test("the vocabulary is exactly the eleven design types", () => {
  assert.deepEqual([...KIND_FIELD_TYPES], [
    "date", "datetime", "https-url", "https-url-list", "integer", "number", "boolean", "slug", "string-list", "latitude", "longitude",
  ]);
  assert.equal(isKindFieldType("url"), false, "url was dropped");
  assert.equal(isKindFieldType("datetime"), true);
  for (const notAType of ["opening-hours", "string", "Date", "", 1, null, "__proto__"]) {
    assert.equal(isKindFieldType(notAType), false, String(notAType));
  }
});

test("parseConventionDoc: fields.types parses declared types without warnings", () => {
  const { kind, codes } = parsed({
    required: ["title", "start"],
    optional: ["latitude", "longitude", "website", "amenities"],
    types: { start: "datetime", latitude: "latitude", longitude: "longitude", website: "https-url", amenities: "string-list" },
  });
  assert.deepEqual(codes, []);
  assert.deepEqual(kind.fields.types, {
    start: "datetime", latitude: "latitude", longitude: "longitude", website: "https-url", amenities: "string-list",
  });
});

test("parseConventionDoc: a convention without fields.types carries no types key", () => {
  const { kind, codes } = parsed({ required: ["title"], optional: [] });
  assert.deepEqual(codes, []);
  assert.equal(Object.hasOwn(kind.fields, "types"), false);
});

test("parseConventionDoc: malformed fields.types warn precisely and enforce nothing", () => {
  const nonMap = parsed({ required: ["title"], types: ["date"] });
  assert.deepEqual(nonMap.codes, ["KIND_CONVENTION_BAD_SHAPE"]);
  assert.equal(nonMap.kind.fields.types, undefined);

  const result = parseConventionDoc(convention({
    required: ["title"],
    optional: ["when", "hours", "website"],
    types: { when: "date", hours: "opening-hours", website: { scheme: "https" }, ghost: "number", type: "date" },
  }), { okfVersion: "0.2" });
  assert.ok(result.ok);
  assert.deepEqual(result.kind.fields.types, { when: "date" });
  assert.deepEqual(result.warnings.map((w) => [w.code, w.field]), [
    ["KIND_CONVENTION_UNKNOWN_FIELD_TYPE", "fields.types.hours"],
    ["KIND_CONVENTION_UNKNOWN_FIELD_TYPE", "fields.types.website"],
    ["KIND_CONVENTION_UNDECLARED_TYPES_FIELD", "fields.types.ghost"],
  ]);
  assert.match(result.warnings[0]!.message, /'opening-hours'.*valid types: date, datetime/);
  assert.deepEqual(result.reservedFieldPaths, ["fields.types.type"]);
});

test("parseConventionDoc: prototype-looking typed fields stay own keys", () => {
  const { kind, codes } = parsed(JSON.parse('{"required":["__proto__"],"types":{"__proto__":"integer"}}'));
  assert.deepEqual(codes, []);
  assert.equal(Object.hasOwn(kind.fields.types!, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(kind.fields.types), Object.prototype);
});

// Design section 2, row by row. Values pass through core's own YAML codec where the row is about
// decoding. Core's codec reads `0o17` as a string (YAML 1.1 octal is `017`), so it is rejected as
// "12" is; the rule (a safe integer after decoding) is what the table fixes.
const LONG_HTTPS = `https://example.org/${"a".repeat(2048 - "https://example.org/".length)}`;
const ACCEPT: Record<KindFieldType, unknown[]> = {
  date: ["2026-02-28", "2024-02-29", yaml("2026-02-28")],
  datetime: [
    "2026-10-10T08:00:00-04:00", "2026-10-10T08:00Z", "2026-10-10t08:00:00z", "2026-10-10T08:00:00+05",
    "2026-10-10T08:00:00+0500", "2026-10-10T08:00:00.123456789Z", yaml("2026-10-10T08:00:00-04:00"),
  ],
  "https-url": ["https://example.org", "HTTPS://example.org/x", "https://example.org/x#y", LONG_HTTPS],
  "https-url-list": [[], ["https://a.example"], ["https://a.example", "https://b.example"], yaml("[https://a.example]")],
  integer: [0, -3, 42, yaml("1.0"), yaml("0x1F"), yaml("017"), Number.MAX_SAFE_INTEGER],
  number: [0, -1.5, 43.0987, yaml("1e3")],
  boolean: [true, false, yaml("false")],
  slug: ["a", "live-music", "2026-fair", "a".repeat(200)],
  "string-list": [[], ["wifi"], yaml("[wifi, patio]")],
  latitude: [-90, 0, 90, 43.0987],
  longitude: [-180, 180, -77.4419],
};
const REJECT: Record<KindFieldType, unknown[]> = {
  date: ["2026-02-30", "2026-2-3", 20260228, yaml("20260228"), "2026-13-01", null],
  datetime: ["2026-10-10T08:00:00", "2026-10-10T24:00:00Z", "2026-10-10", "2026-10-10T08:00:00.1234567890Z", null],
  "https-url": [
    "http://example.org/", "https://", "https://user:pw@example.org/", "https://user@example.org/",
    "https://exa mple.org", " https://example.org", `${LONG_HTTPS}a`, 42, null,
    "https:example.com", "https:/x", "https:\\x", "https:\\\\x", "\u0001https://example.org", "https://example.org\u007F",
    "https://example.org/\u0000", "\u001Fhttps://example.org/",
  ],
  "https-url-list": ["https://a.example", ["https://a.example", "https://a.example"], ["http://a.example"], null],
  integer: [1.5, -0, yaml("-0.0"), 2 ** 53, "12", yaml("0o17"), null],
  number: [Number.NaN, Infinity, "1.5", yaml(".nan"), yaml(".inf"), true, null],
  boolean: ["true", 1, yaml("'false'"), null],
  slug: ["Live-Music", "live--music", "-live", "live-", "a".repeat(201), "", "live music", 7, null],
  "string-list": ["wifi", ["a", "a"], [""], ["a", 1], [null], null],
  latitude: [91, -90.001, "43.1", Infinity, null],
  longitude: [181, -180.5, "-77", null],
};

for (const type of KIND_FIELD_TYPES) {
  test(`kindFieldTypeProblem(${type}) accepts and rejects the documented values`, () => {
    for (const value of ACCEPT[type]) assert.equal(kindFieldTypeProblem(type, value), undefined, `${type} should accept ${JSON.stringify(value)}`);
    for (const value of REJECT[type]) assert.equal(typeof kindFieldTypeProblem(type, value), "string", `${type} should reject ${String(value)}`);
  });
}

const EVENT: KindConvention = {
  id: "conventions/event",
  title: "Event",
  governs: "Event",
  fields: {
    required: ["title", "start"],
    optional: ["end", "capacity", "url"],
    values: {},
    terminal: {},
    descriptions: {},
    types: { start: "datetime", end: "datetime", capacity: "integer", url: "https-url" },
  },
};

test("validateAgainstKind: a mistyped value or null is KIND_FIELD_TYPE; an absent field is not checked", () => {
  const doc = (fm: Record<string, unknown>): OkfDocument => ({ id: "events/fair", frontmatter: { type: "Event", title: "Fair", ...fm }, body: "" });
  assert.deepEqual(validateAgainstKind(doc({ start: "2026-10-10T08:00:00-04:00", capacity: 40 }), EVENT), []);
  const warnings = validateAgainstKind(doc({ start: "2026-10-10T08:00:00", capacity: "40", url: "http://fair.example" }), EVENT);
  assert.deepEqual(warnings.map((w) => [w.code, w.field]), [
    ["KIND_FIELD_TYPE", "start"],
    ["KIND_FIELD_TYPE", "capacity"],
    ["KIND_FIELD_TYPE", "url"],
  ]);
  assert.match(warnings[0]!.message, /'start' must be an ISO-8601 date and time with an explicit UTC offset.*got the string "2026-10-10T08:00:00"/);
  assert.deepEqual(validateAgainstKind(doc({ start: null, end: null }), EVENT).map((w) => [w.code, w.field]), [
    ["KIND_FIELD_MISSING", "start"],
    ["KIND_FIELD_TYPE", "start"],
    ["KIND_FIELD_TYPE", "end"],
  ]);
  assert.match(validateAgainstKind(doc({ start: "2026-10-10T08:00:00Z", url: null }), EVENT)[0]!.message, /'url' must be .*got null/);
  assert.deepEqual(validateAgainstKind(doc({ start: "2026-10-10T08:00:00Z" }), EVENT), [], "absent optional fields are not checked");
  assert.ok(isKindFieldValidationWarning({ code: "KIND_FIELD_TYPE", message: "", severity: "warning" }));
});

test("strict mutateDocument rejects a type violation exactly like an enum violation", async () => {
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Bundle\n");
  const bundle: Bundle = { root: "/unused", backend };
  const registry = buildKindRegistry([kindConventionDoc(EVENT, "", T)], [], { okfVersion: "0.2" });
  const write = (start: unknown) => mutateDocument({
    bundle,
    id: "events/fair",
    mode: "overwrite",
    registry,
    strict: true,
    buildCandidate: () => ({ frontmatter: { type: "Event", title: "Fair", start }, body: "" }),
  });
  await assert.rejects(write("2026-10-10T08:00:00"), (error: unknown) =>
    error instanceof KindConformanceError && error.violations.some((w) => w.code === "KIND_FIELD_TYPE" && w.field === "start"));
  const ok = await write("2026-10-10T08:00:00-04:00");
  assert.equal(ok.doc.frontmatter.start, "2026-10-10T08:00:00-04:00");
});

test("kindFieldInputValue converts flag text by declared type and never guesses", () => {
  const kind: KindConvention = {
    ...EVENT,
    fields: { ...EVENT.fields, optional: [...EVENT.fields.optional, "lat", "free", "tags", "note"], types: { ...EVENT.fields.types, lat: "latitude", free: "boolean", tags: "string-list" } },
  };
  assert.equal(kindFieldInputValue(kind, "lat", ["43.0987"]), 43.0987);
  assert.equal(kindFieldInputValue(kind, "lat", ["-.5"]), -0.5);
  assert.equal(kindFieldInputValue(kind, "lat", ["north"]), "north");
  assert.equal(kindFieldInputValue(kind, "lat", ["0x10"]), "0x10");
  assert.equal(kindFieldInputValue(kind, "capacity", ["40"]), 40);
  assert.equal(kindFieldInputValue(kind, "capacity", ["4.5"]), "4.5");
  assert.equal(kindFieldInputValue(kind, "free", ["true"]), true);
  assert.equal(kindFieldInputValue(kind, "free", ["yes"]), "yes");
  assert.deepEqual(kindFieldInputValue(kind, "tags", ["wifi"]), ["wifi"]);
  assert.equal(kindFieldInputValue(kind, "start", ["2026-10-10T08:00:00Z"]), "2026-10-10T08:00:00Z");
  assert.equal(kindFieldInputValue(kind, "note", ["7"]), "7", "untyped fields keep their text");
  assert.deepEqual(kindFieldInputValue(kind, "note", ["a", "b"]), ["a", "b"]);
});

test("kindConventionDoc round-trips fields.types; authoring projection keeps them", () => {
  const doc = kindConventionDoc(EVENT, "", T);
  assert.deepEqual((doc.frontmatter.fields as Record<string, unknown>).types, EVENT.fields.types);
  const reparsed = parseConventionDoc(doc, { okfVersion: "0.2" });
  assert.ok(reparsed.ok);
  assert.deepEqual(reparsed.warnings, []);
  assert.deepEqual(reparsed.kind.fields.types, EVENT.fields.types);
  assert.deepEqual(projectKindForAuthoring("0.2", reparsed.kind).fields.types, EVENT.fields.types);
  const untyped = kindConventionDoc({ ...EVENT, fields: { ...EVENT.fields, types: undefined } }, "", T);
  assert.equal(Object.hasOwn(untyped.frontmatter.fields as object, "types"), false);
});

test("removing a Kind field also removes its declared type", () => {
  const existing = kindConventionDoc(EVENT, "", T);
  const removed = prepareKindFieldMutation(existing, { governs: "Event", field: "capacity", action: "remove", okfVersion: "0.2" }, "0.2");
  const fields = removed.frontmatter.fields as Record<string, Record<string, string>>;
  assert.deepEqual(fields.types, { start: "datetime", end: "datetime", url: "https-url" });
  const reparsed = parseConventionDoc({ ...existing, frontmatter: removed.frontmatter }, { okfVersion: "0.2" });
  assert.deepEqual(reparsed.warnings, []);
});

test("list enums: fields.values on a string-list checks each item and skips the arity rule", () => {
  const { kind, codes } = parsed({
    required: ["title"],
    optional: ["topics", "tier"],
    types: { topics: "string-list", tier: "integer" },
    values: { topics: ["music", "history"], tier: ["1", "2"] },
  });
  assert.deepEqual(codes, [], "values are allowed on string-list and on any scalar type");
  const doc = (fm: Record<string, unknown>): OkfDocument => ({ id: "places/x", frontmatter: { type: "Place", title: "X", ...fm }, body: "" });
  assert.deepEqual(validateAgainstKind(doc({ topics: ["music", "history"], tier: 2 }), kind), []);
  assert.deepEqual(validateAgainstKind(doc({ topics: [] }), kind), []);
  assert.deepEqual(validateAgainstKind(doc({ topics: ["music", "sports"] }), kind).map((w) => w.code), ["KIND_FIELD_VALUE"]);
  assert.deepEqual(validateAgainstKind(doc({ tier: [1, 2] }), kind).map((w) => w.code), ["KIND_FIELD_ARITY", "KIND_FIELD_TYPE"]);
});

test("parseConventionDoc: values on an https-url-list field is the one mismatch warning and is skipped", () => {
  const result = parseConventionDoc(convention({
    required: ["title"],
    optional: ["links", "slugged", "flag"],
    types: { links: "https-url-list", slugged: "slug", flag: "boolean" },
    values: { links: ["https://a.example"], slugged: ["a-b"], flag: ["true"] },
  }), { okfVersion: "0.2" });
  assert.ok(result.ok);
  assert.deepEqual(result.warnings.map((w) => [w.code, w.field]), [["KIND_CONVENTION_VALUES_TYPE_MISMATCH", "fields.values.links"]]);
  assert.equal(Object.hasOwn(result.kind.fields.values, "links"), false);
  assert.deepEqual(result.kind.fields.values.slugged, ["a-b"]);
});

test("a type violation on the v0.2 progress field projects to its authoring name", () => {
  const kind = parsed({
    required: ["title", "superbee_progress_status"],
    types: { superbee_progress_status: "slug" },
  }).kind;
  const warnings = validateAgainstKind(
    { id: "places/x", frontmatter: { type: "Place", title: "X", superbee_progress_status: "Not Slug" }, body: "" },
    kind,
  );
  const projected = projectKindValidationWarnings("0.2", kind, warnings);
  assert.deepEqual(projected.map((w) => [w.code, w.field]), [["KIND_FIELD_TYPE", "progress_status"]]);
  assert.match(projected[0]!.message, /^'progress_status' must be /);
});

test("Kind field add with a type changes the declaration only and is idempotent", () => {
  const existing = kindConventionDoc(EVENT, "", T);
  const added = prepareKindFieldMutation(existing, { governs: "Event", field: "seats", action: "add", type: "integer", okfVersion: "0.2" }, "0.2");
  const fields = added.frontmatter.fields as Record<string, unknown>;
  assert.deepEqual(fields.optional, ["end", "capacity", "url", "seats"]);
  assert.equal((fields.types as Record<string, string>).seats, "integer");
  const again = prepareKindFieldMutation({ ...existing, frontmatter: added.frontmatter }, { governs: "Event", field: "seats", action: "add", type: "integer", okfVersion: "0.2" }, "0.2");
  assert.deepEqual(again.frontmatter, added.frontmatter);
  const fresh = prepareKindFieldMutation(kindConventionDoc({ ...EVENT, fields: { ...EVENT.fields, types: undefined } }, "", T), { governs: "Event", field: "lat", action: "add", type: "latitude", okfVersion: "0.2" }, "0.2");
  assert.deepEqual((fresh.frontmatter.fields as Record<string, unknown>).types, { lat: "latitude" });
  assert.throws(() => prepareKindFieldMutation(existing, { governs: "Event", field: "x", action: "add", type: "url" as KindFieldType, okfVersion: "0.2" }, "0.2"));
  assert.throws(() => prepareKindFieldMutation(existing, { governs: "Event", field: "capacity", action: "remove", type: "integer", okfVersion: "0.2" }, "0.2"));
  assert.throws(() => prepareKindFieldMutation(existing, { governs: "Event", field: "links", action: "add", type: "https-url-list", values: ["https://a.example"], okfVersion: "0.2" }, "0.2"));
});

test("kindFieldInputValue: an https-url-list is always a list", () => {
  const kind: KindConvention = { ...EVENT, fields: { ...EVENT.fields, optional: ["links"], types: { links: "https-url-list" } } };
  assert.deepEqual(kindFieldInputValue(kind, "links", ["https://a.example"]), ["https://a.example"]);
});
