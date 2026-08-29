import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

export interface HostCommandEnvironment {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform | string;
}

export interface HostCommandDeps {
  readonly resolvePath?: (candidate: string) => string | undefined;
  readonly execFile?: (
    file: string,
    args: readonly string[],
    options: ExecFileSyncOptionsWithStringEncoding,
  ) => string;
}

export interface ResolvedHostCommand {
  readonly display: string;
  readonly file: string;
  readonly prefixArgs: readonly string[];
  readonly usesCommandShell: boolean;
}

export class HostCommandError extends Error {
  readonly state: "absent" | "unreadable";

  constructor(state: "absent" | "unreadable", message: string) {
    super(message);
    this.name = "HostCommandError";
    this.state = state;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function missingPath(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function defaultResolvePath(candidate: string): string | undefined {
  try {
    return realpathSync.native(candidate);
  } catch (error) {
    if (missingPath(error)) return undefined;
    throw error;
  }
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT?.trim() || ".COM;.EXE;.BAT;.CMD";
  const extensions = raw.split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  if (extensions.length === 0 || extensions.some((extension) => !/^\.[a-z0-9]+$/i.test(extension))) {
    throw new HostCommandError("unreadable", "Windows PATHEXT is not usable for command discovery");
  }
  return extensions;
}

function windowsPathDirectory(value: string): string {
  const trimmed = value.trim();
  const directory = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
  if (!directory || !path.win32.isAbsolute(directory)) {
    throw new HostCommandError("unreadable", "Windows PATH contains a relative or current-directory entry");
  }
  return directory;
}

function resolvedCommand(
  display: string,
  file: string,
  prefixArgs: readonly string[],
  usesCommandShell: boolean,
): ResolvedHostCommand {
  return Object.freeze({
    display,
    file,
    prefixArgs: Object.freeze([...prefixArgs]),
    usesCommandShell,
  });
}

/** Resolve one host command snapshot. Windows lookup follows PATH and PATHEXT in native order. */
export function resolveHostCommand(
  command: string,
  input: HostCommandEnvironment,
  deps: Pick<HostCommandDeps, "resolvePath"> = {},
): ResolvedHostCommand {
  if (!/^[a-z0-9._-]+$/i.test(command)) {
    throw new HostCommandError("unreadable", "host command discovery requires one bare command name");
  }
  if (input.platform !== "win32") return resolvedCommand(command, command, [], false);

  const rawPath = input.env.PATH;
  if (!rawPath) throw new HostCommandError("absent", `${command} was not found on PATH`);
  const resolvePath = deps.resolvePath ?? defaultResolvePath;
  let selected: string | undefined;
  let resolved: string | undefined;
  try {
    for (const rawDirectory of rawPath.split(path.win32.delimiter)) {
      const directory = windowsPathDirectory(rawDirectory);
      for (const extension of windowsExtensions(input.env)) {
        const candidate = path.win32.normalize(path.win32.join(directory, `${command}${extension}`));
        const found = resolvePath(candidate);
        if (!found) continue;
        if (!path.win32.isAbsolute(found)) {
          throw new HostCommandError("unreadable", `${command} resolved to a non-absolute path`);
        }
        selected = candidate;
        resolved = path.win32.normalize(found);
        break;
      }
      if (resolved) break;
    }
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    throw new HostCommandError("unreadable", `${command} command discovery could not inspect PATH`);
  }
  if (!selected || !resolved) throw new HostCommandError("absent", `${command} was not found on PATH`);

  const extension = path.win32.extname(selected).toLowerCase();
  const display = path.win32.basename(selected).toLowerCase();
  if (extension === ".exe" || extension === ".com") {
    return resolvedCommand(display, resolved, [], false);
  }
  if (extension !== ".cmd" && extension !== ".bat") {
    throw new HostCommandError("unreadable", `${display} is not a supported executable command form`);
  }

  const comspecCandidate = input.env.ComSpec?.trim()
    || input.env.COMSPEC?.trim()
    || (input.env.SystemRoot?.trim()
      ? path.win32.join(input.env.SystemRoot.trim(), "System32", "cmd.exe")
      : undefined);
  if (!comspecCandidate || !path.win32.isAbsolute(comspecCandidate)) {
    throw new HostCommandError("unreadable", "the Windows command processor could not be resolved safely");
  }
  let comspec: string | undefined;
  try {
    comspec = resolvePath(path.win32.normalize(comspecCandidate));
  } catch {
    throw new HostCommandError("unreadable", "the Windows command processor could not be resolved safely");
  }
  if (!comspec || !path.win32.isAbsolute(comspec)) {
    throw new HostCommandError("unreadable", "the Windows command processor could not be resolved safely");
  }
  return resolvedCommand(display, path.win32.normalize(comspec), ["/d", "/s", "/c", `"${resolved}"`], true);
}

function assertSafeCommandShellArgs(args: readonly string[]): void {
  if (args.some((value) => /[&|<>()^%!"\r\n]/.test(value))) {
    throw new HostCommandError("unreadable", "the host command contains an argument that cannot be relayed safely");
  }
}

/** Execute an already-resolved snapshot without repeating command discovery. */
export function runHostCommand(
  command: ResolvedHostCommand,
  args: readonly string[],
  input: HostCommandEnvironment,
  deps: Pick<HostCommandDeps, "execFile"> = {},
): string {
  if (command.usesCommandShell) assertSafeCommandShellArgs(args);
  const run = deps.execFile ?? ((file, passed, options) => execFileSync(file, passed, options));
  try {
    return run(command.file, [...command.prefixArgs, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: input.env,
      cwd: input.cwd,
      windowsHide: true,
    });
  } catch (error) {
    if (input.platform !== "win32" && missingPath(error)) {
      throw new HostCommandError("absent", `${command.display} was not found on PATH`);
    }
    throw new HostCommandError("unreadable", `${command.display} could not be executed`);
  }
}
