/**
 * Kind conventions — the bundle-declared document-kind registry (`../src/kinds.ts`).
 *
 * Covers: registry build over both adapters + one wire-parity check (the SAME
 * discovery/validation/horizon logic over `RemoteBackend`, router-as-transport, no
 * sockets — mirroring `wire-protocol.test.ts`'s pattern); prefix-scoping (a
 * `Convention` doc OUTSIDE `conventions/` is not discovered — documented behavior,
 * not a bug); required/enum/section validation incl. the empty-description and
 * YAML-boolean-enum-member edge cases; horizon parsing incl. malformed;
 * malformed-convention skip; duplicate-`governs`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRouter } from "@superbee/server";
import { MemoryBackend as ServerMemoryBackend } from "@superbee/core";

import { initBundle, query, writeDoc } from "../src/bundle.js";
import { FilesystemBackend } from "../src/backend.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { RemoteBackend } from "../src/remote-backend.js";
import {
  CONVENTIONS_PREFIX,
  CONVENTION_TYPE,
  PROGRESS_STATUS_FIELD,
  SUPERBEE_PROGRESS_STATUS_FIELD,
  buildKindRegistry,
  claimCoordinates,
  freshnessHorizonMs,
  isTerminal,
  kindConventionDoc,
  parseConventionDoc,
  splitSections,
  validateAgainstKind,
  type KindConvention,
} from "../src/kinds.js";
import { loadKinds } from "../src/kinds-load.js";
import type { Bundle, Frontmatter, OkfDocument } from "../src/types.js";

const T = "2026-07-02T00:00:00.000Z";

/**
 * A GENERIC synthetic kind fixture (shape-identical to the CLI's `context-notes` recipe's
 * `CONTEXT_NOTE_KIND`, which moved out of core in Recipes Unit A — see `packages/cli/src/recipes.ts`).
 * These generic-derivation tests (`freshnessHorizonMs`/`validateAgainstKind`/`kindConventionDoc`)
 * exercise core's pure helpers and do not need the REAL Context Note kind; a local fixture keeps
 * them independent of the CLI's recipe content.
 */
const NOTE_KIND_FIXTURE: KindConvention = {
  id: "conventions/context-note",
  title: "Context Note",
  governs: "Context Note",
  description: "A durable cross-session orientation note.",
  path: "context-notes/",
  fields: {
    required: ["title", "timestamp"],
    optional: ["description", "tags"],
    values: {},
    valueDescriptions: {},
    terminal: {},
    descriptions: { title: "A concise summary.", tags: "Searchable labels." },
  },
  sections: ["Summary"],
  freshnessHorizon: "24h",
};

/** A `Roadmap Item` kind convention doc, matching the plan's worked example shape. */
const ROADMAP_KIND_DOC: OkfDocument = {
  id: "conventions/roadmap-item",
  frontmatter: {
    type: CONVENTION_TYPE,
    title: "Roadmap Item",
    governs: "Roadmap Item",
    description: "  A durable line of work.  ",
    path: "roadmap/",
    fields: {
      required: ["title", "status"],
      optional: ["horizon"],
      values: { status: ["planned", "active", "done"] },
      descriptions: { title: "  A concise outcome.  ", status: "Current lifecycle state." },
    },
    sections: ["Why", "Done when"],
    freshness_horizon: "30d",
    timestamp: T,
  },
  body: "Roadmap items track committed-but-not-yet-built work.",
};

test("prospective registry construction is the same pure authority loadKinds uses", async () => {
  const first = ROADMAP_KIND_DOC;
  const duplicate: OkfDocument = {
    ...ROADMAP_KIND_DOC,
    id: "conventions/z-roadmap-item",
    frontmatter: { ...ROADMAP_KIND_DOC.frontmatter, title: "Shadowed" },
  };
  const pure = buildKindRegistry([duplicate, first]);
  const backend = new MemoryBackend();
  const bundle: Bundle = { root: "mem://prospective-kind-registry", backend };
  await writeDoc(bundle, duplicate);
  await writeDoc(bundle, first);
  const loaded = await loadKinds(bundle);

  assert.deepEqual([...pure.kinds.entries()], [...loaded.kinds.entries()]);
  assert.deepEqual(pure.warnings, loaded.warnings);
  assert.equal(pure.kinds.get("Roadmap Item")?.id, "conventions/roadmap-item");
  assert.equal(pure.warnings.some((warning) => warning.code === "KIND_DUPLICATE_GOVERNS"), true);
});

async function withFsBundle(fn: (bundle: Bundle) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-kinds-fs-"));
  try {
    await fn({ root, backend: new FilesystemBackend(root) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withMemBundle(fn: (bundle: Bundle) => Promise<void>): Promise<void> {
  await fn({ root: "mem://kinds-bundle", backend: new MemoryBackend() });
}

const RUNNERS = [
  ["FilesystemBackend", withFsBundle],
  ["MemoryBackend", withMemBundle],
] as const;

for (const [name, run] of RUNNERS) {
  test(`${name}: loadKinds discovers a Convention doc under conventions/ and parses its declared shape`, async () => {
    await run(async (bundle) => {
      await writeDoc(bundle, ROADMAP_KIND_DOC);
      const registry = await loadKinds(bundle);
      assert.deepEqual(registry.warnings, []);
      assert.equal(registry.kinds.size, 1);
      const kind = registry.kinds.get("Roadmap Item");
      assert.ok(kind);
      assert.equal(kind!.id, "conventions/roadmap-item");
      assert.equal(kind!.path, "roadmap/");
      assert.equal(kind!.description, "A durable line of work.");
      assert.deepEqual(kind!.fields.required, ["title", "status"]);
      assert.deepEqual(kind!.fields.optional, ["horizon"]);
      assert.deepEqual(kind!.fields.values, { status: ["planned", "active", "done"] });
      assert.deepEqual(kind!.fields.valueDescriptions, {});
      assert.deepEqual(kind!.fields.descriptions, {
        title: "A concise outcome.",
        status: "Current lifecycle state.",
      });
      assert.deepEqual(kind!.sections, ["Why", "Done when"]);
      assert.equal(kind!.freshnessHorizon, "30d");
      assert.equal(freshnessHorizonMs(kind!), 30 * 86_400_000);
    });
  });

  test(`${name}: loadKinds is a cheap empty registry for a conventions-free bundle`, async () => {
    await run(async (bundle) => {
      await writeDoc(bundle, { id: "concepts/a", frontmatter: { type: "Concept", timestamp: T }, body: "x" });
      const registry = await loadKinds(bundle);
      assert.equal(registry.kinds.size, 0);
      assert.deepEqual(registry.warnings, []);
    });
  });

  test(`${name}: prefix-scoping — a Convention doc OUTSIDE conventions/ is not discovered`, async () => {
    await run(async (bundle) => {
      await writeDoc(bundle, { ...ROADMAP_KIND_DOC, id: "specs/roadmap-item" });
      const registry = await loadKinds(bundle);
      assert.equal(registry.kinds.size, 0, "a Convention doc outside conventions/ must not register a kind");
    });
  });

  test(`${name}: malformed convention docs are skipped with a collected warning, never thrown`, async () => {
    await run(async (bundle) => {
      await writeDoc(bundle, {
        id: "conventions/no-governs",
        frontmatter: { type: CONVENTION_TYPE, title: "Broken", timestamp: T },
        body: "missing 'governs'.",
      });
      await writeDoc(bundle, ROADMAP_KIND_DOC);
      const registry = await loadKinds(bundle);
      assert.equal(registry.kinds.size, 1);
      assert.ok(registry.kinds.has("Roadmap Item"));
      assert.equal(registry.warnings.length, 1);
      assert.equal(registry.warnings[0]!.code, "KIND_CONVENTION_MALFORMED");
      assert.match(registry.warnings[0]!.message, /no-governs/);
    });
  });

  test(`${name}: duplicate governs — first-by-id declaration wins, the shadowed one warns`, async () => {
    await run(async (bundle) => {
      await writeDoc(bundle, { ...ROADMAP_KIND_DOC, id: "conventions/a-roadmap-item" });
      await writeDoc(bundle, { ...ROADMAP_KIND_DOC, id: "conventions/z-roadmap-item", body: "a second declaration" });
      const registry = await loadKinds(bundle);
      assert.equal(registry.kinds.size, 1);
      assert.equal(registry.kinds.get("Roadmap Item")!.id, "conventions/a-roadmap-item"); // first-by-id
      assert.equal(registry.warnings.length, 1);
      assert.equal(registry.warnings[0]!.code, "KIND_DUPLICATE_GOVERNS");
    });
  });

  test(`${name}: a malformed freshness_horizon is ignored with a warning, kind still registers`, async () => {
    await run(async (bundle) => {
      await writeDoc(bundle, {
        ...ROADMAP_KIND_DOC,
        frontmatter: { ...ROADMAP_KIND_DOC.frontmatter, freshness_horizon: "not-a-horizon" },
      });
      const registry = await loadKinds(bundle);
      const kind = registry.kinds.get("Roadmap Item");
      assert.ok(kind);
      assert.equal(freshnessHorizonMs(kind!), undefined);
      assert.ok(registry.warnings.some((w) => w.code === "KIND_HORIZON_MALFORMED"));
    });
  });

  test(`${name}: a ZERO freshness_horizon ("0h") is rejected the same as malformed — never an instantly-stale horizon (F7 regression)`, async () => {
    await run(async (bundle) => {
      await writeDoc(bundle, {
        ...ROADMAP_KIND_DOC,
        frontmatter: { ...ROADMAP_KIND_DOC.frontmatter, freshness_horizon: "0h" },
      });
      const registry = await loadKinds(bundle);
      const kind = registry.kinds.get("Roadmap Item");
      assert.ok(kind);
      assert.equal(freshnessHorizonMs(kind!), undefined, "a zero horizon must not silently make everything instantly stale");
      assert.ok(registry.warnings.some((w) => w.code === "KIND_HORIZON_MALFORMED"));
    });
  });

  test(`${name}: a convention declaring CLI-reserved field names is filtered with migration guidance, not silently accepted (F2 regression)`, async () => {
    await run(async (bundle) => {
      await writeDoc(bundle, {
        id: "conventions/hijack",
        frontmatter: {
          type: CONVENTION_TYPE,
          title: "Hijack",
          governs: "Hijack",
          fields: { required: ["title", "type", "body-file"], optional: ["dir"] },
          timestamp: T,
        },
        body: "A convention that tries to declare reserved field names as its own.",
      });
      const registry = await loadKinds(bundle);
      const kind = registry.kinds.get("Hijack");
      assert.ok(kind);
      // The names are filtered OUT of required/optional entirely — never ambiguously interpreted
      // as both a domain field and a CLI control at authoring time.
      assert.deepEqual(kind!.fields.required, ["title"]);
      assert.deepEqual(kind!.fields.optional, []);
      const warning = registry.warnings.find((w) => w.code === "KIND_RESERVED_FIELD");
      assert.ok(warning, "expected a KIND_RESERVED_FIELD warning");
      assert.match(warning!.message, /type/);
      assert.match(warning!.message, /dir/);
      assert.match(warning!.message, /body-file/);
      assert.match(warning!.message, /rename those domain fields/);
    });
  });
}

test("loadKinds: absent descriptions normalize empty; malformed descriptions warn and skip; undeclared guidance is retained", async () => {
  await withMemBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: "conventions/described",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Described",
        description: "   ",
        fields: {
          required: ["title"],
          optional: ["note"],
          descriptions: {
            title: "  Human title.  ",
            note: 42,
            extra: "Retained guidance for an undeclared field.",
            type: "Reserved guidance.",
          },
        },
        timestamp: T,
      },
      body: "",
    });
    await writeDoc(bundle, {
      id: "conventions/non-map",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Non-map",
        description: false,
        fields: { required: ["title"], descriptions: ["wrong"] },
        timestamp: T,
      },
      body: "",
    });
    await writeDoc(bundle, {
      id: "conventions/absent",
      frontmatter: { type: CONVENTION_TYPE, governs: "Absent", fields: { required: ["title"] }, timestamp: T },
      body: "",
    });

    const registry = await loadKinds(bundle);
    assert.equal(registry.kinds.get("Described")!.description, undefined);
    assert.deepEqual(registry.kinds.get("Described")!.fields.descriptions, {
      title: "Human title.",
      extra: "Retained guidance for an undeclared field.",
    });
    assert.equal(registry.kinds.get("Non-map")!.description, undefined);
    assert.deepEqual(registry.kinds.get("Non-map")!.fields.descriptions, {});
    assert.deepEqual(registry.kinds.get("Absent")!.fields.descriptions, {});
    assert.equal(registry.warnings.filter((w) => w.code === "KIND_RESERVED_FIELD").length, 1);
    const reserved = registry.warnings.find((w) => w.code === "KIND_RESERVED_FIELD");
    assert.equal(reserved?.field, "fields.descriptions.type");
    assert.ok(
      !registry.warnings.some(
        (w) =>
          w.code === "KIND_CONVENTION_UNDECLARED_DESCRIPTION_FIELD" &&
          w.field === "fields.descriptions.type",
      ),
    );
    assert.ok(registry.warnings.some((w) => w.code === "KIND_CONVENTION_BAD_SHAPE" && w.field === "description"));
    assert.ok(
      registry.warnings.some(
        (w) => w.code === "KIND_CONVENTION_BAD_SHAPE" && w.field === "fields.descriptions",
      ),
    );
    assert.ok(
      registry.warnings.some(
        (w) => w.code === "KIND_CONVENTION_BAD_MEMBER" && w.field === "fields.descriptions.note",
      ),
    );
    assert.ok(
      registry.warnings.some(
        (w) =>
          w.code === "KIND_CONVENTION_UNDECLARED_DESCRIPTION_FIELD" &&
          w.field === "fields.descriptions.extra",
      ),
    );
  });
});

test("parseConventionDoc: fields.value_descriptions keeps only declared enum values and warns precisely", () => {
  const parsed = parseConventionDoc({
    id: "conventions/described-enum",
    frontmatter: {
      type: CONVENTION_TYPE,
      governs: "Described Enum",
      fields: {
        required: ["status"],
        optional: ["note"],
        values: { status: ["active", "challenged", "locked", "deprecated"] },
        value_descriptions: {
          status: {
            active: "  Supported, but still open to revision.  ",
            challenged: "",
            locked: 42,
            deprecated: "Retained for history but not for new reliance.",
            invented: "Not an allowed lifecycle value.",
          },
          note: { short: "A declared field, but not an enum field." },
          missing: { anything: "Not a declared field." },
        },
      },
      timestamp: T,
    },
    body: "",
  });

  assert.ok(parsed.kind);
  assert.deepEqual(parsed.kind!.fields.valueDescriptions, {
    status: {
      active: "Supported, but still open to revision.",
      deprecated: "Retained for history but not for new reliance.",
    },
  });
  assert.ok(
    parsed.warnings.some(
      (warning) =>
        warning.code === "KIND_CONVENTION_BAD_MEMBER" &&
        warning.field === "fields.value_descriptions.status.challenged",
    ),
  );
  assert.ok(
    parsed.warnings.some(
      (warning) =>
        warning.code === "KIND_CONVENTION_BAD_MEMBER" &&
        warning.field === "fields.value_descriptions.status.locked",
    ),
  );
  assert.ok(
    parsed.warnings.some(
      (warning) =>
        warning.code === "KIND_CONVENTION_UNDECLARED_VALUE_DESCRIPTION_VALUE" &&
        warning.field === "fields.value_descriptions.status.invented",
    ),
  );
  for (const field of ["note", "missing"]) {
    assert.ok(
      parsed.warnings.some(
        (warning) =>
          warning.code === "KIND_CONVENTION_UNDECLARED_VALUE_DESCRIPTION_FIELD" &&
          warning.field === `fields.value_descriptions.${field}`,
      ),
    );
  }

  const badOuter = parseConventionDoc({
    id: "conventions/value-descriptions-list",
    frontmatter: {
      type: CONVENTION_TYPE,
      governs: "Value Descriptions List",
      fields: { required: ["status"], values: { status: ["active"] }, value_descriptions: ["active"] },
      timestamp: T,
    },
    body: "",
  });
  assert.deepEqual(badOuter.kind?.fields.valueDescriptions, {});
  assert.ok(
    badOuter.warnings.some(
      (warning) => warning.code === "KIND_CONVENTION_BAD_SHAPE" && warning.field === "fields.value_descriptions",
    ),
  );

  const badInner = parseConventionDoc({
    id: "conventions/value-descriptions-inner-list",
    frontmatter: {
      type: CONVENTION_TYPE,
      governs: "Value Descriptions Inner List",
      fields: {
        required: ["status"],
        values: { status: ["active"] },
        value_descriptions: { status: ["active"] },
      },
      timestamp: T,
    },
    body: "",
  });
  assert.deepEqual(badInner.kind?.fields.valueDescriptions, {});
  assert.ok(
    badInner.warnings.some(
      (warning) =>
        warning.code === "KIND_CONVENTION_BAD_SHAPE" &&
        warning.field === "fields.value_descriptions.status",
    ),
  );

  const absent = parseConventionDoc({
    id: "conventions/no-value-descriptions",
    frontmatter: {
      type: CONVENTION_TYPE,
      governs: "No Value Descriptions",
      fields: { required: ["status"], values: { status: ["active"] } },
      timestamp: T,
    },
    body: "",
  });
  assert.deepEqual(absent.kind?.fields.valueDescriptions, {});
  assert.equal(absent.warnings.length, 0);
});

test("loadKinds: YAML timestamps are rejected as outer and nested value-description maps", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-kind-date-map-"));
  try {
    await initBundle(dir);
    await mkdir(path.join(dir, "conventions"), { recursive: true });
    await writeFile(
      path.join(dir, "conventions", "outer-date.md"),
      `---\ntype: Convention\ngoverns: Outer Date\nfields:\n  required: [status]\n  values:\n    status: [active]\n  value_descriptions: 2026-07-01T00:00:00.000Z\n---\n`,
    );
    await writeFile(
      path.join(dir, "conventions", "inner-date.md"),
      `---\ntype: Convention\ngoverns: Inner Date\nfields:\n  required: [status]\n  values:\n    status: [active]\n  value_descriptions:\n    status: 2026-07-01T00:00:00.000Z\n---\n`,
    );

    const registry = await loadKinds({ root: dir });
    assert.deepEqual(registry.kinds.get("Outer Date")!.fields.valueDescriptions, {});
    assert.deepEqual(registry.kinds.get("Inner Date")!.fields.valueDescriptions, {});
    assert.ok(registry.warnings.some((w) => w.code === "KIND_CONVENTION_BAD_SHAPE" && w.field === "fields.value_descriptions"));
    assert.ok(registry.warnings.some((w) => w.code === "KIND_CONVENTION_BAD_SHAPE" && w.field === "fields.value_descriptions.status"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kindConventionDoc: public literals may omit valueDescriptions while parsed output stays normalized", () => {
  const legacy: KindConvention = {
    id: "conventions/legacy",
    title: "Legacy",
    governs: "Legacy",
    fields: { required: [], optional: ["status"], values: { status: ["done"] }, terminal: {}, descriptions: {} },
  };
  const reparsed = parseConventionDoc(kindConventionDoc(legacy, "", T));
  assert.ok(reparsed.ok);
  assert.deepEqual(reparsed.kind.fields.valueDescriptions, {});
});

test("value descriptions use own declarations for prototype-looking fields and values in parser and serializer", () => {
  const undeclared = parseConventionDoc({
    id: "conventions/prototype-value-descriptions",
    frontmatter: {
      type: CONVENTION_TYPE,
      governs: "Prototype Value Descriptions",
      fields: {
        required: ["status"],
        values: { status: ["active"] },
        value_descriptions: Object.fromEntries([
          ["status", Object.fromEntries([
            ["toString", "Must not match Object.prototype."],
            ["__proto__", "Must not receive special treatment."],
          ])],
          ["toString", { active: "Must not match Object.prototype." }],
          ["__proto__", { active: "Must not receive special treatment." }],
        ]),
      },
      timestamp: T,
    },
    body: "",
  });
  assert.deepEqual(undeclared.kind?.fields.valueDescriptions, {});
  assert.deepEqual(
    undeclared.warnings
      .filter((warning) => warning.code === "KIND_CONVENTION_UNDECLARED_VALUE_DESCRIPTION_FIELD")
      .map((warning) => warning.field)
      .sort(),
    ["fields.value_descriptions.__proto__", "fields.value_descriptions.toString"],
  );
  assert.deepEqual(
    undeclared.warnings
      .filter((warning) => warning.code === "KIND_CONVENTION_UNDECLARED_VALUE_DESCRIPTION_VALUE")
      .map((warning) => warning.field)
      .sort(),
    ["fields.value_descriptions.status.__proto__", "fields.value_descriptions.status.toString"],
  );

  const rejectedSerialization = kindConventionDoc(
    {
      id: "conventions/rejected-prototype-values",
      title: "Rejected Prototype Values",
      governs: "Rejected Prototype Values",
      fields: {
        required: ["status"],
        optional: [],
        values: { status: ["active"] },
        valueDescriptions: Object.fromEntries([
          ["status", Object.fromEntries([
            ["toString", "Must not match Object.prototype."],
            ["__proto__", "Must not receive special treatment."],
          ])],
          ["toString", { active: "Must not match Object.prototype." }],
          ["__proto__", { active: "Must not receive special treatment." }],
        ]),
        terminal: {},
        descriptions: {},
      },
    },
    "",
    T,
  );
  assert.ok(!("value_descriptions" in (rejectedSerialization.frontmatter.fields as Record<string, unknown>)));

  const specialFields = Object.fromEntries([
    ["toString", ["__proto__"]],
    ["__proto__", ["toString"]],
  ]);
  const specialDescriptions = Object.fromEntries([
    ["toString", Object.fromEntries([["__proto__", "A declared special-looking value."]])],
    ["__proto__", Object.fromEntries([["toString", "Another declared special-looking value."]])],
  ]);
  const declared = parseConventionDoc({
    id: "conventions/declared-prototype-values",
    frontmatter: {
      type: CONVENTION_TYPE,
      governs: "Declared Prototype Values",
      fields: {
        required: ["toString", "__proto__"],
        values: specialFields,
        value_descriptions: specialDescriptions,
      },
      timestamp: T,
    },
    body: "",
  });
  assert.deepEqual(declared.kind?.fields.values, specialFields);
  assert.deepEqual(declared.kind?.fields.valueDescriptions, specialDescriptions);
  assert.equal(declared.warnings.length, 0);

  const serialized = kindConventionDoc(
    {
      id: "conventions/serialized-prototype-values",
      title: "Serialized Prototype Values",
      governs: "Serialized Prototype Values",
      fields: {
        required: ["toString", "__proto__"],
        optional: [],
        values: specialFields,
        valueDescriptions: {
          ...specialDescriptions,
          status: { active: "An undeclared field must not serialize." },
        },
        terminal: {},
        descriptions: {},
      },
    },
    "",
    T,
  );
  assert.deepEqual((serialized.frontmatter.fields as Record<string, unknown>).value_descriptions, specialDescriptions);
  const reparsed = parseConventionDoc(serialized);
  assert.deepEqual(reparsed.kind?.fields.valueDescriptions, specialDescriptions);
  assert.equal(reparsed.warnings.length, 0);
});

test("parseConventionDoc preserves prototype-looking field maps as own keys with ordinary prototypes", () => {
  for (const field of ["__proto__", "constructor", "toString"]) {
    const parsed = parseConventionDoc({
      id: `conventions/special-${field}`,
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: `Special ${field}`,
        fields: {
          required: [field],
          values: Object.fromEntries([[field, ["open", "done"]]]),
          terminal: Object.fromEntries([[field, ["done"]]]),
          descriptions: Object.fromEntries([[field, `Description for ${field}.`]]),
        },
        timestamp: T,
      },
      body: "",
    });
    assert.ok(parsed.ok);
    for (const map of [parsed.kind.fields.values, parsed.kind.fields.terminal, parsed.kind.fields.descriptions]) {
      assert.equal(Object.prototype.hasOwnProperty.call(map, field), true);
      assert.equal(Object.getPrototypeOf(map), Object.prototype);
    }
    assert.deepEqual(parsed.kind.fields.values[field], ["open", "done"]);
    assert.deepEqual(parsed.kind.fields.terminal[field], ["done"]);
    assert.equal(parsed.kind.fields.descriptions[field], `Description for ${field}.`);
    assert.equal(parsed.warnings.length, 0);

    const missing: Frontmatter = { type: parsed.kind.governs };
    assert.equal(isTerminal(parsed.kind, missing), false);
    const authored = { type: parsed.kind.governs } as Record<string, unknown>;
    Object.defineProperty(authored, field, { value: "done", enumerable: true, configurable: true, writable: true });
    assert.equal(isTerminal(parsed.kind, authored as Frontmatter), true);
  }
});

test("prototype-looking terminal fields without values parse safely and warn at the exact path", () => {
  for (const field of ["__proto__", "constructor", "toString"]) {
    const parsed = parseConventionDoc({
      id: `conventions/terminal-without-values-${field}`,
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: `Terminal Without Values ${field}`,
        fields: {
          required: [field],
          terminal: Object.fromEntries([[field, ["done"]]]),
        },
        timestamp: T,
      },
      body: "",
    });

    assert.ok(parsed.ok);
    assert.equal(Object.getPrototypeOf(parsed.kind.fields.terminal), Object.prototype);
    assert.equal(Object.prototype.hasOwnProperty.call(parsed.kind.fields.terminal, field), true);
    assert.deepEqual(parsed.kind.fields.terminal[field], ["done"]);
    assert.deepEqual(
      parsed.warnings.map(({ code, field: warningField }) => ({ code, field: warningField })),
      [{ code: "KIND_CONVENTION_TERMINAL_UNDECLARED_FIELD", field: `fields.terminal.${field}` }],
    );
  }
});

// ── convention-doc shape warnings (usability finding F2: agents fed 8 wrong YAML shapes for enum
// constraints and every one was silently accepted, enforcing nothing; a required list fed OBJECTS
// silently corrupted to "[object Object]" entries). parseConventionDoc must be STRICT inside the
// blocks core owns (`fields:`) and PERMISSIVE everywhere else (OKF §9 permits unknown
// frontmatter) — these tests pin that asymmetry. ─────────────────────────────────────────────

test("loadKinds: an unrecognized key inside 'fields:' (not required/optional/values) warns naming the key + valid keys, and contributes nothing", async () => {
  await withMemBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: "conventions/fields-enum",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Status Kind",
        // 'fields.enum' is one of the 8 wrong shapes the F2 study caught agents reaching for.
        fields: { required: ["title"], optional: [], enum: ["a", "b"] },
        timestamp: T,
      },
      body: "A convention with a misplaced 'fields.enum' key.",
    });
    const registry = await loadKinds(bundle);
    const kind = registry.kinds.get("Status Kind");
    assert.ok(kind);
    assert.deepEqual(kind!.fields.required, ["title"]);
    assert.deepEqual(kind!.fields.values, {}); // the bogus key enforces NOTHING — never silently accepted
    const warning = registry.warnings.find((w) => w.code === "KIND_CONVENTION_UNKNOWN_FIELDS_KEY");
    assert.ok(warning, "expected a KIND_CONVENTION_UNKNOWN_FIELDS_KEY warning");
    assert.match(warning!.message, /fields\.enum/);
    assert.match(warning!.message, /fields\.required.*fields\.optional.*fields\.values/);
  });
});

test("loadKinds: an object member in 'fields.required' warns and is DROPPED, never stringified to '[object Object]' (F2 regression)", async () => {
  await withMemBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: "conventions/objects-in-required",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Objects Kind",
        // 'required' fed a list of OBJECTS — the exact silent-corruption case from the study.
        fields: { required: ["title", { name: "status" }], optional: [] },
        timestamp: T,
      },
      body: "A convention whose 'required' list carries an object member.",
    });
    const registry = await loadKinds(bundle);
    const kind = registry.kinds.get("Objects Kind");
    assert.ok(kind);
    assert.deepEqual(kind!.fields.required, ["title"]); // the object member is DROPPED, not stringified
    assert.ok(!kind!.fields.required.some((f) => f.includes("object Object")));
    const warning = registry.warnings.find((w) => w.code === "KIND_CONVENTION_BAD_MEMBER");
    assert.ok(warning, "expected a KIND_CONVENTION_BAD_MEMBER warning");
    assert.match(warning!.message, /fields\.required/);
  });
});

test("loadKinds: parses a 'links' declaration (typed-edge vocabulary); wrong shapes warn and are ignored; absent stays absent with no warning", async () => {
  await withMemBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: "conventions/linked-item",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Linked Item",
        fields: { required: ["title"], optional: [] },
        // The decided declaration shape (decisions/typed-links-carrier): link type -> target kind.
        links: { contains: "Task", "depends on": "Task" },
        timestamp: T,
      },
      body: "A convention declaring its typed-edge vocabulary.",
    });
    await writeDoc(bundle, {
      id: "conventions/links-as-list",
      frontmatter: { type: CONVENTION_TYPE, governs: "Links As List", links: ["contains"], timestamp: T },
      body: "links as a list, not a map.",
    });
    await writeDoc(bundle, {
      id: "conventions/links-bad-member",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Links Bad Member",
        links: { contains: { kind: "Task" }, supersedes: "Claim" },
        timestamp: T,
      },
      body: "one malformed links entry beside a good one.",
    });
    await writeDoc(bundle, {
      id: "conventions/no-links",
      frontmatter: { type: CONVENTION_TYPE, governs: "No Links", timestamp: T },
      body: "no links key at all.",
    });

    const registry = await loadKinds(bundle);
    assert.deepEqual(registry.kinds.get("Linked Item")!.links, { contains: "Task", "depends on": "Task" });

    // Non-map shape: ignored entirely, KIND_CONVENTION_BAD_SHAPE names 'links'.
    assert.equal(registry.kinds.get("Links As List")!.links, undefined);
    assert.ok(
      registry.warnings.some(
        (w) => w.code === "KIND_CONVENTION_BAD_SHAPE" && /links-as-list/.test(w.message) && /'links'/.test(w.message),
      ),
    );

    // Malformed entry: skipped with KIND_CONVENTION_BAD_MEMBER; the good entry survives.
    assert.deepEqual(registry.kinds.get("Links Bad Member")!.links, { supersedes: "Claim" });
    assert.ok(
      registry.warnings.some((w) => w.code === "KIND_CONVENTION_BAD_MEMBER" && w.field === "links.contains"),
    );

    // Absent: no key on the parsed kind, and no warning (not declared is normal).
    assert.equal(registry.kinds.get("No Links")!.links, undefined);
    assert.ok(!registry.warnings.some((w) => /no-links/.test(w.message)));
  });
});

test("loadKinds: link_descriptions keeps declared non-empty guidance; malformed and undeclared entries warn precisely and are skipped", async () => {
  await withMemBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: "conventions/described-links",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Described Links",
        links: { contains: "Task", "depends on": "Task" },
        link_descriptions: {
          contains: "  Work governed by this commitment.  ",
          "depends on": "",
          blocks: "A relationship that is not declared.",
          numbered: 42,
        },
        timestamp: T,
      },
      body: "A convention with relationship guidance.",
    });
    await writeDoc(bundle, {
      id: "conventions/descriptions-as-list",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Descriptions As List",
        links: { contains: "Task" },
        link_descriptions: ["contains"],
        timestamp: T,
      },
      body: "link_descriptions as a list, not a map.",
    });
    await writeDoc(bundle, {
      id: "conventions/no-link-descriptions",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "No Link Descriptions",
        links: { contains: "Task" },
        timestamp: T,
      },
      body: "No relationship guidance.",
    });

    const registry = await loadKinds(bundle);
    assert.deepEqual(registry.kinds.get("Described Links")!.linkDescriptions, {
      contains: "Work governed by this commitment.",
    });
    assert.ok(
      registry.warnings.some(
        (w) => w.code === "KIND_CONVENTION_BAD_MEMBER" && w.field === "link_descriptions.depends on",
      ),
    );
    assert.ok(
      registry.warnings.some(
        (w) => w.code === "KIND_CONVENTION_BAD_MEMBER" && w.field === "link_descriptions.numbered",
      ),
    );
    assert.ok(
      registry.warnings.some(
        (w) =>
          w.code === "KIND_CONVENTION_UNDECLARED_LINK_DESCRIPTION" &&
          w.field === "link_descriptions.blocks" &&
          /not declared in links/.test(w.message),
      ),
    );
    assert.equal(registry.kinds.get("Descriptions As List")!.linkDescriptions, undefined);
    assert.ok(
      registry.warnings.some(
        (w) => w.code === "KIND_CONVENTION_BAD_SHAPE" && w.field === "link_descriptions",
      ),
    );
    assert.equal(registry.kinds.get("No Link Descriptions")!.linkDescriptions, undefined);
    assert.ok(!registry.warnings.some((w) => /no-link-descriptions/.test(w.message)));
  });
});

test("parseConventionDoc: link_descriptions requires an own links declaration, including prototype-looking keys", () => {
  const undeclaredDescriptions = Object.fromEntries([
    ["toString", "Must not match Object.prototype."],
    ["__proto__", "Must not receive special treatment."],
  ]);
  const parsed = parseConventionDoc({
    id: "conventions/prototype-link-descriptions",
    frontmatter: {
      type: CONVENTION_TYPE,
      governs: "Prototype Link Descriptions",
      links: { contains: "Task" },
      link_descriptions: undeclaredDescriptions,
      timestamp: T,
    },
    body: "",
  });

  assert.ok(parsed.kind);
  assert.equal(parsed.kind!.linkDescriptions, undefined);
  assert.deepEqual(
    parsed.warnings
      .filter((warning) => warning.code === "KIND_CONVENTION_UNDECLARED_LINK_DESCRIPTION")
      .map((warning) => warning.field)
      .sort(),
    ["link_descriptions.__proto__", "link_descriptions.toString"],
  );

  const ownSpecialLink = Object.fromEntries([["toString", "Task"]]);
  const ownSpecialDescription = Object.fromEntries([["toString", "An explicitly declared special-looking link."]]);
  const declared = parseConventionDoc({
    id: "conventions/declared-special-link",
    frontmatter: {
      type: CONVENTION_TYPE,
      governs: "Declared Special Link",
      links: ownSpecialLink,
      link_descriptions: ownSpecialDescription,
      timestamp: T,
    },
    body: "",
  });

  assert.deepEqual(declared.kind?.links, ownSpecialLink);
  assert.deepEqual(declared.kind?.linkDescriptions, ownSpecialDescription);
  assert.equal(declared.warnings.length, 0);
});

test("kindConventionDoc: never serializes relationship guidance for inherited or undeclared special-looking keys", () => {
  const linkDescriptions = Object.fromEntries([
    ["toString", "Must not match Object.prototype."],
    ["__proto__", "Must not receive special treatment."],
  ]);
  const doc = kindConventionDoc(
    {
      id: "conventions/prototype-serialization",
      title: "Prototype Serialization",
      governs: "Prototype Serialization",
      fields: { required: [], optional: [], values: {}, terminal: {}, descriptions: {} },
      links: { contains: "Task" },
      linkDescriptions,
    },
    "",
    T,
  );

  assert.equal(doc.frontmatter.link_descriptions, undefined);

  const declaredSpecialLink = Object.fromEntries([["toString", "Task"]]);
  const declaredSpecialDescription = Object.fromEntries([
    ["toString", "An explicitly declared special-looking link."],
  ]);
  const declaredDoc = kindConventionDoc(
    {
      id: "conventions/declared-special-serialization",
      title: "Declared Special Serialization",
      governs: "Declared Special Serialization",
      fields: { required: [], optional: [], values: {}, terminal: {}, descriptions: {} },
      links: declaredSpecialLink,
      linkDescriptions: declaredSpecialDescription,
    },
    "",
    T,
  );
  assert.deepEqual(declaredDoc.frontmatter.link_descriptions, declaredSpecialDescription);
});

test("kindConventionDoc: a links declaration round-trips through write/loadKinds", async () => {
  await withMemBundle(async (bundle) => {
    const kind: KindConvention = {
      id: "conventions/linked-kind",
      title: "Linked Kind",
      governs: "Linked Kind",
      fields: { required: ["title"], optional: [], values: {}, terminal: {}, descriptions: {} },
      links: { contains: "Task" },
      linkDescriptions: { contains: "  Work governed by this kind.  " },
    };
    await writeDoc(bundle, kindConventionDoc(kind, "prose.", T));
    const registry = await loadKinds(bundle);
    assert.deepEqual(registry.kinds.get("Linked Kind")!.links, { contains: "Task" });
    assert.deepEqual(registry.kinds.get("Linked Kind")!.linkDescriptions, {
      contains: "Work governed by this kind.",
    });
    assert.equal(registry.warnings.length, 0);
  });
});

test("loadKinds: parses an 'expects_inbound' declaration (inbound-link expectation, declared on the TARGET kind); wrong shapes warn and are ignored; absent stays absent with no warning", async () => {
  await withMemBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: "conventions/widget",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Widget",
        fields: { required: ["title"], optional: [] },
        // A GENERIC vocabulary (not Task/Roadmap Item) to pin that nothing is hardcoded: a
        // 'Widget' expects an inbound 'contains' edge from a 'Crate' and an inbound 'assigned to'
        // edge from an 'Owner'.
        expects_inbound: { contains: "Crate", "assigned to": "Owner" },
        timestamp: T,
      },
      body: "A convention declaring its inbound-link expectations.",
    });
    await writeDoc(bundle, {
      id: "conventions/expects-as-list",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Expects As List",
        expects_inbound: ["contains"],
        timestamp: T,
      },
      body: "expects_inbound as a list, not a map.",
    });
    await writeDoc(bundle, {
      id: "conventions/expects-bad-member",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Expects Bad Member",
        expects_inbound: { contains: { kind: "Crate" }, supersedes: "Claim" },
        timestamp: T,
      },
      body: "one malformed expects_inbound entry beside a good one.",
    });
    await writeDoc(bundle, {
      id: "conventions/no-expects",
      frontmatter: { type: CONVENTION_TYPE, governs: "No Expects", timestamp: T },
      body: "no expects_inbound key at all.",
    });

    const registry = await loadKinds(bundle);
    assert.deepEqual(registry.kinds.get("Widget")!.expectsInbound, { contains: "Crate", "assigned to": "Owner" });

    // Non-map shape: ignored entirely, KIND_CONVENTION_BAD_SHAPE names 'expects_inbound'.
    assert.equal(registry.kinds.get("Expects As List")!.expectsInbound, undefined);
    assert.ok(
      registry.warnings.some(
        (w) =>
          w.code === "KIND_CONVENTION_BAD_SHAPE" &&
          /expects-as-list/.test(w.message) &&
          /'expects_inbound'/.test(w.message),
      ),
    );

    // Malformed entry: skipped with KIND_CONVENTION_BAD_MEMBER; the good entry survives.
    assert.deepEqual(registry.kinds.get("Expects Bad Member")!.expectsInbound, { supersedes: "Claim" });
    assert.ok(
      registry.warnings.some(
        (w) => w.code === "KIND_CONVENTION_BAD_MEMBER" && w.field === "expects_inbound.contains",
      ),
    );

    // Absent: no key on the parsed kind, and no warning (not declared is normal).
    assert.equal(registry.kinds.get("No Expects")!.expectsInbound, undefined);
    assert.ok(!registry.warnings.some((w) => /no-expects/.test(w.message)));
  });
});

test("kindConventionDoc: an expects_inbound declaration round-trips through write/loadKinds", async () => {
  await withMemBundle(async (bundle) => {
    const kind: KindConvention = {
      id: "conventions/expecting-kind",
      title: "Expecting Kind",
      governs: "Expecting Kind",
      fields: { required: ["title"], optional: [], values: {}, terminal: {}, descriptions: {} },
      expectsInbound: { contains: "Crate" },
    };
    await writeDoc(bundle, kindConventionDoc(kind, "prose.", T));
    const registry = await loadKinds(bundle);
    assert.deepEqual(registry.kinds.get("Expecting Kind")!.expectsInbound, { contains: "Crate" });
    assert.equal(registry.warnings.length, 0);
  });
});

test("special-looking relationship keys survive parse/serialize round-trip as own data properties", () => {
  const special = ["__proto__", "constructor", "toString"];
  const links = Object.fromEntries(special.map((key) => [key, `Target ${key}`]));
  const linkDescriptions = Object.fromEntries(special.map((key) => [key, `Guidance for ${key}.`]));
  const expectsInbound = Object.fromEntries(special.map((key) => [key, `Source ${key}`]));
  const first = parseConventionDoc({
    id: "conventions/special-relationships",
    frontmatter: {
      type: CONVENTION_TYPE,
      governs: "Special Relationships",
      fields: {},
      links,
      link_descriptions: linkDescriptions,
      expects_inbound: expectsInbound,
      timestamp: T,
    },
    body: "",
  });
  assert.ok(first.ok);
  assert.equal(first.warnings.length, 0);

  const reparsed = parseConventionDoc(kindConventionDoc(first.kind, "", T));
  assert.ok(reparsed.ok);
  assert.equal(reparsed.warnings.length, 0);
  for (const [actual, expected] of [
    [reparsed.kind.links, links],
    [reparsed.kind.linkDescriptions, linkDescriptions],
    [reparsed.kind.expectsInbound, expectsInbound],
  ] as const) {
    assert.deepEqual(actual, expected);
    assert.equal(Object.getPrototypeOf(actual!), Object.prototype);
    for (const key of special) assert.equal(Object.prototype.hasOwnProperty.call(actual, key), true);
  }
});

test("loadKinds: a 'fields.values' key naming a field NOT in required/optional warns (a declared constraint on an undeclared field)", async () => {
  await withMemBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: "conventions/undeclared-values",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Undeclared Kind",
        // 'status' is constrained but never declared required/optional.
        fields: { required: ["title"], optional: [], values: { status: ["planned", "done"] } },
        timestamp: T,
      },
      body: "A convention constraining 'status' without declaring it required/optional.",
    });
    const registry = await loadKinds(bundle);
    const kind = registry.kinds.get("Undeclared Kind");
    assert.ok(kind);
    assert.deepEqual(kind!.fields.values, { status: ["planned", "done"] }); // still registers — a warning, not a rejection
    const warning = registry.warnings.find((w) => w.code === "KIND_CONVENTION_UNDECLARED_VALUES_FIELD");
    assert.ok(warning, "expected a KIND_CONVENTION_UNDECLARED_VALUES_FIELD warning");
    assert.match(warning!.message, /status/);
  });
});

// ── 'fields.terminal' (tasks/status-terminal-declaration.md): the subset of an enum's values past
// which an instance is "done". GENERIC vocabulary (a 'Ticket' kind, not Task) to pin that nothing
// is hardcoded — mirrors the exact lenient posture of 'fields.values' above (absent normal,
// non-map BAD_SHAPE warn+ignore, non-scalar member BAD_MEMBER warn+skip) plus two coherence checks.
test("loadKinds: parses 'fields.terminal' (happy path); wrong shapes warn and are ignored; absent stays absent with no warning", async () => {
  await withMemBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: "conventions/ticket",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Ticket",
        fields: {
          required: ["title", "stage"],
          optional: [],
          values: { stage: ["open", "in_review", "resolved", "archived"] },
          terminal: { stage: ["resolved", "archived"] },
        },
        timestamp: T,
      },
      body: "A convention declaring which stage values are terminal.",
    });
    await writeDoc(bundle, {
      id: "conventions/terminal-as-list",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Terminal As List",
        fields: { required: ["title"], optional: [], terminal: ["resolved"] },
        timestamp: T,
      },
      body: "fields.terminal as a list, not a map.",
    });
    await writeDoc(bundle, {
      id: "conventions/terminal-bad-member",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Terminal Bad Member",
        fields: {
          required: ["title", "stage"],
          optional: [],
          values: { stage: ["open", "resolved"] },
          terminal: { stage: ["resolved", { weird: true }] },
        },
        timestamp: T,
      },
      body: "one non-scalar terminal member beside a good one.",
    });
    await writeDoc(bundle, {
      id: "conventions/no-terminal",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "No Terminal",
        fields: { required: ["title"], optional: [] },
        timestamp: T,
      },
      body: "no fields.terminal key at all.",
    });

    const registry = await loadKinds(bundle);
    assert.deepEqual(registry.kinds.get("Ticket")!.fields.terminal, { stage: ["resolved", "archived"] });

    // Non-map shape: ignored entirely (empty map), KIND_CONVENTION_BAD_SHAPE names 'fields.terminal'.
    assert.deepEqual(registry.kinds.get("Terminal As List")!.fields.terminal, {});
    assert.ok(
      registry.warnings.some(
        (w) =>
          w.code === "KIND_CONVENTION_BAD_SHAPE" &&
          /terminal-as-list/.test(w.message) &&
          /'fields\.terminal'/.test(w.message),
      ),
    );

    // Malformed member: skipped with KIND_CONVENTION_BAD_MEMBER; the good member survives.
    assert.deepEqual(registry.kinds.get("Terminal Bad Member")!.fields.terminal, { stage: ["resolved"] });
    assert.ok(
      registry.warnings.some(
        (w) => w.code === "KIND_CONVENTION_BAD_MEMBER" && w.field === "fields.terminal.stage",
      ),
    );

    // Absent: an empty map (the KindFields default), and no warning (not declared is normal).
    assert.deepEqual(registry.kinds.get("No Terminal")!.fields.terminal, {});
    assert.ok(!registry.warnings.some((w) => /no-terminal/.test(w.message)));
  });
});

test("loadKinds: 'fields.terminal' coherence warnings — a terminal set over a field with no declared enum, and a terminal value outside the declared enum", async () => {
  await withMemBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: "conventions/terminal-undeclared-field",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Terminal Undeclared Field",
        // 'stage' has a terminal set but NO fields.values.stage enum at all.
        fields: { required: ["title", "stage"], optional: [], terminal: { stage: ["done"] } },
        timestamp: T,
      },
      body: "A terminal set declared over a field with no enum.",
    });
    await writeDoc(bundle, {
      id: "conventions/terminal-value-outside-enum",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Terminal Value Outside Enum",
        fields: {
          required: ["title", "stage"],
          optional: [],
          values: { stage: ["open", "resolved"] },
          // 'archived' is not one of the declared stage values.
          terminal: { stage: ["resolved", "archived"] },
        },
        timestamp: T,
      },
      body: "A terminal value outside the declared enum.",
    });

    const registry = await loadKinds(bundle);

    assert.deepEqual(registry.kinds.get("Terminal Undeclared Field")!.fields.terminal, { stage: ["done"] });
    const undeclared = registry.warnings.find((w) => w.code === "KIND_CONVENTION_TERMINAL_UNDECLARED_FIELD");
    assert.ok(undeclared, "expected a KIND_CONVENTION_TERMINAL_UNDECLARED_FIELD warning");
    assert.match(undeclared!.message, /stage/);

    assert.deepEqual(registry.kinds.get("Terminal Value Outside Enum")!.fields.terminal, {
      stage: ["resolved", "archived"],
    });
    const outsideEnum = registry.warnings.find((w) => w.code === "KIND_CONVENTION_TERMINAL_VALUE");
    assert.ok(outsideEnum, "expected a KIND_CONVENTION_TERMINAL_VALUE warning");
    assert.match(outsideEnum!.message, /archived/);
  });
});

test("kindConventionDoc: a 'fields.terminal' declaration round-trips through write/loadKinds", async () => {
  await withMemBundle(async (bundle) => {
    const kind: KindConvention = {
      id: "conventions/terminal-kind",
      title: "Terminal Kind",
      governs: "Terminal Kind",
      fields: {
        required: ["title", "stage"],
        optional: [],
        values: { stage: ["open", "resolved"] },
        terminal: { stage: ["resolved"] },
        descriptions: {},
      },
    };
    await writeDoc(bundle, kindConventionDoc(kind, "prose.", T));
    const registry = await loadKinds(bundle);
    assert.deepEqual(registry.kinds.get("Terminal Kind")!.fields.terminal, { stage: ["resolved"] });
    assert.equal(registry.warnings.length, 0);
  });
});

test("isTerminal: truth table — declared+terminal, declared+non-terminal, undeclared field, no terminal declarations at all", () => {
  const kind: KindConvention = {
    id: "conventions/ticket",
    title: "Ticket",
    governs: "Ticket",
    fields: {
      required: ["title", "stage"],
      optional: [],
      values: { stage: ["open", "in_review", "resolved", "archived"] },
      terminal: { stage: ["resolved", "archived"] },
    },
  };
  assert.equal(isTerminal(kind, { type: "Ticket", stage: "resolved" }), true);
  assert.equal(isTerminal(kind, { type: "Ticket", stage: "archived" }), true);
  assert.equal(isTerminal(kind, { type: "Ticket", stage: "open" }), false);
  // A doc missing the declared terminal field entirely is never terminal (not-terminal is the
  // safe default).
  assert.equal(isTerminal(kind, { type: "Ticket" }), false);

  // A kind with an empty 'fields.terminal' (no declaration at all) is never terminal, regardless
  // of the frontmatter — the mechanism only fires when a bundle opts in.
  const undeclaredKind: KindConvention = {
    id: "conventions/plain",
    title: "Plain",
    governs: "Plain",
    fields: { required: ["title"], optional: [], values: {}, terminal: {}, descriptions: {} },
  };
  assert.equal(isTerminal(undeclaredKind, { type: "Plain", stage: "resolved" }), false);
});

test("prototype-looking fields require own properties for required, enum, and terminal semantics", () => {
  for (const field of ["__proto__", "constructor", "toString"]) {
    const inherited = String(({} as Record<string, unknown>)[field]);
    const values = Object.fromEntries([[field, [inherited]]]);
    const terminal = Object.fromEntries([[field, [inherited]]]);
    const kind: KindConvention = {
      id: `conventions/${field}`,
      title: field,
      governs: field,
      fields: { required: [field], optional: [], values, terminal, descriptions: {} },
    };
    const missing: OkfDocument = { id: field, frontmatter: { type: field }, body: "" };
    assert.deepEqual(validateAgainstKind(missing, kind).map((w) => w.code), ["KIND_FIELD_MISSING"]);
    assert.equal(isTerminal(kind, missing.frontmatter), false);

    const frontmatter = { type: field } as Record<string, unknown>;
    Object.defineProperty(frontmatter, field, { value: inherited, enumerable: true, configurable: true, writable: true });
    assert.deepEqual(validateAgainstKind({ id: `${field}-own`, frontmatter: frontmatter as Frontmatter, body: "" }, kind), []);
    assert.equal(isTerminal(kind, frontmatter as Frontmatter), true);
  }
});

test("loadKinds: a top-level near-miss constraint key ('enum'/'enums'/'values'/'constraints') warns 'did you mean fields.values?'", async () => {
  await withMemBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: "conventions/top-level-enum",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Top Level Kind",
        fields: { required: ["title"], optional: [] },
        enum: ["a", "b"], // one of the 8 wrong shapes the F2 study caught agents reaching for
        timestamp: T,
      },
      body: "A convention with a top-level 'enum:' key instead of fields.values.",
    });
    const registry = await loadKinds(bundle);
    assert.ok(registry.kinds.get("Top Level Kind")); // still registers — a warning, not a rejection
    const warning = registry.warnings.find((w) => w.code === "KIND_CONVENTION_MISPLACED_KEY");
    assert.ok(warning, "expected a KIND_CONVENTION_MISPLACED_KEY warning");
    assert.match(warning!.message, /fields\.values/);
  });
});

test("loadKinds: an arbitrary OTHER top-level frontmatter key produces NO warning (permissive outside fields:, per OKF §9's unknown-frontmatter tolerance)", async () => {
  await withMemBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: "conventions/extra-key",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Extra Key Kind",
        fields: { required: ["title"], optional: [] },
        owner: "team-foo", // an arbitrary producer-added key, not in the small deny-adjacent set
        status_enum: ["a", "b"], // a field-name-keyed near-miss — deliberately NOT denylisted
        timestamp: T,
      },
      body: "A convention with harmless extra top-level keys a producer might legitimately add.",
    });
    const registry = await loadKinds(bundle);
    assert.deepEqual(registry.warnings, []);
    assert.ok(registry.kinds.get("Extra Key Kind"));
  });
});

test("wire: loadKinds over a RemoteBackend bundle equals a local bundle (router-as-transport, no sockets)", async () => {
  const serverBackend = new ServerMemoryBackend();
  const serverBundle: Bundle = { root: "mem://kinds-wire-server", backend: serverBackend };
  await writeDoc(serverBundle, ROADMAP_KIND_DOC);
  const router = createRouter(serverBundle);
  const remoteBundle: Bundle = {
    root: "wire://kinds-client",
    backend: new RemoteBackend({ baseUrl: "http://wire.local", bundleId: "bnd_11111111111111111111111111111111", fetchImpl: router }),
  };

  const localBundle: Bundle = { root: "mem://kinds-wire-local", backend: new MemoryBackend() };
  await writeDoc(localBundle, ROADMAP_KIND_DOC);

  const [remoteRegistry, localRegistry] = await Promise.all([loadKinds(remoteBundle), loadKinds(localBundle)]);
  assert.deepEqual(remoteRegistry.warnings, localRegistry.warnings);
  assert.deepEqual([...remoteRegistry.kinds.entries()], [...localRegistry.kinds.entries()]);
  const kind = remoteRegistry.kinds.get("Roadmap Item");
  assert.ok(kind);
  assert.equal(freshnessHorizonMs(kind!), 30 * 86_400_000);
});

test("freshnessHorizonMs: parses <n>(m|h|d); undefined for absent/malformed", () => {
  assert.equal(freshnessHorizonMs({ ...NOTE_KIND_FIXTURE, freshnessHorizon: "24h" }), 24 * 3_600_000);
  assert.equal(freshnessHorizonMs({ ...NOTE_KIND_FIXTURE, freshnessHorizon: "15m" }), 15 * 60_000);
  assert.equal(freshnessHorizonMs({ ...NOTE_KIND_FIXTURE, freshnessHorizon: "2d" }), 2 * 86_400_000);
  assert.equal(freshnessHorizonMs({ ...NOTE_KIND_FIXTURE, freshnessHorizon: undefined }), undefined);
  assert.equal(freshnessHorizonMs({ ...NOTE_KIND_FIXTURE, freshnessHorizon: "24hours" }), undefined);
  assert.equal(freshnessHorizonMs({ ...NOTE_KIND_FIXTURE, freshnessHorizon: "h24" }), undefined);
});

test("validateAgainstKind: required/enum/section warnings, incl. the optional-empty-description + summary-only-section case", () => {
  const roadmapKind = {
    id: "conventions/roadmap-item",
    title: "Roadmap Item",
    governs: "Roadmap Item",
    path: "roadmap/",
    fields: { required: ["title", "status"], optional: ["horizon"], values: { status: ["planned", "active", "done"] } },
    sections: ["Why", "Done when"],
  };

  // Missing required 'status', bad enum value, missing declared section.
  const bad: OkfDocument = {
    id: "roadmap/x",
    frontmatter: { type: "Roadmap Item", title: "X", status: "unstarted", timestamp: T },
    body: "# Why\n\nBecause.\n",
  };
  const warnings = validateAgainstKind(bad, roadmapKind);
  const codes = warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ["KIND_FIELD_VALUE", "KIND_SECTION_MISSING"]);

  // A fully-conforming instance produces no warnings.
  const good: OkfDocument = {
    id: "roadmap/y",
    frontmatter: { type: "Roadmap Item", title: "Y", status: "planned", timestamp: T },
    body: "# Why\n\nBecause.\n\n# Done when\n\nWhen shipped.\n",
  };
  assert.deepEqual(validateAgainstKind(good, roadmapKind), []);

  // The NOTE_KIND_FIXTURE (shape-identical to the CLI's context-notes recipe kind): a Context
  // Note instance can legitimately carry an EMPTY description (optional, not required) — a
  // Context Note with title+timestamp but no description must not fail its own convention. The
  // summary-only body is DELIBERATE: the fixture's `sections:` declares only `Summary` (the one
  // section the recipe scaffolds and every instance carries), so the most common minimal shape
  // must pass clean — the alert-fatigue guard this design pins.
  const note: OkfDocument = {
    id: "context-notes/w/s/c",
    frontmatter: { type: "Context Note", title: "c", description: "", timestamp: T, tags: ["s", "w", "c"] },
    body: "# Summary\n\nHi.\n",
  };
  assert.deepEqual(validateAgainstKind(note, NOTE_KIND_FIXTURE), []);

  // Missing title entirely on a Context Note IS a violation (the `# Summary` body isolates the
  // title violation from the fixture's Summary-section lint).
  const noTitle: OkfDocument = {
    id: "context-notes/w/s/c2",
    frontmatter: { type: "Context Note", timestamp: T },
    body: "# Summary\n\nHi.\n",
  };
  const noTitleWarnings = validateAgainstKind(noTitle, NOTE_KIND_FIXTURE);
  assert.equal(noTitleWarnings.length, 1);
  assert.equal(noTitleWarnings[0]!.code, "KIND_FIELD_MISSING");
  assert.equal(noTitleWarnings[0]!.field, "title");
});

test("special-looking required sections require authored headings and splitSections keeps own keys", () => {
  const headings = ["__proto__", "constructor", "toString"];
  const kind: KindConvention = {
    id: "conventions/special-sections",
    title: "Special Sections",
    governs: "Special Sections",
    fields: { required: [], optional: [], values: {}, terminal: {}, descriptions: {} },
    sections: headings,
  };
  const empty: OkfDocument = { id: "empty", frontmatter: { type: kind.governs }, body: "" };
  assert.deepEqual(validateAgainstKind(empty, kind).map((warning) => warning.field), headings);

  const body = headings.map((heading) => `# ${heading}\n\nBody for ${heading}.`).join("\n\n");
  const sections = splitSections(body);
  assert.equal(Object.getPrototypeOf(sections), Object.prototype);
  for (const heading of headings) {
    assert.equal(Object.prototype.hasOwnProperty.call(sections, heading), true);
    assert.equal(sections[heading], `Body for ${heading}.`);
  }
  assert.deepEqual(validateAgainstKind({ ...empty, body }, kind), []);
});

test("validateAgainstKind: enum comparison tolerates a YAML-1.1-coerced non-string allowed value (unquoted 'no'/'on' etc.)", () => {
  // gray-matter/js-yaml parses an unquoted `no`/`yes`/`on`/`off` scalar as a BOOLEAN, so an author
  // who writes `values: flag: [no, yes]` unquoted ends up with `[false, true]` at the frontmatter
  // layer. validateAgainstKind must String-coerce both the allowed list and the actual field value
  // rather than crashing or silently never-matching.
  const kind = {
    id: "conventions/flagged",
    title: "Flagged",
    governs: "Flagged",
    fields: { required: [], optional: [], values: { flag: [false, true] as unknown as string[] }, terminal: {}, descriptions: {} },
  };
  const doc: OkfDocument = { id: "flagged/x", frontmatter: { type: "Flagged", flag: false, timestamp: T }, body: "" };
  assert.deepEqual(validateAgainstKind(doc, kind), []); // 'false' coerces to allowed 'false'

  const badDoc: OkfDocument = { id: "flagged/y", frontmatter: { type: "Flagged", flag: "maybe", timestamp: T }, body: "" };
  const warnings = validateAgainstKind(badDoc, kind);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.code, "KIND_FIELD_VALUE");
});

test("validateAgainstKind: an enum-restricted field carrying an ARRAY is a KIND_FIELD_ARITY violation; non-enum arrays stay a feature", () => {
  const kind = {
    id: "conventions/roadmap-item",
    title: "Roadmap Item",
    governs: "Roadmap Item",
    fields: { required: ["title", "status"], optional: ["labels"], values: { status: ["planned", "active", "done"] }, terminal: {}, descriptions: {} },
  };

  // Two ALLOWED members still violate arity — each passes the element-wise membership
  // check, which is exactly why this used to persist silently (even under --strict).
  const twoStatus: OkfDocument = {
    id: "roadmap/x",
    frontmatter: { type: "Roadmap Item", title: "X", status: ["planned", "done"], timestamp: T },
    body: "",
  };
  assert.deepEqual(validateAgainstKind(twoStatus, kind).map((w) => w.code), ["KIND_FIELD_ARITY"]);

  // A NON-enum field keeps its array feature untouched (`labels` has no values constraint).
  const arrayLabels: OkfDocument = {
    id: "roadmap/y",
    frontmatter: { type: "Roadmap Item", title: "Y", status: "planned", labels: ["a", "b"], timestamp: T },
    body: "",
  };
  assert.deepEqual(validateAgainstKind(arrayLabels, kind), []);

  // An array with a BAD member reports BOTH the arity violation and the membership one.
  const badMember: OkfDocument = {
    id: "roadmap/z",
    frontmatter: { type: "Roadmap Item", title: "Z", status: ["planned", "nope"], timestamp: T },
    body: "",
  };
  assert.deepEqual(
    validateAgainstKind(badMember, kind)
      .map((w) => w.code)
      .sort(),
    ["KIND_FIELD_ARITY", "KIND_FIELD_VALUE"],
  );
});

test("kindConventionDoc: round-trips through write/loadKinds to the same KindConvention shape", async () => {
  await withMemBundle(async (bundle) => {
    const doc = kindConventionDoc(NOTE_KIND_FIXTURE, "Prose about Context Notes.\n", T);
    assert.equal(doc.id, "conventions/context-note");
    assert.equal(doc.frontmatter.type, CONVENTION_TYPE);
    await writeDoc(bundle, doc);
    const registry = await loadKinds(bundle);
    const kind = registry.kinds.get("Context Note");
    assert.ok(kind);
    assert.equal(kind!.path, "context-notes/");
    assert.equal(kind!.description, "A durable cross-session orientation note.");
    assert.deepEqual(kind!.fields.required, ["title", "timestamp"]);
    assert.deepEqual(kind!.fields.optional, ["description", "tags"]);
    assert.deepEqual(kind!.fields.descriptions, { title: "A concise summary.", tags: "Searchable labels." });
    assert.equal(kind!.freshnessHorizon, "24h");
  });
});

test("kindConventionDoc: sanitizes programmatic description metadata before it can create registry warnings", () => {
  const described: KindConvention = {
    id: "conventions/programmatic",
    title: "Programmatic",
    governs: "Programmatic",
    description: "  Useful purpose.  ",
    fields: {
      required: ["title"],
      optional: [],
      values: {},
      terminal: {},
      descriptions: {
        title: "  Human title.  ",
        blank: "   ",
        number: 42 as unknown as string,
      },
    },
  };
  const doc = kindConventionDoc(described, "", T);
  assert.equal(doc.frontmatter.description, "Useful purpose.");
  assert.deepEqual((doc.frontmatter.fields as Record<string, unknown>).descriptions, {
    title: "Human title.",
  });
  const parsed = parseConventionDoc(doc);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.warnings, []);

  const invalidOnly = kindConventionDoc(
    {
      ...described,
      description: 42 as unknown as string,
      fields: { ...described.fields, descriptions: { blank: " " } },
    },
    "",
    T,
  );
  assert.ok(!("description" in invalidOnly.frontmatter));
  assert.ok(!("descriptions" in (invalidOnly.frontmatter.fields as Record<string, unknown>)));
  const parsedInvalidOnly = parseConventionDoc(invalidOnly);
  assert.equal(parsedInvalidOnly.ok, true);
  assert.deepEqual(parsedInvalidOnly.warnings, []);
});

// ── core never seeds (the kind-convention contract) ──────────────────────────────
//
// Context Note seeding moved OUT of core entirely into the CLI's recipe machinery
// (`packages/cli/src/recipes.ts`'s `context-notes` recipe + `applyRecipe`). The engine keeps only
// the generic `writeDocVersioned` expect-absent CAS primitive; it special-cases nothing about
// conventions. Coverage for the (now CLI-side) seed/idempotency/does-not-disturb-hand-edited
// behavior lives in `packages/cli/test/recipes.test.ts`.

test("initBundle: core never seeds — a bare init carries no conventions/ doc", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-seed-off-"));
  try {
    const bundle = await initBundle(root);
    const registry = await loadKinds(bundle);
    assert.equal(registry.kinds.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── list --fields fields on a Convention row: pin the nested-object rendering (Improvement 7) ──
// This exercises the CORE query path only (the CLI's TOON rendering of the resulting nested object
// is pinned separately in packages/cli/test — this test just locks in that `query` surfaces the raw
// `fields` object unmodified for a Convention row, which is what the CLI's `--fields` hatch reads).

test("query: a Convention doc's frontmatter.fields survives query() as a plain nested object (not stringified)", async () => {
  await withMemBundle(async (bundle) => {
    await writeDoc(bundle, ROADMAP_KIND_DOC);
    const docs = await query(bundle, { type: CONVENTION_TYPE });
    assert.equal(docs.length, 1);
    assert.deepEqual(docs[0]!.frontmatter.fields, {
      required: ["title", "status"],
      optional: ["horizon"],
      values: { status: ["planned", "active", "done"] },
      descriptions: { title: "  A concise outcome.  ", status: "Current lifecycle state." },
    });
  });
});

// ── mutation-survivor pins (core-survivor-triage unit) ────────────────────────

// kills: kinds.ts:208:15 Regex #1477
// kills: kinds.ts:208:15 Regex #1482
test("pin: splitSections splits only LINE-ANCHORED H1s, including a heading directly above its content line", async () => {
  const { splitSections } = await import("../src/kinds.js");
  assert.deepEqual(splitSections("# A\ncontent"), { A: "content" });
  assert.deepEqual(splitSections("text with # inline\n\n# Real\nbody"), { Real: "body" });
});

// kills: kinds.ts:746:7 ConditionalExpression #2085
// kills: kinds.ts:746:56 ConditionalExpression #2091
// kills: kinds.ts:746:56 EqualityOperator #2092
// kills: kinds.ts:746:56 MethodExpression #2093
test("pin: defaultTimestampAndValidateAgainstRegistry preserves a valid timestamp and replaces a whitespace-only one", async () => {
  const { defaultTimestampAndValidateAgainstRegistry } = await import("../src/kinds.js");
  const empty = { kinds: new Map(), warnings: [] };

  const keep = { id: "x", frontmatter: { type: "Note", timestamp: "2026-07-16T00:00:00.000Z" }, body: "" };
  defaultTimestampAndValidateAgainstRegistry(keep, empty);
  assert.equal(keep.frontmatter.timestamp, "2026-07-16T00:00:00.000Z");

  const blank = { id: "y", frontmatter: { type: "Note", timestamp: "   " }, body: "" };
  defaultTimestampAndValidateAgainstRegistry(blank, empty);
  assert.notEqual(blank.frontmatter.timestamp, "   ");
  assert.ok(!Number.isNaN(Date.parse(String(blank.frontmatter.timestamp))));
});

// ── the bundle-declared `claim:` vocabulary ────────────────────────────────────
//
// Ownership is DECLARED by the bundle, never spelled into a consumer. This unit parses only the
// two COORDINATES (research/atomic-shared-task-claim-design); the block's value vocabulary
// (`claimed`/`unclaimed`/`released`) is deliberately not consumed yet, which is why an
// unrecognized key inside `claim:` is ignored rather than warned about.

/** A Task-shaped kind that declares its claim coordinates the way a bundle convention does. */
function claimingKindDoc(claim: unknown): OkfDocument {
  return {
    id: "conventions/task",
    frontmatter: {
      type: CONVENTION_TYPE,
      title: "Task",
      governs: "Task",
      claim,
      fields: { required: ["title", SUPERBEE_PROGRESS_STATUS_FIELD], optional: ["assignee"] },
    } as Frontmatter,
    body: "# Task\n",
  };
}

test("parseConventionDoc: a 'claim' declaration parses its two coordinates and warns about nothing", () => {
  const parsed = parseConventionDoc(
    claimingKindDoc({ owner_field: "assignee", state_field: PROGRESS_STATUS_FIELD }),
  );
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.kind.claim, { ownerField: "assignee", stateField: PROGRESS_STATUS_FIELD });
  assert.deepEqual(parsed.warnings, []);
});

test("parseConventionDoc: 'claim' is lenient — a non-map shape and a malformed member warn and are skipped, never thrown", () => {
  const badShape = parseConventionDoc(claimingKindDoc("assignee"));
  assert.ok(badShape.ok);
  assert.equal(badShape.kind.claim, undefined);
  assert.deepEqual(
    badShape.warnings.map((w) => [w.code, w.field]),
    [["KIND_CONVENTION_BAD_SHAPE", "claim"]],
  );

  const badMember = parseConventionDoc(claimingKindDoc({ owner_field: ["assignee"], state_field: "  " }));
  assert.ok(badMember.ok);
  assert.equal(badMember.kind.claim, undefined, "nothing usable parsed, so no claim block is attached");
  assert.deepEqual(
    badMember.warnings.map((w) => [w.code, w.field]),
    [
      ["KIND_CONVENTION_BAD_MEMBER", "claim.owner_field"],
      ["KIND_CONVENTION_BAD_MEMBER", "claim.state_field"],
    ],
  );

  // One good coordinate beside one bad one still yields the good half.
  const partial = parseConventionDoc(claimingKindDoc({ owner_field: "assignee", state_field: { nested: true } }));
  assert.ok(partial.ok);
  assert.deepEqual(partial.kind.claim, { ownerField: "assignee" });
  assert.deepEqual(
    partial.warnings.map((w) => w.field),
    ["claim.state_field"],
  );
});

test("parseConventionDoc: a 'claim' key this unit does not consume is IGNORED, not warned about", () => {
  const parsed = parseConventionDoc(
    claimingKindDoc({ owner_field: "assignee", claimed: "in_progress", unclaimed: ["todo"], released: "todo" }),
  );
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.kind.claim, { ownerField: "assignee" });
  assert.deepEqual(parsed.warnings, [], "the block's value vocabulary belongs to a later unit, not to a warning");
});

test("claimCoordinates: resolves declared names onto the EDITION's storage keys, and drops what a kind does not carry", () => {
  const taskLike: KindConvention = {
    id: "conventions/task",
    title: "Task",
    governs: "Task",
    fields: {
      required: ["title", SUPERBEE_PROGRESS_STATUS_FIELD],
      optional: ["assignee"],
      values: {},
      valueDescriptions: {},
      terminal: {},
      descriptions: {},
    },
    claim: { ownerField: "assignee", stateField: PROGRESS_STATUS_FIELD },
  };

  // v0.2: the LOGICAL `progress_status` resolves through the one field resolver to the concrete key.
  assert.deepEqual(claimCoordinates("0.2", taskLike), {
    ownerField: "assignee",
    stateField: SUPERBEE_PROGRESS_STATUS_FIELD,
    fields: ["assignee", SUPERBEE_PROGRESS_STATUS_FIELD],
  });

  // v0.1 stores progress in `status`, which THIS kind does not declare — the coordinate resolves to
  // nothing and is dropped rather than becoming a key that could never match.
  assert.deepEqual(claimCoordinates("0.1", taskLike), { ownerField: "assignee", fields: ["assignee"] });

  // No declaration, and a declaration naming only fields the kind lacks, both yield nothing.
  assert.equal(claimCoordinates("0.2", { ...taskLike, claim: undefined }), undefined);
  assert.equal(claimCoordinates("0.2", { ...taskLike, claim: { ownerField: "owner" } }), undefined);
});

test("kindConventionDoc: a 'claim' declaration round-trips through write/loadKinds", async () => {
  await withMemBundle(async (bundle) => {
    const kind: KindConvention = {
      id: "conventions/claimable",
      title: "Claimable",
      governs: "Claimable",
      fields: {
        required: ["title", "stage"],
        optional: ["owner"],
        values: { stage: ["open", "held"] },
        terminal: {},
        descriptions: {},
      },
      claim: { ownerField: "owner", stateField: "stage" },
    };
    await writeDoc(bundle, kindConventionDoc(kind, "prose.", T));
    const registry = await loadKinds(bundle);
    assert.deepEqual(registry.kinds.get("Claimable")!.claim, { ownerField: "owner", stateField: "stage" });
    assert.equal(registry.warnings.length, 0);
    assert.deepEqual(claimCoordinates("0.2", registry.kinds.get("Claimable")!), {
      ownerField: "owner",
      stateField: "stage",
      fields: ["owner", "stage"],
    });
  });
});
