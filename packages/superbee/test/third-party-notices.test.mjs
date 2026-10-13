import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectThirdPartyNotices,
  isAllowedLicense,
  metafileModulePaths,
  packageRootOf,
  renderThirdPartyNotices,
} from "../scripts/third-party-notices.mjs";
import { requireBundledModules } from "../build.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "superbee-notices-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = (dir, manifest, files = {}) => {
    const at = join(root, dir);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "package.json"), JSON.stringify(manifest));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(at, name), text);
    return join(at, "index.js");
  };
  return { root, pkg };
}

test("package roots come from the innermost node_modules segment, scoped or not", () => {
  assert.equal(packageRootOf("/r/node_modules/a/lib/x.js"), "/r/node_modules/a");
  assert.equal(packageRootOf("/r/node_modules/@s/b/x.js"), "/r/node_modules/@s/b");
  assert.equal(packageRootOf("/r/node_modules/a/node_modules/c/x.js"), "/r/node_modules/a/node_modules/c");
  assert.equal(packageRootOf("/r/packages/core/src/index.ts"), null);
  assert.equal(packageRootOf("/r/node_modules/@s"), null);
});

test("metafile inputs resolve against the working directory and skip virtual modules", () => {
  const paths = metafileModulePaths(
    { inputs: { "../../node_modules/a/x.js": {}, "src/index.ts": {}, "<define:__X__>": {}, "(disabled):fs": {} } },
    "/r/packages/superbee",
  );
  assert.deepEqual(paths, ["/r/node_modules/a/x.js", "/r/packages/superbee/src/index.ts"]);
});

test("SPDX expressions pass when an OR alternative, or every AND term, is allowed", () => {
  for (const ok of [
    "MIT", "ISC", "BSD-3-Clause", "(MIT OR Apache-2.0)", "(GPL-3.0 OR MIT)", "MIT AND ISC",
    "MIT AND (ISC OR GPL-3.0)", "(GPL-3.0 AND MIT) OR ISC", "((MIT))",
    // AND binds tighter than OR: MIT alone satisfies this one.
    "MIT OR ISC AND GPL-3.0 AND GPL-2.0 OR GPL-3.0",
  ]) assert.ok(isAllowedLicense(ok), ok);
  for (const bad of [
    "GPL-3.0", "AGPL-3.0-only", "MIT AND GPL-3.0", "UNLICENSED", "", "   ", null, undefined,
    // A required copyleft term must not ride along with an allowed alternative.
    "GPL-3.0 AND (MIT OR ISC)", "(MIT OR GPL-3.0) AND GPL-3.0", "MIT AND GPL-3.0 OR GPL-2.0",
    "Apache-2.0 WITH LLVM-exception", "(MIT", "MIT)", "MIT OR", "AND MIT", "MIT ISC",
  ]) assert.ok(!isAllowedLicense(bad), String(bad));
});

test("notices cover each third-party package once, sorted, with full license text", (t) => {
  const { pkg } = fixture(t);
  const modules = [
    pkg("node_modules/zed", { name: "zed", version: "1.0.0", license: "MIT" }, { LICENSE: "MIT text zed\r\n" }),
    pkg("node_modules/@s/b", { name: "@s/b", version: "2.0.0", license: "ISC" }, { "LICENCE.md": "ISC text" }),
    pkg("node_modules/zed/node_modules/old", { name: "old", version: "0.1.0", licenses: [{ type: "MIT" }] }, { "LICENSE-MIT": "legacy" }),
    pkg("node_modules/@superbee/core", { name: "@superbee/core", version: "0.0.0", license: "Apache-2.0" }),
  ];
  const entries = collectThirdPartyNotices([...modules, modules[0], "/r/packages/core/src/x.ts"]);
  assert.deepEqual(entries.map((e) => `${e.name}@${e.version} ${e.license}`), ["@s/b@2.0.0 ISC", "old@0.1.0 MIT", "zed@1.0.0 MIT"]);
  assert.equal(entries.find((e) => e.name === "zed").licenseText, "MIT text zed");
  const text = renderThirdPartyNotices(entries);
  assert.equal(text, renderThirdPartyNotices(collectThirdPartyNotices([...modules].reverse())), "input order must not change the output");
  assert.match(text, /zed@1\.0\.0\nLicense: MIT\n-{80}\nMIT text zed/);
  assert.ok(!text.includes(tmpdir()), "rendered notices must not leak local paths");
});

test("a copyleft or unlicensed bundled package stops the build and names every offender", (t) => {
  const { pkg } = fixture(t);
  const modules = [
    pkg("node_modules/fine", { name: "fine", version: "1.0.0", license: "MIT" }, { LICENSE: "ok" }),
    pkg("node_modules/viral", { name: "viral", version: "3.0.0", license: "GPL-3.0" }, { COPYING: "gpl" }),
    pkg("node_modules/bare", { name: "bare", version: "1.2.3", license: "MIT" }),
  ];
  assert.throws(() => collectThirdPartyNotices(modules), (error) => {
    assert.match(error.message, /viral@3\.0\.0: license "GPL-3\.0" is not in/);
    assert.match(error.message, /bare@1\.2\.3: no LICENSE\/LICENCE\/COPYING file/);
    assert.doesNotMatch(error.message, /fine@/);
    return true;
  });
});

test("a prepared-inputs record without bundled modules is refused, not treated as empty", () => {
  assert.throws(() => requireBundledModules({ inputs: [] }), /must carry bundledModules/);
  assert.deepEqual(requireBundledModules({ inputs: [], bundledModules: ["/x"] }), ["/x"]);
});

test("the built distribution ships notices for the CLI, embedded UI, and subpath bundles", () => {
  const text = readFileSync(new URL("../dist/THIRD-PARTY-NOTICES.txt", import.meta.url), "utf8");
  const entries = [...text.matchAll(/^={80}\n(.+)@([^@\n]+)\nLicense: (.+)$/gm)].map(([, name, version, license]) => ({ name, version, license }));
  assert.ok(entries.length > 0, "notices must list the bundled packages");
  for (const entry of entries) assert.ok(isAllowedLicense(entry.license), `${entry.name}: ${entry.license}`);
  const names = new Set(entries.map((entry) => entry.name));
  // js-yaml reaches the tarball only through the CLI's esbuild graph; @tanstack/react-query only
  // through the embedded ui build, so its presence proves the prepared-inputs path is wired.
  for (const name of ["js-yaml", "@tanstack/react-query"]) assert.ok(names.has(name), name);
  assert.ok(!text.includes(repoRoot), "notices must not leak the build machine's paths");
  assert.match(readFileSync(new URL("../NOTICE", import.meta.url), "utf8"), /dist\/THIRD-PARTY-NOTICES\.txt/);
});
