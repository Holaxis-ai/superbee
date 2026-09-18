import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { remainingTypechecks } from "./typecheck-after-build.mjs";
import { TSC_WORKSPACES } from "./build.mjs";

const packages = readdirSync(new URL("../packages/", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map(({ name }) => ({ directory: name, ...JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), "utf8")) }));

test("post-build checks retain semantic checking for bundled and Vite packages", () => {
  const remaining = remainingTypechecks(packages).map(({ directory }) => directory);
  for (const name of ["cli", "superbee", "ui"]) assert.ok(remaining.includes(name), name);
  for (const pkg of packages.filter(({ scripts }) => scripts?.typecheck)) {
    assert.ok(remaining.includes(pkg.directory)
      || (TSC_WORKSPACES.includes(pkg.directory) && pkg.scripts.typecheck === "tsc --noEmit"), pkg.name);
  }
});

test("new workspaces and augmented checks cannot silently lose typechecking", () => {
  const fixtures = [
    { directory: "new-package", scripts: { build: "tsc", typecheck: "tsc --noEmit" } },
    { directory: "core", scripts: { build: "tsc", typecheck: "tsc --noEmit && node extra-check.mjs" } },
    { directory: "core", scripts: { build: "tsc", typecheck: "tsc -p tsconfig.test.json" } },
    { directory: "core", scripts: { build: "tsc", typecheck: "tsc --noEmit" } },
    { directory: "no-check", scripts: {} },
  ];
  assert.deepEqual(remainingTypechecks(fixtures), fixtures.slice(0, 3));
  assert.deepEqual(remainingTypechecks([fixtures[3]], []), [fixtures[3]]);
  for (const build of ["esbuild src/index.ts", "tsc --noCheck", "tsc -p tsconfig.other.json"]) {
    const changed = { ...fixtures[3], scripts: { ...fixtures[3].scripts, build } };
    assert.deepEqual(remainingTypechecks([changed]), [changed]);
  }
});
