import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const execFileAsync = promisify(execFile);

export const INVENTORY_SCHEMA = "superbee.rename-literal-inventory.v1";

const SKIP_DIRS = new Set([
  ".git",
  ".agentstate-lite",
  "node_modules",
  "dist",
  "coverage",
  ".stryker-tmp",
  "playwright-report",
  "test-results",
  "release-candidate",
]);

const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
]);

const APPROVED_OCCURRENCES_FILE = "scripts/approved-legacy-occurrences.json";
const APPROVED_OCCURRENCES_SCHEMA = "superbee.approved-legacy-occurrences.v1";
const SELF_FILES = new Set([
  "scripts/rename-literal-inventory.mjs",
  "scripts/rename-literal-inventory.test.mjs",
  APPROVED_OCCURRENCES_FILE,
]);

const LEGACY_LITERAL =
  /__ASLITE_BUILD_IDENTITY__|ASLITE_MCP_APP_SCRIPT|AGENTSTATE_LITE_[A-Z0-9_]+|ASLITE_[A-Z0-9_]+|AGENTSTATE_LITE|AGENTSTATE|ASLITE|@agentstate-lite\/[A-Za-z0-9_-]+|@holaxis\/aslite|\.agentstate-lite|\.agentstate\.json|agentstate-lite|agentstate|aslite/g;

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function positionFor(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (starts[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  const lineIndex = Math.max(0, hi);
  return { line: lineIndex + 1, column: offset - starts[lineIndex] + 1 };
}

function containsAny(value, needles) {
  return needles.some((needle) => value.includes(needle));
}

function lineSha256(lineText) {
  return createHash("sha256").update(lineText).digest("hex");
}

export function approvedOccurrenceKey({ file, line = 1, lineText, match, ordinal = 0 }) {
  return `${file}\0${line}\0${lineSha256(lineText)}\0${match}\0${ordinal}`;
}

async function loadApprovedOccurrences(root) {
  const parsed = JSON.parse(await readFile(path.join(root, APPROVED_OCCURRENCES_FILE), "utf8"));
  if (parsed?.schema !== APPROVED_OCCURRENCES_SCHEMA || !Array.isArray(parsed.occurrences)) {
    throw new Error(`${APPROVED_OCCURRENCES_FILE} must use ${APPROVED_OCCURRENCES_SCHEMA}`);
  }
  const approved = new Map();
  for (const row of parsed.occurrences) {
    const key = `${row.file}\0${row.line}\0${row.line_sha256}\0${row.literal}\0${row.ordinal}`;
    if (approved.has(key)) throw new Error(`duplicate approved legacy occurrence: ${row.file}`);
    approved.set(key, {
      category: row.category,
      treatment: row.treatment,
      owner: row.owner,
      reason: row.reason,
    });
  }
  return approved;
}

function shouldScanFile(file) {
  if (SELF_FILES.has(file)) return false;
  if (!TEXT_EXTENSIONS.has(path.extname(file))) return false;
  return !file.split("/").some((part) => SKIP_DIRS.has(part));
}

export function classifyLegacyLiteral({ file, line = 1, lineText, match, ordinal = 0, approvedOccurrences }) {
  const generatedOrFixture =
    file.includes("/test/fixtures/") ||
    file.includes("/prior-shipped-") ||
    file.endsWith("/fixtures.json") ||
    file.includes("/dist/");

  if (generatedOrFixture) {
    return {
      category: "immutable-fixture",
      treatment: "preserve",
      owner: "test-fixture-owner",
      reason: "historical or generated fixture bytes are preserved and renamed only by explicit fixture updates",
    };
  }

  if (
    file.includes("/test/") ||
    file.includes("/e2e/") ||
    file.endsWith(".test.mjs") ||
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx")
  ) {
    return {
      category: "test-assertion",
      treatment: "update-or-preserve-with-covered-surface",
      owner: "test-owner",
      reason: "test literals move with the product surface they assert or remain as explicit legacy fixtures",
    };
  }

  if (match === "agentstate-lite" || match === "aslite") {
    const key = approvedOccurrenceKey({ file, line, lineText, match, ordinal });
    const approved = approvedOccurrences?.get(key);
    if (approved !== undefined) {
      approvedOccurrences.delete(key);
      return approved;
    }
    return {
      category: "unclassified",
      treatment: "fail-closed",
      owner: "unassigned",
      reason: "ambiguous lowercase legacy names require an exact approved occurrence",
    };
  }

  if (file === "scripts/verify-npm-package.mjs") {
    return {
      category: "package-verifier-policy",
      treatment: "rename-or-preserve-by-target",
      owner: "package-verifier",
      reason: "AC-29/AC-60 require verifier install roots, entrypoints, and teaching-surface assumptions to be target-aware",
    };
  }

  if (match === "ASLITE_MCP_APP_SCRIPT") {
    return {
      category: "generated-marker",
      treatment: "rename-with-projection-test",
      owner: "mcp-app",
      reason: "AC-60 names this generated marker as a projection that must be deliberately handled",
    };
  }

  if (match === "__ASLITE_BUILD_IDENTITY__") {
    return {
      category: "build-identity-marker",
      treatment: "rename-with-build-identity-test",
      owner: "cli-build",
      reason: "AC-60 names this build identity seam explicitly",
    };
  }

  if (match === "AGENTSTATE_LITE" || match === "ASLITE" || match.startsWith("AGENTSTATE_LITE_") || match.startsWith("ASLITE_")) {
    if (match.includes("RELEASE_LIVE_ENABLED")) {
      return {
        category: "release-live-gate-variable",
        treatment: "rename-with-release-policy",
        owner: "release-policy",
        reason: "release live-gate variables are part of the AC-60 workflow authority surface",
      };
    }
    if (match.includes("RELEASE_TARBALL") || match.includes("RELEASE_MANIFEST")) {
      return {
        category: "release-retained-artifact-variable",
        treatment: "rename-with-release-policy",
        owner: "release-policy",
        reason: "retained tarball and manifest variables are part of the AC-60 release artifact surface",
      };
    }
    const actor = match.includes("ACTOR");
    const apiKey = match.includes("API_KEY");
    const noUpdate = containsAny(lineText, ["NO_UPDATE_CHECK", "NO_UPDATE_NOTIFIER", "CI"]);
    const noAutopull = lineText.includes("NO_AUTOPULL");
    const remote = lineText.includes("REMOTE");
    const lockBarrier = lineText.includes("INSTALLED_LOCK_BARRIER");
    if (actor || apiKey || noUpdate || noAutopull || remote || lockBarrier) {
      return {
        category: "environment-variable",
        treatment: "compatibility-reader-plus-superbee-authority",
        owner: "cli-policy",
        reason: "old environment variables are compatibility inputs; canonical SUPERBEE_* policy is added separately",
      };
    }
  }

  if (match === ".agentstate.json" || match === ".agentstate-lite") {
    return {
      category: "bundle-discovery",
      treatment: "compatibility-reader",
      owner: "bundle-discovery",
      reason: "DG-2/DG-3 preserve legacy roots and bindings while adding Superbee canonical readers",
    };
  }

  if (match === "@holaxis/aslite") {
    return {
      category: "npm-old-coordinate",
      treatment: "bridge-or-doc-compatibility",
      owner: "release-policy",
      reason: "DG-5/DG-6 retain old coordinate as a bridge and recovery authority",
    };
  }

  if (match.startsWith("@agentstate-lite/")) {
    return {
      category: "workspace-package-identity",
      treatment: "rename-to-superbee-package",
      owner: "build-graph",
      reason: "AC-05 requires current workspace package identity to move to @superbee/*",
    };
  }

  if (match === "agentstate" || match === "AGENTSTATE") {
    return {
      category: "serialized-or-protocol-identifier",
      treatment: "dg-4-matrix",
      owner: "compatibility-policy",
      reason: "DG-4 decides per-identifier preserve/version/write behavior",
    };
  }

  return {
    category: "unclassified",
    treatment: "fail-closed",
    owner: "unknown",
    reason: "legacy literal matched no known rename policy rule",
  };
}

async function* walk(root, rel = "") {
  const current = path.join(root, rel);
  let info;
  try {
    info = await stat(current);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  if (info.isDirectory()) {
    const base = path.basename(current);
    if (SKIP_DIRS.has(base)) return;
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) yield* walk(root, path.join(rel, entry.name));
    return;
  }

  if (!info.isFile()) return;
  if (!TEXT_EXTENSIONS.has(path.extname(current))) return;
  yield toPosix(rel);
}

async function trackedTextFiles(root) {
  const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "-z"], { maxBuffer: 20 * 1024 * 1024 });
  return stdout
    .split("\0")
    .filter(Boolean)
    .map(toPosix)
    .filter(shouldScanFile)
    .sort();
}

export async function generateRenameLiteralInventory({ root = repoRoot, roots } = {}) {
  const approvedOccurrences = await loadApprovedOccurrences(root);
  const files = [];
  if (roots) {
    for (const entry of roots) {
      for await (const file of walk(root, entry)) if (shouldScanFile(file)) files.push(file);
    }
    files.sort();
  } else {
    files.push(...(await trackedTextFiles(root)));
  }

  const matches = [];
  for (const file of files) {
    const absolute = path.join(root, ...file.split("/"));
    const text = await readFile(absolute, "utf8");
    const starts = lineStarts(text);
    for (const found of text.matchAll(LEGACY_LITERAL)) {
      const offset = found.index ?? 0;
      const position = positionFor(starts, offset);
      const lineEnd = text.indexOf("\n", starts[position.line - 1]);
      const lineText = text.slice(starts[position.line - 1], lineEnd === -1 ? text.length : lineEnd);
      const lineOffset = offset - starts[position.line - 1];
      const ordinal = [...lineText.slice(0, lineOffset).matchAll(new RegExp(found[0], "g"))].length;
      const classification = classifyLegacyLiteral({
        file,
        line: position.line,
        lineText,
        match: found[0],
        ordinal,
        approvedOccurrences,
      });
      matches.push({
        file,
        line: position.line,
        column: position.column,
        literal: found[0],
        ...classification,
      });
    }
  }

  if (!roots && approvedOccurrences.size > 0) {
    const [first] = approvedOccurrences.keys();
    throw new Error(`stale approved legacy occurrence: ${first}`);
  }

  matches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return {
    schema: INVENTORY_SCHEMA,
    source: roots ? "explicit-roots" : "git-ls-files",
    roots: roots ? roots.map(toPosix) : [],
    files_scanned: files.length,
    matches,
    summary: matches.reduce((acc, row) => {
      acc[row.category] = (acc[row.category] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

export function assertClassifiedInventory(inventory) {
  const unknown = inventory.matches.filter(
    (row) =>
      row.category === "unclassified" ||
      row.treatment === "fail-closed" ||
      row.treatment.includes("rename-or-classify"),
  );
  if (unknown.length) {
    const first = unknown[0];
    throw new Error(
      `unclassified legacy literal ${JSON.stringify(first.literal)} at ${first.file}:${first.line}:${first.column}`,
    );
  }
}

export function parseInventoryArgs(argv) {
  const check = argv.includes("--check");
  const json = argv.includes("--json");
  const rest = argv.filter((arg) => arg !== "--check" && arg !== "--json");
  if (rest.length !== 0) throw new Error("usage: rename-literal-inventory.mjs [--check] [--json]");
  return { check, json };
}

if (isMainModule(import.meta.url)) {
  try {
    const args = parseInventoryArgs(process.argv.slice(2));
    const inventory = await generateRenameLiteralInventory();
    if (args.check) assertClassifiedInventory(inventory);
    if (args.json || !args.check) {
      console.log(JSON.stringify(inventory, null, 2));
    } else {
      console.log(
        `rename literal inventory: ${inventory.matches.length} classified matches across ${inventory.files_scanned} files`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
