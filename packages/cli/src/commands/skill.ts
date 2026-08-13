// `superbee skill install|status|uninstall` — install this distribution's generated Agent Skill
// (SKILL.md + references/) into host skill folders.
//
// ASSET SOURCE: the running distribution's own package root (`dirname(executable)/..` → SKILL.md +
// references/) — the npm layout (`<pkg>/dist/superbee.mjs`) and a dev/repo build
// (`packages/cli/dist/…`) both resolve naturally.
//
// TARGETS: Claude Code + Codex only, via the ONE HOST_CONFIG_ROOTS authority (the same env-var
// semantics `hook install --scope user` uses). OpenCode is deliberately excluded — it has no
// skill surface; its SessionStart integration is the plugin written by `hook install`.
//
// DESTRUCTIVE-WRITE DISCIPLINE (same boundary as hook.ts): install writes a manifest
// (`.aslite-skill.json`: file list + package version + installed-by) inside the target folder and
// REFUSES a pre-existing folder it does not manage (no manifest, a malformed manifest, or files
// present that no manifest names) — nothing is written or deleted on refusal. Uninstall removes
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
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  cliInvocation,
  collapseHomeDirectory,
  currentExecutableRealPath,
} from "../invocation.js";
import { atomicWriteFileSync } from "./hook.js";
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

export { isSafeManifestEntry };

export const SKILL_USAGE = `superbee skill — install this package's Agent Skill into host skill folders

Usage:
  superbee skill install   [--scope project|user]
  superbee skill status    [--scope project|user]
  superbee skill uninstall [--scope project|user]

Installs (or removes) the generated Agent Skill shipped with this npm package — SKILL.md plus its
references/ folder — for Claude Code and Codex. OpenCode is deliberately not a target: it has no
skill surface; its SessionStart integration is the plugin written by \`hook install\`.

Install writes a manifest (${"`"}.aslite-skill.json${"`"}) inside the target folder and refuses a
pre-existing folder it does not manage; uninstall removes exactly the manifested files and refuses
a folder holding anything else. Reinstall is idempotent (exit 0, changed:false when current).
\`status\` reports per host: absent | unmanaged | installed | stale (byte-compare against this
executable's own shipped assets). Status reports install state at these paths; Codex host
discovery is verified at USER scope (codex 0.144.x) — project-scope placement follows each
host's documented convention.

Persistent install from npm-package bytes requires a durable global install
(\`npm install -g superbee\`); transient npx/npm-exec cache paths fail closed before either
host folder is changed. npx remains supported for read-only, trial, and bootstrap commands.

Options:
  --scope project   Write to the CURRENT project (default): .claude/skills/aslite/, .codex/skills/aslite/
  --scope user      Write to each host's configured user home (environment override or default)
  --json            Emit compact JSON instead of TOON
  -h, --help        Show this help

The former spelling --scope global remains accepted as an alias for --scope user.
`;

/** The installed skill folder name under each host's `skills/` directory. */
export const SKILL_DIR_NAME = "aslite";
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

/** The per-host target folders (the `skills/aslite` dir itself) for one resolved scope. */
export interface SkillTargets {
  claude: string;
  codex: string;
}

export function skillTargets(
  scope: InstallScope,
  deps: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv } = {},
): SkillTargets {
  if (scope === "project") {
    const cwd = deps.cwd ?? process.cwd();
    return {
      claude: join(cwd, ".claude", "skills", SKILL_DIR_NAME),
      codex: join(cwd, ".codex", "skills", SKILL_DIR_NAME),
    };
  }
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  return {
    claude: join(resolveHostConfigRoot(HOST_CONFIG_ROOTS.claude, home, env), "skills", SKILL_DIR_NAME),
    codex: join(resolveHostConfigRoot(HOST_CONFIG_ROOTS.codex, home, env), "skills", SKILL_DIR_NAME),
  };
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

/** Convergent install into one target folder. Refuses (nothing written) a folder we don't manage. */
function installIntoDir(dir: string, assets: SkillAssets): InstallResult {
  const notDir = nonDirectoryRefusal(dir);
  if (notDir !== undefined) return { ok: false, reason: notDir };
  const manifest = readManifest(dir);
  const ownedForSweep = sweepOwnership(manifest, assets.files);
  if (existsSync(dir)) {
    const logicalFiles = listFilesRelative(dir).filter((file) => !isManagedDebris(file, ownedForSweep));
    if (manifest === undefined && logicalFiles.length > 0) {
      return { ok: false, reason: `folder exists with no ${SKILL_MANIFEST_FILENAME} manifest — not managed by this tool` };
    }
    if (manifest === null) {
      return { ok: false, reason: `${SKILL_MANIFEST_FILENAME} does not prove ownership — refusing to write over a folder in an unknown state` };
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

/**
 * Remove EXACTLY the manifested files (skip-missing — a manifest-first partial install cleans up
 * without a throw) + the manifest; refuse a folder holding anything else, and refuse a target
 * that is not a real directory before any walk.
 */
function uninstallFromDir(dir: string): UninstallResult {
  const notDir = nonDirectoryRefusal(dir);
  if (notDir !== undefined) return { ok: false, reason: notDir };
  if (!existsSync(dir)) return { ok: true, changed: false };
  const manifest = readManifest(dir);
  const ownedForSweep = sweepOwnership(manifest, []);
  if (manifest === undefined) {
    // A folder left empty (a first-install kill stranded only OUR manifest tmp, or a pre-existing
    // empty dir) holds nothing foreign — a no-op, cleaned up only when we removed the debris.
    const logicalFiles = listFilesRelative(dir).filter((file) => !isManagedDebris(file, ownedForSweep));
    if (logicalFiles.length === 0) {
      const debrisRemoved = sweepManagedDebris(dir, ownedForSweep);
      if (debrisRemoved) removeEmptyDirectories(dir, true);
      return { ok: true, changed: debrisRemoved };
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
  // Sweep only after the whole target has passed the no-delete preflight.
  sweepManagedDebris(dir, ownedForSweep);
  for (const relativePath of manifest.files) {
    // Type-aware: a symlinked entry unlinks the link itself (never its target); an EMPTY
    // directory (pre-scanned above) rmdirs; absent files skip without a throw.
    removeManagedPath(join(dir, ...relativePath.split("/")));
  }
  rmSync(join(dir, SKILL_MANIFEST_FILENAME), { force: true });
  removeEmptyDirectories(dir, true);
  return { ok: true, changed: true };
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

/** Injectable seams, defaulting to production. */
export interface SkillDeps {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Override the running-executable path the asset source derives from (tests). */
  executable?: string;
  /** Override the one pre-write persistent-install authority (tests). */
  installAuthority?: () => PersistentInstallAuthority;
  stdout?: (s: string) => void;
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

  const targets = skillTargets(scope, deps);
  const mode = resolveMode(values);
  const hostDirs: [key: "claude_code" | "codex", dir: string][] = [
    ["claude_code", targets.claude],
    ["codex", targets.codex],
  ];

  if (sub === "status") {
    const assets = resolveSkillAssets(deps.executable);
    const hosts: Record<string, unknown> = {};
    for (const [key, dir] of hostDirs) {
      const s = skillStatusForDir(
        dir,
        assets,
        `${cliInvocation()} skill install --scope ${scope}`,
      );
      hosts[key] = {
        path: collapseHomeDirectory(dir),
        state: s.state,
        ...(s.version ? { version: s.version } : {}),
        compatibility: s.compatibility,
      };
    }
    stdout(render({ skill: { action: "status", scope, version: assets.version, hosts } }, mode));
    return;
  }

  if (sub === "install") {
    const assets = resolveSkillAssets(deps.executable);
    const authority =
      deps.installAuthority?.() ?? resolvePersistentInstallAuthority({ env: deps.env ?? process.env });
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
    let changed = false;
    for (const [key, dir] of hostDirs) {
      // Any unexpected fs throw on one host becomes a structured refusal so the sibling host
      // still processes (same aggregation shape as hook install).
      let result: InstallResult;
      try {
        result = installIntoDir(dir, assets);
      } catch (err) {
        result = { ok: false, reason: `unexpected error: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!result.ok) {
        refusals.push(`${collapseHomeDirectory(dir)}: ${result.reason}`);
        continue;
      }
      changed = changed || result.changed;
      hosts[key] = { path: collapseHomeDirectory(dir), changed: result.changed };
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
    stdout(
      render(
        {
          skill: {
            action: "install",
            scope,
            version: assets.version,
            source: collapseHomeDirectory(assets.root),
            changed,
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
  for (const [key, dir] of hostDirs) {
    // Same per-host wrap as install: one host's unexpected fs throw must never abort the sibling.
    let result: UninstallResult;
    try {
      result = uninstallFromDir(dir);
    } catch (err) {
      result = { ok: false, reason: `unexpected error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!result.ok) {
      refusals.push(`${collapseHomeDirectory(dir)}: ${result.reason}`);
      continue;
    }
    changed = changed || result.changed;
    hosts[key] = { path: collapseHomeDirectory(dir), changed: result.changed };
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
