// `superbee skill install|status|uninstall` — install this distribution's generated Agent Skill
// (SKILL.md + references/) into host skill folders.
//
// ASSET SOURCE: the running distribution's own package root (`dirname(executable)/..` → SKILL.md +
// references/) — the npm layout (`<pkg>/dist/superbee.mjs`) and a dev/repo build
// (`packages/cli/dist/…`) both resolve naturally.
//
// TARGETS: Claude Code + Codex through the ONE HOST_CONFIG_ROOTS authority (the same env-var
// semantics `hook install --scope user` uses). OpenCode reuses the Claude-compatible project path
// and the documented global ~/.claude path. Those are one physical target unless Claude Code has
// been explicitly relocated, in which case each host needs its own managed copy. New installs use
// skills/superbee; skills/aslite is inspected only for migration, status, and uninstall.
//
// DESTRUCTIVE-WRITE DISCIPLINE (same boundary as hook.ts): install writes a manifest
// (`.aslite-skill.json`: file list + package version + installed-by) inside the canonical folder
// and REFUSES a canonical folder it does not manage (no manifest, a malformed manifest, or files
// present that no manifest names). A foreign legacy folder coexists untouched. Uninstall removes
// EXACTLY the manifested files + the manifest, then only empty directories. Reinstall is
// idempotent/convergent: byte-stable, exit 0, changed:false when already current. Every write is
// same-directory temp + rename (atomicWriteFileSync).
//
// The MANIFEST IS WRITTEN FIRST on install — and an UPGRADE writes a TRANSITIONAL manifest
// (files = union of old and new) before touching assets, converges assets, removes obsolete old
// files, then writes the FINAL manifest (= exactly the asset set) — so every reachable
// interruption point leaves a MANAGED state whose manifest owns everything on disk: `status`
// reports stale, a re-run install converges over it (exit 0), and uninstall removes whatever
// manifested files exist. A kill inside atomicWriteFileSync's write→rename window strands a
// `<file>.tmp-<pid>-…` orphan; one whose base name we own is MANAGED DEBRIS — ignored by the
// extras scan and swept by the mutating verbs — while a temp-patterned name with a foreign base
// stays foreign — and ownership must be ESTABLISHED: without a valid manifest, the only swept
// base is the reserved manifest filename itself, so a refusal over a foreign folder deletes
// nothing of that folder's own content. Mutating verbs perform a complete READ-ONLY preflight and
// sweep eligible debris only after the target is accepted, so every refusal is byte-preserving.
// The one unmanaged shape (files, no
// manifest) can only be foreign, and stays a refusal. A target that exists but is NOT a real directory — a symlink above all — is refused by
// every verb before any walk: destructive operations never follow a link AT the target or in
// manifested entries (ancestor symlinks, e.g. a stowed ~/.claude, are deliberately honored — the
// guard is leaf-only), and manifested files that ARE links are replaced on install / unlinked
// (never followed) on removal. A DIRECTORY squatting at a manifested path is handled type-aware:
// an empty one converges/uninstalls (rmdir); a non-empty one is a structured refusal — this tool
// never recursive-deletes content no manifest names.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  cliInvocation,
  collapseHomeDirectory,
  currentExecutableRealPath,
} from "../invocation.js";
import { atomicWriteFileSync } from "../private-config-write.js";
import { render, resolveMode } from "../output.js";
import { CliError } from "../errors.js";
import { parseSelectorOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { HOST_CONFIG_ROOTS, resolveHostConfigRoot } from "../host-config.js";
import { buildIdentityEnvelope, cliVersion } from "../build-identity.js";
import {
  SKILL_INSTALLER,
  SKILL_MANIFEST_SCHEMA,
  classifySkillCompatibility,
  isSafeManifestEntry,
  parseOwnedSkillManifest,
  type OwnedSkillManifest,
  type SkillCompatibility,
  type SkillManifestV2,
  type SkillSourceIdentity,
  type SkillState,
} from "../skill-compatibility.js";
import {
  resolvePersistentInstallAuthority,
  type PersistentInstallAuthority,
} from "../install-authority.js";
import { normalizeInstallScope, type InstallScope } from "../install-scope.js";
import { integrationChangeReceipt, type IntegrationHost } from "../integration-receipt.js";

export { isSafeManifestEntry };

export const SKILL_USAGE = `superbee skill — install this package's Agent Skill into host skill folders

Usage:
  superbee skill install   [--scope project|user]
  superbee skill status    [--scope project|user]
  superbee skill uninstall [--scope project|user]

Installs (or removes) the generated Agent Skill shipped with this npm package — SKILL.md plus its
references/ folder — for Claude Code, Codex, and OpenCode. OpenCode shares the Claude-compatible
target unless Claude Code uses a relocated config root, so duplicate bytes are not written in the
normal case. Its separate SessionStart integration is the plugin written by \`hook install\`.

Install writes a manifest (${"`"}.aslite-skill.json${"`"}) inside the canonical superbee folder.
An owned old-only aslite folder migrates atomically; an unmanaged legacy folder coexists untouched;
an unmanaged canonical folder or dual owned folders are refused. Uninstall independently removes
each proven-owned canonical or legacy folder and refuses foreign bytes. Reinstall is idempotent.
\`status\` reports canonical and legacy path/state per host: absent | unmanaged | installed | stale
(byte-compare against this executable's own shipped assets). Codex host
discovery is verified at USER scope (codex 0.144.x) — project-scope placement follows each
host's documented convention.

Persistent install from npm-package bytes requires a durable global install
(\`npm install -g superbee\`); transient npx/npm-exec cache paths fail closed before either
host folder is changed. npx remains supported for read-only, trial, and bootstrap commands.

Options:
  --scope project   Write to the CURRENT project (default): .claude/skills/superbee/, .codex/skills/superbee/
  --scope user      Write to each host's documented user path; OpenCode uses ~/.claude/skills/superbee/
  --json            Emit compact JSON instead of TOON
  -h, --help        Show this help

The former spelling --scope global remains accepted as an alias for --scope user.
`;

/** The installed skill folder name under each host's `skills/` directory. */
export const SKILL_DIR_NAME = "superbee";
/** Historical install folder retained only as a migration/uninstall input. */
export const LEGACY_SKILL_DIR_NAME = "aslite";
/** The install-manifest filename written inside the target folder. */
export const SKILL_MANIFEST_FILENAME = ".aslite-skill.json";

/** The running distribution's skill assets: package root, version, and relative file list. */
export interface SkillAssets {
  root: string;
  version: string;
  compatibilityContract: number | null;
  sourceIdentity: SkillSourceIdentity;
  /** Sorted, POSIX-relative to `root`: `SKILL.md` plus every file under `references/`. */
  files: string[];
  fileSha256: Record<string, string>;
}

export type SkillManifest = OwnedSkillManifest;

/** All files under `dir`, recursively, POSIX-relative (empty when `dir` does not exist). */
function listFilesRelative(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFilesRelative(join(dir, entry.name), relativePath));
    else out.push(relativePath);
  }
  return out.sort();
}

/**
 * Resolve the running distribution's skill assets, or throw. `executable` is injectable for
 * tests; production resolves the real running bundle.
 */
export function resolveSkillAssets(executable?: string): SkillAssets {
  const exe = executable ?? currentExecutableRealPath();
  if (exe === undefined) {
    throw new CliError("RUNTIME", "cannot resolve the running executable's own path", {
      help: `${cliInvocation()} skill install --scope project|user`,
    });
  }
  const root = dirname(dirname(exe));
  const skillMd = join(root, "SKILL.md");
  const referencesDir = join(root, "references");
  if (!existsSync(skillMd) || !existsSync(referencesDir)) {
    throw new CliError(
      "RUNTIME",
      `the running distribution carries no skill assets (expected SKILL.md + references/ at ${collapseHomeDirectory(root)})`,
      { help: "run the npm-installed (or repo-built) CLI, whose package root ships both" },
    );
  }
  const files = ["SKILL.md", ...listFilesRelative(referencesDir).map((f) => `references/${f}`)].sort();
  const identity = buildIdentityEnvelope({
    executablePath: () => exe,
    managedBin: () => undefined,
  });
  const fileSha256 = Object.fromEntries(
    files.map((relativePath) => [
      relativePath,
      `sha256:${createHash("sha256").update(readFileSync(join(root, relativePath))).digest("hex")}`,
    ]),
  );
  return {
    root,
    version: cliVersion(),
    compatibilityContract: identity.identity.compatibility_contracts.skill,
    sourceIdentity: {
      release_version: identity.identity.package.version,
      source_commit: identity.identity.source.commit,
      artifact_channel: identity.identity.artifact.channel,
      artifact_sha256: identity.identity.artifact.sha256,
    },
    files,
    fileSha256,
  };
}

/** The per-host canonical target folders (the `skills/superbee` dir itself). */
export interface SkillTargets {
  claude: string;
  codex: string;
  opencode: string;
}

function skillTargetsForName(
  dirName: string,
  scope: InstallScope,
  deps: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv; platform?: string } = {},
): SkillTargets {
  const platform = deps.platform ?? process.platform;
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (scope === "project") {
    const cwd = deps.cwd ?? process.cwd();
    return {
      claude: paths.join(cwd, ".claude", "skills", dirName),
      codex: paths.join(cwd, ".codex", "skills", dirName),
      opencode: paths.join(cwd, ".claude", "skills", dirName),
    };
  }
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  return {
    claude: paths.join(resolveHostConfigRoot(HOST_CONFIG_ROOTS.claude, home, env, platform), "skills", dirName),
    codex: paths.join(resolveHostConfigRoot(HOST_CONFIG_ROOTS.codex, home, env, platform), "skills", dirName),
    // OpenCode documents this literal Claude-compatible global path. It does not document
    // CLAUDE_CONFIG_DIR as a discovery authority.
    opencode: paths.join(home, ".claude", "skills", dirName),
  };
}

export function skillTargets(
  scope: InstallScope,
  deps: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv; platform?: string } = {},
): SkillTargets {
  return skillTargetsForName(SKILL_DIR_NAME, scope, deps);
}

export function legacySkillTargets(
  scope: InstallScope,
  deps: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv; platform?: string } = {},
): SkillTargets {
  return skillTargetsForName(LEGACY_SKILL_DIR_NAME, scope, deps);
}

/**
 * Refusal reason when the target path exists but is not a REAL directory — a symlink above all
 * (destructive/creative walks must never follow a link; a dangling link counts), or a plain file.
 * `undefined` means absent or a real directory: safe to proceed.
 */
function nonDirectoryRefusal(dir: string): string | undefined {
  let stats;
  try {
    stats = lstatSync(dir);
  } catch {
    return undefined; // absent — fine
  }
  if (stats.isSymbolicLink()) return "target is a symlink — refusing destructive operations through links";
  if (!stats.isDirectory()) return "target exists and is not a directory";
  return undefined;
}

/** True when the path itself is a symlink (never follows; false when absent). */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** atomicWriteFileSync's temp naming: `<base>.tmp-<pid>-<time36>-<rand36>`. Captures the base. */
const TEMP_DEBRIS_RE = /^(.+)\.tmp-\d+-[a-z0-9]+-[a-z0-9]+$/;

/**
 * MANAGED DEBRIS: a relative path matching OUR atomic-write temp pattern whose stripped base is a
 * path we own — the stranding a kill inside the write→rename window leaves. Scoped tightly on
 * purpose: a temp-patterned name with a foreign base stays foreign, so the extras refusal is not
 * weakened.
 */
function isManagedDebris(relativePath: string, owned: Set<string>): boolean {
  const match = TEMP_DEBRIS_RE.exec(relativePath);
  return match !== null && owned.has(match[1]!);
}

/**
 * The owned-path set debris recognition checks bases against. OWNERSHIP MUST BE ESTABLISHED: only
 * a VALID manifest extends ownership to manifested/asset file names. Without one (absent or
 * malformed — a folder the verbs will refuse as unmanaged), the ONLY owned base is the reserved
 * manifest filename itself: its tmp is unambiguously ours (needed for the first-install-kill
 * recovery shape), while an asset-named tmp in a foreign folder could shadow foreign data and
 * must survive the refusal untouched.
 */
function sweepOwnership(
  manifest: SkillManifest | undefined | null,
  assetFiles: readonly string[],
): Set<string> {
  if (manifest === undefined || manifest === null) return new Set([SKILL_MANIFEST_FILENAME]);
  return new Set([...manifest.files, ...assetFiles, SKILL_MANIFEST_FILENAME]);
}

/** Delete managed debris from `dir` (mutating verbs only — status merely ignores it). */
function sweepManagedDebris(dir: string, owned: Set<string>): boolean {
  let removed = false;
  for (const relativePath of listFilesRelative(dir)) {
    if (isManagedDebris(relativePath, owned)) {
      rmSync(join(dir, ...relativePath.split("/")), { force: true });
      removed = true;
    }
  }
  return removed;
}

/** Read + validate ownership. `undefined` when absent; `null` when ownership is not proven. */
function readManifest(dir: string): SkillManifest | undefined | null {
  const manifestPath = join(dir, SKILL_MANIFEST_FILENAME);
  let manifestStats;
  try {
    manifestStats = lstatSync(manifestPath);
  } catch {
    return undefined;
  }
  if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) return null;
  try {
    return parseOwnedSkillManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch {
    return null;
  }
}

/** Legacy manifest-first transition: it owns union files without claiming not-yet-true digests. */
function transitionalManifestContent(assets: SkillAssets, files: readonly string[]): string {
  const manifest = {
    package: "superbee",
    version: assets.version,
    installed_by: SKILL_INSTALLER,
    files: [...files],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function manifestContent(assets: SkillAssets): string {
  if (assets.compatibilityContract === null) {
    throw new CliError("RUNTIME", "running build has no skill compatibility contract", {
      help: `${cliInvocation()} version --json`,
    });
  }
  const manifest: Omit<SkillManifestV2, "kind" | "receipt_valid"> = {
    schema: SKILL_MANIFEST_SCHEMA,
    package: "superbee",
    version: assets.version,
    installed_by: SKILL_INSTALLER,
    compatibility_contract: assets.compatibilityContract,
    source_identity: assets.sourceIdentity,
    files: [...assets.files],
    file_sha256: Object.fromEntries(assets.files.map((file) => [file, assets.fileSha256[file]!])),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Files in `dir` that neither the manifest/new asset set nor eligible managed debris accounts for. */
function unmanagedExtras(dir: string, managed: Set<string>): string[] {
  return listFilesRelative(dir).filter(
    (f) => f !== SKILL_MANIFEST_FILENAME && !managed.has(f) && !isManagedDebris(f, managed),
  );
}

/** True when the path is a directory (lstat — a symlink to a directory is NOT; false when absent). */
function isDirectory(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * NON-EMPTY directories squatting at owned paths. Refused up front by both mutating verbs —
 * converging would require a recursive delete of content no manifest names, which this tool
 * never performs. An EMPTY directory is not an obstruction: it is converged (rmdir + write) or
 * uninstalled (rmdir) type-aware, crash-free.
 */
function directoryObstructions(dir: string, ownedFiles: Iterable<string>): string[] {
  const obstructed: string[] = [];
  for (const relativePath of ownedFiles) {
    const p = join(dir, ...relativePath.split("/"));
    if (isDirectory(p) && readdirSync(p).length > 0) obstructed.push(relativePath);
  }
  return obstructed;
}

function directoryObstructionRefusal(obstructed: string[]): { ok: false; reason: string } {
  return {
    ok: false,
    reason: `manifested path(s) are directories with contents: ${obstructed.join(", ")} — remove them manually; nothing deleted`,
  };
}

/** Remove one managed path: files/links unlink; a (pre-scanned EMPTY) directory rmdirs. Absent is fine. */
function removeManagedPath(p: string): void {
  if (isDirectory(p)) rmdirSync(p);
  else rmSync(p, { force: true });
}

type InstallResult = { ok: true; changed: boolean } | { ok: false; reason: string };
type InstallPreflight =
  | { ok: true; manifest: SkillManifest | undefined; ownedForSweep: Set<string> }
  | { ok: false; reason: string };

/** Complete read-only install preflight for one target folder. */
function preflightInstallIntoDir(dir: string, assets: SkillAssets): InstallPreflight {
  const notDir = nonDirectoryRefusal(dir);
  if (notDir !== undefined) return { ok: false, reason: notDir };
  const manifest = readManifest(dir);
  const ownedForSweep = sweepOwnership(manifest, assets.files);
  if (manifest === null) {
    return { ok: false, reason: `${SKILL_MANIFEST_FILENAME} does not prove ownership - refusing to write over a folder in an unknown state` };
  }
  if (existsSync(dir)) {
    const logicalFiles = listFilesRelative(dir).filter((file) => !isManagedDebris(file, ownedForSweep));
    if (manifest === undefined && logicalFiles.length > 0) {
      return { ok: false, reason: `folder exists with no ${SKILL_MANIFEST_FILENAME} manifest — not managed by this tool` };
    }
    if (manifest !== undefined) {
      if (
        manifest.compatibility_contract !== null &&
        assets.compatibilityContract !== null &&
        manifest.compatibility_contract > assets.compatibilityContract
      ) {
        return {
          ok: false,
          reason: `installed skill uses newer compatibility contract ${manifest.compatibility_contract}; running CLI contract ${assets.compatibilityContract} will not downgrade it`,
        };
      }
      const managed = new Set([...manifest.files, ...assets.files, SKILL_MANIFEST_FILENAME]);
      const obstructed = directoryObstructions(dir, managed);
      if (obstructed.length > 0) return directoryObstructionRefusal(obstructed);
      const extras = unmanagedExtras(dir, managed);
      if (extras.length > 0) {
        return {
          ok: false,
          reason: `folder holds file(s) the manifest does not name: ${extras.join(", ")} — remove them or delete the folder, then re-run`,
        };
      }
    }
  }
  return { ok: true, manifest, ownedForSweep };
}

/** Convergent install into one target folder after its read-only preflight. */
function installIntoDir(
  dir: string,
  assets: SkillAssets,
  prepared?: Extract<InstallPreflight, { ok: true }>,
): InstallResult {
  const preflight = prepared ?? preflightInstallIntoDir(dir, assets);
  if (!preflight.ok) return preflight;
  const { manifest, ownedForSweep } = preflight;
  // No refused target has been touched. Debris cleanup starts only after the entire target passes
  // the read-only ownership/extras/obstruction/no-downgrade preflight.
  const debrisRemoved = sweepManagedDebris(dir, ownedForSweep);
  let changed = debrisRemoved;
  // Manifest FIRST — and on an UPGRADE over an existing valid manifest, a TRANSITIONAL manifest
  // first: files = union(old manifested files, new asset files). Every interruption point then
  // leaves a manifest that OWNS everything on disk (old survivors, partial new assets, or both),
  // so the extras refusal can never fire on our own intermediate state; a re-run converges and
  // uninstall removes only owned files. The FINAL manifest (= exactly the asset set) lands only
  // after assets are converged AND obsolete old files are removed.
  const manifestPath = join(dir, SKILL_MANIFEST_FILENAME);
  const finalManifest = manifestContent(assets);
  const unionFiles = [...new Set([...(manifest?.files ?? []), ...assets.files])].sort();
  const transitionalManifest = transitionalManifestContent(assets, unionFiles);
  const writeManifest = (content: string): void => {
    // atomicWriteFileSync writes THROUGH a symlinked destination (right for user-owned settings);
    // skill-folder contents are wholly TOOL-owned, so a link here is unmanaged drift — converge by
    // REPLACING the link with a real file: unlink the link itself first (never its target).
    if (isSymlink(manifestPath)) rmSync(manifestPath, { force: true });
    atomicWriteFileSync(manifestPath, content);
    changed = true;
  };
  const currentManifest =
    !isSymlink(manifestPath) && existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : undefined;
  // Steady state (current == final) and resumed-upgrade state (current == transitional) skip this
  // write; anything else (fresh install, v1 manifest, symlinked/hand-edited manifest) gets the
  // transitional content, which for a fresh install IS the final content (union == asset set).
  if (currentManifest !== transitionalManifest && currentManifest !== finalManifest) {
    writeManifest(transitionalManifest);
  }
  const wanted = new Set(assets.files);
  for (const relativePath of assets.files) {
    const bytes = readFileSync(join(assets.root, relativePath));
    const destPath = join(dir, ...relativePath.split("/"));
    // A dest that is a LINK is always replaced with a real file (same rationale as the manifest);
    // a dest that is a directory is EMPTY here (non-empty ones were refused above) and converges.
    const destIsLink = isSymlink(destPath);
    const destIsDir = !destIsLink && isDirectory(destPath);
    const current = !destIsLink && !destIsDir && existsSync(destPath) ? readFileSync(destPath) : undefined;
    if (destIsLink || destIsDir || current === undefined || !bytes.equals(current)) {
      if (destIsLink) rmSync(destPath, { force: true });
      if (destIsDir) rmdirSync(destPath);
      atomicWriteFileSync(destPath, bytes);
      changed = true;
    }
  }
  // A previously manifested file no longer shipped converges away (type-aware: an empty dir rmdirs).
  for (const relativePath of manifest?.files ?? []) {
    if (!wanted.has(relativePath)) {
      removeManagedPath(join(dir, ...relativePath.split("/")));
      changed = true;
    }
  }
  // FINAL manifest: exactly the asset set — written only now that the disk matches it.
  const manifestAfterConverge = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : undefined;
  if (manifestAfterConverge !== finalManifest) {
    writeManifest(finalManifest);
  }
  removeEmptyDirectories(dir, false);
  return { ok: true, changed };
}

/** Remove empty directories bottom-up under `dir`; when `removeSelf`, also `dir` if empty. */
function removeEmptyDirectories(dir: string, removeSelf: boolean): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(join(dir, entry.name), true);
  }
  if (removeSelf && readdirSync(dir).length === 0) rmdirSync(dir);
}

type UninstallResult = { ok: true; changed: boolean } | { ok: false; reason: string };
type UninstallPreflight =
  | { ok: true; manifest: SkillManifest | undefined; ownedForSweep: Set<string>; changed: boolean }
  | { ok: false; reason: string };

/**
 * Complete read-only uninstall preflight for one path. A successful absent path may still carry
 * only a reserved manifest temp file, which the mutation phase is allowed to sweep.
 */
function preflightUninstallFromDir(dir: string): UninstallPreflight {
  const notDir = nonDirectoryRefusal(dir);
  if (notDir !== undefined) return { ok: false, reason: notDir };
  if (!existsSync(dir)) {
    return { ok: true, manifest: undefined, ownedForSweep: new Set([SKILL_MANIFEST_FILENAME]), changed: false };
  }
  const manifest = readManifest(dir);
  const ownedForSweep = sweepOwnership(manifest, []);
  if (manifest === undefined) {
    // A folder left empty (a first-install kill stranded only OUR manifest tmp, or a pre-existing
    // empty dir) holds nothing foreign.
    const logicalFiles = listFilesRelative(dir).filter((file) => !isManagedDebris(file, ownedForSweep));
    if (logicalFiles.length === 0) {
      const hasDebris = listFilesRelative(dir).some((file) => isManagedDebris(file, ownedForSweep));
      return { ok: true, manifest: undefined, ownedForSweep, changed: hasDebris };
    }
    return { ok: false, reason: `folder exists with no ${SKILL_MANIFEST_FILENAME} manifest — not managed by this tool, nothing deleted` };
  }
  if (manifest === null) {
    return { ok: false, reason: `${SKILL_MANIFEST_FILENAME} does not prove ownership — refusing to delete anything from a folder in an unknown state` };
  }
  const managed = new Set([...manifest.files, SKILL_MANIFEST_FILENAME]);
  const obstructed = directoryObstructions(dir, managed);
  if (obstructed.length > 0) return directoryObstructionRefusal(obstructed);
  const extras = unmanagedExtras(dir, managed);
  if (extras.length > 0) {
    return {
      ok: false,
      reason: `folder holds file(s) the manifest does not name: ${extras.join(", ")} — nothing deleted`,
    };
  }
  return { ok: true, manifest, ownedForSweep, changed: true };
}

/** Remove exactly the preflight-proven files and manifest, skipping missing partial-install files. */
function uninstallFromDir(
  dir: string,
  prepared?: Extract<UninstallPreflight, { ok: true }>,
): UninstallResult {
  const preflight = prepared ?? preflightUninstallFromDir(dir);
  if (!preflight.ok) return preflight;
  const { manifest, ownedForSweep } = preflight;
  // Sweep only after the whole target has passed the no-delete preflight.
  const debrisRemoved = sweepManagedDebris(dir, ownedForSweep);
  if (manifest === undefined) {
    if (debrisRemoved) removeEmptyDirectories(dir, true);
    return { ok: true, changed: debrisRemoved };
  }
  for (const relativePath of manifest.files) {
    // Type-aware: a symlinked entry unlinks the link itself (never its target); an EMPTY
    // directory (pre-scanned above) rmdirs; absent files skip without a throw.
    removeManagedPath(join(dir, ...relativePath.split("/")));
  }
  rmSync(join(dir, SKILL_MANIFEST_FILENAME), { force: true });
  removeEmptyDirectories(dir, true);
  return { ok: true, changed: preflight.changed };
}

export type { SkillState } from "../skill-compatibility.js";

/**
 * Read-only per-folder state: byte-compare the manifested install against the running assets.
 * A target that is not a real directory (a symlink above all) reports `unmanaged` — the same
 * honesty install/uninstall enforce as a refusal. A manifest whose files are missing, partial,
 * hand-edited, or symlinked is managed-STALE (install converges over it), never unmanaged.
 * Managed temp-write debris is IGNORED (status stays read-only; the mutating verbs sweep it).
 */
export function skillStatusForDir(
  dir: string,
  assets: SkillAssets,
  installCommand = `${cliInvocation()} skill install --scope project`,
): { state: SkillState; version?: string; compatibility: SkillCompatibility } {
  const classify = (
    target: "absent" | "unmanaged" | "owned",
    manifest: OwnedSkillManifest | null,
    assetsMatch: boolean,
    receiptDigestsMatch: boolean,
  ) =>
    classifySkillCompatibility({
      target,
      manifest,
      running_contract: assets.compatibilityContract,
      assets_match: assetsMatch,
      receipt_digests_match: receiptDigestsMatch,
      install_command: installCommand,
    });

  if (nonDirectoryRefusal(dir) !== undefined) {
    return classify("unmanaged", null, false, false);
  }
  if (!existsSync(dir)) return classify("absent", null, false, false);
  const manifest = readManifest(dir);
  const owned = sweepOwnership(manifest, assets.files);
  const files = listFilesRelative(dir).filter((f) => !isManagedDebris(f, owned));
  if (files.length === 0) return classify("absent", null, false, false);
  if (manifest === undefined || manifest === null) return classify("unmanaged", null, false, false);
  const version = manifest.version;
  const onDisk = files.filter((f) => f !== SKILL_MANIFEST_FILENAME);
  const sameSet =
    onDisk.length === assets.files.length && onDisk.every((f, i) => f === assets.files[i]);
  let assetsMatch = sameSet;
  let receiptDigestsMatch = manifest.kind === "legacy";
  if (sameSet) {
    receiptDigestsMatch = manifest.kind === "legacy" || (manifest.receipt_valid && manifest.file_sha256 !== null);
    for (const relativePath of assets.files) {
      const installedPath = join(dir, ...relativePath.split("/"));
      let regularFile = false;
      try {
        regularFile = lstatSync(installedPath).isFile();
      } catch {
        regularFile = false;
      }
      if (!regularFile) {
        assetsMatch = false;
        receiptDigestsMatch = false;
        break;
      }
      const installed = readFileSync(installedPath);
      const shipped = readFileSync(join(assets.root, relativePath));
      if (!installed.equals(shipped)) assetsMatch = false;
      if (
        manifest.kind === "v2" &&
        manifest.file_sha256?.[relativePath] !==
          `sha256:${createHash("sha256").update(installed).digest("hex")}`
      ) {
        receiptDigestsMatch = false;
      }
    }
  }
  const classified = classify("owned", manifest, assetsMatch, receiptDigestsMatch);
  return { ...classified, version };
}

type SkillStatusResult = ReturnType<typeof skillStatusForDir>;
type InstallPathInspection =
  | { ok: true; status: SkillStatusResult; preflight: InstallPreflight }
  | { ok: false; reason: string };

type ReadyInstallPathInspection = {
  ok: true;
  status: SkillStatusResult;
  preflight: Extract<InstallPreflight, { ok: true }>;
};

type HostInstallInspection =
  | {
      ok: true;
      canonical: ReadyInstallPathInspection;
      legacy: Extract<InstallPathInspection, { ok: true }>;
      canonicalOwned: boolean;
      legacyOwned: boolean;
    }
  | { ok: false; reason: string };

function inspectInstallPath(dir: string, assets: SkillAssets, installCommand: string): InstallPathInspection {
  try {
    return {
      ok: true,
      status: skillStatusForDir(dir, assets, installCommand),
      preflight: preflightInstallIntoDir(dir, assets),
    };
  } catch (err) {
    return { ok: false, reason: `unexpected error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Exact read-only authority/preflight used by both the installer and passive refresh guidance. */
function inspectHostInstall(
  canonicalDir: string,
  legacyDir: string,
  assets: SkillAssets,
  installCommand: string,
): HostInstallInspection {
  const canonical = inspectInstallPath(canonicalDir, assets, installCommand);
  const legacy = inspectInstallPath(legacyDir, assets, installCommand);
  if (!canonical.ok) return canonical;
  if (!legacy.ok) return legacy;
  if (!canonical.preflight.ok) return canonical.preflight;

  const canonicalOwned = canonical.status.state === "installed" || canonical.status.state === "stale";
  const legacyOwned = legacy.status.state === "installed" || legacy.status.state === "stale";
  if (legacyOwned && !legacy.preflight.ok) return legacy.preflight;
  if (canonicalOwned && legacyOwned) {
    return {
      ok: false,
      reason: `both canonical and legacy folders are owned (${canonicalDir}, ${legacyDir}) - refusing ambiguous convergence`,
    };
  }
  return {
    ok: true,
    canonical: { ...canonical, preflight: canonical.preflight },
    legacy,
    canonicalOwned,
    legacyOwned,
  };
}

type HostInstallResult =
  | { ok: true; changed: boolean; migrated: boolean; legacyState: SkillState }
  | { ok: false; reason: string };

/** Inspect both host paths before mutation, then install or migrate only proven-owned bytes. */
function installForHost(
  canonicalDir: string,
  legacyDir: string,
  assets: SkillAssets,
  installCommand: string,
): HostInstallResult {
  const inspected = inspectHostInstall(canonicalDir, legacyDir, assets, installCommand);
  if (!inspected.ok) return inspected;
  const { canonical, legacy, canonicalOwned, legacyOwned } = inspected;

  if (!canonicalOwned && legacyOwned) {
    // The paths share one host skills directory, so rename is atomic. Any interruption before it
    // leaves the owned legacy install; any interruption after it leaves an owned canonical install.
    sweepManagedDebris(canonicalDir, canonical.preflight.ownedForSweep);
    removeEmptyDirectories(canonicalDir, true);
    renameSync(legacyDir, canonicalDir);
    const result = installIntoDir(canonicalDir, assets);
    return result.ok
      ? { ok: true, changed: true, migrated: true, legacyState: legacy.status.state }
      : result;
  }

  // An unmanaged legacy folder deliberately coexists. It never grants mutation authority and
  // does not prevent a clean canonical install or refresh.
  const result = installIntoDir(canonicalDir, assets, canonical.preflight);
  return result.ok
    ? { ok: true, changed: result.changed, migrated: false, legacyState: legacy.status.state }
    : result;
}

function statusOutput(dir: string, status: SkillStatusResult): Record<string, unknown> {
  return {
    path: collapseHomeDirectory(dir),
    state: status.state,
    ...(status.version ? { version: status.version } : {}),
    compatibility: status.compatibility,
  };
}

export interface SkillHostStatus {
  canonical: SkillStatusResult;
  legacy: SkillStatusResult;
}

export interface SkillStatusInspection {
  version: string;
  targets: SkillTargets;
  legacyTargets: SkillTargets;
  hosts: { claude_code: SkillHostStatus; codex: SkillHostStatus; opencode: SkillHostStatus };
}

/** Read both supported hosts through the same asset and ownership authorities as `skill status`. */
export function inspectSkillStatus(
  scope: InstallScope,
  deps: Pick<SkillDeps, "cwd" | "home" | "env" | "executable"> = {},
): SkillStatusInspection {
  const assets = resolveSkillAssets(deps.executable);
  const targets = skillTargets(scope, deps);
  const legacyTargets = legacySkillTargets(scope, deps);
  const inspect = (canonicalDir: string, legacyDir: string): SkillHostStatus => ({
    canonical: skillStatusForDir(
      canonicalDir,
      assets,
      `${cliInvocation()} skill install --scope ${scope}`,
    ),
    legacy: skillStatusForDir(
      legacyDir,
      assets,
      `${cliInvocation()} skill install --scope ${scope}`,
    ),
  });
  return {
    version: assets.version,
    targets,
    legacyTargets,
    hosts: {
      claude_code: inspect(targets.claude, legacyTargets.claude),
      codex: inspect(targets.codex, legacyTargets.codex),
      opencode: inspect(targets.opencode, legacyTargets.opencode),
    },
  };
}

/** Injectable seams, defaulting to production. */
export interface SkillDeps {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  /** Override the running-executable path the asset source derives from (tests). */
  executable?: string;
  /** Override the one pre-write persistent-install authority (tests). */
  installAuthority?: () => PersistentInstallAuthority;
  stdout?: (s: string) => void;
}

/**
 * Fs-only refresh signal for the session orientation surface. Absent, unmanaged, and conflicted
 * folders stay quiet: setup owns onboarding and conflict diagnosis. Canonical or old-only legacy
 * stale installs surface only when the exact scope command passes every host's install preflight.
 */
export function skillRefreshScopes(
  deps: Pick<SkillDeps, "cwd" | "home" | "env" | "executable"> = {},
): InstallScope[] {
  let assets: SkillAssets;
  try {
    assets = resolveSkillAssets(deps.executable);
  } catch {
    return [];
  }
  const scopes: InstallScope[] = [];
  for (const scope of ["user", "project"] as const) {
    try {
      const targets = skillTargets(scope, deps);
      const legacyTargets = legacySkillTargets(scope, deps);
      const remedy = `${cliInvocation()} skill install --scope ${scope}`;
      const hosts = [
        [targets.claude, legacyTargets.claude],
        [targets.codex, legacyTargets.codex],
        [targets.opencode, legacyTargets.opencode],
      ] as const;
      const distinctHosts = hosts.filter((row, index, rows) =>
        rows.findIndex((candidate) => candidate[0] === row[0] && candidate[1] === row[1]) === index);
      let actionableStale = false;
      let installable = true;
      for (const [canonicalDir, legacyDir] of distinctHosts) {
        const inspected = inspectHostInstall(canonicalDir, legacyDir, assets, remedy);
        if (!inspected.ok) {
          installable = false;
          break;
        }
        actionableStale ||= inspected.canonical.status.state === "stale"
          || inspected.legacy.status.state === "stale";
      }
      if (installable && actionableStale) {
        scopes.push(scope);
      }
    } catch {
      // Session orientation is fail-soft. Explicit `skill status` owns detailed diagnostics.
    }
  }
  return scopes;
}

/**
 * CLI entry: dispatch the positional subcommand (install|status|uninstall). Output is TOON. An
 * unknown/missing subcommand, or an unsupported --scope, is a USAGE error; a refused folder is a
 * structured RUNTIME failure with nothing written or deleted at the refusing target.
 */
export async function skill(argv: string[], deps: SkillDeps = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const { values, selection } = parseSelectorOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          scope: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    "skill",
    (positionals) => {
      const [sub, ...data] = positionals;
      if (sub === undefined) return { kind: "unknown" } as const;
      if (sub !== "install" && sub !== "status" && sub !== "uninstall") return { kind: "unknown", token: sub } as const;
      return {
        kind: "selected",
        leaf: sub === "install"
          ? CLI_LEAVES.skillInstall
          : sub === "status"
            ? CLI_LEAVES.skillStatus
            : CLI_LEAVES.skillUninstall,
        data,
        payload: sub,
      } as const;
    },
  );
  if (selection.kind === "help" || selection.kind === "navigation") {
    stdout(SKILL_USAGE);
    return;
  }

  if (selection.kind === "unknown") {
    throw new CliError(
      "USAGE",
      selection.token === undefined
        ? "skill requires a subcommand (install|status|uninstall)"
        : `unknown skill subcommand: ${selection.token} (expected install|status|uninstall)`,
      { help: `${cliInvocation()} skill install|status|uninstall [--scope project|user]` },
    );
  }
  const sub = selection.payload;

  const requestedScope = values.scope as string | undefined;
  const scope = normalizeInstallScope(requestedScope);
  if (scope === undefined) {
    throw new CliError("USAGE", `unsupported skill scope: ${requestedScope} (expected project|user)`, {
      help: `${cliInvocation()} skill ${sub} --scope project|user`,
    });
  }

  const mode = resolveMode(values);

  if (sub === "status") {
    const inspection = inspectSkillStatus(scope, deps);
    const hosts: Record<string, unknown> = {};
    const rows = [
      ["claude_code", inspection.targets.claude, inspection.legacyTargets.claude, inspection.hosts.claude_code],
      ["codex", inspection.targets.codex, inspection.legacyTargets.codex, inspection.hosts.codex],
      ["opencode", inspection.targets.opencode, inspection.legacyTargets.opencode, inspection.hosts.opencode],
    ] as const;
    for (const [key, canonicalDir, legacyDir, status] of rows) {
      hosts[key] = {
        ...statusOutput(canonicalDir, status.canonical),
        canonical: statusOutput(canonicalDir, status.canonical),
        legacy: statusOutput(legacyDir, status.legacy),
      };
    }
    stdout(render({ skill: { action: "status", scope, version: inspection.version, hosts } }, mode));
    return;
  }

  const targets = skillTargets(scope, deps);
  const legacyTargets = legacySkillTargets(scope, deps);
  const hostDirs: [key: IntegrationHost, canonicalDir: string, legacyDir: string][] = [
    ["claude_code", targets.claude, legacyTargets.claude],
    ["codex", targets.codex, legacyTargets.codex],
    ["opencode", targets.opencode, legacyTargets.opencode],
  ];
  const distinctHostDirs = hostDirs.filter((row, index, rows) =>
    rows.findIndex((candidate) => candidate[1] === row[1] && candidate[2] === row[2]) === index);
  const aliasesFor = (canonicalDir: string, legacyDir: string) =>
    hostDirs.filter((row) => row[1] === canonicalDir && row[2] === legacyDir);

  if (sub === "install") {
    const assets = resolveSkillAssets(deps.executable);
    const authority =
      deps.installAuthority?.() ?? resolvePersistentInstallAuthority({
        env: deps.env ?? process.env,
        platform: deps.platform,
      });
    if (!authority.allowed) {
      throw new CliError(
        "RUNTIME",
        `persistent skill install requires a durable npm-global CLI; authority is ${authority.state}: ${authority.reason}`,
        {
          details: { install_authority: authority },
          help: "run `npm install -g superbee`, verify `superbee version --json`, then re-run skill install; npx remains supported for read-only/trial commands",
        },
      );
    }
    const refusals: string[] = [];
    const hosts: Record<string, unknown> = {};
    const changedByHost: Partial<Record<IntegrationHost, boolean>> = {};
    for (const [, canonicalDir, legacyDir] of distinctHostDirs) {
      // Any unexpected fs throw on one host becomes a structured refusal so the sibling host
      // still processes (same aggregation shape as hook install).
      let result: HostInstallResult;
      try {
        result = installForHost(
          canonicalDir,
          legacyDir,
          assets,
          `${cliInvocation()} skill install --scope ${scope}`,
        );
      } catch (err) {
        result = { ok: false, reason: `unexpected error: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!result.ok) {
        refusals.push(`${collapseHomeDirectory(canonicalDir)}: ${result.reason}`);
        continue;
      }
      for (const [key] of aliasesFor(canonicalDir, legacyDir)) {
        changedByHost[key] = result.changed;
        hosts[key] = {
          path: collapseHomeDirectory(canonicalDir),
          legacy_path: collapseHomeDirectory(legacyDir),
          changed: result.changed,
          migrated: result.migrated,
          legacy_state_before: result.legacyState,
        };
      }
    }
    if (refusals.length > 0) {
      throw new CliError(
        "RUNTIME",
        `skill install refused ${refusals.length} target folder(s); other targets were still processed`,
        {
          details: { refused: refusals },
          help: "inspect the named folder(s) — nothing was written to them; remove what this tool does not manage, then re-run",
        },
      );
    }
    const lifecycle = integrationChangeReceipt(changedByHost);
    stdout(
      render(
        {
          skill: {
            action: "install",
            scope,
            version: assets.version,
            source: collapseHomeDirectory(assets.root),
            ...lifecycle,
            hosts,
          },
        },
        mode,
      ),
    );
    return;
  }

  // uninstall
  const refusals: string[] = [];
  const hosts: Record<string, unknown> = {};
  let changed = false;
  for (const [, canonicalDir, legacyDir] of distinctHostDirs) {
    const paths = [
      ["canonical", canonicalDir],
      ["legacy", legacyDir],
    ] as const;
    // Both path preflights finish before either path mutates. A refusal remains path-local: the
    // other proven-owned path and the sibling host still process.
    const prepared = paths.map(([label, dir]) => {
      try {
        return { label, dir, plan: preflightUninstallFromDir(dir) } as const;
      } catch (err) {
        return {
          label,
          dir,
          plan: { ok: false, reason: `unexpected error: ${err instanceof Error ? err.message : String(err)}` },
        } as const;
      }
    });
    const pathResults: Record<string, unknown> = {};
    let hostChanged = false;
    for (const entry of prepared) {
      let result: UninstallResult;
      if (!entry.plan.ok) {
        result = entry.plan;
      } else {
        try {
          result = uninstallFromDir(entry.dir, entry.plan);
        } catch (err) {
          result = { ok: false, reason: `unexpected error: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      if (!result.ok) {
        refusals.push(`${collapseHomeDirectory(entry.dir)}: ${result.reason}`);
        pathResults[entry.label] = {
          path: collapseHomeDirectory(entry.dir),
          changed: false,
          refused: result.reason,
        };
        continue;
      }
      hostChanged = hostChanged || result.changed;
      pathResults[entry.label] = { path: collapseHomeDirectory(entry.dir), changed: result.changed };
    }
    changed = changed || hostChanged;
    for (const [key] of aliasesFor(canonicalDir, legacyDir)) {
      hosts[key] = { changed: hostChanged, ...pathResults };
    }
  }
  if (refusals.length > 0) {
    throw new CliError(
      "RUNTIME",
      `skill uninstall refused ${refusals.length} target folder(s); other targets were still processed`,
      {
        details: { refused: refusals },
        help: "inspect the named folder(s) — nothing was deleted from them",
      },
    );
  }
  stdout(render({ skill: { action: "uninstall", scope, changed, hosts } }, mode));
}
