// CI bot: on merge to main, regenerate the committed plugin bundle and — only if that
// regeneration actually changed something — bump the plugin version in BOTH manifests
// (`.claude-plugin/marketplace.json`, `plugins/agentstate-lite/.codex-plugin/plugin.json`) and
// commit artifact+manifests together. This retires the old convention (CLAUDE.md, pre-2026-07-09)
// where every PR hand-bumped both manifests and hand-rebuilt the ~4.4MB committed bundle — a tax
// that grew O(n^2) in concurrent PRs (each crossing cost a rebase + re-bump + regen + full gate
// re-run).
//
// BUILD-IDENTITY UPDATE (version-build-identity): the runtime bundle embeds the CLI package
// identity, exact checkout commit/dirty fact, and `marketplace-legacy` flavor. Drift/version
// decisions normalize ONLY the baked source commit/dirty fields. If regeneration differs only by
// those facts, this script restores the prior artifact before returning; provenance-only commits
// therefore do not rewrite ~3MB or invalidate the version-keyed marketplace cache.
//
// LOOP SAFETY is structural: rebuilding a bot commit changes only the normalized source stamp, so
// the prior artifact is restored and the run no-ops. The workflow actor check is a cheap
// optimization, not a correctness dependency; PAT/app actors may retrigger safely.
//
// Usage: npm run ci:version-bundle
// Exits 0 whether or not anything changed; exits 1 on any unexpected failure (regen error,
// malformed manifest, etc.) — the workflow decides whether to commit by checking `git status`
// after this script runs, not by parsing its output.
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve, relative, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { currentSourceFacts } from "../packages/cli/scripts/build-bundle.mjs";
import { bundleContentEqual } from "../packages/cli/scripts/bundle-identity-comparison.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// scripts/ -> repo root
const repoRoot = resolve(here, "..");
const cliDir = resolve(repoRoot, "packages/cli");

export const REAL_PATHS = {
  marketplace: resolve(repoRoot, ".claude-plugin/marketplace.json"),
  pluginJson: resolve(repoRoot, "plugins/agentstate-lite/.codex-plugin/plugin.json"),
  skillMd: resolve(repoRoot, "plugins/agentstate-lite/skills/agentstate-lite/SKILL.md"),
  bundleMjs: resolve(repoRoot, "plugins/agentstate-lite/skills/agentstate-lite/scripts/agentstate-lite.mjs"),
  // The skill projection of the distribution resource inventory, synced by
  // `gen-skill.mjs --target skill` alongside SKILL.md. LOAD-BEARING: without this in the
  // before/after diff below, a references-only change (a new manifest entry, an edited source
  // file it points at) would never register in `changed` — the version would silently never
  // bump on a references-only commit, even though the workflow's own `git status` would still see
  // (and commit) the regenerated files, decoupling the shipped version from what it now contains.
  referencesDir: resolve(repoRoot, "plugins/agentstate-lite/skills/agentstate-lite/references"),
};

// ---------------------------------------------------------------------------------------------
// Pure semver helpers — no I/O, easy to unit test directly.
// ---------------------------------------------------------------------------------------------

/** Parse a strict `major.minor.patch` (non-negative integers, no pre-release/build suffix). */
export function parseSemver(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`not a plain major.minor.patch version: ${JSON.stringify(version)}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatSemver({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

/** Patch-increment: 1.0.24 -> 1.0.25. This repo's numbering convention is patch-only (CLAUDE.md). */
export function bumpPatch(version) {
  const v = parseSemver(version);
  return formatSemver({ ...v, patch: v.patch + 1 });
}

/** The semantically greater of two versions (equal → returns `a`). Self-heals a rare drift between the two manifests (e.g. a stale hand-bump on only one of them) without ever picking a LOWER base to bump from. */
export function higherVersion(a, b) {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (va.major !== vb.major) return va.major > vb.major ? a : b;
  if (va.minor !== vb.minor) return va.minor > vb.minor ? a : b;
  return va.patch >= vb.patch ? a : b;
}

// ---------------------------------------------------------------------------------------------
// Manifest text surgery — a targeted single-field regex replace, NOT JSON.parse + re-stringify.
// Re-stringifying would reformat unrelated content (e.g. marketplace.json's inline
// `"author": { "name": "Holaxis" }`), turning a version bump into a noisy whole-file diff.
// ---------------------------------------------------------------------------------------------

const VERSION_FIELD_RE = /"version"\s*:\s*"([^"]+)"/;

/** Extract the sole `"version": "..."` field's value. Throws if there isn't EXACTLY one match — a defensive guard against a manifest shape change (e.g. a second plugin entry) silently making this a no-op or ambiguous. */
export function extractVersion(manifestText, label) {
  const matches = manifestText.match(new RegExp(VERSION_FIELD_RE, "g")) ?? [];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one "version" field in ${label}, found ${matches.length}`);
  }
  return VERSION_FIELD_RE.exec(manifestText)[1];
}

/** Replace the sole `"version": "..."` field's value, byte-identical everywhere else. */
export function replaceVersion(manifestText, newVersion, label) {
  extractVersion(manifestText, label); // validate exactly-one before mutating
  return manifestText.replace(VERSION_FIELD_RE, `"version": "${newVersion}"`);
}

// ---------------------------------------------------------------------------------------------
// Regeneration — the real, repo-tied rebuild: the ONE committed-bundle writer
// (packages/cli/scripts/build-plugin-bundle.mjs — the dev build, build.mjs, deliberately never
// writes the committed path) plus a `gen-skill.mjs --target skill` regen.
// ---------------------------------------------------------------------------------------------

export async function regenerateArtifacts(_paths, { source } = {}) {
  const { buildPluginBundle } = await import("../packages/cli/scripts/build-plugin-bundle.mjs");

  await buildPluginBundle({ source });

  execFileSync(
    process.execPath,
    [resolve(cliDir, "scripts/gen-skill.mjs"), "--target", "skill"],
    { stdio: "inherit" },
  );
}

// ---------------------------------------------------------------------------------------------
// Orchestrator.
// ---------------------------------------------------------------------------------------------

async function readBytesOrNull(path) {
  try {
    return await readFile(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function buffersEqual(a, b) {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

/** All files under `dir`, recursively, as absolute paths. Empty if `dir` doesn't exist. */
async function listFilesRecursive(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full)));
    else out.push(full);
  }
  return out;
}

/**
 * Snapshot every file under `dir` as a `relative/posix/path -> bytes` Map, or `null` if `dir`
 * doesn't exist at all — `null` (not an empty Map) is what lets an absent -> present transition
 * (the `references/` folder appearing for the first time) register as a change below, the same
 * way `readBytesOrNull` distinguishes a missing single file from an empty one.
 */
async function snapshotDir(dir) {
  try {
    await stat(dir);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const snapshot = new Map();
  for (const file of await listFilesRecursive(dir)) {
    const rel = relative(dir, file).split(sep).join("/");
    snapshot.set(rel, await readFile(file));
  }
  return snapshot;
}

function snapshotsEqual(a, b) {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  for (const [rel, bytes] of a) {
    const other = b.get(rel);
    if (!other || !bytes.equals(other)) return false;
  }
  return true;
}

/**
 * Regenerate the committed skill artifacts and, only if that changed something, bump the patch
 * version in both manifests. `regenerate` and `paths` are overridable for tests (production
 * always uses the real regen against the real repo paths); tests pass BOTH together as a matched
 * pair, never the real regen against fake paths (gen-skill.mjs always writes to the real
 * committed SKILL.md location, so mixing the two would silently target the wrong file).
 */
export async function run({
  regenerate = regenerateArtifacts,
  paths = REAL_PATHS,
  source = currentSourceFacts(),
} = {}) {
  const beforeSkillMd = await readBytesOrNull(paths.skillMd);
  const beforeBundle = await readBytesOrNull(paths.bundleMjs);
  const beforeReferences = await snapshotDir(paths.referencesDir);

  // `source` is an explicit snapshot for the complete generation attempt. In production the
  // plugin writer derives it immediately before building. Tests that perform two regenerations
  // against one logical checkout pass the same snapshot both times; otherwise the first run's
  // generated tracked outputs would redefine the second run's dirty evidence.
  await regenerate(paths, { source });

  const afterSkillMd = await readBytesOrNull(paths.skillMd);
  const afterBundle = await readBytesOrNull(paths.bundleMjs);
  const afterReferences = await snapshotDir(paths.referencesDir);

  const skillMdChanged = !buffersEqual(beforeSkillMd, afterSkillMd);
  const bundleBytesChanged = !buffersEqual(beforeBundle, afterBundle);
  const bundleChanged = !bundleContentEqual(beforeBundle, afterBundle);
  const referencesChanged = !snapshotsEqual(beforeReferences, afterReferences);
  if (bundleBytesChanged && !bundleChanged && beforeBundle !== null) {
    // The writer stamped a different checkout/dirty fact onto otherwise identical content. Keep
    // the already-committed runtime artifact (and its honest provenance) so the workflow's later
    // `git status` check cannot turn source-only churn into a commit or plugin-version bump.
    await writeFile(paths.bundleMjs, beforeBundle);
  }
  const changed = skillMdChanged || bundleChanged || referencesChanged;

  if (!changed) {
    console.log(
      "ci-version-bundle: no-op — regenerated artifacts already match committed bytes; version left unchanged.",
    );
    return { changed: false };
  }

  const marketplaceText = await readFile(paths.marketplace, "utf8");
  const pluginText = await readFile(paths.pluginJson, "utf8");
  const marketplaceVersion = extractVersion(marketplaceText, paths.marketplace);
  const pluginVersion = extractVersion(pluginText, paths.pluginJson);
  const baseVersion = higherVersion(marketplaceVersion, pluginVersion);
  const newVersion = bumpPatch(baseVersion);

  await writeFile(paths.marketplace, replaceVersion(marketplaceText, newVersion, paths.marketplace));
  await writeFile(paths.pluginJson, replaceVersion(pluginText, newVersion, paths.pluginJson));

  console.log(
    `ci-version-bundle: artifact changed (SKILL.md=${skillMdChanged}, bundle=${bundleChanged}, ` +
      `references=${referencesChanged}); version ${baseVersion} -> ${newVersion}`,
  );
  return { changed: true, baseVersion, newVersion, skillMdChanged, bundleChanged, referencesChanged };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await run();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
}
