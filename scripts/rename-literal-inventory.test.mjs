import assert from "node:assert/strict";
import test from "node:test";

import {
  assertClassifiedInventory,
  classifyLegacyLiteral,
  generateRenameLiteralInventory,
  INVENTORY_SCHEMA,
  parseInventoryArgs,
} from "./rename-literal-inventory.mjs";

test("parseInventoryArgs accepts only the inventory modes", () => {
  assert.deepEqual(parseInventoryArgs([]), { check: false, json: false });
  assert.deepEqual(parseInventoryArgs(["--check"]), { check: true, json: false });
  assert.deepEqual(parseInventoryArgs(["--json", "--check"]), { check: true, json: true });
  for (const invalid of [["--out", "x"], ["--unknown"]]) {
    assert.throws(() => parseInventoryArgs(invalid), /usage: rename-literal-inventory/);
  }
});

test("AC-60 named literals are classified with explicit owners and treatments", () => {
  const rows = [
    {
      file: "packages/mcp-app/src/view.html",
      lineText: "<!-- ASLITE_MCP_APP_SCRIPT -->",
      match: "ASLITE_MCP_APP_SCRIPT",
      category: "generated-marker",
      owner: "mcp-app",
    },
    {
      file: "packages/cli/src/build-identity.ts",
      lineText: 'const token = "__ASLITE_BUILD_IDENTITY__";',
      match: "__ASLITE_BUILD_IDENTITY__",
      category: "build-identity-marker",
      owner: "cli-build",
    },
    {
      file: "packages/cli/package.json",
      lineText: "const root = '@holaxis/aslite';",
      match: "@holaxis/aslite",
      category: "npm-old-coordinate",
      owner: "release-policy",
    },
    {
      file: "package.json",
      lineText: '"name": "@agentstate-lite/core"',
      match: "@agentstate-lite/core",
      category: "workspace-package-identity",
      owner: "build-graph",
    },
    {
      file: "scripts/release-candidate.mjs",
      lineText: 'const schema = "aslite.release-candidate.v1";',
      match: "aslite",
      category: "release-artifact-or-schema",
      owner: "release-policy",
    },
    {
      file: "packages/cli/src/autopull.ts",
      lineText: 'const env = "AGENTSTATE_LITE_NO_AUTOPULL";',
      match: "AGENTSTATE_LITE",
      category: "environment-variable",
      owner: "cli-policy",
    },
    {
      file: "packages/cli/src/bundle.ts",
      lineText: 'const binding = ".agentstate.json";',
      match: ".agentstate.json",
      category: "bundle-discovery",
      owner: "bundle-discovery",
    },
    {
      file: "packages/cli/src/bundle.ts",
      lineText: 'const dir = ".agentstate-lite";',
      match: ".agentstate-lite",
      category: "bundle-discovery",
      owner: "bundle-discovery",
    },
    {
      file: "scripts/release-candidate.mjs",
      lineText: 'const out = "dist/agentstate-lite.mjs";',
      match: "agentstate-lite",
      category: "compiled-artifact-path",
      owner: "cli-build",
    },
  ];

  for (const row of rows) {
    const classified = classifyLegacyLiteral(row);
    assert.equal(classified.category, row.category, row.match);
    assert.equal(classified.owner, row.owner, row.match);
    assert.notEqual(classified.treatment, "fail-closed", row.match);
  }
});

test("unknown legacy literals fail closed until a policy owner classifies them", () => {
  const classified = classifyLegacyLiteral({
    file: "packages/cli/src/unowned.ts",
    lineText: "const value = 'ASLITE_SURPRISE';",
    match: "ASLITE",
  });
  assert.equal(classified.category, "unclassified");
  assert.equal(classified.treatment, "fail-closed");
  assert.throws(
    () =>
      assertClassifiedInventory({
        matches: [{ file: "x.ts", line: 1, column: 1, literal: "ASLITE", ...classified }],
      }),
    /unclassified legacy literal/,
  );
});

test("repository inventory is deterministic and has no unclassified legacy literals", async () => {
  const inventory = await generateRenameLiteralInventory();
  assert.equal(inventory.schema, INVENTORY_SCHEMA);
  assert.equal(inventory.source, "git-ls-files");
  assert.ok(inventory.files_scanned > 0);
  assert.ok(inventory.matches.length > 0);
  assertClassifiedInventory(inventory);

  const categories = new Set(inventory.matches.map((row) => row.category));
  for (const expected of [
    "build-identity-marker",
    "bundle-discovery",
    "compiled-artifact-path",
    "environment-variable",
    "generated-marker",
    "npm-old-coordinate",
    "release-artifact-or-schema",
    "workspace-package-identity",
  ]) {
    assert.ok(categories.has(expected), `inventory must include ${expected}`);
  }

  const second = await generateRenameLiteralInventory();
  assert.deepEqual(second, inventory);
});

test("repository inventory includes tracked root files, including the dev shim and dotfiles", async () => {
  const inventory = await generateRenameLiteralInventory();
  const rows = inventory.matches.map((row) => `${row.file}:${row.literal}`);
  assert.ok(rows.includes("aslite:aslite"), "dev shim name must be inventoried");
  assert.ok(rows.includes("aslite:agentstate-lite"), "dev shim dist target must be inventoried");
  assert.ok(rows.includes(".gitignore:.agentstate.json"), "root binding ignore entry must be inventoried");
  assert.ok(rows.includes(".gitignore:.agentstate-lite"), "root bundle ignore entry must be inventoried");
  assert.ok(rows.includes(".gitattributes:agentstate-lite"), "root generated-file metadata must be inventoried");
  assert.ok(rows.includes("examples/views/demo.sh:agentstate-lite"), "tracked shell script dist target must be inventoried");
  assert.ok(rows.includes("examples/views/demo.sh:aslite"), "tracked shell script temp prefix must be inventoried");
});
