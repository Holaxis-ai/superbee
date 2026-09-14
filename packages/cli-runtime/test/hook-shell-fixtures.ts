const DIRECT = "/tmp/x/packages/cli/dist/agentstate-lite.mjs";
const directWith = (segment: string): string =>
  `/tmp/${segment}/packages/cli/dist/agentstate-lite.mjs session-start`;
const nodeWith = (segment: string): string =>
  `/opt/${segment}/bin/node /opt/${segment}/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs session-start`;

/** Shell-active or grammar-foreign strings that must never establish destructive ownership. */
export const SHELL_FOREIGN_COMMANDS: ReadonlyArray<{ family: string; command: string }> = [
  { family: "parameter expansion", command: directWith("${HOME}") },
  { family: "command substitution", command: directWith("$(pwd)") },
  { family: "backtick command substitution", command: directWith("`pwd`") },
  { family: "arithmetic expansion", command: directWith("$((1+1))") },
  { family: "and operator", command: `${DIRECT} session-start && echo foreign` },
  { family: "pipe operator", command: `${DIRECT} session-start | echo foreign` },
  { family: "semicolon operator", command: `${DIRECT} session-start; echo foreign` },
  { family: "output redirect", command: `${DIRECT} session-start >/tmp/hook.log` },
  { family: "input redirect", command: `${DIRECT} session-start </tmp/hook.input` },
  { family: "shell comment", command: `${DIRECT} session-start # foreign` },
  { family: "comment marker in token", command: directWith("#foreign") },
  { family: "star pathname expansion", command: directWith("*") },
  { family: "question pathname expansion", command: directWith("?") },
  { family: "bracket pathname expansion", command: directWith("[ab]") },
  { family: "brace list expansion", command: directWith("{a,b}") },
  { family: "brace sequence expansion", command: directWith("{1..2}") },
  { family: "tilde expansion", command: "~/packages/cli/dist/agentstate-lite.mjs session-start" },
  { family: "history expansion", command: directWith("!1") },
  { family: "history quick substitution", command: directWith("^old^new^") },
  { family: "unterminated single quote", command: `'${DIRECT} session-start` },
  { family: "unterminated double quote", command: `"${DIRECT} session-start` },
  { family: "unquoted escape", command: directWith(String.raw`\x`) },
  { family: "unquoted Unicode", command: directWith("café") },
  { family: "Node parameter expansion", command: nodeWith("${HOME}") },
  { family: "Node pathname expansion", command: nodeWith("*") },
  { family: "Node brace expansion", command: nodeWith("{a,b}") },
];

/** Shell-equivalent argv spellings that no current or historical hook writer emitted. */
export const LEXICAL_ENVELOPE_FOREIGN_COMMANDS: ReadonlyArray<{ family: string; command: string }> = [
  { family: "empty single quotes inside binary", command: "a''slite session-start" },
  { family: "empty single quotes inside subcommand", command: "aslite s''ession-start" },
  { family: "empty double quotes inside subcommand", command: 'aslite s""ession-start' },
  {
    family: "single-quoted direct prefix with unquoted suffix",
    command: "'/tmp/x/packages/cli/dist/'agentstate-lite.mjs session-start",
  },
  {
    family: "double-quoted direct prefix with unquoted suffix",
    command: '"/tmp/x/packages/cli/dist/"agentstate-lite.mjs session-start',
  },
  {
    family: "single-quoted Node prefixes with unquoted suffixes",
    command:
      "'/opt/aslite/bin/'node '/opt/aslite/lib/node_modules/@holaxis/aslite/dist/'agentstate-lite.mjs session-start",
  },
  {
    family: "double-quoted Node prefixes with unquoted suffixes",
    command:
      '"/opt/aslite/bin/"node "/opt/aslite/lib/node_modules/@holaxis/aslite/dist/"agentstate-lite.mjs session-start',
  },
  {
    family: "canonical first Node token plus partial second token",
    command:
      "/opt/aslite/bin/node '/opt/aslite/lib/node_modules/@holaxis/aslite/dist/'agentstate-lite.mjs session-start",
  },
  {
    family: "historical double envelopes in a never-historical Node layout",
    command:
      '"/opt/as lite/bin/node" "/opt/as lite/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs" session-start',
  },
];

export const localDevExecutable = (segment: string): string =>
  `/tmp/x${segment}x/packages/cli/dist/agentstate-lite.mjs`;

export const stableNodePair = (segment: string): [string, string] => [
  `/opt/x${segment}x/bin/node`,
  `/opt/x${segment}x/lib/node_modules/superbee/dist/superbee.mjs`,
];

export const MISMATCHED_NPM_NODE_COMMAND =
  "/opt/runtime-a/bin/node /opt/npm-b/lib/node_modules/superbee/dist/superbee.mjs session-start";

/** Lexically valid path spellings that no hook writer emits and therefore never establish ownership. */
export const NONCANONICAL_MANAGED_PATH_CASES: ReadonlyArray<{
  family: string;
  program: string;
  args: string[];
  command: string;
}> = [
  {
    family: "npm pair with current-directory segments",
    program: "/opt/npm/./bin/node",
    args: ["/opt/npm/./lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs", "session-start"],
  },
  {
    family: "npm pair with duplicate separators",
    program: "/opt/npm//bin/node",
    args: ["/opt/npm//lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs", "session-start"],
  },
  {
    family: "npm pair with parent-directory segments",
    program: "/opt/npm/a/../bin/node",
    args: ["/opt/npm/a/../lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs", "session-start"],
  },
  {
    family: "direct npm entry with current-directory segment",
    program: "/opt/npm/./lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs",
    args: ["session-start"],
  },
  {
    family: "direct local-dev entry with duplicate separator",
    program: "/workspace/agentstate-lite//packages/cli/dist/agentstate-lite.mjs",
    args: ["session-start"],
  },
  {
    family: "noncanonical runtime with canonical local-dev entry",
    program: "/opt/runtime/./bin/node",
    args: ["/workspace/agentstate-lite/packages/cli/dist/agentstate-lite.mjs", "session-start"],
  },
].map((fixture) => ({ ...fixture, command: [fixture.program, ...fixture.args].join(" ") }));

/** Semantic provenance matrix: lexical validity alone does not establish a generated Node pair. */
export const NODE_PACKAGE_PAIR_CASES: ReadonlyArray<{
  family: string;
  command: string;
  state: "current" | "legacy_identity" | "legacy_path_bound" | "unmanaged";
}> = [
  {
    family: "same-prefix npm A",
    command:
      "/opt/npm-a/bin/node /opt/npm-a/lib/node_modules/superbee/dist/superbee.mjs session-start",
    state: "current",
  },
  {
    family: "same-prefix npm B",
    command:
      "/opt/npm-b/bin/node /opt/npm-b/lib/node_modules/superbee/dist/superbee.mjs session-start",
    state: "current",
  },
  { family: "foreign runtime with npm B", command: MISMATCHED_NPM_NODE_COMMAND, state: "unmanaged" },
  {
    family: "npm A runtime with npm B package",
    command:
      "/opt/npm-a/bin/node /opt/npm-b/lib/node_modules/superbee/dist/superbee.mjs session-start",
    state: "unmanaged",
  },
  {
    family: "npm B runtime with npm A package",
    command:
      "/opt/npm-b/bin/node /opt/npm-a/lib/node_modules/superbee/dist/superbee.mjs session-start",
    state: "unmanaged",
  },
  {
    family: "legacy scoped npm package remains owned but upgradeable",
    command:
      "/opt/aslite/bin/node /opt/aslite/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs session-start",
    state: "legacy_identity",
  },
  {
    family: "historical unscoped npm package is not a current Node pair",
    command:
      "/opt/aslite/bin/node /opt/aslite/lib/node_modules/aslite/dist/agentstate-lite.mjs session-start",
    state: "unmanaged",
  },
  {
    family: "independently located local-dev package",
    command:
      "/opt/runtime-a/bin/node /workspace/superbee/packages/cli/dist/superbee.mjs session-start",
    state: "current",
  },
];
