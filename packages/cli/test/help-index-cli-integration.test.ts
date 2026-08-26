/**
 * End-to-end smoke test for the top-level `--help`/`-h`/`help` rewrite (help-index-readability
 * task), run against the BUILT CLI (`dist/superbee.mjs`) over a real subprocess — the actual
 * bytes an agent shelling out to the tool would see. Mirrors `doc-cli-integration.test.ts`'s
 * `before`-hook build pattern (this package has no other build-once convention to reuse).
 *
 * The regression this guards: the top-level index used to TOON-encode `commandReference()`,
 * producing one escaped string-array line per command GROUP (an agent had to grep the line to find
 * a command). `helpIndexText()` (src/reference.ts) now renders the same data as grouped plain text,
 * one command per physical line — this file pins that shape on the actual CLI process boundary, and
 * separately confirms the bare (home) view and a subcommand's own `--help` are untouched.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(here, "..");
const cliBin = path.join(cliPackageRoot, "dist", "superbee.mjs");

// Build ONLY if the bundle is absent — the package `test` script builds once up front, so this is
// a no-op under `npm test`/`npm run check`. That prevents this file and `doc-cli-integration` from
// each kicking off a concurrent `vite build` (node --test runs files in parallel) that would race
// on packages/ui/dist. Building here still supports running THIS file on its own.
before(() => {
  if (!existsSync(cliBin)) execFileSync("node", ["build.mjs", "local-dev"], { cwd: cliPackageRoot, stdio: "inherit" });
});

function run(args: string[]): string {
  return execFileSync("node", [cliBin, ...args], { encoding: "utf8" });
}

for (const argv of [["--help"], ["-h"], ["help"]]) {
  test(`built CLI: \`${argv[0]}\` renders the grouped plain-text command index, not TOON`, () => {
    const out = run(argv);

    // The OLD TOON shape this replaces: `Group[n]: "cmd1 — …","cmd2 — …",...` — a comma-joined,
    // quote-escaped array on one line per group. None of that survives.
    assert.doesNotMatch(out, /\[\d+\]:/, "must not contain a TOON array-length header like `Bundle[3]:`");
    assert.doesNotMatch(out, /","/, "must not contain TOON's comma-quote array-item separator");

    // The new shape: a description header, a Usage line, and every group as its own plain heading
    // with each command on its own indented physical line. (The resolved invocation off-PATH is
    // `npx --no-install superbee`, a multi-word prefix, so match loosely on the leading token.)
    const heading = out.match(/^(.+) — read and write a local OKF knowledge bundle/m);
    assert.ok(heading, "must render the invocation in the heading");
    assert.match(out, /\nUsage: .+ <command> \[options\]\n/);
    assert.match(out, /\nBundle:\n {2}bundle locate \[--dir <path>\][^\n]* — Resolve the exact canonical local bundle path/);
    assert.match(out, /\n {2}catalog \(add <label>[^\n]* — Register and deterministically resolve this user's explicitly named local workspaces/);
    assert.match(out, /\n {2}init \[--dir <path>\][^\n]* — Create \(or open\) an OKF knowledge bundle/);
    assert.match(out, /\nDocuments & links:\n {2}doc write <id> --type <t>/);
    assert.match(
      out,
      /\nSession:\n {2}version \[--check\] \[--tag latest\|next\] \[--json\][^\n]* — Show the complete local build\/runtime identity[^\n]*\n {2}session-start/,
    );
    assert.match(out, /\n {2}hook install\|status\|uninstall/);
    assert.match(out, /\nAgent setup:\n/);
    assert.match(out, /The calling agent executes the returned action/);
    assert.match(out, /npx --no-install superbee/);
    assert.ok(out.includes(`    ${heading[1]} setup --host <host> --scope <scope> --json`));
    assert.doesNotMatch(out, /npx -y superbee/);

    // The footer pointers are still present, and readably wrapped (no single line runs the whole
    // bundle-resolution paragraph together).
    assert.match(out, /kinds are declared per-bundle/);
    assert.match(out, /bundle resolution: HTTP is activated only by explicit --remote/);
  });
}

test("built CLI: the bare (home) view is UNCHANGED by the --help rewrite — still TOON", () => {
  const out = run([]);
  assert.match(out, /^superbee:\n {2}bin: /);
  assert.doesNotMatch(out, /\nBundle:\n {2}init /, "home must not have picked up the --help prose format");
  assert.doesNotMatch(out, /^auth:/m, "home must not project hosted credential identity");
  assert.doesNotMatch(out, /^remotes:/m, "home must not enumerate stored hosted credentials");
  for (const group of ["Identity", "Invites & members (admin)", "API keys"]) {
    assert.doesNotMatch(out, new RegExp(`^ {2}${group}:`, "m"), `${group} must be absent from compact home`);
  }
});

test("built CLI: bundle locate is dispatched and returns the canonical explicit target", () => {
  const fixture = path.resolve(cliPackageRoot, "../../examples/sample-bundle");
  const receipt = JSON.parse(run(["bundle", "locate", "--dir", fixture, "--json"])) as {
    schema_version: number;
    locator: { kind: string; path: string };
    selected_by: string;
    available: boolean;
  };
  assert.deepEqual(receipt, {
    schema_version: 1,
    locator: { kind: "local-path", path: realpathSync(fixture) },
    selected_by: "explicit-dir",
    available: true,
  });
});

const RETIRED = ["login", "join", "whoami", "invite", "member", "key"];

test("built CLI: hosted control-plane command families are absent from help and unreachable", () => {
  const help = run(["--help"]);
  for (const command of RETIRED) {
    assert.doesNotMatch(help, new RegExp(`^  ${command}(?: |$)`, "m"));
    const result = spawnSync("node", [cliBin, command], { encoding: "utf8" });
    assert.equal(result.status, 2, `${command} must route to the ordinary unknown-command boundary`);
    assert.match(`${result.stdout}${result.stderr}`, new RegExp(`unknown command: ${command}`));
  }
});

test("built CLI: `view` is now catalog inspection only; the retired static renderer remains unreachable", () => {
  const help = run(["--help"]);
  assert.match(help, /^  view list(?: |$)/m);

  const result = spawnSync("node", [cliBin, "view", "legacy-file.html"], { encoding: "utf8" });
  assert.equal(result.status, 2, "view must route to the ordinary unknown-command boundary");
  assert.match(`${result.stdout}${result.stderr}`, /unknown view subcommand: legacy-file\.html/);
});

test("built CLI: a subcommand's own `--help` (e.g. `new --help`) is UNCHANGED by the top-level rewrite", () => {
  const out = run(["new", "--help"]);
  assert.match(out, /^superbee new — create a new instance of a bundle-declared kind/);
  assert.match(out, /\nUsage:\n {2}superbee new /);
  assert.doesNotMatch(out, /\nBundle:\n/, "must not have picked up the top-level index's group headings");
});

test("built CLI: a nearby list option typo names the exact correction", () => {
  // npm workspace scripts prepend node_modules/.bin, which can expose this exact built artifact as
  // `superbee`. Establish the off-PATH condition this assertion is specifically meant to cover.
  const result = spawnSync(process.execPath, [cliBin, "list", "--limt", "5"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /unknown option '--limt' — did you mean '--limit'\?/);
  assert.match(result.stdout, /help: (?:superbee|npx --no-install superbee) list --help/);
  assert.equal(result.stderr, "");
});
