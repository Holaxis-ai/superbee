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
    assert.match(out, /--latitude <v>  optional; type: latitude \(a number from -90 to 90\)/);
    assert.match(out, /--website <v>  optional; type: https-url \(an absolute https:\/\/ URL\)/);
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
