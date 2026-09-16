import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
test("distribution retains its executable and stable exports without runtime dependencies", () => {
 const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
 assert.deepEqual(Object.keys(pkg.exports), [".", "./publication", "./publication/bridge", "./bundle-descriptor"]);
 for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) assert.equal(pkg[field], undefined);
 const result = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/superbee.mjs", import.meta.url)), "--version"], { encoding: "utf8" });
 assert.equal(result.status, 0); assert.equal(result.stdout, pkg.version + "\n"); assert.equal(result.stderr, "");
});
