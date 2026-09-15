import path from "node:path";
import { homedir } from "node:os";
import { constants } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import type {
  HostCommands,
  PrivateStateHost,
  UserStateEnvironment,
  UserStatePolicy,
} from "./runtime-types.js";
import { HostCommandError } from "./host-command-error.js";

export function assertSupportedCliHost(
  platform: string = process.platform,
): void {
  if (platform !== "darwin" && platform !== "linux")
    throw new Error(
      "This Superbee distribution supports macOS and Linux; use a Windows distribution on Windows.",
    );
}
function renderGeneratedHookToken(value: string): string {
  return isSafeUnquotedHookToken(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}
function isSafeUnquotedHookToken(value: string): boolean {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value);
}
interface DoubleQuotedSegment {
  value: string;
  next: number;
}

function decodeDoubleQuotedSegment(
  command: string,
  start: number,
): DoubleQuotedSegment | undefined {
  let i = start + 1;
  let value = "";
  while (i < command.length) {
    const inner = command[i]!;
    if (inner === '"') return { value, next: i + 1 };
    const code = inner.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || inner === "$" || inner === "`")
      return undefined;
    if (inner === "\\") {
      const next = command[i + 1];
      if (next === undefined) return undefined;
      // POSIX double quotes consume a backslash only before $, `, ", or another backslash.
      if (next === "$" || next === "`" || next === '"' || next === "\\") {
        value += next;
        i += 2;
        continue;
      }
      value += "\\";
      i += 1;
      continue;
    }
    value += inner;
    i += 1;
  }
  return undefined;
}

function renderHistoricalDoubleQuotedHookToken(
  value: string,
): string | undefined {
  // The historical writer used JSON.stringify only when its command base contained whitespace.
  if (!/\s/.test(value)) return undefined;
  const rendered = JSON.stringify(value);
  const decoded = decodeDoubleQuotedSegment(rendered, 0);
  return decoded?.next === rendered.length && decoded.value === value
    ? rendered
    : undefined;
}

type HookTokenEnvelope = "current" | "historical_double";

interface PosixLexicalHookToken {
  raw: string;
  value: string;
  envelope: HookTokenEnvelope;
}

/**
 * Parse only enough shell syntax to recover raw token slices, then require every decoded token to
 * round-trip to one exact current or historical writer envelope. Shell-equivalent mixed, empty,
 * or partial quote segments are therefore foreign even when quote removal yields familiar argv.
 */
function lexicalPosixHookTokens(
  command: string,
): PosixLexicalHookToken[] | undefined {
  if (command.length === 0 || command.startsWith(" ") || command.endsWith(" "))
    return undefined;
  const tokens: PosixLexicalHookToken[] = [];
  let i = 0;
  while (i < command.length) {
    const start = i;
    let token = "";
    let consumed = false;
    while (i < command.length && command[i] !== " ") {
      consumed = true;
      const ch = command[i]!;
      if (ch === "'") {
        const end = command.indexOf("'", i + 1);
        if (end < 0) return undefined;
        token += command.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (ch === '"') {
        const segment = decodeDoubleQuotedSegment(command, i);
        if (!segment) return undefined;
        token += segment.value;
        i = segment.next;
        continue;
      }
      if (ch === "\\" && command[i + 1] === "'") {
        token += "'";
        i += 2;
        continue;
      }
      if (!isSafeUnquotedHookToken(ch)) return undefined;
      token += ch;
      i += 1;
    }
    if (!consumed) return undefined;
    if (
      [...token].some(
        (ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f,
      )
    ) {
      return undefined;
    }
    const raw = command.slice(start, i);
    const current = renderGeneratedHookToken(token);
    const historical = renderHistoricalDoubleQuotedHookToken(token);
    const envelope: HookTokenEnvelope | undefined =
      raw === current
        ? "current"
        : raw === historical
          ? "historical_double"
          : undefined;
    if (!envelope) return undefined;
    tokens.push({ raw, value: token, envelope });
    if (i < command.length) {
      i += 1;
      if (i === command.length || command[i] === " ") return undefined;
    }
  }
  if (tokens.some(({ envelope }) => envelope === "historical_double")) {
    const exactHistoricalCommand =
      tokens.length === 2 &&
      tokens[0]?.envelope === "historical_double" &&
      tokens[1]?.envelope === "current" &&
      tokens[1]?.raw === "session-start";
    if (!exactHistoricalCommand) return undefined;
  }
  return tokens.length > 0 ? tokens : undefined;
}

export function createPosixHostCommands(): HostCommands {
  assertSupportedCliHost();
  return {
    id: process.platform,
    paths: path.posix,
    resolveCommand(name) {
      if (!/^[a-z0-9._-]+$/i.test(name))
        throw new HostCommandError(
          "unreadable",
          "host command discovery requires one bare command name",
        );
      return Object.freeze({ display: name, file: name, shellWrapper: null });
    },
    runCommand(command, args, input, deps = {}) {
      try {
        return (deps.execFile ?? execFileSync)(command.file, [...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          env: input.env,
          cwd: input.cwd,
        }) as string;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR")
          throw new HostCommandError(
            "absent",
            `${command.display} was not found on PATH`,
          );
        throw new HostCommandError(
          "unreadable",
          `${command.display} could not be executed`,
        );
      }
    },
    renderShellToken(value) {
      return `'${value.replaceAll("'", "'\\''")}'`;
    },
    renderGeneratedHookToken,
    lexicalHookTokens: lexicalPosixHookTokens,
    sameResolvedPath: (a, b) => a === b,
    comparisonKey: (value) => path.posix.normalize(value),
    claudeDesktopConfigPath: (home, _env, platform = process.platform) =>
      platform === "darwin"
        ? path.posix.join(
            home,
            "Library",
            "Application Support",
            "Claude",
            "claude_desktop_config.json",
          )
        : undefined,
    npmPrefixInvocation: () => ({
      command: "npm",
      args: ["prefix", "--global"],
    }),
    npmGlobalPaths(prefix, layout) {
      return {
        executable: path.posix.join(
          prefix,
          "lib",
          "node_modules",
          ...layout.packageName.split("/"),
          layout.entryRelativePath,
        ),
        binDirectory: path.posix.join(prefix, "bin"),
      };
    },
    executableCandidates: (directory, name) => [
      path.posix.normalize(path.posix.join(directory, name)),
    ],
    installedBinPath: (prefix, name) =>
      path.posix.normalize(path.posix.join(prefix, name)),
    binMatches: (_candidate, resolved, executable) => resolved === executable,
    stableRuntimePath: (prefix) =>
      path.posix.normalize(path.posix.join(prefix, "node")),
    isCanonicalAbsolutePath: (value) =>
      path.posix.isAbsolute(value) && path.posix.normalize(value) === value,
    isNodeRuntimePath: (value) => value.endsWith("/bin/node"),
    isStableRuntimePair(program, executable, layout) {
      const suffix =
        "/lib/node_modules/" +
        layout.packageName +
        "/" +
        layout.entryRelativePath;
      return (
        program.endsWith("/bin/node") &&
        executable.endsWith(suffix) &&
        program.slice(0, -9) === executable.slice(0, -suffix.length)
      );
    },
    hasAdditionalStdinInput: () => false,
    openBrowser(url) {
      try {
        const child = spawn(
          process.platform === "darwin" ? "open" : "xdg-open",
          [url],
          { stdio: "ignore", detached: true },
        );
        child.once("error", () => {});
        child.unref();
      } catch {}
    },
    spawnChild: (file, args, options) => spawn(file, [...args], options),
  };
}
function stateEnvironment(
  input?: string | UserStateEnvironment,
): UserStateEnvironment {
  return typeof input === "object"
    ? input
    : {
        platform: process.platform,
        home: input ?? homedir(),
        env: process.env,
      };
}
function absoluteHome(input: UserStateEnvironment): string {
  if (!path.posix.isAbsolute(input.home))
    throw new Error(
      "private Superbee user-state root must be an absolute path",
    );
  return input.home;
}
function legacyRoot(input: UserStateEnvironment): string {
  return path.posix.join(absoluteHome(input), ".agentstate");
}
function supersededRoots(input: UserStateEnvironment): readonly string[] {
  return [path.posix.join(absoluteHome(input), ".config", "superbee")];
}
function resolvePolicy(input: UserStateEnvironment): UserStatePolicy {
  const home = absoluteHome(input);
  const canonicalRoot = path.posix.join(home, ".superbee-state");
  return {
    platform: input.platform,
    home,
    state: "ready",
    canonicalRoot,
    guardedRoots: [
      ...new Set([canonicalRoot, legacyRoot(input), ...supersededRoots(input)]),
    ],
    displayRoot: "~/.superbee-state",
  };
}
function displayPath(input: UserStateEnvironment, target: string): string {
  const rel = path.posix.relative(input.home, target);
  return rel === ""
    ? "~"
    : !rel.startsWith("..") && !path.posix.isAbsolute(rel)
      ? `~/${rel}`
      : target;
}
export function createPosixPrivateStateHost(): PrivateStateHost {
  assertSupportedCliHost();
  return {
    id: process.platform,
    enforcePrivateMode: true,
    environment: stateEnvironment,
    resolvePolicy,
    legacyRoot,
    supersededRoots,
    displayPath,
    migrationSources(input) {
      return [legacyRoot(input), ...supersededRoots(input)].map((root) => ({
        root,
        display: displayPath(input, root),
        requiresMarker: false,
      }));
    },
    currentUid: () => process.getuid?.(),
    privateRead: {
      flags:
        constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
      inspectBeforeOpen: false,
    },
    isTransientConfigReplaceError: () => false,
    sourceInspectionCommand: (display, detailed) =>
      `ls -l${detailed ? "a" : "d"} ${display}`,
    bundleBoundaryRecovery: (root, inv) =>
      `${root} lives inside it — create the bundle in a project directory instead: mkdir -p ~/projects/<name> && cd ~/projects/<name> && ${inv} init --create-only --dir .superbee (move any bundle files that already exist here into that directory first)`,
  };
}
