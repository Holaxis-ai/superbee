import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The aliasing-host lane exists so that assertions which depend on the host filesystem's
// identity class (case aliasing, unicode normalization) actually execute in CI. Its target is
// scoped for speed, so this proof keeps the scope complete as a constraint, not a filename
// list: any workspace test whose own text or test-local imports touch the host-class machinery
// must be executed by the lane's script chain, and the chain itself is interpreted fail-closed
// (an unrecognized segment is an error, never silently skipped coverage).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(root, "scripts", "ci-lanes.json"), "utf8"));

const TEST_FILE = /\.test\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage", ".turbo"]);

// One marker per known way of touching host-class behavior. Broad on purpose: a false positive
// costs one file of macOS runtime, a false negative silently stops a native branch from ever
// running in CI. See the trailing test for what these markers cannot see.
export const HOST_SENSITIVITY_MARKERS = {
  "host-class helper": /host-class/,
  "lane expectation variable": /SUPERBEE_TEST_EXPECT_ALIASING_HOST/,
  "identity or lock module": /filesystem-identity|filesystem-lock/,
  "unicode normalization fixture": /normalize\(\s*["'`]NF|\\u03[0-6][0-9a-fA-F]|[\u0300-\u036f]/,
  "case-variant derivation": /toUpperCase\s*\(/,
};

/**
 * Two distinct path-like string literals that are one name under the identity fold
 * (NFKD + lower-case) mean the test exercises two spellings of one filesystem identity.
 */
export function pathLikeFoldCollision(text) {
  const literals = new Set(
    [...text.matchAll(/["'`]((?:\\.|[^"'`\\\n]){1,80})["'`]/g)]
      .map((m) => m[1])
      .filter((lit) => /[\p{L}]/u.test(lit) && (lit.includes("/") || /\.[a-z0-9]{1,8}$/.test(lit))),
  );
  const byFold = new Map();
  for (const lit of literals) {
    const fold = lit.normalize("NFKD").toLowerCase();
    const prior = byFold.get(fold);
    if (prior !== undefined && prior !== lit) return [prior, lit];
    byFold.set(fold, lit);
  }
  return null;
}

export function markersIn(text) {
  const hits = Object.entries(HOST_SENSITIVITY_MARKERS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
  const collision = pathLikeFoldCollision(text);
  if (collision) hits.push(`fold-equivalent path spellings ${JSON.stringify(collision[0])} / ${JSON.stringify(collision[1])}`);
  return hits;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function resolveRelativeImport(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.mjs`, `${base}.js`];
  if (specifier.endsWith(".js")) candidates.push(base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep trying the next extension candidate
    }
  }
  return null;
}

/**
 * A test's host-sensitivity surface is its own text plus every test-local module it reaches
 * through relative imports (support contracts, fixtures, child-process entry points). Imports
 * into runtime source are not followed: a marker-bearing src module is exercised by many
 * host-independent tests, and reaching the identity machinery still shows up here as the
 * import specifier itself in the test's own text.
 */
function testLocalClosure(file, readFile = (p) => readFileSync(p, "utf8")) {
  const surface = [];
  const queue = [file];
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const text = readFile(current);
    surface.push({ file: current, text });
    for (const match of text.matchAll(/(?:from\s+|import\(\s*|require\(\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const resolved = resolveRelativeImport(current, specifier);
      if (resolved === null) continue;
      const relative = path.relative(root, resolved);
      if (/(^|\/)(test|fixtures)\//.test(relative)) queue.push(resolved);
    }
  }
  return surface;
}

/** Map of workspace test file -> the markers that make it host-sensitive (empty map when none). */
export function detectHostSensitiveTests(repoRoot = root) {
  const detected = new Map();
  const packagesDir = path.join(repoRoot, "packages");
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of walk(path.join(packagesDir, entry.name))) {
      if (!TEST_FILE.test(file)) continue;
      const reasons = [];
      for (const part of testLocalClosure(file)) {
        for (const marker of markersIn(part.text)) {
          reasons.push(part.file === file ? marker : `${marker} (via ${path.relative(repoRoot, part.file)})`);
        }
      }
      if (reasons.length > 0) detected.set(path.relative(repoRoot, file), [...new Set(reasons)]);
    }
  }
  return detected;
}

function parseNodeTestInvocation(script, packageDir, listDir) {
  const tokens = script.split(/\s+/).filter((token) => !/^[A-Z_][A-Z0-9_]*=/.test(token));
  assert.equal(tokens[0], "node", `lane test script must invoke node directly, got: ${script}`);
  assert.ok(tokens.includes("--test"), `lane test script must use the node test runner: ${script}`);
  const files = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--import") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (token.includes("*")) {
      const starAt = token.indexOf("*");
      assert.ok(!token.slice(starAt + 1).includes("*"), `unsupported glob in lane test script: ${token}`);
      const head = token.slice(0, starAt);
      const slashAt = head.lastIndexOf("/");
      const dir = slashAt >= 0 ? head.slice(0, slashAt) : ".";
      const [prefix, suffix] = [head.slice(slashAt + 1), token.slice(starAt + 1)];
      for (const name of listDir(path.join(packageDir, dir))) {
        if (name.startsWith(prefix) && name.endsWith(suffix)) files.push(path.join(packageDir, dir, name));
      }
    } else {
      files.push(path.join(packageDir, token));
    }
  }
  assert.ok(files.length > 0, `lane test script names no test files: ${script}`);
  return files;
}

/**
 * Interpret the lane's script chain into the set of test files it executes. Fail closed: any
 * segment this interpreter does not recognize is an error, so coverage can never be silently
 * widened on paper by a segment that runs nothing.
 */
export function laneCoveredFiles(
  laneScript,
  { readPackage = (dir) => JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")), listDir = readdirSync, repoRoot = root } = {},
) {
  assert.equal(typeof laneScript, "string", "the aliasing-host lane must declare a package script");
  const workspaceDirs = () =>
    readdirSync(path.join(repoRoot, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(repoRoot, "packages", entry.name));
  const packageDirByName = new Map();
  for (const dir of workspaceDirs()) packageDirByName.set(readPackage(dir).name, dir);

  const covered = new Set();
  for (const segment of laneScript.split(" && ").map((part) => part.trim())) {
    if (segment === "npm run build") continue;
    let match = /^npm test -w (\S+)(?: --ignore-scripts)?$/.exec(segment);
    if (match) {
      const dir = packageDirByName.get(match[1]);
      assert.ok(dir, `lane segment targets unknown workspace ${match[1]}`);
      for (const file of parseNodeTestInvocation(readPackage(dir).scripts.test, dir, listDir)) {
        covered.add(path.relative(repoRoot, file));
      }
      continue;
    }
    match = /^npm run (\S+) -w (\S+)$/.exec(segment);
    if (match) {
      const dir = packageDirByName.get(match[2]);
      assert.ok(dir, `lane segment targets unknown workspace ${match[2]}`);
      const script = readPackage(dir).scripts[match[1]];
      assert.ok(script, `lane segment references missing script ${match[1]} in ${match[2]}`);
      for (const file of parseNodeTestInvocation(script, dir, listDir)) {
        covered.add(path.relative(repoRoot, file));
      }
      continue;
    }
    assert.fail(`unrecognized aliasing-host lane segment (extend the interpreter deliberately): ${segment}`);
  }
  return covered;
}

export function assertLaneCoversHostSensitiveTests(detected, covered) {
  const missing = [...detected].filter(([file]) => !covered.has(file));
  assert.deepEqual(
    missing.map(([file, reasons]) => `${file} [${reasons.join("; ")}]`),
    [],
    "host-sensitive tests exist outside the aliasing-host lane target; add them to the lane's " +
      "script chain (or route their host-class use through covered files) so their native branch runs in CI",
  );
}

test("the scanner still sees the owning host-class machinery", () => {
  // Canary against scanner rot, not a coverage floor: one known member per marker family.
  const detected = detectHostSensitiveTests();
  assert.ok(detected.size > 0, "the host-sensitivity scan found nothing; the detector is broken");
  const native = detected.get(path.join("packages", "core", "test", "filesystem-identity-native.test.ts"));
  assert.ok(native?.some((reason) => reason.includes("host-class")), "helper detection is broken");
  const boundary = detected.get(path.join("packages", "cli", "test", "private-state-bundle-boundary.test.ts"));
  assert.ok(boundary?.some((reason) => reason.includes("normalization") || reason.includes("case-variant")), "fixture detection is broken");
});

test("every host-sensitive workspace test is executed by the aliasing-host lane", () => {
  assert.equal(manifest.lanes["aliasing-host"].script, "ci:aliasing-host", "the lane manifest must run the scoped target");
  const covered = laneCoveredFiles(rootPkg.scripts["ci:aliasing-host"]);
  assertLaneCoversHostSensitiveTests(detectHostSensitiveTests(), covered);
});

test("the completeness check goes red on host-sensitive tests outside the lane", () => {
  const covered = laneCoveredFiles(rootPkg.scripts["ci:aliasing-host"]);
  const outside = "packages/server/test/synthetic.test.ts";
  for (const [attack, text] of [
    ["expectation variable", "if (process.env.SUPERBEE_TEST_EXPECT_ALIASING_HOST === '1') assertAliased();"],
    ["helper import", "import { detectHostClass } from '../../core/test/host-class.js';"],
    ["identity module import", "import { identityKey } from '../../core/src/filesystem-identity.js';"],
    ["normalization fixture", 'const decomposed = name.normalize("NFD");'],
    ["derived case variant", "const variant = base.toUpperCase();"],
    ["fold-equivalent spellings", 'await write("concepts/Auth.md"); await read("concepts/auth.md");'],
  ]) {
    const markers = markersIn(text);
    assert.ok(markers.length > 0, `${attack} must be detected`);
    assert.throws(
      () => assertLaneCoversHostSensitiveTests(new Map([[outside, markers]]), covered),
      /outside the aliasing-host lane target/,
      `${attack} outside the lane must fail the proof`,
    );
  }
  // What the markers cannot see, kept as an executable statement: a hand-rolled probe that
  // lower-cases an upper-case literal (or hardcodes one spelling per file) carries none of the
  // marker shapes. Tightening this means adding a marker, not adding filenames.
  assert.deepEqual(markersIn('const probe = "CONCEPTS".toLowerCase();'), []);
});

test("the lane interpreter fails closed on segments it cannot prove", () => {
  assert.throws(() => laneCoveredFiles("npm run build && bash run-things.sh"), /unrecognized aliasing-host lane segment/);
  assert.throws(() => laneCoveredFiles(undefined), /must declare a package script/);
  assert.throws(
    () => laneCoveredFiles("npm test -w @superbee/core --ignore-scripts", {
      readPackage: (dir) => ({ ...JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")), scripts: { test: "vitest run" } }),
    }),
    /must invoke node directly/,
  );
});
