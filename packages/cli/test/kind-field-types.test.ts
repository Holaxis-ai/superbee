/**
 * CLI surface for Convention `fields.types`: `kinds` projects declared types, `new` stores typed
 * input as its YAML type and rejects a mistyped value like an enum violation, `new "<Kind>" --help`
 * names each field's type, `doc update` applies the same conversion and rejection, and `status`
 * counts a mistyped value as frontmatter conformance debt. Runs commands in-process against a real
 * temporary filesystem bundle, mirroring `kinds.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CONVENTION_TYPE, initBundle, readDoc, writeDoc, type Bundle } from "@superbee/core";

import { newCommand } from "../src/commands/new.js";
import { kinds } from "../src/commands/kinds.js";
import { kind } from "../src/commands/kind.js";
import { materializeRecipeForEdition } from "@superbee/core/recipe-lifecycle";
import type { LoadedRecipe } from "../src/recipe-source.js";
import { doc } from "../src/commands/doc.js";
import { status } from "../src/commands/status.js";
import { CliError } from "../src/errors.js";

const T = "2026-10-03T00:00:00Z";

async function placeBundle(): Promise<{ dir: string; bundle: Bundle; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-kind-field-types-"));
  await initBundle(dir);
  const bundle: Bundle = { root: dir };
  await writeDoc(bundle, {
    id: "conventions/place",
    frontmatter: {
      type: CONVENTION_TYPE,
      title: "Place",
      governs: "Place",
      path: "places/",
      fields: {
        required: ["title"],
        optional: ["latitude", "longitude", "website", "opened", "seats", "accessible", "amenities", "note"],
        types: {
          latitude: "latitude",
          longitude: "longitude",
          website: "https-url",
          opened: "date",
          seats: "integer",
          accessible: "boolean",
          amenities: "string-list",
        },
      },
      timestamp: T,
    },
    body: "A location with typed fields.",
  });
  return { dir, bundle, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function runJson(
  cmd: (argv: string[], deps: { stdout: (s: string) => void }) => Promise<void>,
  argv: string[],
): Promise<Record<string, unknown>> {
  let out = "";
  await cmd([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

function rejectsAsTypeViolation(field: string) {
  return (err: unknown) => {
    assert.ok(err instanceof CliError, String(err));
    assert.equal(err.code, "USAGE");
    assert.match(err.message, new RegExp(`'${field}' must be`));
    const violations = (err.details as { violations: Array<{ code: string; field: string }> }).violations;
    assert.ok(violations.some((v) => v.code === "KIND_FIELD_TYPE" && v.field === field), JSON.stringify(violations));
    return true;
  };
}

test("kinds: projects fields.types; a kind without types carries no types key", async () => {
  const { dir, bundle, cleanup } = await placeBundle();
  try {
    await writeDoc(bundle, {
      id: "conventions/note",
      frontmatter: { type: CONVENTION_TYPE, governs: "Note", fields: { required: ["title"], optional: [] }, timestamp: T },
      body: "",
    });
    const result = await runJson(kinds, ["--dir", dir]);
    const rows = result.kinds as Array<Record<string, unknown>>;
    const place = rows.find((r) => r.governs === "Place");
    assert.deepEqual(place?.types, {
      latitude: "latitude",
      longitude: "longitude",
      website: "https-url",
      opened: "date",
      seats: "integer",
      accessible: "boolean",
      amenities: "string-list",
    });
    assert.ok(!("types" in rows.find((r) => r.governs === "Note")!));
    assert.equal(result.warnings, undefined);
  } finally {
    await cleanup();
  }
});

test("kinds: an unknown declared type is a registry warning and enforces nothing", async () => {
  const { dir, bundle, cleanup } = await placeBundle();
  try {
    await writeDoc(bundle, {
      id: "conventions/shop",
      frontmatter: { type: CONVENTION_TYPE, governs: "Shop", fields: { required: ["title"], optional: ["hours"], types: { hours: "opening-hours" } }, timestamp: T },
      body: "",
    });
    const result = await runJson(kinds, ["--dir", dir]);
    const warnings = result.warnings as Array<Record<string, unknown>>;
    assert.deepEqual(warnings.map((w) => [w.code, w.field]), [["KIND_CONVENTION_UNKNOWN_FIELD_TYPE", "fields.types.hours"]]);
    await newCommand(["Shop", "s1", "--title", "S", "--hours", "whenever", "--dir", dir], { stdout: () => {} });
    assert.equal((await readDoc(bundle, "s1")).frontmatter.hours, "whenever");
  } finally {
    await cleanup();
  }
});

test("new: typed flag text is stored as its YAML type", async () => {
  const { dir, bundle, cleanup } = await placeBundle();
  try {
    await newCommand([
      "Place", "cafe", "--title", "Cafe", "--latitude", "43.0987", "--longitude=-77.4419",
      "--website", "https://cafe.example/", "--opened", "2019-05-01", "--seats", "40",
      "--accessible", "true", "--amenities", "wifi", "--note", "42", "--dir", dir,
    ], { stdout: () => {} });
    const saved = (await readDoc(bundle, "places/cafe")).frontmatter;
    assert.equal(saved.latitude, 43.0987);
    assert.equal(saved.longitude, -77.4419);
    assert.equal(saved.seats, 40);
    assert.equal(saved.accessible, true);
    assert.deepEqual(saved.amenities, ["wifi"]);
    assert.equal(saved.opened, "2019-05-01");
    assert.equal(saved.note, "42", "an untyped field keeps its text");
  } finally {
    await cleanup();
  }
});

test("new: a mistyped value is rejected like an enum violation and nothing is written", async () => {
  const { dir, bundle, cleanup } = await placeBundle();
  try {
    const cases: Array<[string, string]> = [
      ["latitude", "91"],
      ["latitude", "north"],
      ["website", "http://cafe.example/"],
      ["opened", "2019-02-30"],
      ["seats", "4.5"],
      ["accessible", "yes"],
    ];
    for (const [field, value] of cases) {
      await assert.rejects(
        () => newCommand(["Place", `bad-${field}`, "--title", "Bad", `--${field}`, value, "--dir", dir, "--json"]),
        rejectsAsTypeViolation(field),
        `${field}=${value}`,
      );
    }
    await assert.rejects(() => readDoc(bundle, "places/bad-latitude"));
  } finally {
    await cleanup();
  }
});

test('new "<Kind>" --help names each typed field\'s type', async () => {
  const { dir, cleanup } = await placeBundle();
  try {
    let out = "";
    await newCommand(["Place", "--help", "--dir", dir], { stdout: (s) => (out += s) });
    assert.match(out, /--latitude <v>  optional; type: latitude\n/);
    assert.match(out, /--website <v>  optional; type: https-url\n/);
    assert.match(out, /--note <v>  optional\n/);
  } finally {
    await cleanup();
  }
});

test("doc update: typed conversion and rejection match new", async () => {
  const { dir, bundle, cleanup } = await placeBundle();
  try {
    await newCommand(["Place", "cafe", "--title", "Cafe", "--dir", dir], { stdout: () => {} });
    const deps = { stdout: () => {}, readStdin: async () => undefined };
    await doc(["update", "places/cafe", "--seats", "12", "--dir", dir, "--json"], deps);
    assert.equal((await readDoc(bundle, "places/cafe")).frontmatter.seats, 12);
    await assert.rejects(
      () => doc(["update", "places/cafe", "--website", "ftp://cafe.example", "--dir", dir, "--json"], deps),
      rejectsAsTypeViolation("website"),
    );
    assert.equal((await readDoc(bundle, "places/cafe")).frontmatter.website, undefined);
  } finally {
    await cleanup();
  }
});

test("status: a mistyped value written around the CLI is kind_warnings and conformance debt", async () => {
  const { dir, bundle, cleanup } = await placeBundle();
  try {
    await writeDoc(bundle, { id: "places/raw", frontmatter: { type: "Place", title: "Raw", latitude: "43.1", timestamp: T }, body: "" });
    const result = await runJson(status, ["--dir", dir]);
    assert.equal(result.conformance_debt, 1);
    assert.equal(result.kind_warnings, 1);
    const rows = (result.kind_lint as { rows: Array<Record<string, unknown>> }).rows;
    assert.deepEqual(rows, [{ id: "places/raw", field: "latitude", code: "KIND_FIELD_TYPE" }]);
  } finally {
    await cleanup();
  }
});

test("new: --latitude 42.5 stores a number, --latitude abc is KIND_FIELD_TYPE, one --topics stores a list", async () => {
  const { dir, bundle, cleanup } = await placeBundle();
  try {
    await newCommand(["Place", "p", "--title", "P", "--latitude", "42.5", "--amenities", "x", "--dir", dir], { stdout: () => {} });
    const saved = (await readDoc(bundle, "places/p")).frontmatter;
    assert.equal(saved.latitude, 42.5);
    assert.deepEqual(saved.amenities, ["x"]);
    await assert.rejects(
      () => newCommand(["Place", "q", "--title", "Q", "--latitude", "abc", "--dir", dir, "--json"]),
      rejectsAsTypeViolation("latitude"),
    );
    await assert.rejects(() => readDoc(bundle, "places/q"));
  } finally {
    await cleanup();
  }
});

test("new: a string-list enum checks each item and has no arity rule", async () => {
  const { dir, bundle, cleanup } = await placeBundle();
  try {
    await writeDoc(bundle, {
      id: "conventions/venue",
      frontmatter: {
        type: CONVENTION_TYPE, governs: "Venue", path: "venues/", timestamp: T,
        fields: { required: ["title"], optional: ["topics"], types: { topics: "string-list" }, values: { topics: ["music", "history"] } },
      },
      body: "",
    });
    await newCommand(["Venue", "v1", "--title", "V", "--topics", "music", "--topics", "history", "--dir", dir], { stdout: () => {} });
    assert.deepEqual((await readDoc(bundle, "venues/v1")).frontmatter.topics, ["music", "history"]);
    await assert.rejects(
      () => newCommand(["Venue", "v2", "--title", "V", "--topics", "music", "--topics", "sports", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        const codes = (err.details as { violations: Array<{ code: string }> }).violations.map((v) => v.code);
        assert.deepEqual(codes, ["KIND_FIELD_VALUE"]);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("doc field set: a literal for a typed field converts; a bad literal is refused", async () => {
  const { dir, bundle, cleanup } = await placeBundle();
  try {
    await newCommand(["Place", "cafe", "--title", "Cafe", "--dir", dir], { stdout: () => {} });
    const deps = { stdout: () => {}, readStdin: async () => undefined };
    await doc(["field", "set", "places/cafe", "seats", "12", "--dir", dir, "--json"], deps);
    assert.equal((await readDoc(bundle, "places/cafe")).frontmatter.seats, 12);
    await doc(["field", "set", "places/cafe", "accessible", "false", "--dir", dir, "--json"], deps);
    assert.equal((await readDoc(bundle, "places/cafe")).frontmatter.accessible, false);
    await doc(["field", "set", "places/cafe", "note", "12", "--dir", dir, "--json"], deps);
    assert.equal((await readDoc(bundle, "places/cafe")).frontmatter.note, "12", "an untyped field keeps its text");
    await assert.rejects(
      () => doc(["field", "set", "places/cafe", "latitude", "abc", "--dir", dir, "--json"], deps),
      rejectsAsTypeViolation("latitude"),
    );
    assert.equal((await readDoc(bundle, "places/cafe")).frontmatter.latitude, undefined);
  } finally {
    await cleanup();
  }
});

async function slugTitledBundle() {
  const fixture = await placeBundle();
  await writeDoc(fixture.bundle, {
    id: "conventions/code",
    frontmatter: { type: CONVENTION_TYPE, governs: "Code", timestamp: T, fields: { required: ["title"], types: { title: "slug" } } },
    body: "",
  });
  return fixture;
}

test("doc write: a type violation warns by default and --strict refuses", async () => {
  const { dir, bundle, cleanup } = await slugTitledBundle();
  try {
    const deps = { stdout: () => {}, readStdin: async () => undefined };
    let out = "";
    await doc(["write", "codes/a", "--type", "Code", "--title", "Not A Slug", "--body", "b", "--dir", dir, "--json"], {
      ...deps, stdout: (s: string) => (out += s),
    });
    const receipt = JSON.parse(out) as { warnings?: Array<{ code: string }> };
    assert.ok(receipt.warnings?.some((w) => w.code === "KIND_FIELD_TYPE"), out);
    await assert.rejects(
      () => doc(["write", "codes/b", "--type", "Code", "--title", "Also Bad", "--body", "b", "--strict", "--dir", dir, "--json"], deps),
      rejectsAsTypeViolation("title"),
    );
    await assert.rejects(() => readDoc(bundle, "codes/b"));
  } finally {
    await cleanup();
  }
});

test("doc write: the lenient-overwrite ratchet refuses a new type violation on a conforming doc", async () => {
  const { dir, bundle, cleanup } = await slugTitledBundle();
  try {
    const deps = { stdout: () => {}, readStdin: async () => undefined };
    await doc(["write", "codes/c", "--type", "Code", "--title", "good-slug", "--body", "b", "--dir", dir, "--json"], deps);
    await assert.rejects(
      () => doc(["write", "codes/c", "--type", "Code", "--title", "Bad Slug", "--body", "b", "--dir", dir, "--json"], deps),
      rejectsAsTypeViolation("title"),
    );
    assert.equal((await readDoc(bundle, "codes/c")).frontmatter.title, "good-slug");
  } finally {
    await cleanup();
  }
});

test("status: null on a typed field is a type violation counted as conformance debt", async () => {
  const { dir, bundle, cleanup } = await placeBundle();
  try {
    await writeDoc(bundle, { id: "places/nulled", frontmatter: { type: "Place", title: "N", website: null, timestamp: T }, body: "" });
    const result = await runJson(status, ["--dir", dir]);
    assert.equal(result.conformance_debt, 1);
    const rows = (result.kind_lint as { rows: Array<Record<string, unknown>> }).rows;
    assert.deepEqual(rows, [{ id: "places/nulled", field: "website", code: "KIND_FIELD_TYPE" }]);
  } finally {
    await cleanup();
  }
});

test("kind field add --type declares the type only; remove drops it; a bad type is a usage error", async () => {
  const { dir, bundle, cleanup } = await placeBundle();
  try {
    await writeDoc(bundle, { id: "places/raw", frontmatter: { type: "Place", title: "Raw", capacity: "lots", timestamp: T }, body: "" });
    const before = await readDoc(bundle, "places/raw");
    await kind(["field", "Place", "add", "capacity", "--type", "integer", "--dir", dir, "--json"], { stdout: () => {} });
    const types = (await readDoc(bundle, "conventions/place")).frontmatter.fields as Record<string, unknown>;
    assert.equal((types.types as Record<string, string>).capacity, "integer");
    assert.deepEqual((await readDoc(bundle, "places/raw")).frontmatter, before.frontmatter, "instances are not rewritten");
    const listed = await runJson(kinds, ["--dir", dir]);
    assert.equal(((listed.kinds as Array<Record<string, unknown>>)[0]!.types as Record<string, string>).capacity, "integer");
    await kind(["field", "Place", "remove", "capacity", "--dir", dir, "--json"], { stdout: () => {} });
    const after = (await readDoc(bundle, "conventions/place")).frontmatter.fields as Record<string, unknown>;
    assert.ok(!("capacity" in (after.types as Record<string, string>)));
    await assert.rejects(
      () => kind(["field", "Place", "add", "hours", "--type", "opening-hours", "--dir", dir, "--json"], { stdout: () => {} }),
      (err: unknown) => err instanceof CliError && err.code === "USAGE" && /not a field type/.test(err.message),
    );
    await assert.rejects(
      () => kind(["field", "Place", "remove", "website", "--type", "https-url", "--dir", dir, "--json"], { stdout: () => {} }),
      (err: unknown) => err instanceof CliError && err.code === "USAGE",
    );
  } finally {
    await cleanup();
  }
});

test("doc update and doc field set refuse a typed list field up front and point to new", async () => {
  const { dir, bundle, cleanup } = await placeBundle();
  try {
    await newCommand(["Place", "cafe", "--title", "Cafe", "--amenities", "wifi", "--dir", dir], { stdout: () => {} });
    const before = await readDoc(bundle, "places/cafe");
    const deps = { stdout: () => {}, readStdin: async () => undefined };
    const refusesList = (command: string) => (err: unknown) => {
      assert.ok(err instanceof CliError, String(err));
      assert.equal(err.code, "USAGE");
      assert.match(err.message, new RegExp(`'amenities' is a string-list field, and '${command}' does not replace lists`));
      assert.match(err.message, /'new'/);
      assert.match(err.help ?? "", /new Place --help/);
      return true;
    };
    await assert.rejects(() => doc(["update", "places/cafe", "--amenities", "patio", "--dir", dir, "--json"], deps), refusesList("doc update"));
    await assert.rejects(() => doc(["field", "set", "places/cafe", "amenities", "patio", "--dir", dir, "--json"], deps), refusesList("doc field set"));
    assert.deepEqual((await readDoc(bundle, "places/cafe")).frontmatter, before.frontmatter);
  } finally {
    await cleanup();
  }
});

test("recipe materialization renames a progress_status type to its storage field in each edition", () => {
  const recipe = {
    id: "typed", title: "Typed", version: "1", summary: "", offer: "", source: "test", pages: [], references: [],
    docs: [{
      id: "conventions/job",
      frontmatter: {
        type: CONVENTION_TYPE, governs: "Job",
        fields: { required: ["title", "progress_status"], optional: ["start"], types: { progress_status: "slug", start: "datetime" } },
      },
      body: "",
    }],
  } as unknown as LoadedRecipe;
  const fieldsOf = (edition: string) => materializeRecipeForEdition(recipe, edition).docs[0]!.frontmatter.fields as Record<string, unknown>;
  assert.deepEqual(fieldsOf("0.2").types, { superbee_progress_status: "slug", start: "datetime" });
  assert.deepEqual(fieldsOf("0.1").types, { status: "slug", start: "datetime" });
});
