import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  approvedOccurrenceKey,
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
      exactApproval: true,
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
      file: ".github/workflows/release-staged.yml",
      lineText: "ASLITE_RELEASE_LIVE_ENABLED: legacy transition input",
      match: "ASLITE_RELEASE_LIVE_ENABLED",
      category: "release-live-gate-variable",
      owner: "release-policy",
    },
    {
      file: "scripts/release-env.mjs",
      lineText: 'const legacy = "ASLITE_RELEASE_TARBALL";',
      match: "ASLITE_RELEASE_TARBALL",
      category: "release-retained-artifact-variable",
      owner: "release-policy",
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
      exactApproval: true,
      category: "compiled-artifact-path",
      owner: "cli-build",
    },
  ];

  for (const row of rows) {
    const approvedOccurrences = row.exactApproval
      ? new Map([[approvedOccurrenceKey(row), {
          category: row.category,
          treatment: "bridge-or-successor-target-policy",
          owner: row.owner,
          reason: "test approval",
        }]])
      : undefined;
    const classified = classifyLegacyLiteral({ ...row, approvedOccurrences });
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

  const maintainedGuide = classifyLegacyLiteral({
    file: "docs/getting-started.md",
    lineText: "Run agentstate-lite ui",
    match: "agentstate-lite",
  });
  assert.equal(maintainedGuide.category, "unclassified");
  assert.equal(maintainedGuide.treatment, "fail-closed");

  for (const file of [
    "release/README.md",
    "packages/core/src/index-marker.ts",
    "packages/cli/src/commands/hook.ts",
  ]) {
    for (const match of ["agentstate-lite", "aslite"]) {
      const privilegedPathGuide = classifyLegacyLiteral({
        file,
        lineText: `Run ${match} ui`,
        match,
      });
      assert.equal(privilegedPathGuide.category, "unclassified", `${file}: ${match}`);
      assert.equal(privilegedPathGuide.treatment, "fail-closed", `${file}: ${match}`);
    }
  }
});

test("lowercase compatibility ownership binds to one exact occurrence, not its surrounding path or line", () => {
  const approvedRow = {
    category: "legacy-command-compatibility",
    treatment: "preserve-as-explicit-compatibility",
    owner: "cli-policy",
    reason: "test approval",
  };
  const base = {
    file: "packages/cli/src/commands/hook.ts",
    line: 99,
    lineText: 'const LEGACY_HOOK_MARKER = "agentstate-lite";',
    match: "agentstate-lite",
    ordinal: 0,
  };
  const approvedOccurrences = new Map([[approvedOccurrenceKey(base), approvedRow]]);
  assert.deepEqual(classifyLegacyLiteral({ ...base, approvedOccurrences }), approvedRow);
  assert.equal(approvedOccurrences.size, 0, "a consumed occurrence cannot approve a duplicate");

  for (const lineText of [
    `Run agentstate-lite ui; ${base.lineText}`,
    `${base.lineText} // Run agentstate-lite ui`,
  ]) {
    const mixed = classifyLegacyLiteral({
      ...base,
      lineText,
      approvedOccurrences: new Map([[approvedOccurrenceKey(base), approvedRow]]),
    });
    assert.equal(mixed.category, "unclassified");
    assert.equal(mixed.treatment, "fail-closed");
  }

  const shifted = classifyLegacyLiteral({
    ...base,
    line: 100,
    approvedOccurrences: new Map([[approvedOccurrenceKey(base), approvedRow]]),
  });
  assert.equal(shifted.category, "unclassified", "moving an approval to another occurrence requires review");
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
    "bundle-discovery",
    "compiled-artifact-path",
    "environment-variable",
    "generated-marker",
    "npm-old-coordinate",
    "release-artifact-or-schema",
  ]) {
    assert.ok(categories.has(expected), `inventory must include ${expected}`);
  }

  const second = await generateRenameLiteralInventory();
  assert.deepEqual(second, inventory);
});

test("repository inventory includes tracked root files, including the dev shim and dotfiles", async () => {
  const inventory = await generateRenameLiteralInventory();
  const rows = inventory.matches.map((row) => `${row.file}:${row.literal}`);
  const legacyShim = await readFile(new URL("../aslite", import.meta.url), "utf8");
  assert.match(legacyShim, /dist\/superbee\.mjs/, "legacy dev shim must route to the Superbee artifact");
  const superbeeShim = await readFile(new URL("../superbee", import.meta.url), "utf8");
  assert.match(superbeeShim, /dist\/superbee\.mjs/, "canonical dev shim must target the Superbee artifact");
  assert.ok(rows.includes(".gitignore:.agentstate.json"), "root binding ignore entry must be inventoried");
  assert.ok(rows.includes(".gitignore:.agentstate-lite"), "root bundle ignore entry must be inventoried");
  assert.ok(!rows.some((row) => row.startsWith("examples/views/demo.sh:")), "the current View demo must carry no legacy product literals");
  const demo = await readFile(new URL("../examples/views/demo.sh", import.meta.url), "utf8");
  assert.match(demo, /packages\/cli\/dist\/superbee\.mjs/);
  assert.match(demo, /superbee-views-demo/);
  assert.doesNotMatch(demo, /REPO\/\.agentstate-lite/);
});

test("maintained first-party consumer authorities use Superbee identity", async () => {
  const cases = [
    ["../examples/views/conventions/view.md", /`superbee ui`/, /`(?:agentstate-lite ui|aslite status)`/],
    ["../packages/ui/index.html", /<title>Superbee<\/title>/, /<title>agentstate-lite<\/title>/],
    ["../packages/ui-server/README.md", /@superbee\/ui-server/, /@agentstate-lite\/ui-server/],
    ["../packages/board-git/README.md", /@superbee\/board-git/, /@agentstate-lite\/board-git/],
  ];
  for (const [relative, required, forbidden] of cases) {
    const content = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.match(content, required, relative);
    assert.doesNotMatch(content, forbidden, relative);
  }
});

test("root gitignore keeps preferred and legacy project bindings machine-local", async () => {
  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  const entries = new Set(
    gitignore
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  );

  assert.ok(entries.has(".superbee.json"), "preferred binding must be ignored");
  assert.ok(entries.has(".agentstate.json"), "legacy binding must remain ignored during compatibility");
});
