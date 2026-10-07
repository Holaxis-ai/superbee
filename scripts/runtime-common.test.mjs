import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commonWorkspaces, runCommon } from "./runtime-common.mjs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));

test("common and CLI workspaces partition every discovered test script", () => {
  const all = readdirSync(path.join(root, "packages")).map(dir => JSON.parse(readFileSync(path.join(root, "packages", dir, "package.json"), "utf8")))
    .filter(pkg => pkg.scripts?.test).map(pkg => pkg.name).sort();
  assert.deepEqual([...commonWorkspaces(root), "@superbee/cli"].sort(), all);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["ci:runtime-cli"], "npm run build && npm test -w @superbee/cli --ignore-scripts");
  assert.equal(pkg.scripts["ci:runtime-common"], "npm run build && npm run typecheck:after-build && npm run test:runtime-common");
  assert.equal(pkg.scripts["test:runtime-common"], "node scripts/runtime-common.mjs");
});

test("new workspace tests are included by identity; discovery and child failures fail closed", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "common-workspace-probe-"));
  const write = async (directory, name, scripts) => {
    await mkdir(path.join(scratch, "packages", directory), { recursive: true });
    await writeFile(path.join(scratch, "packages", directory, "package.json"), JSON.stringify({ name, scripts }));
  };
  try {
    await writeFile(path.join(scratch, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    await write("renamed-cli-directory", "@superbee/cli", { test: "node test.mjs" });
    await write("core", "@superbee/core", { test: "node test.mjs" });
    await write("no-tests", "no-tests", {});
    assert.deepEqual(commonWorkspaces(scratch), ["@superbee/core"]);
    await write("cli", "new-package", { test: "node test.mjs" });
    assert.deepEqual(commonWorkspaces(scratch), ["@superbee/core", "new-package"]);
    const fakeNpm = path.join(scratch, "npm.cjs");
    await writeFile(fakeNpm, `const assert = require('node:assert/strict');assert.deepEqual(process.argv.slice(2), ['test','--ignore-scripts','--workspace','@superbee/core','--workspace','new-package']);process.exit(23);`);
    assert.equal(runCommon(scratch, fakeNpm), 23);
    await writeFile(path.join(scratch, "package.json"), JSON.stringify({ workspaces: ["packages/*", "other/*"] }));
    assert.throws(() => commonWorkspaces(scratch), /discovery/);
    await writeFile(path.join(scratch, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    await write("renamed-cli-directory", "not-cli", { test: "node test.mjs" });
    assert.throws(() => commonWorkspaces(scratch), /exactly one CLI/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
