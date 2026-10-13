// The one owner of the third-party notices that travel with the published `superbee` tarball.
// esbuild inlines npm dependencies into dist/*.mjs, so their MIT/ISC/BSD/Apache notices must ship
// as a file of their own: the package declares no runtime dependencies that npm could fetch with
// their licenses attached. The package set is DERIVED from the module paths each build stage
// actually bundled, never from a hand-maintained list, so it cannot drift from the artifact.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Licenses whose terms permit redistribution in the Apache-2.0 tarball with notice alone. */
export const ALLOWED_LICENSES = Object.freeze(["0BSD", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT"]);

const NODE_MODULES = `${sep}node_modules${sep}`;
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.-][^/]*)?$/i;
const RULE = "=".repeat(80);
const SUBRULE = "-".repeat(80);

/** The installed package directory that owns `modulePath`, or null for first-party source. */
export function packageRootOf(modulePath) {
  const at = modulePath.lastIndexOf(NODE_MODULES);
  if (at === -1) return null;
  const rest = modulePath.slice(at + NODE_MODULES.length).split(sep);
  const depth = rest[0]?.startsWith("@") ? 2 : 1;
  if (rest.length <= depth || rest.slice(0, depth).some((part) => part.length === 0)) return null;
  return modulePath.slice(0, at + NODE_MODULES.length) + rest.slice(0, depth).join(sep);
}

/**
 * Absolute paths of the modules that contribute bytes to an esbuild output. Top-level
 * `metafile.inputs` also lists modules tree shaking removed, which are not distributed; only the
 * per-output input maps with positive `bytesInOutput` describe what ships. Keys are relative to
 * `absWorkingDir`.
 */
export function metafileModulePaths(metafile, absWorkingDir) {
  const shipped = new Set();
  for (const output of Object.values(metafile?.outputs ?? {})) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs ?? {})) {
      if (bytesInOutput > 0) shipped.add(input);
    }
  }
  return [...shipped]
    .filter((input) => !/^(?:<[^>]*>|\([a-z]+\):)/.test(input))
    .map((input) => resolve(absWorkingDir, input.replace(/^[a-z-]+:(?!\/\/)/, "")));
}

/**
 * True when the SPDX expression can be satisfied using allowed licenses only: an OR needs one
 * allowed side, an AND needs both. Parsed by precedence (AND binds tighter than OR) with real
 * parenthesis nesting, because splitting the string lets a required copyleft term ride along with
 * an allowed alternative. Anything unparseable, and any `WITH` exception, is refused.
 */
export function isAllowedLicense(expression) {
  if (typeof expression !== "string") return false;
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const fail = () => { throw new SyntaxError(expression); };
  const parseOr = () => {
    let allowed = parseAnd();
    while (tokens[at] === "OR") { at += 1; allowed = parseAnd() || allowed; }
    return allowed;
  };
  const parseAnd = () => {
    let allowed = parseTerm();
    while (tokens[at] === "AND") { at += 1; allowed = parseTerm() && allowed; }
    return allowed;
  };
  const parseTerm = () => {
    const token = tokens[at++];
    if (token === "(") {
      const allowed = parseOr();
      if (tokens[at++] !== ")") fail();
      return allowed;
    }
    if (token === undefined || ["(", ")", "AND", "OR", "WITH"].includes(token)) fail();
    if (tokens[at] === "WITH") { at += 2; return false; }
    return ALLOWED_LICENSES.includes(token);
  };
  try {
    const allowed = parseOr();
    return at === tokens.length && tokens.length > 0 && allowed;
  } catch {
    return false;
  }
}

function declaredLicense(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (typeof manifest.license?.type === "string") return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses.map((entry) => entry?.type).filter((type) => typeof type === "string");
    if (types.length > 0) return types.length === 1 ? types[0] : `(${types.join(" OR ")})`;
  }
  return null;
}

/** Read one installed package's identity, declared license, and shipped license text. */
export function readPackageNotice(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const files = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const licenseText = files.map((name) => readFileSync(join(root, name), "utf8").replace(/\r\n?/g, "\n").trim()).join("\n\n");
  return { name: manifest.name, version: manifest.version, license: declaredLicense(manifest), licenseText, root };
}

/**
 * Collect the notice for every third-party package that owns one of `modulePaths`. Throws, naming
 * every offending package, when a license is not allowed or its text is missing: an incomplete or
 * copyleft notice set must stop the build, not ship.
 */
export function collectThirdPartyNotices(modulePaths, read = readPackageNotice) {
  const roots = [...new Set(modulePaths.map(packageRootOf).filter((root) => root !== null))];
  const notices = roots
    .map((root) => read(root))
    .filter((notice) => notice.name !== "superbee" && !notice.name?.startsWith("@superbee/"));
  const unique = new Map();
  for (const notice of notices) unique.set(`${notice.name}@${notice.version}`, notice);
  // Code-unit order, not localeCompare: the file must not vary with the build host's locale.
  const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const entries = [...unique.values()].sort((a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(a.version, b.version));
  const problems = [];
  for (const entry of entries) {
    if (!isAllowedLicense(entry.license)) problems.push(`${entry.name}@${entry.version}: license ${JSON.stringify(entry.license)} is not in ${ALLOWED_LICENSES.join(", ")}`);
    if (entry.licenseText === "") problems.push(`${entry.name}@${entry.version}: no LICENSE/LICENCE/COPYING file in ${entry.root}`);
  }
  if (problems.length > 0) throw new Error(`third-party notices are incomplete:\n  ${problems.join("\n  ")}`);
  return entries;
}

/** Deterministic plain-text rendering: sorted entries, no timestamps or local paths. */
export function renderThirdPartyNotices(entries) {
  const header = [
    "Third-party software notices",
    "",
    "The superbee package bundles the following third-party open-source packages into its",
    "dist/ files. Each is redistributed under the license named below; its full license text",
    "follows.",
  ].join("\n");
  const sections = entries.map((entry) =>
    [RULE, `${entry.name}@${entry.version}`, `License: ${entry.license}`, SUBRULE, entry.licenseText].join("\n"),
  );
  return [header, ...sections].join("\n\n") + "\n";
}

/** Derive, check, and write the notices for everything the given module paths pull in. */
export function writeThirdPartyNotices(modulePaths, outfile) {
  const entries = collectThirdPartyNotices(modulePaths);
  writeFileSync(outfile, renderThirdPartyNotices(entries));
  return entries;
}
