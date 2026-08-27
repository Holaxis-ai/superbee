// Resolve the running CLI's OWN invocation for emitted follow-up commands + the home-view identity.
//
// The CLI is a standalone, npm-publishable package (`superbee`; the successor installs only that
// bin while legacy `aslite` / `agentstate-lite` invocations remain migration-recognized). Per AXI
// §7/§10 a printed
// follow-up command must be COPY-PASTE runnable and never a phantom path:
//
//   • cliInvocation() — the runnable command PREFIX for hints/help. If a managed bin name resolves on
//     PATH to THIS executable, we emit the bare name (`superbee`, portable across installs);
//     otherwise we fall back to `npx -y superbee` (the npm-first distribution form).
//     Never an absolute dist path.
//   • exactCliInvocation() — the command PREFIX for a transactional continuation that MUST be
//     executed by the same artifact. It pins the current Node runtime, its execution arguments,
//     and the registered CLI entry instead of consulting PATH or the npm registry.
//   • binPath() — the home-collapsed ABSOLUTE path of the running executable, for the home view's
//     `bin:` identity field (AXI §10: "identify the tool itself before the live data").
//
// This resolves against the REAL running module (import.meta.url / process.argv[1]) — no committed
// shim, no `dist/axi`. The former phantom-shim resolver is gone.
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { renderGeneratedHookToken } from "./hook-compatibility.js";

/** The npm package coordinate — the token used for the `npx -y <pkg>` fallback. */
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

/** Quote one arbitrary value as a single host-shell argument for emitted copy-paste commands. */
export function shellArg(value: string): string {
  if (process.platform === "win32") return renderGeneratedHookToken(value, "win32");
  return `'${value.replaceAll("'", "'\\''")}'`;
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

/** The absolute real path of the registered CLI entry (bundled or source), or a helper fallback. */
export function currentExecutableRealPath(): string | undefined {
  if (registeredExecutableEntry) return registeredExecutableEntry;
  // import.meta.url is the running module; under the bundle that IS the executable file.
  // Helper-only unit tests do not evaluate src/index.ts and deliberately retain this fallback.
  const fromModule = realOrUndefined(fileURLToPath(import.meta.url));
  if (fromModule) return fromModule;
  const argv1 = process.argv[1];
  return argv1 ? realOrUndefined(argv1) : undefined;
}

/**
 * If a managed bin name (`superbee` or a supported legacy alias) is found on PATH and its realpath matches the
 * running executable, return that bare name (portable). Otherwise undefined. POSIX PATH scan — the
 * target platforms are macOS/Linux; Windows PATHEXT is not handled (the tool ships as an .mjs).
 */
export function managedBinNameOnPath(): string | undefined {
  const exe = currentExecutableRealPath();
  if (!exe) return undefined;
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of BIN_NAMES) {
    for (const dir of dirs) {
      const resolved = realOrUndefined(join(dir, name));
      if (resolved && resolved === exe) return name;
    }
  }
  return undefined;
}

/**
 * The runnable command prefix for emitted follow-ups: the bare bin name when this executable is on
 * PATH; otherwise `npx -y superbee`. Every `help:` field and success `help[]` entry is built
 * from this so a copy-pasted next step always runs the supported npm artifact.
 */
export function cliInvocation(): string {
  const onPath = managedBinNameOnPath();
  if (onPath) return onPath;
  return `npx -y ${PACKAGE_NAME}`;
}

/**
 * An artifact-bound command prefix for receipts whose continuation is valid only for the CLI that
 * produced them. Generic help should keep using {@link cliInvocation}; an absolute entry path is
 * appropriate only when substituting another installed or registry artifact would break the
 * command's state/feature contract.
 */
export function exactCliInvocation(): string {
  // Only src/index.ts can establish production command-dispatch identity. Helper-only unit imports
  // deliberately have no exact executable contract and retain the portable guidance fallback.
  if (!registeredExecutableEntry) return cliInvocation();
  const node = realOrUndefined(process.execPath) ?? process.execPath;
  return [node, ...process.execArgv, registeredExecutableEntry].map(shellArg).join(" ");
}

/**
 * The home-collapsed ABSOLUTE path of the running executable — the home view's `bin:` identity field
 * (AXI §10). Falls back to the package name if the path cannot be resolved.
 */
export function binPath(): string {
  const exe = currentExecutableRealPath();
  return exe ? collapseHomeDirectory(exe) : PACKAGE_NAME;
}

/**
 * The command a persistent SessionStart hook should run: the bare bin name when on PATH (fast,
 * portable), else the ABSOLUTE executable path (directly runnable via its shebang) — NOT the npx
 * form, so a per-session hook has no network/startup cost. This mirrors the axi-sdk-js
 * `resolvePortableHookCommand` semantics, so the value we DISPLAY matches what the installer writes.
 */
export function hookCommand(): string {
  return managedBinNameOnPath() ?? currentExecutableRealPath() ?? PACKAGE_NAME;
}
