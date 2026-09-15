import { commandToken } from "./command-text.js";
import { currentHost, distributionLayouts, distributionPackageName } from "./runtime-context.js";
// Resolve the running CLI's OWN invocation for emitted follow-up commands + the home-view identity.
//
// The CLI is a standalone, npm-publishable package (`superbee`; the successor installs only that
// bin while legacy `aslite` / `agentstate-lite` invocations remain migration-recognized). Per AXI
// §7/§10 a printed
// follow-up command must be COPY-PASTE runnable and never a phantom path:
//
//   • cliInvocation() — the runnable command PREFIX for hints/help. If a managed bin name resolves on
//     PATH to THIS executable, we emit the bare name (`superbee`, portable across installs);
//     otherwise we fall back to `npx --no-install superbee`, which never downloads a different
//     package version while rendering an actionable hint.
//     Never an absolute dist path.
//   • exactCliInvocation() — the command PREFIX for a transactional continuation that MUST be
//     executed by the same artifact. It pins the current Node runtime, its execution arguments,
//     and the registered CLI entry instead of consulting PATH or the npm registry.
//   • binPath() — the home-collapsed ABSOLUTE path of the running executable, for the home view's
//     `bin:` identity field (AXI §10: "identify the tool itself before the live data").
//
// The executable registers its real entry explicitly; imported helpers never become worker targets.
import { readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { renderShellToken } from "./shell-quoting.js";
// Type-only (erased at runtime): command-text.ts imports shellArg from here, so a value import
// would close a cycle. Branding the two invocation prefixes is what lets the quoting checker
// recognise a command-shaped template literal by TYPE instead of by pattern-matching its text.
import type { CommandPrefix, CommandText } from "./command-text.js";

/** The npm package coordinate — the token used for the no-download npx fallback. */
export const PACKAGE_NAME = "superbee";
/** Recognized current and legacy bin names; only the first is installed by the successor package. */
export const BIN_NAMES = ["superbee", "aslite", "agentstate-lite"] as const;

/** Collapse a leading $HOME to `~` (e.g. /Users/me/x → ~/x). Non-home paths pass through verbatim. */
export function collapseHomeDirectory(p: string): string {
  const home = homedir();
  if (home && (p === home || p.startsWith(home + "/"))) {
    return "~" + p.slice(home.length);
  }
  return p;
}

/**
 * Quote one arbitrary value as a single host-shell argument for emitted copy-paste commands. The
 * result is branded {@link CommandText}: this is the low-level quoting authority, and always-quote
 * is unconditionally safe, so a site already using it needs no change. New sites should prefer
 * `commandToken` from command-text.ts, which leaves inert values unquoted and keeps help readable.
 *
 * The selected host renderer throws for values it cannot render inertly (see
 * shell-quoting.ts); `commandToken` absorbs that, so such a value degrades one hint rather than
 * aborting the diagnostic carrying it.
 */
export function shellArg(value: string): CommandText {
  return renderShellToken(value) as CommandText;
}


/** realpath a path, or undefined if it does not exist / is not resolvable. */
function realOrUndefined(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

let registeredExecutableEntry: string | undefined;

/**
 * Register the production entry module before command dispatch. In a bundle, the entry module's
 * import.meta.url is the emitted .mjs; in a loader-driven source run it is src/index.ts. Imported
 * helpers and test runners must never replace that explicit entry with their own module path.
 */
export function registerExecutableEntry(entryPath: string): void {
  const resolved = realOrUndefined(entryPath);
  if (!resolved) return;
  if (registeredExecutableEntry && registeredExecutableEntry !== resolved) {
    throw new Error(
      `CLI executable entry was already registered as ${registeredExecutableEntry}; refusing ${resolved}`,
    );
  }
  registeredExecutableEntry = resolved;
}

/** The absolute real path of the registered CLI entry (bundled or source), if configured. */
export function currentExecutableRealPath(): string | undefined {
  if (registeredExecutableEntry) return registeredExecutableEntry;
  // A library module and argv from an unrelated host are never executable authority.
  return undefined;
}

/** Resolve a managed bin against this registered executable and exact host shim grammar. */
export function managedBinNameOnPath():string|undefined {
 const exe=currentExecutableRealPath();if(!exe)return undefined;
 const host=currentHost(); const layouts=distributionLayouts();
 const dirs=(process.env.PATH??'').split(host.paths.delimiter).filter(Boolean);
 for(const name of layouts.flatMap(layout=>layout.bins)) for(const dir of dirs) {
   let found=false;
   for(const candidate of host.executableCandidates(dir,name,process.env)) {
     const resolved=realOrUndefined(candidate);if(!resolved)continue;found=true;
     if(host.binMatches(candidate,resolved,exe,process.execPath,layouts))return name;
     break;
   }
   if(found)break;
 }
 return undefined;
}

/**
 * The runnable command prefix for emitted follow-ups: the bare bin name when this executable is on
 * PATH; otherwise `npx --no-install superbee`. Every `help:` field and success `help[]` entry is
 * built from this so a copy-pasted next step never silently downloads a newer npm artifact.
 */
export function cliInvocation(): CommandPrefix {
  const onPath = managedBinNameOnPath();
  if (onPath) return onPath as CommandPrefix;
  return `npx --no-install ${commandToken(distributionPackageName())}` as CommandPrefix;
}

/**
 * An artifact-bound command prefix for receipts whose continuation is valid only for the CLI that
 * produced them. Generic help should keep using {@link cliInvocation}; an absolute entry path is
 * appropriate only when substituting another installed or registry artifact would break the
 * command's state/feature contract.
 */
export function exactCliInvocation(): CommandPrefix {
  // Only src/index.ts can establish production command-dispatch identity. Helper-only unit imports
  // deliberately have no exact executable contract and retain the portable guidance fallback.
  if (!registeredExecutableEntry) return cliInvocation();
  const node = realOrUndefined(process.execPath) ?? process.execPath;
  return [node, ...process.execArgv, registeredExecutableEntry].map(shellArg).join(" ") as CommandPrefix;
}

/**
 * The home-collapsed ABSOLUTE path of the running executable — the home view's `bin:` identity field
 * (AXI §10). Falls back to the package name if the path cannot be resolved.
 */
export function binPath(): string {
  const exe = currentExecutableRealPath();
  return exe ? collapseHomeDirectory(exe) : distributionPackageName();
}

/**
 * The command a persistent SessionStart hook should run: the bare bin name when on PATH (fast,
 * portable), else the ABSOLUTE executable path (directly runnable via its shebang) — NOT the npx
 * form, so a per-session hook has no network/startup cost. This mirrors the axi-sdk-js
 * `resolvePortableHookCommand` semantics, so the value we DISPLAY matches what the installer writes.
 */
export function hookCommand(): string {
  return managedBinNameOnPath() ?? currentExecutableRealPath() ?? distributionPackageName();
}
