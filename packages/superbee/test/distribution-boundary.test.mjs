import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
test("distribution retains its executable and stable exports without runtime dependencies", () => {
 const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
 assert.deepEqual(Object.keys(pkg.exports), [".", "./publication", "./publication/bridge", "./bundle-descriptor", "./portable-export", "./publication/site-manifest"]);
 for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) assert.equal(pkg[field], undefined);
 const result = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/superbee.mjs", import.meta.url)), "--version"], { encoding: "utf8" });
 assert.equal(result.status, 0); assert.equal(result.stdout, pkg.version + "\n"); assert.equal(result.stderr, "");
});

test("the installed entry guards Windows board sync by the libuv file identity fix", () => {
  const entry = new URL("../dist/superbee.mjs", import.meta.url);
  for (const [node, uv, supported] of [
    ["22.14.0", "1.49.2", false],
    ["22.17.0", "1.51.0", true],
    ["24.1.0", "1.50.0", false],
    ["24.2.0", "1.51.0", true],
    ["26.0.0", "1.52.1", true],
  ]) {
    // Vary only host facts. The supported rows ask for help so the CLI never accesses board state.
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      Object.defineProperty(process, "platform", { value: "win32" });
      Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(node)} });
      Object.defineProperty(process.versions, "uv", { value: ${JSON.stringify(uv)} });
      process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entry))}, "sync", "--help"];
      await import(${JSON.stringify(entry.href)});
    `], { encoding: "utf8" });
    assert.equal(result.status, supported ? 0 : 1, result.stderr);
    if (supported) assert.match(result.stdout, /--pull-only/);
    else {
      assert.match(result.stdout, /code: RUNTIME/);
      assert.match(result.stdout, /Native Windows Git board sync requires Node\.js 22\.17\.0/);
      assert.ok(result.stdout.includes(`Found Node.js ${node}.`));
    }
    assert.equal(result.stderr, "");
  }
});
