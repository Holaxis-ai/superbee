import assert from "node:assert/strict";
import test from "node:test";
import { CliError } from "../src/errors.js";
import { setup, type SetupDeps } from "../src/commands/setup.js";

function deps(write: (text: string) => void): SetupDeps {
  return {
    stdout: write,
    cwd: () => "/Users/private/project",
    home: () => "/Users/private",
    inspectDistribution: () => ({
      allowed: true,
      state: "durable_global",
      reason: "durable",
      evidence: {
        npm_prefix: "/Users/private/npm",
        bin_path: "/Users/private/npm/bin/superbee",
        executable_path: "/Users/private/npm/lib/node_modules/superbee/dist/superbee.mjs",
        runtime_path: "/Users/private/npm/bin/node",
      },
    }),
    inspectSkill: () => ({
      version: "1.0.0",
      targets: { claude: "/Users/private/.claude/skills/superbee", codex: "/Users/private/.codex/skills/superbee" },
      legacyTargets: { claude: "/Users/private/.claude/skills/aslite", codex: "/Users/private/.codex/skills/aslite" },
      hosts: {
        claude_code: {
          canonical: { state: "installed", compatibility: { state: "current", reason: "current" } },
          legacy: { state: "absent", compatibility: { state: "absent", reason: "absent" } },
        },
        codex: {
          canonical: { state: "installed", compatibility: { state: "current", reason: "current" } },
          legacy: { state: "absent", compatibility: { state: "absent", reason: "absent" } },
        },
      },
    }),
    inspectHook: () => ({
      targets: {
        claudeSettings: "/Users/private/.claude/settings.json",
        codexHooks: "/Users/private/.codex/hooks.json",
        codexConfig: "/Users/private/.codex/config.toml",
        opencodePlugin: "/Users/private/.config/opencode/plugins/superbee.js",
        legacyOpencodePlugin: "/Users/private/.config/opencode/plugins/aslite.js",
      },
      hosts: {
        claude_code: { installed: true, compatibility: { state: "current", reason: "current" } },
        codex: { installed: true, compatibility: { state: "current", reason: "current" } },
        opencode: { installed: true, compatibility: { state: "current", reason: "current" } },
      },
    }),
    inspectMcp: (targets) => targets.map((target) => ({
      host: target.id,
      label: target.label,
      state: "owned_current",
      config: "/Users/private/config.json",
      reason: "current",
      docs_url: target.docs_url,
    })),
    resolveBundle: async () => ({
      root: "/Users/private/project/.agentstate-lite",
      canonicalRoot: "/Users/private/project/.agentstate-lite",
      selectedBy: "discovery",
    }),
    listCatalog: async () => [{
      id: "bnd_00000000000000000000000000000000",
      label: "project",
      locator: { kind: "local-path", path: "/Users/private/project/.agentstate-lite" },
      available: true,
    }],
  };
}

test("setup without a host returns a bounded path-free four-host selector", async () => {
  let output = "";
  await setup(["--json"], deps((text) => { output += text; }));
  const parsed = JSON.parse(output) as { setup: { mode: string; hosts: Array<{ id: string; command: string }> } };
  assert.equal(parsed.setup.mode, "select_host");
  assert.deepEqual(parsed.setup.hosts.map((row) => row.id), ["codex", "claude-code", "claude-desktop", "opencode"]);
  assert.equal(parsed.setup.hosts[0]?.command, "superbee setup --host codex --scope user");
  assert.doesNotMatch(output, /\/Users\/private/);
});

test("host-scoped setup returns a complete plan and remains path-free", async () => {
  let output = "";
  const injected = deps((text) => { output += text; });
  injected.inspectSkill = () => { throw new Error("desktop setup must not inspect skills"); };
  injected.inspectHook = () => { throw new Error("desktop setup must not inspect hooks"); };
  const inspectMcp = injected.inspectMcp;
  injected.inspectMcp = (targets) => {
    assert.deepEqual(targets.map((target) => target.id), ["claude-desktop"]);
    return inspectMcp(targets);
  };
  await setup(["--host", "claude-desktop", "--json"], injected);
  const parsed = JSON.parse(output) as { setup: { host: string; ready: boolean; complete: boolean; next?: unknown } };
  assert.deepEqual(parsed.setup, {
    ...parsed.setup,
    host: "claude-desktop",
    ready: true,
    complete: true,
  });
  assert.equal(parsed.setup.next, undefined);
  assert.doesNotMatch(output, /\/Users\/private/);
});

test("setup defaults to TOON rather than JSON", async () => {
  let output = "";
  await setup(["--host", "claude-desktop"], deps((text) => { output += text; }));
  assert.match(output, /^setup:/);
  assert.doesNotMatch(output, /^\{/);
});

test("incomplete setup is a successful diagnosis with one next command", async () => {
  let output = "";
  const injected = deps((text) => { output += text; });
  injected.inspectMcp = (targets) => targets.map((target) => ({
    host: target.id,
    label: target.label,
    state: "absent",
    config: null,
    reason: "absent",
    docs_url: target.docs_url,
  }));
  await setup(["--host", "claude-desktop", "--json"], injected);
  const parsed = JSON.parse(output) as { setup: { ready: boolean; next: { command: string } } };
  assert.equal(parsed.setup.ready, false);
  assert.equal(parsed.setup.next.command, "superbee mcp install --host claude-desktop");
});

test("setup validates exact host, scope, arity, and serves offline help", async () => {
  await assert.rejects(setup(["--host", "unknown"], deps(() => {})), (error: unknown) =>
    error instanceof CliError && error.code === "USAGE");
  await assert.rejects(setup(["--scope", "machine"], deps(() => {})), (error: unknown) =>
    error instanceof CliError && error.code === "USAGE");
  await assert.rejects(setup(["extra"], deps(() => {})), (error: unknown) =>
    error instanceof CliError && error.code === "USAGE");
  let help = "";
  await setup(["--help"], { stdout: (text) => { help += text; } });
  assert.match(help, /one safe next command/);
});
