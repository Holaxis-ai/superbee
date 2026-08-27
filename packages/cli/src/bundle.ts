// Bundle discovery for the Superbee CLI.
//
// Every OKF command operates on ONE Knowledge Bundle. Locally that's a directory tree; this module
// turns a `--dir <path>` flag (or the cwd) into the `Bundle` handle the core engine consumes
// ({ root }). An explicit existing directory is already an exact bundle boundary, so it does not
// require OKF's optional root `index.md`. Ambient discovery still walks UP to the nearest reserved
// `index.md`, mirroring how `git` finds `.git` — so an agent can run `superbee` from anywhere inside
// an indexed bundle without making an index-less directory an ambient guess. `init` uses
// `resolveTargetDir` instead (it CREATES the bundle, so the dir need not already exist).
//
// `--remote <url>` is the OTHER way to resolve a bundle: it produces a
// `{ root: <url>, backend: RemoteBackend }` handle wired to a `docs/WIRE-PROTOCOL.md` v0 server
// (`superbee serve`). The sentinel `root` is the URL itself — it can never collide with a
// real filesystem path, while still giving consumers a stable display identity (the
// tri-backend tests' `mem://…` roots are the same pattern). An EXPLICIT `--remote`
// flag and an EXPLICIT `--dir` flag remain mutually exclusive (a USAGE error) — that combination
// contradicts the caller's own stated intent and cannot be silently resolved either way.
//
// HTTP activation is explicit: only `--remote <url>` produces a RemoteBackend. The retired
// `AGENTSTATE_LITE_REMOTE` variable is detected after explicit flags and rejected with migration
// guidance; an explicit `--dir` or `--remote` remains authoritative and suppresses that legacy
// ambient state.
//
// `.superbee.json` and the supported legacy `.agentstate.json` are COMMITTED, project-scoped LOCAL
// pointers: `{ "bundle": "<path>" }` at a project root, discovered in ONE walk up from the cwd.
// At each level both names are inspected together: one wins, while both fail closed rather than
// guessing. The nearest level wins overall. The binding rung sits between explicit flags and cwd
// discovery: explicit
// `--remote`/`--dir` -> the local project binding -> the cwd walk (which checks each ancestor's own
// `index.md` first, then its canonical `.superbee/index.md` or legacy
// `.agentstate-lite/index.md`). Explicit beats committed
// beats discovered, and within discovery an enclosing bundle beats the conventional project folder
// at the same level. A relative binding path resolves against the directory containing
// the selected binding, never the cwd, so committed pointers stay clone-portable. A malformed file
// (unreadable, invalid JSON, missing/empty/
// non-string `bundle`) is a USAGE CliError naming the file — never a silent fallthrough to the next
// rung, because a committed-but-broken binding is a real repo mistake the user must see.
//
// URL-valued bindings are rejected at the parser with an explicit-`--remote` migration hint. Local
// bindings are consumed by `openBundle`'s cwd-discovery fallback, which keeps bare commands local.
//
// API-key sourcing for an explicitly gated remote: `openRemoteBundle` sources a bearer token for
// the resolved remote's ORIGIN in priority order — (1) the `AGENTSTATE_LITE_API_KEY` env var
// (a session-wide override, no credentials-file write needed for scripts/CI), then (2) the
// already-provisioned origin-keyed entry stored (`credentials.ts`'s
// `getApiKeyForOrigin`). Neither is required: the reference `serve()` ignores the
// `Authorization` header entirely (no auth enforced there), so an ungated local bundle works
// exactly as before with no key configured.
import { BUNDLE_DIR, BUNDLE_DIRS, LEGACY_BUNDLE_DIR, resolveBundleKey } from "@superbee/board-git";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import {
  FilesystemMutationLockError,
  RemoteBackend,
  RemoteError,
  VersionConflict,
  withFilesystemMutationLock,
  type Bundle,
  type FetchLike,
  type FilesystemMutationLockOptions,
} from "@superbee/core";
import { CliError } from "./errors.js";
import { cliInvocation } from "./invocation.js";
import { normalizeServer } from "./config.js";
import { getApiKeyForOrigin } from "./credentials.js";
import {
  assertBundleOutsidePrivateState,
  assertSearchDirOutsidePrivateState,
} from "./private-state-bundle-boundary.js";
import { type BoundBoardOwner, validateBoundBoardOwner } from "./bound-board-owner.js";
import {
  LEGACY_API_KEY_ENV,
  SUPERBEE_API_KEY_ENV,
  resolveCompatibleScalarEnv,
} from "./env-policy.js";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The directory `init` should create/open: the explicit `--dir`, else the cwd. */
export function resolveTargetDir(dirFlag: string | undefined): string {
  return path.resolve(dirFlag ?? process.cwd());
}

/**
 * Preserve plain init's idempotent open-or-create behavior without allowing it to mint a second
 * conventional project bundle. The strict create-only path has broader safety checks; this guard
 * is the compatibility minimum for ordinary init.
 */
export async function assertPlainInitTarget(dirFlag: string | undefined): Promise<string> {
  const target = resolveTargetDir(dirFlag);
  assertBundleOutsidePrivateState(target);
  const ownIndex = await exists(path.join(target, "index.md"));
  const base = path.basename(target);
  if (BUNDLE_DIRS.includes(base as (typeof BUNDLE_DIRS)[number])) {
    const selected = await conventionalBundleAt(path.dirname(target));
    if (selected && path.resolve(selected) !== target) {
      throw new CliError(
        "CONFLICT",
        `an existing project workspace ${selected} already serves this location — refusing to create a second conventional bundle`,
        { help: `use the existing bundle, or move it outside the project before retrying with ${cliInvocation()} init --create-only` },
      );
    }
    return target;
  }
  if (!ownIndex) {
    const selected = await conventionalBundleAt(target);
    if (selected) {
      throw new CliError(
        "CONFLICT",
        `an existing project workspace ${selected} already serves this location — refusing to create another bundle at its project root`,
        { help: `use the existing bundle, or choose a genuinely new path with ${cliInvocation()} init --create-only` },
      );
    }
  }
  return target;
}

/**
 * The conventional project-scoped bundle directory name: a bundle at
 * `<project-root>/.superbee/` (or an existing legacy `.agentstate-lite/`) is discovered by the
 * cwd walk with NO configuration —
 * the folder alone is enough, the way `git` treats `.git`. It is the DEFAULT home for a
 * project's workspace bundle (committed, so it collaborates across clones), while
 * `.agentstate.json` remains the explicit override for anything unconventional (a remote
 * URL, an out-of-tree directory) and — being an explicit committed pointer — beats it.
 */
// The one sanctioned reverse edge (board-git A1): the discovery layer consumes the git
// channel's BUNDLE_DIR constant, so the conventional folder name has ONE owner.
export const CONVENTIONAL_BUNDLE_DIR_NAME: string = BUNDLE_DIR;
/** Pre-rename conventional name, accepted as an existing compatibility input only. */
export const LEGACY_CONVENTIONAL_BUNDLE_DIR_NAME: string = LEGACY_BUNDLE_DIR;

function conventionalBundleConflict(dir: string): CliError {
  return new CliError(
    "CONFLICT",
    `both ${BUNDLE_DIR}/index.md and ${LEGACY_BUNDLE_DIR}/index.md exist at ${dir} — refusing to choose between two project bundles`,
    { help: "choose the project bundle to keep, then move the other directory outside the project" },
  );
}

/** The one indexed recognized child at this level; same-level dual presence fails closed. */
async function conventionalBundleAt(dir: string): Promise<string | null> {
  const found: string[] = [];
  for (const name of BUNDLE_DIRS) {
    const candidate = path.join(dir, name);
    if (await exists(path.join(candidate, "index.md"))) found.push(candidate);
  }
  if (found.length > 1) throw conventionalBundleConflict(dir);
  return found[0] ?? null;
}

/**
 * Walk up from `start` to the nearest bundle root; null if none. At EACH level, the
 * directory's own `index.md` is checked first (standing inside a bundle keeps winning),
 * then the canonical `.superbee/index.md` or legacy `.agentstate-lite/index.md` — so the nearest level wins overall,
 * and within a level an enclosing bundle beats the conventional folder. EXPORTED for
 * session-start's `--dir` bridge (home.ts `discoverSummarizeBundle`): its `--dir` names a
 * PROJECT directory. Explicit local resolution accepts only the requested root or its direct
 * conventional child; this walk additionally discovers bundles from nested descendants.
 *
 * THE one place a "no bundle here" verdict is reached, so it is also the one place that verdict is
 * denied to private state: a start directory that IS or lives INSIDE a guarded root refuses with the
 * boundary conflict instead of walking up and reporting absence. Without it every discovery consumer
 * answers "no OKF bundle found" for a guarded root and offers a relative `init --dir .superbee` that
 * lands inside it.
 */
export async function findBundleRoot(start: string): Promise<string | null> {
  assertSearchDirOutsidePrivateState(start);
  let dir = path.resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await exists(path.join(dir, "index.md"))) return dir;
    const conventional = await conventionalBundleAt(dir);
    if (conventional) return conventional;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The preferred committed project-scoped pointer filename (see the module header). */
export const SUPERBEE_PROJECT_BINDING_FILE_NAME = ".superbee.json";

/** The supported pre-rename pointer filename. Kept exported for compatibility and fixtures. */
export const PROJECT_BINDING_FILE_NAME = ".agentstate.json";

const PROJECT_BINDING_FILE_NAMES = [
  SUPERBEE_PROJECT_BINDING_FILE_NAME,
  PROJECT_BINDING_FILE_NAME,
] as const;

/**
 * A resolved project binding — see the module header for the full precedence story.
 */
export interface ProjectBinding {
  /** Absolute path to the selected binding file (surfaced in errors/notes). */
  file: string;
  /** Absolute directory target; relative values resolve against the binding file's directory. */
  target: string;
}

/** How a local bundle target won the CLI's selection precedence. */
export type LocalBundleSelection = "explicit-dir" | "project-binding" | "discovery";

/**
 * The validated local target shared by bundle-opening commands and the public locator receipt.
 * It retains both the lexical root ordinary commands use and its canonical physical directory.
 */
export interface LocalBundleTarget {
  /** The lexical absolute root ordinary commands have historically operated through. */
  root: string;
  /** The same physical directory canonicalized for a stable machine receipt. */
  canonicalRoot: string;
  selectedBy: LocalBundleSelection;
  bindingFile?: string;
}

/** A physical directory receipt frozen while classifying a symlinked plain binding. */
export interface DirectoryIdentity {
  /** The canonical directory path the selected lexical route resolved to. */
  canonicalRoot: string;
  /** The filesystem device owning the directory at classification time. */
  dev: number;
  /** The filesystem inode identifying the directory at classification time. */
  ino: number;
}

/**
 * A local selection carries no authority by default.  Only a proven linked board worktree gets
 * the immutable owner capability needed for Git and private-state effects.
 */
export type ResolvedLocalRoute =
  | { readonly kind: "unbound"; readonly target: LocalBundleTarget; readonly bundle: Bundle }
  | {
      readonly kind: "bound-local";
      readonly target: LocalBundleTarget;
      readonly bundle: Bundle;
      readonly identity: DirectoryIdentity;
    }
  | {
      readonly kind: "bound-board";
      readonly readiness: "ready";
      readonly target: LocalBundleTarget;
      readonly bundle: Bundle;
      readonly owner: BoundBoardOwner;
    }
  | {
      readonly kind: "bound-board";
      readonly readiness: "recovery-pending";
      readonly target: LocalBundleTarget;
      readonly bundle: Bundle;
      readonly owner: BoundBoardOwner;
    };

/** The post-persist board decision is total and computed before a mutation persists. */
export type BoardAttribution =
  | { readonly kind: "none" }
  | { readonly kind: "board"; readonly stateKey: string };

interface BindingUriIntent {
  detail: string;
  suggestedRemote?: string;
}

function bindingUriIntent(value: string): BindingUriIntent | null {
  if (/^[A-Za-z]:(?!\/\/)/.test(value)) return null;
  if (value.startsWith("//")) {
    return { detail: `protocol-relative URL ${value}` };
  }
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return { detail: `unsupported URI scheme "${scheme}" in ${value}` };
  }
  try {
    const url = new URL(value);
    if (url.protocol === `${scheme}:`) return { detail: `remote URL ${value}`, suggestedRemote: value };
  } catch {
    // The scheme establishes URI intent even when the URL itself is malformed.
  }
  return { detail: `invalid ${scheme} URL ${value}` };
}

/** Parse one project binding identically for ordinary discovery and strict create-only discovery. */
function parseProjectBinding(file: string, raw: string): ProjectBinding {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(
      "USAGE",
      `malformed project binding ${file}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
      { help: `fix or remove ${file}` },
    );
  }
  const rawBundle = (parsed as Record<string, unknown> | null)?.bundle;
  if (typeof rawBundle !== "string" || rawBundle.trim() === "") {
    throw new CliError(
      "USAGE",
      `malformed project binding ${file}: "bundle" must be a non-empty filesystem path`,
      { help: `fix or remove ${file}` },
    );
  }
  const value = rawBundle.trim();
  const uriIntent = bindingUriIntent(value);
  if (uriIntent) {
    const remote = uriIntent.suggestedRemote ?? "<url>";
    throw new CliError(
      "USAGE",
      `project binding ${file} cannot use ${uriIntent.detail}; URL bindings no longer activate remotes — pass --remote ${remote} explicitly or replace "bundle" with a filesystem path`,
      { help: `${cliInvocation()} <command> --remote ${remote}` },
    );
  }
  return { file, target: path.resolve(path.dirname(file), value) };
}

async function readProjectBindingFile(file: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    // Symlinked binding files are supported, so follow the link; O_NONBLOCK plus fstat prevents a
    // FIFO/socket/device target from hanging discovery while still validating the opened object.
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    throw new CliError(
      "USAGE",
      `could not read project binding ${file}: ${err instanceof Error ? err.message : String(err)}`,
      { help: `fix or remove ${file}` },
    );
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new CliError(
        "USAGE",
        `project binding ${file} must be a regular file`,
        { help: `fix or remove ${file}` },
      );
    }
    return await handle.readFile("utf8");
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      "USAGE",
      `could not read project binding ${file}: ${err instanceof Error ? err.message : String(err)}`,
      { help: `fix or remove ${file}` },
    );
  } finally {
    await handle.close().catch(() => {});
  }
}

function projectBindingConflict(dir: string): CliError {
  const preferred = path.join(dir, SUPERBEE_PROJECT_BINDING_FILE_NAME);
  const legacy = path.join(dir, PROJECT_BINDING_FILE_NAME);
  return new CliError(
    "USAGE",
    `conflicting project bindings at ${dir}: found both ${preferred} and ${legacy}; remove one instead of relying on an ambiguous target`,
    { help: `remove one binding, or pass --dir <bundle-path> explicitly` },
  );
}

async function ordinaryBindingEntryExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw new CliError(
      "USAGE",
      `could not inspect project binding ${file}: ${err instanceof Error ? err.message : String(err)}`,
      { help: `fix or remove ${file}` },
    );
  }
}

async function ordinaryProjectBindingAtLevel(dir: string): Promise<string | null> {
  const observed = await Promise.all(
    PROJECT_BINDING_FILE_NAMES.map(async (name) => {
      const file = path.join(dir, name);
      return { file, present: await ordinaryBindingEntryExists(file) };
    }),
  );
  const present = observed.filter((entry) => entry.present);
  if (present.length > 1) throw projectBindingConflict(dir);
  return present[0]?.file ?? null;
}

/**
 * Discover + parse + validate the nearest project binding walking up from `startDir` (default
 * cwd). Each level inspects `.superbee.json` and `.agentstate.json` together; both at one level are
 * an explicit conflict, while either at a nearer level wins over either name farther away. Returns
 * `null` when neither exists anywhere up-tree (the common case; NOT an error). When one IS found,
 * it is read and validated immediately: an unreadable file, invalid JSON, or a missing/empty/
 * non-string `bundle` field is a real committed mistake — thrown as a USAGE CliError (exit 2)
 * naming the file, never swallowed into a silent `null`. A URL value is rejected: remote access
 * requires an explicit `--remote`. A filesystem path is resolved against the binding file's OWN
 * directory (never the cwd — see the module header on clone-portability).
 */
export async function resolveProjectBinding(startDir: string = process.cwd()): Promise<ProjectBinding | null> {
  let dir = path.resolve(startDir);
  for (;;) {
    const file = await ordinaryProjectBindingAtLevel(dir);
    if (file) return parseProjectBinding(file, await readProjectBindingFile(file));
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Wrap a fetch-like transport so a transport-level failure (ECONNREFUSED, DNS, timeout — `fetch`
 * rejects with a plain `TypeError` for all of these) surfaces as a `CliError("RUNTIME", …)` with a
 * `serve` hint BEFORE it reaches command code. Without this, a command's catch-all (e.g. `link`'s,
 * `doc write`'s) would misclassify an unreachable server as a USAGE error (exit 2) instead of a
 * retryable RUNTIME fault (exit 1) — wrong-but-plausible, since both look like "a plain Error" to
 * a generic catch. HTTP-level failures (404/412/5xx) are UNCHANGED: they still resolve to a normal
 * `Response` that `RemoteBackend` maps itself (see `core/src/remote-backend.ts`).
 */
function wrapTransportErrors(remote: string): FetchLike {
  return async (request: Request): Promise<Response> => {
    try {
      return await globalThis.fetch(request);
    } catch (err) {
      throw new CliError(
        "RUNTIME",
        `could not reach the remote bundle at ${remote} (${err instanceof Error ? err.message : String(err)})`,
        { help: `${cliInvocation()} serve --dir <path>` },
      );
    }
  };
}

/** Session-wide override for the `--remote` API key. See {@link openRemoteBundle}. */
export const API_KEY_ENV_VAR = LEGACY_API_KEY_ENV;
export const SUPERBEE_API_KEY_ENV_VAR = SUPERBEE_API_KEY_ENV;

export function resolveApiKeyEnv(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  return resolveCompatibleScalarEnv({
    canonical: SUPERBEE_API_KEY_ENV_VAR,
    legacy: API_KEY_ENV_VAR,
    label: "API key",
    env,
  });
}

/**
 * Resolve a `--remote <url>` bundle: a `RemoteBackend` wired to the wire-protocol v0 reference
 * server, using the same http(s) URL discipline `config.ts`'s `normalizeServer` applies to
 * remote credential lookup (a malformed/non-http(s) URL is a USAGE error, exit 2). The bundle-path segment
 * is a fixed `"default"` — the single-bundle reference router ignores it; meaningful only for a
 * future multi-bundle deployment (no `--bundle` flag exists yet; out of scope).
 *
 * Sources a bearer `authToken` for the resolved origin: `SUPERBEE_API_KEY` or legacy
 * `AGENTSTATE_LITE_API_KEY` env var first, else an already-provisioned origin-keyed
 * credentials-file entry. If both environment variables are set to different non-empty values,
 * resolution fails before any request and does not print either secret. Neither
 * is required — an ungated bundle (the reference `serve()`) ignores the header either way.
 */
async function openRemoteBundle(remoteFlag: string): Promise<Bundle> {
  let base: string;
  let origin: string;
  try {
    const resolved = normalizeServer(remoteFlag);
    base = resolved.base;
    origin = resolved.resource;
  } catch (err) {
    throw new CliError("USAGE", err instanceof Error ? err.message : String(err), {
      help: `${cliInvocation()} <command> --remote http://127.0.0.1:4818`,
    });
  }
  const envKey = resolveApiKeyEnv();
  const authToken = envKey || (await getApiKeyForOrigin(origin));
  const backend = new RemoteBackend({
    baseUrl: base,
    bundle: "default",
    fetchImpl: wrapTransportErrors(base),
    authToken,
  });
  return { root: base, backend };
}

/** Retired remote-default environment variable, retained only for an actionable migration error. */
export const REMOTE_ENV_VAR = "AGENTSTATE_LITE_REMOTE";

/**
 * Resolve the effective `--remote` value. Only an explicit flag can return a URL. An explicit
 * `--dir` wins locally. With neither flag, a present legacy `AGENTSTATE_LITE_REMOTE` is rejected
 * with migration guidance, and a reached project binding is parsed solely to reject malformed or
 * URL-valued bindings before local discovery consumes a valid path binding.
 *
 * `openBundle`'s `--remote`/`--dir` mutual-exclusion check therefore only ever fires for an
 * explicit `--remote` FLAG (not an env- or binding-derived one) alongside an explicit `--dir` — the
 * one combination that is a genuine, unresolvable contradiction of the caller's own stated intent.
 * Every remote-capable command calls THIS (passing its OWN `dirFlag` too) before `openBundle`, never
 * `openBundle` directly with a raw `values.remote` — except `init` (explicitly rejects `--remote`,
 * no create-bundle endpoint exists) and `serve` (always boots over a LOCAL bundle; picking up an
 * ambient remote default there would be actively wrong, not a convenience), which must NOT call this.
 * `home`'s local dashboard read is a THIRD such exception, for the same reason it already skips the
 * env default (see the module header's URL-binding note).
 */
export async function resolveRemoteFlag(
  remoteFlag: string | undefined,
  dirFlag: string | undefined,
): Promise<string | undefined> {
  if (remoteFlag !== undefined) return remoteFlag;
  if (dirFlag !== undefined) return undefined; // explicit --dir wins over legacy ambient state
  if (process.env[REMOTE_ENV_VAR] !== undefined) {
    const legacy = process.env[REMOTE_ENV_VAR]?.trim();
    throw new CliError(
      "USAGE",
      `${REMOTE_ENV_VAR} ambient remote selection is retired; pass --remote <url> explicitly`,
      { help: `${cliInvocation()} <command> --remote ${legacy || "<url>"}` },
    );
  }
  await resolveProjectBinding();
  return undefined;
}

async function canonicalDirectoryRoot(
  root: string,
  notFoundMessage: string,
  help: string,
): Promise<string> {
  try {
    const [canonicalRoot, info] = await Promise.all([fs.realpath(root), fs.stat(root)]);
    if (!info.isDirectory()) throw new Error("target is not a directory");
    return canonicalRoot;
  } catch {
    // The target may have disappeared between selection and canonicalization. Keep that race in
    // the same user-facing class as an initially missing target rather than leaking a raw fs error.
    throw new CliError("NOT_FOUND", notFoundMessage, { help });
  }
}

interface CreateOnlyFilesystem {
  lstat(p: string): Promise<Stats>;
  stat(p: string): Promise<Stats>;
  realpath(p: string): Promise<string>;
  readdir(p: string): Promise<string[]>;
  mkdir(p: string): Promise<void>;
  readFile(p: string): Promise<string>;
}

const createOnlyFs: CreateOnlyFilesystem = {
  lstat: (p) => fs.lstat(p),
  stat: (p) => fs.stat(p),
  realpath: (p) => fs.realpath(p),
  readdir: (p) => fs.readdir(p),
  mkdir: (p) => fs.mkdir(p).then(() => undefined),
  readFile: (p) => readProjectBindingFile(p),
};

export interface CreateOnlyTargetDeps {
  fs?: Partial<CreateOnlyFilesystem>;
  withFilesystemMutationLockImpl?: typeof withFilesystemMutationLock;
  lockOptions?: FilesystemMutationLockOptions;
}

export interface CreateOnlyTargetReceipt<T> {
  root: string;
  createdDirectories: string[];
  value: T;
}

interface CreateOnlyResolution {
  logical: string;
  target: string;
  physicalPrefix: string;
  missingTail: string[];
  targetStat?: Stats;
}

type CreateOnlyPhase = "preflight" | "locked-revalidation" | "directory-creation" | "pre-publish" | "lock";
type CreateOnlyPublicationState = "not-started" | "started-or-uncertain" | "published";

function createOnlyRecoveryHelp(): string {
  return (
    `${cliInvocation()} recipe add <name> --dir <existing-bundle>  (modify a verified existing bundle), or ` +
    `${cliInvocation()} init --create-only --dir <new-path>  (a different, genuinely new location)`
  );
}

function createOnlyConflict(message: string, details: Record<string, unknown> = {}): never {
  throw new CliError("ALREADY_EXISTS", message, { details, help: createOnlyRecoveryHelp() });
}

function fsCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

function createOnlyUncertainty(
  phase: CreateOnlyPhase,
  operation: string,
  p: string,
  err: unknown,
  createdDirectories: string[] = [],
  extraDetails: Record<string, unknown> = {},
): never {
  const code = fsCode(err);
  throw new CliError(
    "RUNTIME",
    `cannot safely ${operation} create-only path ${p}${code ? ` (${code})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
    {
      details: {
        phase,
        operation,
        path: p,
        ...(code ? { fs_code: code } : {}),
        residual_created_directories: [...createdDirectories],
        ...extraDetails,
      },
      help: `inspect access and path identity at ${p}, then retry or choose a different explicit --dir`,
    },
  );
}

function samePhysicalPath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Parent and child targets intentionally share this conservative physical-root arbitration key. */
export function createOnlyArbitrationLockKey(physicalTarget: string): string {
  return path.parse(path.resolve(physicalTarget)).root;
}

async function optionalLstat(
  io: CreateOnlyFilesystem,
  p: string,
  phase: CreateOnlyPhase,
  operation: string,
  createdDirectories: string[] = [],
): Promise<Stats | null> {
  try {
    return await io.lstat(p);
  } catch (err) {
    if (fsCode(err) === "ENOENT") return null;
    createOnlyUncertainty(phase, operation, p, err, createdDirectories);
  }
}

async function resolveCreateOnlyPhysicalTarget(
  logical: string,
  io: CreateOnlyFilesystem,
  phase: CreateOnlyPhase,
  createdDirectories: string[] = [],
): Promise<CreateOnlyResolution> {
  let existingPrefix = logical;
  const missingTail: string[] = [];
  let targetStat: Stats | undefined;
  for (;;) {
    try {
      const info = await io.lstat(existingPrefix);
      if (existingPrefix === logical) targetStat = info;
      break;
    } catch (err) {
      const code = fsCode(err);
      if (code === "ENOTDIR") {
        createOnlyConflict(`create-only target ${logical} runs through an existing file — pass a directory path`, {
          phase,
          operation: "lstat",
          path: existingPrefix,
          fs_code: code,
          residual_created_directories: [...createdDirectories],
        });
      }
      if (code !== "ENOENT") createOnlyUncertainty(phase, "lstat", existingPrefix, err, createdDirectories);
      const parent = path.dirname(existingPrefix);
      if (parent === existingPrefix) createOnlyUncertainty(phase, "lstat", existingPrefix, err, createdDirectories);
      missingTail.unshift(path.basename(existingPrefix));
      existingPrefix = parent;
    }
  }

  if (missingTail.length === 0 && targetStat) {
    if (targetStat.isSymbolicLink()) {
      createOnlyConflict(`create-only target ${logical} is a symlink — pass the physical directory instead`, {
        phase,
        operation: "lstat",
        path: logical,
        residual_created_directories: [...createdDirectories],
      });
    }
    if (!targetStat.isDirectory()) {
      createOnlyConflict(`create-only target ${logical} exists and is not a directory`, {
        phase,
        operation: "lstat",
        path: logical,
        residual_created_directories: [...createdDirectories],
      });
    }
  }

  let physicalPrefix: string;
  try {
    physicalPrefix = await io.realpath(existingPrefix);
  } catch (err) {
    createOnlyUncertainty(phase, "realpath", existingPrefix, err, createdDirectories);
  }
  return {
    logical,
    target: path.join(physicalPrefix, ...missingTail),
    physicalPrefix,
    missingTail,
    ...(targetStat ? { targetStat } : {}),
  };
}

async function assertObservedDirectory(
  io: CreateOnlyFilesystem,
  dir: string,
  phase: CreateOnlyPhase,
  createdDirectories: string[],
): Promise<void> {
  let info: Stats;
  try {
    info = await io.lstat(dir);
  } catch (err) {
    createOnlyUncertainty(phase, "lstat", dir, err, createdDirectories);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    createOnlyUncertainty(
      phase,
      "validate-directory-shape",
      dir,
      Object.assign(new Error("observed path is no longer a physical directory"), { code: "ESHAPE" }),
      createdDirectories,
    );
  }
}

async function existingBundleAt(
  io: CreateOnlyFilesystem,
  candidate: string,
  phase: CreateOnlyPhase,
  createdDirectories: string[],
): Promise<string | null> {
  const candidateInfo = await optionalLstat(
    io,
    candidate,
    phase,
    "lstat-binding-target",
    createdDirectories,
  );
  if (!candidateInfo) return null;

  let effectiveInfo = candidateInfo;
  if (candidateInfo.isSymbolicLink()) {
    try {
      effectiveInfo = await io.stat(candidate);
    } catch (err) {
      createOnlyUncertainty(phase, "stat-binding-target", candidate, err, createdDirectories);
    }
  }

  let physicalCandidate: string;
  try {
    physicalCandidate = await io.realpath(candidate);
  } catch (err) {
    createOnlyUncertainty(phase, "realpath-binding-target", candidate, err, createdDirectories);
  }
  let physicalInfo: Stats;
  try {
    physicalInfo = await io.lstat(physicalCandidate);
  } catch (err) {
    createOnlyUncertainty(
      phase,
      "lstat-resolved-binding-target",
      physicalCandidate,
      err,
      createdDirectories,
    );
  }
  if (
    physicalInfo.isSymbolicLink() ||
    effectiveInfo.isDirectory() !== physicalInfo.isDirectory()
  ) {
    createOnlyUncertainty(
      phase,
      "validate-resolved-binding-target-shape",
      physicalCandidate,
      Object.assign(new Error("resolved binding target shape changed during observation"), {
        code: "ESHAPE",
      }),
      createdDirectories,
    );
  }
  if (effectiveInfo.dev !== physicalInfo.dev || effectiveInfo.ino !== physicalInfo.ino) {
    createOnlyUncertainty(
      phase,
      "validate-resolved-binding-target-identity",
      physicalCandidate,
      Object.assign(new Error("resolved binding target identity changed during observation"), {
        code: "EPATHCHANGED",
      }),
      createdDirectories,
    );
  }
  if (!physicalInfo.isDirectory()) return null;

  const own = await optionalLstat(
    io,
    path.join(physicalCandidate, "index.md"),
    phase,
    "lstat-own-index",
    createdDirectories,
  );
  if (own) return physicalCandidate;
  return strictConventionalBundleAt(io, physicalCandidate, phase, createdDirectories, "binding-target");
}

async function strictConventionalBundleAt(
  io: CreateOnlyFilesystem,
  dir: string,
  phase: CreateOnlyPhase,
  createdDirectories: string[],
  operation: string,
): Promise<string | null> {
  const found: string[] = [];
  for (const name of BUNDLE_DIRS) {
    const candidate = path.join(dir, name);
    const info = await optionalLstat(io, candidate, phase, `lstat-${operation}-directory`, createdDirectories);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      createOnlyUncertainty(
        phase,
        `validate-${operation}-directory-shape`,
        candidate,
        Object.assign(new Error("conventional bundle path is not a physical directory"), { code: "ESHAPE" }),
        createdDirectories,
      );
    }
    if (await optionalLstat(io, path.join(candidate, "index.md"), phase, `lstat-${operation}-index`, createdDirectories)) {
      found.push(candidate);
    }
  }
  if (found.length > 1) throw conventionalBundleConflict(dir);
  return found[0] ?? null;
}

async function strictProjectBinding(
  io: CreateOnlyFilesystem,
  start: string,
  phase: CreateOnlyPhase,
  createdDirectories: string[],
): Promise<ProjectBinding | null> {
  let dir = start;
  for (;;) {
    await assertObservedDirectory(io, dir, phase, createdDirectories);
    const observed = await Promise.all(
      PROJECT_BINDING_FILE_NAMES.map(async (name) => {
        const file = path.join(dir, name);
        const info = await optionalLstat(
          io,
          file,
          phase,
          "lstat-binding",
          createdDirectories,
        );
        return { file, info };
      }),
    );
    const present = observed.filter(
      (entry): entry is { file: string; info: Stats } => entry.info !== null,
    );
    if (present.length > 1) throw projectBindingConflict(dir);
    const selected = present[0];
    if (selected) {
      const { file, info } = selected;
      if (!info.isFile() && !info.isSymbolicLink()) {
        throw new CliError("USAGE", `malformed project binding ${file}: expected a regular file`, {
          help: `fix or remove ${file}`,
        });
      }
      let raw: string;
      try {
        raw = await io.readFile(file);
      } catch (err) {
        if (err instanceof CliError) throw err;
        createOnlyUncertainty(phase, "read-binding", file, err, createdDirectories);
      }
      return parseProjectBinding(file, raw);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function inspectCreateOnlyTarget(
  logical: string,
  io: CreateOnlyFilesystem,
  phase: CreateOnlyPhase,
  createdDirectories: string[] = [],
): Promise<CreateOnlyResolution> {
  const resolved = await resolveCreateOnlyPhysicalTarget(logical, io, phase, createdDirectories);
  const target = resolved.target;
  if (resolved.missingTail.length === 0) {
    if (await optionalLstat(io, path.join(target, "index.md"), phase, "lstat-own-index", createdDirectories)) {
      createOnlyConflict(`create-only target ${target} is already an OKF bundle`, {
        phase,
        residual_created_directories: [...createdDirectories],
      });
    }
    const conventional = await strictConventionalBundleAt(io, target, phase, createdDirectories, "conventional");
    if (conventional) {
      createOnlyConflict(`an existing project workspace ${conventional} already serves this location — join it rather than creating a second bundle`, {
        phase,
        residual_created_directories: [...createdDirectories],
      });
    }
    let entries: string[];
    try {
      entries = await io.readdir(target);
    } catch (err) {
      createOnlyUncertainty(phase, "readdir", target, err, createdDirectories);
    }
    if (entries.length > 0) {
      createOnlyConflict(
        `create-only target ${target} exists and is not empty (${entries.length} entr${entries.length === 1 ? "y" : "ies"}) — a new workspace must not adopt existing files`,
        { phase, residual_created_directories: [...createdDirectories] },
      );
    }
  }

  const existingParent = resolved.missingTail.length > 0 ? resolved.physicalPrefix : path.dirname(target);
  let ancestor = existingParent;
  for (;;) {
    await assertObservedDirectory(io, ancestor, phase, createdDirectories);
    if (await optionalLstat(io, path.join(ancestor, "index.md"), phase, "lstat-upward-own-index", createdDirectories)) {
      createOnlyConflict(`create-only target ${target} would nest inside the existing bundle at ${ancestor}`, {
        phase,
        residual_created_directories: [...createdDirectories],
      });
    }
    const conventional = await strictConventionalBundleAt(io, ancestor, phase, createdDirectories, "upward-conventional");
    if (conventional) {
      createOnlyConflict(`an existing project workspace ${conventional} already serves this location — join it rather than creating a second bundle`, {
        phase,
        residual_created_directories: [...createdDirectories],
      });
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  const binding = await strictProjectBinding(io, existingParent, phase, createdDirectories);
  if (binding) {
    const boundBundle = await existingBundleAt(io, binding.target, phase, createdDirectories);
    if (boundBundle && !samePhysicalPath(boundBundle, target)) {
      createOnlyConflict(
        `project binding ${binding.file} already resolves this location to the existing bundle at ${boundBundle} — bare commands here would keep using it, shadowing a new bundle`,
        { phase, residual_created_directories: [...createdDirectories] },
      );
    }
  }
  return resolved;
}

function createOnlyIo(deps: CreateOnlyTargetDeps): CreateOnlyFilesystem {
  return { ...createOnlyFs, ...deps.fs };
}

/** Read-only strict create-only inspection. Ordinary discovery intentionally remains permissive. */
export async function assertCreateOnlyTarget(
  dirFlag: string | undefined,
  startDir: string = process.cwd(),
  deps: CreateOnlyTargetDeps = {},
): Promise<string> {
  const logical = path.resolve(startDir, dirFlag ?? startDir);
  return (await inspectCreateOnlyTarget(logical, createOnlyIo(deps), "preflight")).target;
}

async function createMissingDirectories(
  resolution: CreateOnlyResolution,
  io: CreateOnlyFilesystem,
  createdDirectories: string[],
): Promise<void> {
  let current = resolution.physicalPrefix;
  for (const segment of resolution.missingTail) {
    const next = path.join(current, segment);
    try {
      await io.mkdir(next);
      createdDirectories.push(next);
    } catch (err) {
      if (fsCode(err) === "EEXIST") {
        createOnlyConflict(`create-only target ${resolution.target} changed while its directories were being created`, {
          phase: "directory-creation",
          operation: "mkdir",
          path: next,
          fs_code: "EEXIST",
          residual_created_directories: [...createdDirectories],
        });
      }
      if (fsCode(err) === "ENOTDIR") {
        createOnlyConflict(`create-only target ${resolution.target} runs through an existing file — pass a directory path`, {
          phase: "directory-creation",
          operation: "mkdir",
          path: next,
          fs_code: "ENOTDIR",
          residual_created_directories: [...createdDirectories],
        });
      }
      createOnlyUncertainty("directory-creation", "mkdir", next, err, createdDirectories);
    }
    current = next;
  }
}

function sameMissingTail(a: CreateOnlyResolution, b: CreateOnlyResolution): boolean {
  return (
    a.missingTail.length === b.missingTail.length &&
    a.missingTail.every((segment, index) => segment === b.missingTail[index])
  );
}

function sameDirectoryIdentity(a: Stats | undefined, b: Stats | undefined): boolean {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

function assertLockedResolutionStable(
  initial: CreateOnlyResolution,
  locked: CreateOnlyResolution,
  createdDirectories: string[],
): void {
  if (!samePhysicalPath(locked.target, initial.target)) {
    createOnlyUncertainty(
      "locked-revalidation",
      "compare-physical-target",
      initial.logical,
      Object.assign(new Error(`physical target changed from ${initial.target} to ${locked.target}`), {
        code: "EPATHCHANGED",
      }),
      createdDirectories,
    );
  }
  if (!sameMissingTail(initial, locked)) {
    createOnlyUncertainty(
      "locked-revalidation",
      "compare-target-presence",
      initial.target,
      Object.assign(new Error("target component presence changed after preflight"), {
        code: "EPATHCHANGED",
      }),
      createdDirectories,
    );
  }
  if (initial.targetStat && !sameDirectoryIdentity(initial.targetStat, locked.targetStat)) {
    createOnlyUncertainty(
      "locked-revalidation",
      "compare-target-identity",
      initial.target,
      Object.assign(new Error("existing target directory identity changed after preflight"), {
        code: "EPATHCHANGED",
      }),
      createdDirectories,
    );
  }
}

function assertPrePublishResolutionStable(
  locked: CreateOnlyResolution,
  beforePublish: CreateOnlyResolution,
  target: string,
  createdDirectories: string[],
): void {
  if (!samePhysicalPath(beforePublish.target, target)) {
    createOnlyUncertainty(
      "pre-publish",
      "compare-physical-target",
      locked.logical,
      Object.assign(new Error(`physical target changed from ${target} to ${beforePublish.target}`), {
        code: "EPATHCHANGED",
      }),
      createdDirectories,
    );
  }
  if (beforePublish.missingTail.length > 0 || !beforePublish.targetStat) {
    createOnlyUncertainty(
      "pre-publish",
      "validate-target-presence",
      target,
      Object.assign(new Error("target disappeared after directory creation"), { code: "ENOENT" }),
      createdDirectories,
    );
  }
  if (locked.targetStat && !sameDirectoryIdentity(locked.targetStat, beforePublish.targetStat)) {
    createOnlyUncertainty(
      "pre-publish",
      "compare-target-identity",
      target,
      Object.assign(new Error("existing target directory identity changed before publication"), {
        code: "EPATHCHANGED",
      }),
      createdDirectories,
    );
  }
}

function decorateCreateOnlyFailure(
  err: unknown,
  target: string,
  createdDirectories: string[],
  publicationState: CreateOnlyPublicationState,
): never {
  if (err instanceof VersionConflict) {
    createOnlyConflict(`create-only target ${target} gained a bundle concurrently — another process created it first`, {
      phase: "pre-publish",
      operation: "write-index-expect-absent",
      path: path.join(target, "index.md"),
      residual_created_directories: [...createdDirectories],
      publication_outcome: publicationState,
    });
  }
  if (err instanceof CliError) {
    throw new CliError(err.code, err.message, {
      help: err.help,
      details: {
        ...err.details,
        residual_created_directories: [...createdDirectories],
        publication_outcome: publicationState,
      },
    });
  }
  createOnlyUncertainty(
    publicationState === "not-started" ? "directory-creation" : "pre-publish",
    publicationState === "not-started" ? "create-only-critical-section" : "publish-index",
    publicationState === "not-started"
      ? ((err as NodeJS.ErrnoException)?.path ?? target)
      : ((err as NodeJS.ErrnoException)?.path ?? path.join(target, "index.md")),
    err,
    createdDirectories,
    { publication_outcome: publicationState },
  );
}

/**
 * Own the complete create-only critical section: strict locked revalidation, component-wise
 * directory creation, final strict inspection, and expect-absent publication. The receipt is
 * diagnostic only; no failure path removes anything from the product tree.
 */
export async function withCreateOnlyTarget<T>(
  dirFlag: string | undefined,
  publish: (physicalTarget: string) => Promise<T>,
  startDir: string = process.cwd(),
  deps: CreateOnlyTargetDeps = {},
): Promise<CreateOnlyTargetReceipt<T>> {
  const io = createOnlyIo(deps);
  const logical = path.resolve(startDir, dirFlag ?? startDir);
  // Ordered before the create-only preflight so a private-state target reads as the boundary
  // refusal it is, rather than as an incidental "target exists and is not empty" that also leaks the
  // private coordinate. A target the relation cannot resolve at all (a symlink loop, an unreadable
  // ancestor) is left to the inspection below, which refuses it structurally before anything is
  // created; `target` is re-checked against the boundary immediately after.
  try {
    assertBundleOutsidePrivateState(logical);
  } catch (error) {
    if (error instanceof CliError && error.code === "CONFLICT") throw error;
  }
  const initial = await inspectCreateOnlyTarget(logical, io, "preflight");
  const target = initial.target;
  assertBundleOutsidePrivateState(target);
  const createdDirectories: string[] = [];
  let criticalSectionEntered = false;
  let publicationState: CreateOnlyPublicationState = "not-started";
  let propagatedCriticalFailure: unknown;
  let value!: T;
  const lock = deps.withFilesystemMutationLockImpl ?? withFilesystemMutationLock;
  const lockKey = createOnlyArbitrationLockKey(target);

  try {
    await lock(
      lockKey,
      async () => {
        criticalSectionEntered = true;
        try {
          const locked = await inspectCreateOnlyTarget(logical, io, "locked-revalidation", createdDirectories);
          assertLockedResolutionStable(initial, locked, createdDirectories);
          await createMissingDirectories(locked, io, createdDirectories);
          const beforePublish = await inspectCreateOnlyTarget(logical, io, "pre-publish", createdDirectories);
          assertPrePublishResolutionStable(locked, beforePublish, target, createdDirectories);
          publicationState = "started-or-uncertain";
          value = await publish(target);
          publicationState = "published";
        } catch (err) {
          try {
            decorateCreateOnlyFailure(err, target, createdDirectories, publicationState);
          } catch (decorated) {
            propagatedCriticalFailure = decorated;
            throw decorated;
          }
        }
      },
      deps.lockOptions,
    );
  } catch (err) {
    if (err === propagatedCriticalFailure) throw err;

    const releaseFailure = criticalSectionEntered;
    const operation = releaseFailure
      ? "release-filesystem-mutation-lock"
      : "acquire-filesystem-mutation-lock";
    const lockPath =
      err instanceof FilesystemMutationLockError
        ? err.lockPath
        : ((err as NodeJS.ErrnoException)?.path ?? lockKey);
    const priorDetails =
      propagatedCriticalFailure instanceof CliError
        ? {
            prior_code: propagatedCriticalFailure.code,
            ...(propagatedCriticalFailure.details?.phase
              ? { prior_phase: propagatedCriticalFailure.details.phase }
              : {}),
            ...(propagatedCriticalFailure.details?.operation
              ? { prior_operation: propagatedCriticalFailure.details.operation }
              : {}),
            ...(propagatedCriticalFailure.details?.path
              ? { prior_path: propagatedCriticalFailure.details.path }
              : {}),
            ...(propagatedCriticalFailure.details?.fs_code
              ? { prior_fs_code: propagatedCriticalFailure.details.fs_code }
              : {}),
            ...(propagatedCriticalFailure.details?.publication_outcome
              ? { prior_publication_outcome: propagatedCriticalFailure.details.publication_outcome }
              : {}),
            ...(Array.isArray(propagatedCriticalFailure.details?.residual_created_directories)
              ? {
                  prior_residual_created_directories: [
                    ...propagatedCriticalFailure.details.residual_created_directories,
                  ],
                }
              : {}),
          }
        : {};
    const code = fsCode(err);
    // TypeScript cannot observe assignments made inside the mutex callback; retain the declared
    // state-machine type at this boundary instead of narrowing the outer variable to its initializer.
    const observedPublicationState = publicationState as CreateOnlyPublicationState;
    const message = releaseFailure
      ? observedPublicationState === "published"
        ? `create-only bundle was published at ${target}, but its arbitration lock could not be released safely: ${err instanceof Error ? err.message : String(err)}`
        : observedPublicationState === "started-or-uncertain"
          ? `create-only publication started at ${target}, its outcome is uncertain, and the arbitration lock could not be released safely: ${err instanceof Error ? err.message : String(err)}`
          : `create-only entered its critical section for ${target} but failed before publication, and the arbitration lock could not be released safely: ${err instanceof Error ? err.message : String(err)}`
      : `cannot acquire the create-only arbitration lock for ${target}: ${err instanceof Error ? err.message : String(err)}`;
    throw new CliError("RUNTIME", message, {
      details: {
        phase: "lock",
        operation,
        path: lockPath,
        lock_path: lockPath,
        ...(code ? { fs_code: code } : {}),
        ...(err instanceof FilesystemMutationLockError
          ? {
              owner: err.owner,
              stale: err.stale,
              malformed: err.malformed,
            }
          : {}),
        publication_outcome: observedPublicationState,
        residual_created_directories: [...createdDirectories],
        ...priorDetails,
      },
      help: `inspect ${lockPath} and ${target} before retrying`,
    });
  }
  return { root: target, createdDirectories, value };
}

/**
 * Resolve exactly one local bundle using the CLI's established precedence and retain why it won.
 * This is the sole local target-selection primitive: {@link openBundle} consumes it, and
 * `bundle locate` only projects its result.
 */
export async function resolveLocalBundleTarget(
  dirFlag: string | undefined,
  startDir: string = process.cwd(),
): Promise<LocalBundleTarget> {
  if (dirFlag !== undefined) {
    const requested = path.resolve(startDir, dirFlag);
    // Ordered BEFORE existence resolution: the relation does not depend on the target existing, and
    // an absent target inside a guarded root must not fall through to the NOT_FOUND below, whose
    // help echoes `--dir` back as an `init --create-only` command pointing into private state.
    assertBundleOutsidePrivateState(requested);
    // Preserve the established project-directory shorthand when its direct conventional bundle is
    // indexed, but an own index is the higher-precedence exact boundary and must short-circuit
    // before inspecting conventional children (including a conflicting child pair).
    const ownIndex = await exists(path.join(requested, "index.md"));
    const conventional = ownIndex ? null : await conventionalBundleAt(requested);
    const root = ownIndex ? requested : conventional ?? requested;

    let canonicalRoot: string;
    try {
      canonicalRoot = await canonicalDirectoryRoot(
        root,
        `no local bundle directory at ${root}`,
        `${cliInvocation()} init --create-only --dir ${dirFlag}`,
      );
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      // A typo must not silently retarget an ancestor, but existing discovery still prevents
      // divergent init help when the requested target is unavailable or not a directory.
      const enclosing = await findBundleRoot(requested);
      throw new CliError(
        "NOT_FOUND",
        `no local bundle directory at ${requested}`,
        {
          help: enclosing
            ? `${cliInvocation()} <command> --dir ${enclosing}`
            : `${cliInvocation()} init --create-only --dir ${dirFlag}`,
        },
      );
    }
    assertBundleOutsidePrivateState(canonicalRoot);
    return { root, canonicalRoot, selectedBy: "explicit-dir" };
  }

  const binding = await resolveProjectBinding(startDir);
  if (binding) {
    // A committed local binding is also an exact declared boundary. Like explicit --dir, it does
    // not need the optional root index.md; malformed and unavailable targets still fail closed.
    // Same ordering as explicit `--dir`: an ABSENT binding target inside a guarded root would
    // otherwise emit an `init --create-only --dir <private path>` help.
    assertBundleOutsidePrivateState(path.resolve(binding.target));
    const canonicalRoot = await canonicalDirectoryRoot(
      binding.target,
      `no local bundle directory at ${binding.target} — from project binding ${binding.file}`,
      `${cliInvocation()} init --create-only --dir ${binding.target}`,
    );
    assertBundleOutsidePrivateState(canonicalRoot);
    return {
      root: binding.target,
      canonicalRoot,
      selectedBy: "project-binding",
      bindingFile: binding.file,
    };
  }

  const discovered = await findBundleRoot(startDir);
  if (!discovered) {
    throw new CliError(
      "NOT_FOUND",
      `no OKF bundle found (no index.md, and no ${CONVENTIONAL_BUNDLE_DIR_NAME}/index.md, in the current directory or its ancestors)`,
      { help: `${cliInvocation()} init --create-only --dir ${CONVENTIONAL_BUNDLE_DIR_NAME}` },
    );
  }
  const canonicalRoot = await canonicalDirectoryRoot(
    discovered,
    `no OKF bundle at ${discovered} (no index.md)`,
    `${cliInvocation()} init --create-only --dir ${CONVENTIONAL_BUNDLE_DIR_NAME}`,
  );
  assertBundleOutsidePrivateState(canonicalRoot);
  return { root: discovered, canonicalRoot, selectedBy: "discovery" };
}

function bindingPathConflict(target: LocalBundleTarget, message: string): CliError {
  return new CliError("CONFLICT", `project binding cannot be used: ${message}`, {
    details: { binding_file: target.bindingFile, binding_target: target.root, validation_stage: "lexical-path" },
  });
}

function strictlyLexicalAncestor(ancestor: string, descendant: string): boolean {
  const relative = path.relative(ancestor, descendant);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** macOS exposes these physical paths through stable lexical aliases. Never derive aliases from a binding target. */
function lexicalBindingAnchors(anchor: string): string[] {
  const anchors = [anchor];
  if (process.platform !== "darwin") return anchors;
  for (const [physical, lexical] of [
    [path.join(path.sep, "private", "var"), path.join(path.sep, "var")],
    [path.join(path.sep, "private", "tmp"), path.join(path.sep, "tmp")],
  ] as const) {
    if (anchor === physical || anchor.startsWith(`${physical}${path.sep}`)) {
      anchors.push(`${lexical}${anchor.slice(physical.length)}`);
    }
  }
  return anchors;
}

/**
 * Inspect a binding's lexical route before any bundle open, summary, Git, or private-state
 * operation can follow it. Links strictly before the binding-file anchor are outside the route;
 * all remaining links are part of the declared route, even when they resolve to an ancestor.
 */
async function bindingRouteTraversesSymlink(target: LocalBundleTarget): Promise<boolean> {
  if (target.selectedBy !== "project-binding") return false;
  if (!target.bindingFile) throw bindingPathConflict(target, "the selected binding has no source path");

  const lexicalAnchor = path.resolve(path.dirname(target.bindingFile));
  const lexicalAnchors = lexicalBindingAnchors(lexicalAnchor);
  const targetRoot = path.resolve(target.root);
  const parsedTargetRoot = path.parse(targetRoot).root;
  // Split only the path below its filesystem root. Splitting an absolute Windows path directly
  // includes the drive designator ("C:") and would incorrectly probe "C:\\C:" as the first
  // lexical component.
  const targetParts = targetRoot.slice(parsedTargetRoot.length).split(path.sep).filter(Boolean);

  let traversesBindingSymlink = false;
  let current = parsedTargetRoot;
  for (const segment of targetParts) {
    current = path.join(current, segment);
    let info;
    try {
      info = await fs.lstat(current);
    } catch {
      throw bindingPathConflict(target, `the lexical path component ${current} is unavailable`);
    }
    if (info.isSymbolicLink()) {
      // A platform alias such as macOS's /var -> /private/var can occur strictly before the
      // binding anchor. Exception eligibility is lexical, never based on where the link resolves:
      // a descendant link that resolves back to an ancestor is still part of the binding route.
      const strictlyBeforeAnchor = lexicalAnchors.some((anchor) => strictlyLexicalAncestor(current, anchor));
      if (!strictlyBeforeAnchor) traversesBindingSymlink = true;
    }
  }

  return traversesBindingSymlink;
}

async function captureDirectoryIdentity(target: LocalBundleTarget): Promise<DirectoryIdentity> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(target.root);
  } catch {
    throw bindingPathConflict(target, "the selected target is unavailable");
  }
  assertBundleOutsidePrivateState(path.resolve(target.root));
  assertBundleOutsidePrivateState(canonicalRoot);
  if (canonicalRoot !== target.canonicalRoot) {
    throw bindingPathConflict(target, "the selected target changed while its lexical path was validated");
  }
  let stat: Stats;
  try {
    stat = await fs.stat(canonicalRoot);
  } catch {
    throw bindingPathConflict(target, "the selected target is unavailable");
  }
  if (!stat.isDirectory()) throw bindingPathConflict(target, "the selected target is not a directory");
  return { canonicalRoot, dev: stat.dev, ino: stat.ino };
}

async function hasOwnGitWorktreeSignature(root: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * A symlinked conventional target is never allowed to become a board route. This is an FS-only
 * refusal, intentionally before the owner validator can open Git or private state.
 */
async function assertSymlinkedTargetIsNotBoardShaped(
  target: LocalBundleTarget,
  identity: DirectoryIdentity,
): Promise<void> {
  if (!BUNDLE_DIRS.includes(path.basename(identity.canonicalRoot) as (typeof BUNDLE_DIRS)[number])) return;
  if (await hasOwnGitWorktreeSignature(identity.canonicalRoot)) {
    throw bindingPathConflict(target, "the symlinked target has a conventional board-worktree signature");
  }
}

/** Revalidate the frozen physical target immediately before a bound-local engine operation. */
export async function assertResolvedLocalRouteIdentity(route: ResolvedLocalRoute): Promise<void> {
  if (route.kind !== "bound-local") return;
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(route.target.root);
  } catch {
    throw bindingPathConflict(route.target, "the selected target is unavailable");
  }
  assertBundleOutsidePrivateState(path.resolve(route.target.root));
  assertBundleOutsidePrivateState(canonicalRoot);
  if (canonicalRoot !== route.identity.canonicalRoot) {
    throw bindingPathConflict(route.target, "the selected target changed after classification");
  }
  let stat: Stats;
  try {
    stat = await fs.stat(canonicalRoot);
  } catch {
    throw bindingPathConflict(route.target, "the selected target is unavailable");
  }
  if (stat.dev !== route.identity.dev || stat.ino !== route.identity.ino) {
    throw bindingPathConflict(route.target, "the selected target identity changed after classification");
  }
}

/** Resolve one selected local bundle and, for bindings only, its possible frozen board capability. */
export async function resolveLocalBundleRoute(
  dirFlag: string | undefined,
  startDir: string = process.cwd(),
): Promise<ResolvedLocalRoute> {
  const target = await resolveLocalBundleTarget(dirFlag, startDir);
  const bundle: Bundle = { root: target.root };
  if (target.selectedBy !== "project-binding") return { kind: "unbound", target, bundle };

  const traversesBindingSymlink = await bindingRouteTraversesSymlink(target);
  const identity = await captureDirectoryIdentity(target);
  if (traversesBindingSymlink) {
    await assertSymlinkedTargetIsNotBoardShaped(target, identity);
    const route: ResolvedLocalRoute = {
      kind: "bound-local",
      target,
      bundle: { root: identity.canonicalRoot },
      identity,
    };
    await assertResolvedLocalRouteIdentity(route);
    return route;
  }
  const board = await validateBoundBoardOwner(target);
  if (board) return { kind: "bound-board", readiness: board.readiness, target, bundle, owner: board.owner };
  const route: ResolvedLocalRoute = { kind: "bound-local", target, bundle, identity };
  await assertResolvedLocalRouteIdentity(route);
  return route;
}

/** Compute mutation attribution before persistence; post-persist code receives only this value. */
export function boardAttributionForRoute(route: ResolvedLocalRoute): BoardAttribution {
  if (route.kind === "bound-board") {
    return route.readiness === "ready" ? { kind: "board", stateKey: route.owner.stateKey } : { kind: "none" };
  }
  if (route.kind === "bound-local") return { kind: "none" };
  if (!BUNDLE_DIRS.includes(path.basename(route.bundle.root) as (typeof BUNDLE_DIRS)[number])) return { kind: "none" };
  try {
    return { kind: "board", stateKey: resolveBundleKey(route.bundle.root) };
  } catch {
    // Unbound conventional bundles retain historic self-attribution only when Git is available.
    // Attribution is optional post-persist bookkeeping, never an authority to make a local write fail.
    return { kind: "none" };
  }
}

/**
 * Resolve the {@link Bundle} an OKF command should operate on: `--remote <url>` wins (mutually
 * exclusive with `--dir`, checked here — a USAGE error, exit 2, if both are given); otherwise the
 * existing filesystem discovery applies. With `--dir`, an existing requested directory is the
 * exact bundle boundary even when OKF's optional root index is absent; an indexed direct
 * conventional child keeps the established project-directory shorthand. It never selects an
 * ancestor. Without either,
 * a committed `.agentstate.json` directory-type binding applies next (item 43 follow-on — see the
 * module header); only then does discovery walk up from the cwd. Throws a NOT_FOUND CliError (exit
 * 6) when no LOCAL bundle is found — the fixing command points at `superbee init`.
 *
 * Callers pass `remoteFlag` through {@link resolveRemoteFlag} first, so any truthy value here is an
 * explicit `--remote` flag and the mutual-exclusion error below is unambiguous.
 */
export async function openBundle(dirFlag: string | undefined, remoteFlag?: string): Promise<Bundle> {
  if (remoteFlag !== undefined) {
    if (dirFlag !== undefined) {
      throw new CliError(
        "USAGE",
        "--remote and --dir are mutually exclusive",
        { help: `${cliInvocation()} <command> --remote <url>` },
      );
    }
    return openRemoteBundle(remoteFlag);
  }
  const route = await resolveLocalBundleRoute(dirFlag);
  await assertResolvedLocalRouteIdentity(route);
  return route.bundle;
}
