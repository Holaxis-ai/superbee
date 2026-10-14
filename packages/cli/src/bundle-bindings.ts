// Which copy of each declared dependency a command reads: the CLI side of cross-bundle links.
//
// Resolution is explicit. Without `--with` or `--with-deps` nothing here runs and no other bundle
// is read. `--with alias=<value>` names one copy; `--with-deps` binds each alias's committed `path`,
// but only inside the referring bundle's own git repository. Core owns the grammar, the
// declaration and the resolver; this module only turns flags into `BundleBinding`s (a backend, the
// copy's identity and a git subtree `PinCheck`).
import { existsSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  BUNDLE_NAME_DOC_ID,
  declaredBundleId,
  isBundleAlias,
  readDoc,
  type Bundle,
  type BundleBinding,
  type CommitPin,
  type DependencyMap,
  type PinCheck,
} from "@superbee/core";
import { backendFor } from "@superbee/core/bundle-ops";
import { runGit } from "@superbee/board-git";

import { openBundle } from "./bundle.js";
import { loadCatalog, resolveCatalogEntry } from "./catalog.js";
import { CliError } from "./errors.js";
import { bindingForPath } from "./hosted/binding.js";
import { cliInvocation } from "./invocation.js";
import { commandToken } from "./command-text.js";

/** A binding problem, reported beside the parser's `DEP_*` rows in `dependency_problems`. */
export interface BindingProblem {
  code: "BIND_OUTSIDE_REPO" | "BIND_PATH_MISSING" | "BIND_NOT_A_BUNDLE" | "BIND_IDENTITY_CONFLICT" | "GIT_MISSING";
  alias: string;
  detail: string;
}

export interface BoundCopy {
  /** The canonical root that was bound, as shown in the `bound` column. */
  root: string;
  via: "with" | "with-deps";
}

export interface ResolvedBindings {
  bindings: Map<string, BundleBinding>;
  bound: Map<string, BoundCopy>;
  problems: BindingProblem[];
}

export interface BindingRequest {
  /** The referring bundle's root. */
  referringRoot: string | null;
  dependencies: DependencyMap;
  /** Raw `--with` values, `alias=<path or catalog label>`. */
  withValues: readonly string[];
  withDeps: boolean;
  /** Resolves relative `--with` paths and the ambiguity check (default: the process cwd). */
  cwd?: string;
  /** The home whose private state holds the catalog and hosted bindings (default: the OS home). */
  home?: string;
}

/**
 * A `--with` value is a path when it contains `/` or `\`, starts with `.` or `~`, or is
 * drive-qualified (`C:`). Anything else is a catalog label.
 */
export function isWithPathValue(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.startsWith(".") || value.startsWith("~") || /^[A-Za-z]:/.test(value);
}

/** Split `--with alias=<value>` flags. Refuses a malformed flag or an alias given twice. */
export function parseWithFlags(values: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of values) {
    const eq = raw.indexOf("=");
    const alias = eq < 0 ? "" : raw.slice(0, eq).trim();
    const value = eq < 0 ? "" : raw.slice(eq + 1).trim();
    if (!alias || !value) {
      throw new CliError("USAGE", `--with expects alias=<path or catalog label>, got '${raw}'`, {
        help: `${cliInvocation()} status --with beers=../catalog/.superbee`,
      });
    }
    if (!isBundleAlias(alias)) {
      throw new CliError("USAGE", `--with alias '${alias}' must match ^[a-z][a-z0-9-]{0,62}$`);
    }
    if (out.has(alias)) throw new CliError("USAGE", `--with names alias '${alias}' more than once`);
    out.set(alias, value);
  }
  return out;
}

/** Thrown inside this module when the git binary is absent, so callers can fail closed with GIT_MISSING. */
class GitMissing extends Error {}

const GIT_MISSING_DETAIL = "GIT_MISSING: git is not installed on this machine";

function isGitMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "GIT_MISSING";
}

/** Run git; a missing binary throws {@link GitMissing}, any other spawn failure reads as a failed run. */
function git(dir: string, args: string[]): { status: number; stdout: string } {
  try {
    return runGit(dir, args);
  } catch (error) {
    if (isGitMissing(error)) throw new GitMissing(GIT_MISSING_DETAIL);
    return { status: -1, stdout: "" };
  }
}

function gitLine(dir: string, args: string[]): string | null {
  const result = git(dir, args);
  const text = result.stdout.trim();
  return result.status === 0 && text.length > 0 ? text : null;
}

async function canonicalOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** The canonical git toplevel holding `dir`, or null outside any repository. Throws {@link GitMissing}. */
async function gitTop(dir: string): Promise<string | null> {
  const top = gitLine(dir, ["rev-parse", "--show-toplevel"]);
  return top === null ? null : canonicalOrNull(top);
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * A commit pin names the bundle's subtree, not the repository HEAD: it holds when the tree at
 * `<pin>:<rel>` equals `HEAD:<rel>` and `git status --porcelain -- <rel>` is empty, so commits
 * elsewhere in a shared repository never break it. The dirty check ignores the user's git config:
 * untracked and gitignored files under the subtree both count, since either changes what a reader
 * of the copy sees. Without git the pin fails closed with GIT_MISSING.
 */
export function gitSubtreePinCheck(canonicalRoot: string): PinCheck {
  return async (pin: CommitPin) => {
    try {
      return await checkSubtreePin(canonicalRoot, pin);
    } catch (error) {
      if (error instanceof GitMissing) return { ok: false, detail: `${GIT_MISSING_DETAIL}, so pin ${pin.value} cannot be checked` };
      throw error;
    }
  };
}

async function checkSubtreePin(canonicalRoot: string, pin: CommitPin): Promise<{ ok: true } | { ok: false; detail: string }> {
  const top = await gitTop(canonicalRoot);
  if (top === null) return { ok: false, detail: `${canonicalRoot} is not in a git repository, so a commit pin cannot hold` };
  const rel = path.relative(top, canonicalRoot).split(path.sep).join("/");
  if (gitLine(top, ["rev-parse", "--verify", "--quiet", `${pin.value}^{commit}`]) === null) {
    return { ok: false, detail: `pin ${pin.value} is not a commit in this clone (a shallow clone lacks it)` };
  }
  const pinned = gitLine(top, ["rev-parse", "--verify", "--quiet", `${pin.value}:${rel}`]);
  const head = gitLine(top, ["rev-parse", "--verify", "--quiet", `HEAD:${rel}`]);
  if (pinned === null) return { ok: false, detail: `${rel || "."} does not exist at pin ${pin.value}` };
  if (pinned !== head) return { ok: false, detail: `${rel || "."} at HEAD differs from pin ${pin.value}` };
  const result = git(top, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--", rel === "" ? "." : rel]);
  if (result.status !== 0) return { ok: false, detail: `git status failed for ${rel || "."}` };
  if (result.stdout.trim() !== "") {
    return { ok: false, detail: `${rel || "."} has uncommitted, untracked or ignored files since pin ${pin.value}` };
  }
  return { ok: true };
}

/** Identity: `docs/bundle` `bundle_id`, else the hosted private binding. Never the checkout marker. */
async function identityOf(bundle: Bundle, canonicalRoot: string, home: string): Promise<{ id?: string; conflict?: string }> {
  let declared: string | undefined;
  try {
    declared = declaredBundleId(await readDoc(bundle, BUNDLE_NAME_DOC_ID));
  } catch {
    declared = undefined;
  }
  const hosted = (await bindingForPath(home, canonicalRoot).catch(() => null))?.bundle_id;
  if (declared !== undefined && hosted !== undefined && declared !== hosted) {
    return { conflict: `docs/bundle says '${declared}' but the hosted binding says '${hosted}'` };
  }
  const id = declared ?? hosted;
  return id === undefined ? {} : { id };
}

async function bindingFor(bundle: Bundle, home: string): Promise<{ binding: BundleBinding; root: string; conflict?: string }> {
  const root = (await canonicalOrNull(bundle.root)) ?? bundle.root;
  const identity = await identityOf(bundle, root, home);
  const binding: BundleBinding = { backend: backendFor(bundle), label: root, pin: gitSubtreePinCheck(root) };
  if (identity.id !== undefined) binding.identity = identity.id;
  return identity.conflict === undefined ? { binding, root } : { binding, root, conflict: identity.conflict };
}

/** Resolve one `--with` value to a bundle: a path, or a catalog label. A bare value that is both is refused. */
async function openWithValue(alias: string, value: string, cwd: string, home: string): Promise<Bundle> {
  if (isWithPathValue(value)) {
    const expanded = value === "~" || value.startsWith("~/") || value.startsWith("~\\") ? path.join(home, value.slice(1)) : value;
    return openBundle(path.resolve(cwd, expanded));
  }
  const catalog = await loadCatalog(home);
  const labelled = catalog.entries.some((entry) => entry.label === value);
  const local = path.resolve(cwd, value);
  let isDirectory = false;
  try {
    isDirectory = existsSync(local) && statSync(local).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (labelled && isDirectory) {
    throw new CliError(
      "USAGE",
      `the --with value '${alias}=${value}' is ambiguous: '${value}' is both a catalog label and a directory here`,
      { help: `${cliInvocation()} status --with ${commandToken(`${alias}=./${value}`)}  — the directory; run from another directory for the label` },
    );
  }
  if (!labelled && isDirectory) {
    throw new CliError("NOT_FOUND", `'${value}' is not a catalog label; a bare value is read as a label`, {
      help: `${cliInvocation()} status --with ${commandToken(`${alias}=./${value}`)}`,
    });
  }
  const entry = await resolveCatalogEntry(value, home);
  return openBundle(entry.locator.path);
}

/**
 * Build the bindings for `--with` and `--with-deps`. Returns nothing bound when neither flag is
 * given, without touching the filesystem.
 */
export async function resolveBundleBindings(request: BindingRequest): Promise<ResolvedBindings> {
  const out: ResolvedBindings = { bindings: new Map(), bound: new Map(), problems: [] };
  const explicit = parseWithFlags(request.withValues);
  if (explicit.size === 0 && !request.withDeps) return out;
  const home = request.home ?? homedir();
  const cwd = request.cwd ?? process.cwd();

  for (const alias of explicit.keys()) {
    if (!request.dependencies.has(alias)) {
      throw new CliError("USAGE", `--with names alias '${alias}', which docs/dependencies does not declare`, {
        help: `${cliInvocation()} doc read docs/dependencies`,
      });
    }
  }

  let top: string | null = null;
  let referringRoot: string | null = null;
  if (request.withDeps) {
    referringRoot = request.referringRoot === null ? null : await canonicalOrNull(request.referringRoot);
    try {
      top = referringRoot === null ? null : await gitTop(referringRoot);
    } catch (error) {
      if (!(error instanceof GitMissing)) throw error;
      // Fail closed: without git nothing confirms a declared path stays inside the repository.
      for (const entry of request.dependencies.values()) {
        if (explicit.has(entry.alias) || entry.path === undefined) continue;
        out.problems.push({ code: "GIT_MISSING", alias: entry.alias, detail: `${GIT_MISSING_DETAIL}, so --with-deps cannot confirm the path is inside the repository` });
      }
      request = { ...request, withDeps: false };
      referringRoot = null;
    }
    if (request.withDeps && top === null) {
      throw new CliError("USAGE", "--with-deps binds declared paths only inside the bundle's git repository, and this bundle is not in one", {
        help: `${cliInvocation()} status --with <alias>=<path>`,
      });
    }
  }

  const add = async (alias: string, bundle: Bundle, via: BoundCopy["via"]): Promise<void> => {
    const { binding, root, conflict } = await bindingFor(bundle, home);
    if (conflict !== undefined) out.problems.push({ code: "BIND_IDENTITY_CONFLICT", alias, detail: conflict });
    out.bindings.set(alias, binding);
    out.bound.set(alias, { root, via });
  };

  for (const [alias, value] of explicit) await add(alias, await openWithValue(alias, value, cwd, home), "with");

  if (request.withDeps && top !== null && referringRoot !== null) {
    for (const entry of request.dependencies.values()) {
      if (explicit.has(entry.alias) || entry.path === undefined) continue;
      const target = await canonicalOrNull(path.resolve(referringRoot, entry.path));
      if (target === null) {
        out.problems.push({ code: "BIND_PATH_MISSING", alias: entry.alias, detail: `declared path ${entry.path} does not exist` });
        continue;
      }
      if (!isInside(top, target)) {
        out.problems.push({ code: "BIND_OUTSIDE_REPO", alias: entry.alias, detail: "path outside repository" });
        continue;
      }
      let bundle: Bundle;
      try {
        bundle = await openBundle(target);
      } catch (error) {
        out.problems.push({ code: "BIND_NOT_A_BUNDLE", alias: entry.alias, detail: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const opened = await canonicalOrNull(bundle.root);
      if (opened === null || !isInside(top, opened)) {
        out.problems.push({ code: "BIND_OUTSIDE_REPO", alias: entry.alias, detail: "path outside repository" });
        continue;
      }
      await add(entry.alias, bundle, "with-deps");
    }
  }
  return out;
}
