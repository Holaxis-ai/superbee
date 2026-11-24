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

function runAsWindows(args, uv, node = process.versions.node) {
  const entry = new URL("../dist/superbee.mjs", import.meta.url);
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    Object.defineProperty(process, "platform", { value: "win32" });
    Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(node)} });
    Object.defineProperty(process.versions, "uv", { value: ${JSON.stringify(uv)} });
    process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entry))}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(entry.href)});
  `], { encoding: "utf8" });
}

test("the installed entry guards Windows board sync by the libuv file identity fix", () => {
  for (const [node, uv, supported] of [
    ["22.14.0", "1.49.2", false],
    ["22.17.0", "1.51.0", true],
    ["24.1.0", "1.50.0", false],
    ["24.2.0", "1.51.0", true],
    ["26.0.0", "1.52.1", true],
  ]) {
    // Vary only host facts. The supported rows ask for help so the CLI never accesses board state.
    const result = runAsWindows(["sync", "--help"], uv, node);
    assert.equal(result.status, supported ? 0 : 1, result.stderr);
    if (supported) assert.match(result.stdout, /--pull-only/);
    else {
      assert.match(result.stdout, /code: RUNTIME/);
      assert.match(result.stdout, /Native Windows file operations require Node\.js 22\.17\.0/);
      assert.ok(result.stdout.includes(`Found Node.js ${node}.`));
    }
    assert.equal(result.stderr, "");
  }
});

test("the native Windows runtime dispatches local reads and guarded updates and refuses other operations", () => {
  for (const [args, uv, status, output] of [
    [["list", "--help"], "1.51.0", 0, /--dir <standalone-board>/],
    [["query", "--help"], "1.51.0", 0, /--dir <standalone-board>/],
    [["list", "--help"], "1.50.0", 1, /file operations require Node\.js 22\.17\.0/],
    [["doc", "read", "--help"], "1.51.0", 0, /--dir <local-bundle-or-standalone-board> --json/],
    [["doc", "read", "--help"], "1.50.0", 1, /file operations require Node\.js 22\.17\.0/],
    [["doc", "update", "--help"], "1.51.0", 0, /--dir <standalone-board> --expected-version <v>/],
    [["doc", "update", "concepts/example", "--title", "Example"], "1.51.0", 2, /requires --expected-version/],
    [["doc", "write", "--help"], "1.51.0", 0, /--create-only --dir <local-bundle>/],
    [["setup", "--help"], "1.51.0", 0, /--project <folder>/],
    [["setup", "--help"], "1.50.0", 1, /file operations require/],
    [["init", "--help"], "1.50.0", 1, /file operations require/],
    [["doc", "write", "--help"], "1.50.0", 1, /file operations require/],
    [["setup", "hosted"], "1.51.0", 2, /local project setup/],
    [["setup", "--host", "codex"], "1.51.0", 2, /local project setup/],
    [["setup", "quarantine-state"], "1.51.0", 2, /local project setup/],
    [["search", "--help"], "1.51.0", 1, /Use WSL2 for the full CLI/],
    [["__managed-ui-v1"], "1.51.0", 1, /Use WSL2 for the full CLI/],
    [["__update-refresh-v1", "token"], "1.51.0", 1, /Use WSL2 for the full CLI/],
    [["version", "--json"], "1.50.0", 0, /"identity"/],
    [[], "1.50.0", 0, /superbee list --help/],
  ]) {
    const result = runAsWindows(args, uv);
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stdout, output);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /--(?:body-|rendered-)?out\b/);
  }
});
