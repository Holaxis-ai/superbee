// Proofs for the command-surface inventory.
//
// The inventory's only value is that its labels are TRUE, so these tests pin the two ways the
// derivation was observed to lie during development, plus the staleness gate. They run against the
// real registry and the real import graph: a synthetic graph would prove the traversal and not the
// claim.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { generate } from "./command-surface.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = resolve(here, "../COMMAND-SURFACE.md");

const inventory = await generate();
const leaf = (path) => {
  const found = inventory.rows.find((row) => row.path === path);
  assert.ok(found, `no inventory row for ${path}`);
  return found;
};
const reaches = (path, reach) => Object.hasOwn(leaf(path).reaches, reach);
const evidenceFor = (path, reach) => leaf(path).reaches[reach].map((cause) => cause.evidence);

test("the checked-in report is current", async () => {
  const committed = await readFile(reportPath, "utf8").catch(() => undefined);
  assert.equal(
    committed,
    inventory.report,
    "packages/cli/COMMAND-SURFACE.md is stale — run `npm run surface -w @superbee/cli`",
  );
});

test("the inventory covers the whole public registry", () => {
  assert.equal(inventory.rows.length, 58);
  assert.equal(new Set(inventory.rows.map((row) => row.command)).size, 29);
  // Every leaf resolves to a module, or its labels would be silently empty rather than absent.
  assert.deepEqual(inventory.rows.filter((row) => row.module === undefined), []);
});

test("a command that pulls the board on its own is labelled network", () => {
  for (const path of ["list", "doc read", "status", "link show"]) {
    assert.ok(reaches(path, "network"), `${path} should reach the network`);
    assert.ok(evidenceFor(path, "network").includes("autopull.ts"), `${path} should cite autopull.ts`);
  }
  // `sync` reaches the remote through a helper rather than inline; an implementation walk that
  // stopped at one hop called it bundle-only.
  assert.ok(reaches("sync", "network"));
  assert.ok(evidenceFor("sync", "network").includes("sync-cli.ts"));
});

test("importing a sibling command is not evidence of calling it", () => {
  // `commands/pull.ts` imports `commands/doc.ts`, which reaches `commands/doc/read.ts`, which
  // pulls the board. `commands/new.ts` reaches the same through `commands/link.ts`. A transitive
  // closure labelled both of them network commands. Neither one touches the network by itself.
  assert.equal(reaches("pull", "network"), false, "pull must not inherit doc read's board pull");
  assert.equal(reaches("new", "network"), false, "new must not inherit link's board pull");
});

test("an opt-in network reach is not counted as an automatic one", () => {
  // `--remote` is a property of the invocation, so it must never be confused with a command that
  // reaches the network whether or not you ask it to.
  assert.ok(reaches("doc write", "network-opt-in"));
  assert.equal(reaches("doc write", "network"), false);
  // `version` is the mirror case: no `--remote`, but it checks npm unprompted.
  assert.ok(reaches("version", "network"));
  assert.equal(reaches("version", "network-opt-in"), false);
});

test("host integration is labelled where a vendor's config is actually touched", () => {
  for (const path of ["hook install", "skill install", "mcp status"]) {
    assert.ok(reaches(path, "vendor-config"), `${path} should be vendor-config`);
  }
  // A leaf that only reads and writes the bundle must not pick the label up.
  assert.equal(reaches("doc write", "vendor-config"), false);
});

test("an alias reports the reach of what it aliases", () => {
  assert.equal(leaf("query").alias, "list");
  assert.deepEqual(Object.keys(leaf("query").reaches).sort(), Object.keys(leaf("list").reaches).sort());
});

test("every label names the module that proves it", () => {
  for (const row of inventory.rows) {
    for (const [reach, causes] of Object.entries(row.reaches)) {
      assert.ok(causes.length > 0, `${row.path}/${reach} has no evidence`);
      for (const cause of causes) {
        assert.equal(typeof cause.evidence, "string");
        assert.notEqual(cause.evidence, "", `${row.path}/${reach} has empty evidence`);
        assert.equal(typeof cause.why, "string");
      }
    }
  }
});
