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

// A host-sensitive row must be scored against the aliasing its OWN pair of spellings exercises.
// The aggregate class is true whenever EITHER kind aliases, so a row that branches on it demands
// a refusal on a case-sensitive, normalization-insensitive volume for a case pair the product
// correctly treats as two distinct ids. This prohibits the SHAPE — comparing a host-class value
// against "exact" or "aliasing" — rather than listing the rows known to get it wrong, so an
// unrecognized new row fails closed. Escaping it takes an explicit annotated reason on the line.
const AGGREGATE_BRANCH = /(?:!==|===)\s*"(?:exact|aliasing)"|"(?:exact|aliasing)"\s*(?:!==|===)/;
// "exact" is ALSO the observation-verdict vocabulary (`verdict === "exact"`, `observed.state ===
// "exact"`), and asserting on a verdict inside an identity test is an ordinary thing to do. Firing
// there would push an author to annotate `aggregate-class-branch:` about something that is not
// aggregate-class branching, which is exactly how an annotation stops meaning anything. So a line
// is in scope only when it also names a host-class receiver.
const HOST_CLASS_RECEIVER = /hostClass|HostClass|detectHost|hostAliasing|HostAliasing/;
const AGGREGATE_BRANCH_ESCAPE = /\/\/\s*aggregate-class-branch:\s*\S/;
// The module that OWNS the classification necessarily compares against these literals.
const AGGREGATE_BRANCH_OWNER = path.join("packages", "core", "test", "host-class.ts");

/**
 * Every offending `file:line` in one file's text, ignoring annotated escapes.
 *
 * Measured evasion surface, so the stated limits match what was tested rather than what was
 * hoped (external re-review, 2026-08-25, each shape run through this function):
 *
 * - It does not check that a row passes the RIGHT spellings to `hostAliasesPair`, nor that it uses
 *   the result the right way round. That is the residual closest to the original defect, together
 *   with a row that reads the wrong DIMENSION by hand (`const aliasing = host.normalization;` on a
 *   row writing a case pair): this rule prohibits reading the AGGREGATE, not asking the wrong
 *   question. No row in the tree does either, and nothing here enforces it.
 * - It is line-local and literal-quoted: single quotes or backticks, `switch (h) { case "exact": }`,
 *   `["exact"].includes(h)`, `h.startsWith("exact")`, and a comparison assembled across lines
 *   (`const c = h.hostClass;` then `c !== "exact"`, which also drops the receiver token) all pass.
 *   The receiver requirement above widens that last one deliberately, trading a narrow evasion for
 *   the annotation keeping its meaning.
 * - `"normalizing"` is not prohibited at all: `hostClass` has three values and only two are the
 *   aliasing/exact axis, so branching on a normalizing store is legitimate (AC-17 and the identity
 *   contract both do it).
 * - It reads only files the coverage scanner classifies as host-sensitive, plus their test-local
 *   closure, so production's own `=== "exact"` verdict lines are out of range for a second reason.
 */
export function aggregateBranchesIn(text) {
  return text
    .split("\n")
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter(
      ({ text: line }) =>
        AGGREGATE_BRANCH.test(line) && HOST_CLASS_RECEIVER.test(line) && !AGGREGATE_BRANCH_ESCAPE.test(line),
    );
}

export function assertNoAggregateHostClassBranches(repoRoot = root) {
  const offenders = [];
  for (const [file] of detectHostSensitiveTests(repoRoot)) {
    for (const part of testLocalClosure(path.join(repoRoot, file))) {
      const relative = path.relative(repoRoot, part.file);
      if (relative === AGGREGATE_BRANCH_OWNER) continue;
      for (const hit of aggregateBranchesIn(part.text)) {
        offenders.push(`${relative}:${hit.line}: ${hit.text.trim()}`);
      }
    }
  }
  assert.deepEqual(
    [...new Set(offenders)].sort(),
    [],
    "a host-sensitive test decides an expectation from the AGGREGATE host class; branch on the " +
      "pair the row writes instead (hostAliasesPair(host, first, second)), or annotate the line " +
      "with `// aggregate-class-branch: <reason>` when the aggregate really is the row's subject",
  );
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

test("no host-sensitive test decides an expectation from the aggregate host class", () => {
  assertNoAggregateHostClassBranches();
});

test("the aggregate-branch prohibition catches the shape and honours only an annotated escape", () => {
  for (const forbidden of [
    'const aliasing = (await hostClass()) !== "exact";',
    'if (detected.hostClass === "exact") {',
    'const aliasing = host.hostClass === "aliasing";',
    'if ("exact" !== detectHostClass()) skip();',
  ]) {
    assert.equal(aggregateBranchesIn(forbidden).length, 1, `must be caught: ${forbidden}`);
  }
  assert.deepEqual(aggregateBranchesIn('if (h.hostClass === "exact") {} // aggregate-class-branch: subject'), []);
  // The escape must carry a reason; a bare marker does not buy the exemption.
  assert.equal(aggregateBranchesIn('if (h.hostClass === "exact") {} // aggregate-class-branch:').length, 1);
  // Shapes it deliberately does not touch: the classifier's own output, and the unrelated
  // "exact" states this codebase asserts on elsewhere.
  assert.deepEqual(aggregateBranchesIn('const EXACT_HOST = { hostClass: "exact", case: false };'), []);
  assert.deepEqual(aggregateBranchesIn('assert.deepEqual(result, { state: "exact", value: "body" });'), []);
});

// The false positive that would hollow out the annotation. "exact" is the observation-verdict
// vocabulary too, and these lines belong inside identity tests; an author pushed to annotate them
// `aggregate-class-branch:` would be writing a reason that is not true, after which the marker
// stops being a claim about anything. Both directions are pinned so neither can drift back.
test("the aggregate-branch prohibition ignores observation verdicts and still catches host-class branches", () => {
  for (const verdictLine of [
    // The exact line an external review used to demonstrate the false positive.
    'const isExactObservation = (o: { state: string }): boolean => o.state === "exact";',
    'if (verdict === "exact") return;',
    'if (realized.state === "exact") return realized.value;',
    'assert.equal(observed.state === "exact", true);',
    'const settled = outcome !== "exact";',
  ]) {
    assert.deepEqual(aggregateBranchesIn(verdictLine), [], `must NOT be caught: ${verdictLine}`);
  }
  // Same comparison, host-class receiver: still caught. The rule narrowed its scope, not its teeth.
  assert.equal(aggregateBranchesIn('const aliasing = (await hostClass()) !== "exact";').length, 1);
  assert.equal(aggregateBranchesIn('const aliasing = detected.hostClass !== "exact";').length, 1);
  assert.equal(aggregateBranchesIn('const aliasing = (await detectHostAliasing()).hostClass !== "exact";').length, 1);
  // A verdict line and a host-class line in one file: only the second is reported.
  const both = 'if (verdict === "exact") return;\nconst aliasing = detected.hostClass !== "exact";';
  assert.deepEqual(aggregateBranchesIn(both).map((hit) => hit.line), [2]);
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
