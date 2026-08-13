import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyHookCommand,
  classifyHookEntry,
  isSafeUnquotedHookToken,
  isOwnedHookCompatibility,
  renderGeneratedHookToken,
  tokenizeGeneratedHookCommand,
} from "../src/hook-compatibility.js";
import {
  LEXICAL_ENVELOPE_FOREIGN_COMMANDS,
  NONCANONICAL_MANAGED_PATH_CASES,
  NODE_PACKAGE_PAIR_CASES,
  SHELL_FOREIGN_COMMANDS,
  localDevExecutable,
} from "./hook-shell-fixtures.js";

const stable =
  "/opt/superbee/bin/node /opt/superbee/lib/node_modules/superbee/dist/superbee.mjs session-start";

test("generated command tokenizer accepts emitted quoting and rejects shell behavior", () => {
  assert.deepEqual(tokenizeGeneratedHookCommand(stable), [
    "/opt/superbee/bin/node",
    "/opt/superbee/lib/node_modules/superbee/dist/superbee.mjs",
    "session-start",
  ]);
  assert.deepEqual(tokenizeGeneratedHookCommand('"/Users/a b/bin/aslite" session-start'), [
    "/Users/a b/bin/aslite",
    "session-start",
  ]);
  for (const command of [
    "aslite session-start && echo owned",
    "aslite\nsession-start",
    "aslite\rsession-start",
    "aslite\tsession-start",
    "'aslite\nsession-start'",
    "aslite  session-start",
    "$(which aslite) session-start",
    "aslite; session-start",
    "/tmp/*/packages/cli/dist/agentstate-lite.mjs session-start",
    "/tmp/?/packages/cli/dist/agentstate-lite.mjs session-start",
    "/tmp/[ab]/packages/cli/dist/agentstate-lite.mjs session-start",
    String.raw`"\u0061slite" session-start`,
    String.raw`"aslite\nsession-start"`,
    "aslite 'unterminated",
  ]) {
    assert.equal(tokenizeGeneratedHookCommand(command), undefined, command);
  }
  assert.deepEqual(tokenizeGeneratedHookCommand("echo agentstate-lite"), ["echo", "agentstate-lite"]);
});

test("the recognizer's unquoted alphabet is exactly the writer's closed alphabet", () => {
  const alphabet = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_@%+=:,./-");
  for (let code = 0x21; code <= 0x7e; code += 1) {
    const character = String.fromCharCode(code);
    const safe = alphabet.has(character);
    assert.equal(isSafeUnquotedHookToken(character), safe, `predicate drift for ${JSON.stringify(character)}`);
    const command = `${localDevExecutable(character)} session-start`;
    assert.equal(
      tokenizeGeneratedHookCommand(command) !== undefined,
      safe,
      `tokenizer drift for ${JSON.stringify(character)}`,
    );
  }
  for (const character of [" ", "é", "\u{1f642}", "\n", "\t"]) {
    assert.equal(isSafeUnquotedHookToken(character), false, JSON.stringify(character));
  }
});

test("shell-expansion taxonomy is unmanaged before the semantic classifier", () => {
  for (const { family, command } of SHELL_FOREIGN_COMMANDS) {
    assert.equal(tokenizeGeneratedHookCommand(command), undefined, family);
    assert.equal(classifyHookCommand(command).state, "unmanaged", family);
  }
});

test("lexical envelopes are whole-token canonical writer spellings, never shell-equivalent segmentations", () => {
  const accepted: Array<{ family: string; command: string; tokens: string[] }> = [
    { family: "safe unquoted", command: "aslite session-start", tokens: ["aslite", "session-start"] },
    {
      family: "current whole-token single quote",
      command: "'/tmp/a b/packages/cli/dist/agentstate-lite.mjs' session-start",
      tokens: ["/tmp/a b/packages/cli/dist/agentstate-lite.mjs", "session-start"],
    },
    {
      family: "current canonical embedded apostrophe",
      command: String.raw`'/tmp/a'\''b/packages/cli/dist/agentstate-lite.mjs' session-start`,
      tokens: ["/tmp/a'b/packages/cli/dist/agentstate-lite.mjs", "session-start"],
    },
    {
      family: "historical whitespace-triggered JSON double quote",
      command: '"/tmp/a b/packages/cli/dist/agentstate-lite.mjs" session-start',
      tokens: ["/tmp/a b/packages/cli/dist/agentstate-lite.mjs", "session-start"],
    },
  ];
  for (const { family, command, tokens } of accepted) {
    assert.deepEqual(tokenizeGeneratedHookCommand(command), tokens, family);
    assert.notEqual(classifyHookCommand(command).state, "unmanaged", family);
  }

  assert.equal(renderGeneratedHookToken("aslite"), "aslite");
  assert.equal(
    renderGeneratedHookToken("/tmp/a b/packages/cli/dist/agentstate-lite.mjs"),
    "'/tmp/a b/packages/cli/dist/agentstate-lite.mjs'",
  );
  assert.equal(
    renderGeneratedHookToken("/tmp/a'b/packages/cli/dist/agentstate-lite.mjs"),
    String.raw`'/tmp/a'\''b/packages/cli/dist/agentstate-lite.mjs'`,
  );

  const historicalBackslash = String.raw`/tmp/a b\c/packages/cli/dist/agentstate-lite.mjs`;
  assert.deepEqual(
    tokenizeGeneratedHookCommand(`${JSON.stringify(historicalBackslash)} session-start`),
    [historicalBackslash, "session-start"],
  );
  for (const unsafeHistoricalValue of [
    "/tmp/a b/$HOME/packages/cli/dist/agentstate-lite.mjs",
    "/tmp/a b/`pwd`/packages/cli/dist/agentstate-lite.mjs",
    "/tmp/a\nb/packages/cli/dist/agentstate-lite.mjs",
  ]) {
    const command = `${JSON.stringify(unsafeHistoricalValue)} session-start`;
    assert.equal(tokenizeGeneratedHookCommand(command), undefined, command);
  }
  assert.equal(
    tokenizeGeneratedHookCommand(String.raw`"/tmp/a b/\$HOME/packages/cli/dist/agentstate-lite.mjs" session-start`),
    undefined,
    "POSIX-safe escaping is not the historical JSON spelling",
  );

  for (const { family, command } of LEXICAL_ENVELOPE_FOREIGN_COMMANDS) {
    assert.equal(tokenizeGeneratedHookCommand(command), undefined, family);
    assert.equal(classifyHookCommand(command).state, "unmanaged", family);
  }
  for (const command of [
    "'aslite' session-start",
    '"aslite" session-start',
    "aslite 'session-start'",
    "'/tmp/a b/'packages/cli/dist/agentstate-lite.mjs session-start",
  ]) {
    assert.equal(tokenizeGeneratedHookCommand(command), undefined, command);
  }
});

test("supported quote grammar retains literal shell characters only inside managed layouts", () => {
  const table: Array<[string, string]> = [
    ["'/tmp/{a,b}/packages/cli/dist/agentstate-lite.mjs' session-start", "legacy_identity"],
    ['"/tmp/{a,b}/packages/cli/dist/agentstate-lite.mjs" session-start', "unmanaged"],
    ["'/tmp/#/packages/cli/dist/agentstate-lite.mjs' session-start", "legacy_identity"],
    ["'/tmp/~/packages/cli/dist/agentstate-lite.mjs' session-start", "legacy_identity"],
    ["'/tmp/!/packages/cli/dist/agentstate-lite.mjs' session-start", "legacy_identity"],
    ["'/tmp/café/packages/cli/dist/agentstate-lite.mjs' session-start", "legacy_identity"],
    [String.raw`"/tmp/\${HOME}/packages/cli/dist/agentstate-lite.mjs" session-start`, "unmanaged"],
    [String.raw`"/tmp/\$(pwd)/packages/cli/dist/agentstate-lite.mjs" session-start`, "unmanaged"],
    ["'echo {a,b}' session-start", "unmanaged"],
  ];
  for (const [command, state] of table) {
    assert.equal(classifyHookCommand(command).state, state, command);
  }
});

test("command compatibility recognizes exact generated history and rejects near-matches", () => {
  const marketplace =
    "/Users/u/.claude/plugins/cache/holaxis/agentstate-lite/1.0.147/skills/agentstate-lite/scripts/agentstate-lite.mjs";
  const table: Array<[string, string]> = [
    [stable, "current"],
    [
      "/opt/aslite/bin/node /opt/aslite/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs session-start",
      "legacy_identity",
    ],
    ["aslite session-start", "legacy_path_bound"],
    ["agentstate-lite session-start", "legacy_path_bound"],
    ["aslite", "stale"],
    ["/usr/local/bin/aslite session-start", "unmanaged"],
    ["/x/packages/cli/dist/agentstate-lite.mjs session-start", "legacy_identity"],
    ["/opt/node/bin/node /x/packages/cli/dist/agentstate-lite.mjs session-start", "legacy_identity"],
    ["/opt/node/bin/node /x/packages/cli/dist/superbee.mjs session-start", "current"],
    ["node /tmp/agentstate-lite.mjs session-start", "unmanaged"],
    ["/tmp/bin/node /tmp/agentstate-lite.mjs session-start", "unmanaged"],
    ["npx -y agentstate-lite session-start", "legacy_path_bound"],
    ["npx -y agentstate-lite", "stale"],
    [`${marketplace} session-start`, "legacy_path_bound"],
    [marketplace, "stale"],
    [
      "/Users/u/.codex/plugins/cache/agentstate-lite/agentstate-lite/1.0.147/skills/agentstate-lite/scripts/agentstate-lite.mjs session-start",
      "legacy_path_bound",
    ],
    [
      "/repo/plugins/agentstate-lite/skills/agentstate-lite/scripts/agentstate-lite.mjs session-start",
      "legacy_path_bound",
    ],
    [
      "/Users/u/.claude/plugins/cache/holaxis/not-agentstate-lite/1.0.147/skills/agentstate-lite/scripts/agentstate-lite.mjs session-start",
      "unmanaged",
    ],
    [
      "/Users/u/.claude/plugins/cache/holaxis/agentstate-lite/1.0.147/skills/agentstate-lite/scripts/other.mjs session-start",
      "unmanaged",
    ],
    ["npx -y @holaxis/aslite session-start", "unmanaged"],
    ["echo agentstate-lite", "unmanaged"],
    ["agentstate-lite backup", "unmanaged"],
    ["aslite2 session-start", "unmanaged"],
    [String.raw`"\u0061slite" session-start`, "unmanaged"],
    [String.raw`"aslite\/" session-start`, "unmanaged"],
    ["/tmp/*/packages/cli/dist/agentstate-lite.mjs session-start", "unmanaged"],
    ["/tmp/?/packages/cli/dist/agentstate-lite.mjs session-start", "unmanaged"],
    ["/tmp/[ab]/packages/cli/dist/agentstate-lite.mjs session-start", "unmanaged"],
    [
      "/opt/*/bin/node /opt/*/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs session-start",
      "unmanaged",
    ],
    [
      "/opt/?/bin/node /opt/?/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs session-start",
      "unmanaged",
    ],
    [
      "/opt/[ab]/bin/node /opt/[ab]/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs session-start",
      "unmanaged",
    ],
    ["'/tmp/*/packages/cli/dist/agentstate-lite.mjs' session-start", "legacy_identity"],
    ['"/tmp/?/packages/cli/dist/agentstate-lite.mjs" session-start', "unmanaged"],
    ["'/tmp/[ab]/packages/cli/dist/agentstate-lite.mjs' session-start", "legacy_identity"],
    [
      "'/opt/*/bin/node' '/opt/*/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs' session-start",
      "legacy_identity",
    ],
    ["some-tool --aslite", "unmanaged"],
  ];
  for (const [command, state] of table) {
    assert.equal(classifyHookCommand(command).state, state, command);
  }
});

test("Node/package semantic provenance requires same-prefix npm but permits enumerated local layouts", () => {
  for (const { family, command, state } of NODE_PACKAGE_PAIR_CASES) {
    assert.notEqual(tokenizeGeneratedHookCommand(command), undefined, `${family}: lexical precondition`);
    assert.equal(classifyHookCommand(command).state, state, family);
  }
});

test("managed path ownership requires the writer's canonical absolute spelling", () => {
  for (const { family, command } of NONCANONICAL_MANAGED_PATH_CASES) {
    assert.notEqual(tokenizeGeneratedHookCommand(command), undefined, `${family}: lexical precondition`);
    assert.equal(classifyHookCommand(command).state, "unmanaged", family);
  }
});

test("entry compatibility owns only exact current and explicitly historical host shapes", () => {
  const current = classifyHookEntry({
    entry: { type: "command", command: stable, timeout: 10 },
    location: "SessionStart",
    matcher: "",
    timeoutSeconds: 10,
  });
  assert.equal(current.state, "current");
  const historical = classifyHookEntry({
    entry: { type: "command", command: "aslite session-start", timeout: 10 },
    location: "session_start",
    timeoutSeconds: 10,
  });
  assert.equal(historical.state, "stale");
  assert.equal(isOwnedHookCompatibility(historical), true);

  for (const changed of [
    { location: "SessionStart" as const, matcher: "tool", type: "command", timeout: 10 },
    { location: "SessionStart" as const, matcher: "", type: "prompt", timeout: 10 },
    { location: "SessionStart" as const, matcher: "", type: "command", timeout: 9 },
  ]) {
    const compatibility = classifyHookEntry({
      entry: { type: changed.type, command: stable, timeout: changed.timeout },
      location: changed.location,
      matcher: changed.matcher,
      timeoutSeconds: 10,
    });
    assert.equal(compatibility.state, "unmanaged");
    assert.equal(isOwnedHookCompatibility(compatibility), false);
  }
});
