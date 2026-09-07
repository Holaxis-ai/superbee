import assert from "node:assert/strict";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  BUNDLE_DESCRIPTOR_SCHEMA_V1,
  BUNDLE_DESCRIPTOR_V1,
} from "../dist/index.js";

const validate = new Ajv2020({ allErrors: true, strict: true }).compile(BUNDLE_DESCRIPTOR_SCHEMA_V1);

function descriptor(overrides = {}) {
  return {
    schema: BUNDLE_DESCRIPTOR_V1,
    bundleId: "example.operations",
    name: "Example Operations",
    purpose: "Shared operational knowledge.",
    ...overrides,
  };
}

test("exports the canonical deeply immutable v1 schema", () => {
  assert.equal(BUNDLE_DESCRIPTOR_SCHEMA_V1.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(BUNDLE_DESCRIPTOR_SCHEMA_V1.$id, BUNDLE_DESCRIPTOR_V1);
  assert.equal(Object.isFrozen(BUNDLE_DESCRIPTOR_SCHEMA_V1), true);
  assert.equal(Object.isFrozen(BUNDLE_DESCRIPTOR_SCHEMA_V1.properties), true);
  assert.equal(Object.isFrozen(BUNDLE_DESCRIPTOR_SCHEMA_V1.$defs.bundleId), true);
});

test("accepts only the minimal authority-qualified self-description", () => {
  assert.equal(validate(descriptor()), true, JSON.stringify(validate.errors));

  for (const invalid of [
    descriptor({ bundleId: "operations" }),
    descriptor({ name: "   " }),
    descriptor({ purpose: "unsafe\u202Etext" }),
    descriptor({ technicalCapabilities: ["okf.v0.2"] }),
    descriptor({ sensitivity: "public" }),
    descriptor({ authority: "operations" }),
    descriptor({ resolver: "https://example.test/bundle" }),
  ]) {
    assert.equal(validate(invalid), false, JSON.stringify(invalid));
  }
});

test("rejects every Unicode Bidi_Control code point in display text", () => {
  const bidiControls = [
    0x061c,
    0x200e,
    0x200f,
    ...Array.from({ length: 5 }, (_, offset) => 0x202a + offset),
    ...Array.from({ length: 4 }, (_, offset) => 0x2066 + offset),
  ];

  for (const codePoint of bidiControls) {
    const marker = String.fromCodePoint(codePoint);
    assert.equal(
      validate(descriptor({ name: `unsafe${marker}name` })),
      false,
      `name accepted Bidi_Control U+${codePoint.toString(16).padStart(4, "0")}`,
    );
    assert.equal(
      validate(descriptor({ purpose: `unsafe${marker}purpose` })),
      false,
      `purpose accepted Bidi_Control U+${codePoint.toString(16).padStart(4, "0")}`,
    );
  }
});
