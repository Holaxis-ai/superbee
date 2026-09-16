/**
 * THE CONTRACT for emitted commands, as an executable specification.
 *
 * Stated once, in one sentence:
 *
 *   For every emitted command containing a rendered value, on every supported shell, executing that
 *   command PARSES, and DELIVERS the value verbatim as exactly ONE argument, with nothing expanded.
 *
 * Everything this change has chased is a corollary. The reason those escaped is that the tests
 * asserted what the renderer RETURNS AS A STRING, on one platform — never what a shell does with it.
 * The three properties below fail independently and are therefore asserted independently:
 *
 *   (a) RENDERS  — a token is produced, or the documented placeholder is.
 *   (b) PARSES   — the shell accepts the command line. Nothing in this repo asserted this before.
 *   (c) DELIVERS — argv holds the value verbatim as one element, and no expansion occurred.
 *
 * A shell that is absent SKIPS VISIBLY. It never passes vacuously: `unavailableReason` is reported
 * so a reader can tell "verified here" from "not run here".
 */
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A value the CLI does not own, in the shapes that have actually produced findings. */
export interface ContractValue {
  id: string;
  value: string;
  /** Why this shape is in the table — so a future reader cannot delete it as noise. */
  because: string;
}

export const CONTRACT_VALUES: readonly ContractValue[] = [
  { id: "plain", value: "task", because: "the inert baseline: must pass through unquoted" },
  { id: "multi-word", value: "Context Note", because: "a space must not split into two arguments" },
  { id: "apostrophe", value: "Owner's Guide", because: "ordinary text; the POSIX quote character" },
  { id: "double-quote", value: 'He said "hi"', because: "quoted user text must stay one argument" },
  { id: "typographic-quote", value: "a\u201db", because: "Unicode punctuation must survive verbatim" },
  { id: "substitution", value: "a$(id)b", because: "command substitution executes in sh" },
  { id: "backtick", value: "a`id`b", because: "backticks execute in sh" },
  { id: "percent", value: "%SUPERBEE_PROBE_VAR%", because: "percent-bearing user data must survive verbatim" },
  { id: "bang", value: "a!SUPERBEE_PROBE_VAR!b", because: "punctuation-bearing user data must survive verbatim" },
  { id: "trailing-backslash", value: "C:\\dir\\", because: "a trailing backslash must survive verbatim" },
  { id: "windows-path", value: "C:\\Program Files\\x", because: "foreign-platform paths remain ordinary user data" },
  { id: "posix-path", value: "/tmp/a b/x", because: "a path that must stay one argument" },
  { id: "encoded-url", value: "http://example.com/a%20b", because: "percent-encoding is routine, not exotic" },
  { id: "empty", value: "", because: "an empty value must still be one argument, not zero" },
  { id: "flag-shaped", value: "--body-file", because: "quoting cannot fix this; the contract must not claim it does" },
  { id: "unicode", value: "caf\u00e9 \u2713", because: "non-ASCII must survive byte-for-byte" },
  { id: "newline", value: "a\nb", because: "a line break must not become two commands" },
];

export interface ShellRun {
  /** argv the child actually received, or `undefined` when the child never ran at all. */
  argv: string[] | undefined;
  stderr: string;
  status: number | null;
}

export interface Shell {
  id: string;
  available: boolean;
  unavailableReason?: string;
  /** Execute `<node> <dump> <renderedToken>` through this shell. */
  run: (renderedToken: string, dump: string, argvOut: string) => ShellRun;
}

function has(binary: string, probeArgs: string[]): boolean {
  try {
    execFileSync(binary, probeArgs, { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** Quote a path for the shell we are invoking THROUGH — harness plumbing, not the value under test. */
const posixPath = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The dumper writes the argument COUNT first, then the values, all NUL-separated. Without the count
 * an empty file is ambiguous between "the child never ran" and "the child received one empty
 * argument" — and the empty value is precisely one of the cases under test, so the harness must be
 * able to tell those apart. (It could not, at first: the empty cell reported a PARSE failure for a
 * command that had parsed perfectly.)
 */
function readArgv(argvOut: string): string[] | undefined {
  if (!existsSync(argvOut)) return undefined;
  const raw = readFileSync(argvOut, "utf8");
  if (raw === "") return undefined;
  const [count, ...rest] = raw.split("\u0000");
  const expected = Number(count);
  return Number.isNaN(expected) ? undefined : rest.slice(0, expected);
}

export function shells(): Shell[] {
  const pwsh = ["pwsh", "powershell"].find((candidate) => has(candidate, ["-NoProfile", "-Command", "exit 0"]));
  const node = process.execPath;

  return [
    {
      id: "sh",
      available: existsSync("/bin/sh"),
      unavailableReason: "no /bin/sh on this host",
      run: (token, dump, argvOut) => {
        const line = `${posixPath(node)} ${posixPath(dump)} ${token}`;
        const result = spawnSync("/bin/sh", ["-c", line], {
          encoding: "utf8", timeout: 60_000,
          env: { ...process.env, SUPERBEE_ARGV_OUT: argvOut, SUPERBEE_PROBE_VAR: "EXPANDED" },
        });
        return { argv: readArgv(argvOut), stderr: result.stderr ?? "", status: result.status };
      },
    },
    {
      id: "pwsh",
      available: pwsh !== undefined,
      unavailableReason: "no pwsh/powershell on this host",
      run: (token, dump, argvOut) => {
        const line = `& ${posixPath(node)} ${posixPath(dump)} ${token}`;
        const result = spawnSync(pwsh!, ["-NoProfile", "-NonInteractive", "-Command", line], {
          encoding: "utf8", timeout: 60_000,
          env: { ...process.env, SUPERBEE_ARGV_OUT: argvOut, SUPERBEE_PROBE_VAR: "EXPANDED" },
        });
        return { argv: readArgv(argvOut), stderr: result.stderr ?? "", status: result.status };
      },
    },
  ];
}

export interface Harness {
  dump: string;
  argvOut: string;
  cleanup: () => void;
}

/** An argv dumper that writes NUL-separated arguments, so no value can be confused with a separator. */
export function makeHarness(): Harness {
  const home = mkdtempSync(path.join(tmpdir(), "superbee-contract-"));
  const dump = path.join(home, "dump.cjs");
  const argvOut = path.join(home, "argv.bin");
  writeFileSync(
    dump,
    'const a = process.argv.slice(2);\n'
    + 'require("node:fs").writeFileSync(process.env.SUPERBEE_ARGV_OUT, [String(a.length), ...a].join("\\u0000"));\n',
    "utf8",
  );
  return { dump, argvOut, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
