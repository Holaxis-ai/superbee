import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nodeCommandTarget, parseShellScript, parseWorkflowYaml, resolveWord } from "./release-workflow-topology.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowDirectory = path.join(repoRoot, ".github", "workflows");
const fail = (message) => { throw new Error(message); };

async function workflowFiles() {
  return (await readdir(workflowDirectory)).filter((name) => name.endsWith(".yml")).sort();
}

function stringifyScalars(value) {
  if (Array.isArray(value)) return value.map(stringifyScalars);
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [String(key), stringifyScalars(entry)]));
  }
  return String(value);
}

function argvOf(command) {
  return command.words.map((word) => resolveWord(word, new Map()));
}

test("the YAML reader models mappings, sequences, block scalars, and flow collections", () => {
  const document = parseWorkflowYaml([
    "name: example",
    "# a comment that is not content",
    "permissions: {}",
    "on:",
    "  push:",
    "    branches: [main, 'release/*']",
    "jobs:",
    "  gate:",
    "    runs-on: ubuntu-latest",
    "    env:",
    "      MODE: live",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          fetch-depth: 1",
    "      - name: run it",
    "        working-directory: packages/ui",
    "        run: |",
    "          set -euo pipefail",
    "",
    "          node scripts/one.mjs \\",
    "            --flag value",
    "      - run: npm ci",
    "",
  ].join("\n"), "example.yml", fail);

  assert.equal(document.name, "example");
  assert.deepEqual(document.permissions, {});
  assert.deepEqual(document.on.push.branches, ["main", "release/*"]);
  assert.deepEqual(document.jobs.gate.env, { MODE: "live" });
  const steps = document.jobs.gate.steps;
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[0], { uses: "actions/checkout@v4", with: { "fetch-depth": "1" } });
  assert.equal(steps[1]["working-directory"], "packages/ui");
  assert.equal(steps[1].run, "set -euo pipefail\n\nnode scripts/one.mjs \\\n  --flag value\n");
  assert.equal(steps[2].run, "npm ci");
});

test("the YAML reader fails closed on every construct it does not model", () => {
  for (const [name, text, expected] of [
    ["tabs", "jobs:\n\tgate: 1\n", /tab character/],
    ["anchors", "base: &anchor\n  a: 1\n", /anchor, alias, or tag/],
    ["aliases", "copy: *anchor\n", /anchor, alias, or tag/],
    ["tags", "value: !!binary abcd\n", /anchor, alias, or tag/],
    ["folded scalars", "run: >\n  folded text\n", /folded block scalar/],
    ["duplicate keys", "a: 1\na: 2\n", /repeats mapping key/],
    ["document markers", "---\na: 1\n", /document marker/],
    ["unterminated quotes", 'a: "open\n', /unterminated double-quoted/],
    ["carriage returns", "a: 1\r\n", /carriage return/],
  ]) {
    assert.throws(() => parseWorkflowYaml(text, "fixture.yml", fail), expected, name);
  }
});

test("the YAML reader agrees with a reference parser on every repository workflow", async (t) => {
  const reference = await import("js-yaml").catch(() => null);
  if (!reference) {
    t.skip("no reference YAML parser is installed in this environment");
    return;
  }
  const files = await workflowFiles();
  assert.ok(files.length >= 5, "the repository should carry its release and CI workflows");
  for (const name of files) {
    const text = await readFile(path.join(workflowDirectory, name), "utf8");
    const parsed = parseWorkflowYaml(text, name, fail);
    const expected = (reference.default ?? reference).load(text);
    assert.deepEqual(stringifyScalars(parsed.jobs), stringifyScalars(expected.jobs), name);
  }
});

test("the shell reader splits commands across operators, substitutions, and continuations", () => {
  const commands = parseShellScript([
    "set -euo pipefail",
    "# a comment line",
    'FACTS="$(node scripts/resolve.mjs --json)"',
    'if [ -n "$FACTS" ]; then',
    "  node scripts/apply.mjs --mode live > out.txt 2>&1",
    "else",
    "  npm run build && npm test | tee log.txt",
    "fi",
    "node \\",
    "  scripts/last.mjs",
  ].join("\n"), "fixture", fail);

  const argvs = commands.map(argvOf);
  assert.deepEqual(argvs[0], ["set", "-euo", "pipefail"]);
  assert.deepEqual(argvs[1], ["node", "scripts/resolve.mjs", "--json"], "command substitutions are parsed as commands");
  assert.deepEqual(argvs[2], [null], "the assignment carrying the substitution stays unresolvable");
  assert.deepEqual(argvs[3], ["if", "[", "-n", null, "]"]);
  assert.deepEqual(argvs[4], ["then"]);
  assert.deepEqual(argvs[5], ["node", "scripts/apply.mjs", "--mode", "live"], "redirection targets are not arguments");
  assert.deepEqual(argvs.at(-1), ["node", "scripts/last.mjs"], "a continued line is one command");
  assert.ok(argvs.some((argv) => argv[0] === "npm" && argv[1] === "run" && argv[2] === "build"));
  assert.deepEqual(argvs.slice(7, 10), [["npm", "run", "build"], ["npm", "test"], ["tee", "log.txt"]], "&& and | each end a command");
  assert.ok(argvs.every((argv) => !argv.includes("out.txt")), "redirection targets never become arguments");
  assert.ok(argvs.every((argv) => !argv.some((word) => word?.includes("comment"))), "comments are not commands");
});

test("the shell reader keeps quoting semantics and fails closed on unmodelled syntax", () => {
  const [command] = parseShellScript(`node 'scripts/one.mjs' "--name=a b" --plain`, "fixture", fail);
  assert.deepEqual(argvOf(command), ["node", "scripts/one.mjs", "--name=a b", "--plain"]);

  for (const [name, text, expected] of [
    ["heredocs", "cat <<EOF\nbody\nEOF\n", /heredoc/],
    ["backticks", "X=`node scripts/one.mjs`\n", /backtick/],
    ["dollar-quoted strings", "node $'scripts/one.mjs'\n", /\$-quoted/],
    ["unbalanced substitutions", 'X="$(node scripts/one.mjs"\n', /unbalanced/],
  ]) {
    assert.throws(() => parseShellScript(text, "fixture", fail), expected, name);
  }
});

test("word resolution uses the literal environment and refuses unknown expansions", () => {
  const [command] = parseShellScript('node "$CLI" --dir "${DIR}" "${{ github.token }}"', "fixture", fail);
  const environment = new Map([["CLI", "packages/cli/dist/superbee.mjs"], ["DIR", "/tmp/x"]]);
  assert.deepEqual(command.words.map((word) => resolveWord(word, environment)), [
    "node", "packages/cli/dist/superbee.mjs", "--dir", "/tmp/x", null,
  ]);
  assert.equal(resolveWord(command.words[1], new Map()), null, "an unset variable is not resolvable");
});

test("node command targets separate script paths from inline code and option values", () => {
  const target = (script) => {
    const [command] = parseShellScript(script, "fixture", fail);
    return nodeCommandTarget(command.words, new Map(), "fixture", fail);
  };
  assert.deepEqual(target("node scripts/one.mjs --flag"), { kind: "script", script: "scripts/one.mjs" });
  assert.deepEqual(target("node --import ./loader.mjs scripts/two.mjs"), { kind: "script", script: "scripts/two.mjs" });
  assert.deepEqual(target("node --test-concurrency=1 scripts/three.mjs"), { kind: "script", script: "scripts/three.mjs" });
  assert.deepEqual(target("node -- scripts/four.mjs"), { kind: "script", script: "scripts/four.mjs" });
  assert.deepEqual(target('node -p "require(\'./x.json\').a"'), { kind: "inline" });
  assert.deepEqual(target("node --version"), { kind: "inline" });
  assert.throws(() => target('node "$UNKNOWN"'), /unresolvable/);
});
