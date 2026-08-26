import assert from "node:assert/strict";
import test from "node:test";
import { CliError } from "../src/errors.js";
import { setup, type SetupDeps } from "../src/commands/setup.js";

function deps(write: (text: string) => void): SetupDeps {
  return {
    stdout: write,
    cwd: () => "/Users/private/project",
    home: () => "/Users/private",
    invocation: () => "superbee",
    inspectDistribution: () => ({
      allowed: true, state: "durable_global", reason: "durable",
      evidence: {
        npm_prefix: "/Users/private/npm", bin_path: "/Users/private/npm/bin/superbee",
        executable_path: "/Users/private/npm/lib/node_modules/superbee/dist/superbee.mjs",
        runtime_path: "/Users/private/npm/bin/node",
      },
    }),
    inspectSkill: () => ({
      version: "1.0.0",
      targets: { claude: "/Users/private/.claude/skills/superbee", codex: "/Users/private/.codex/skills/superbee" },
      legacyTargets: { claude: "/Users/private/.claude/skills/aslite", codex: "/Users/private/.codex/skills/aslite" },
      hosts: {
        claude_code: { canonical: { state: "installed", compatibility: { state: "current", reason: "current" } }, legacy: { state: "absent", compatibility: { state: "absent", reason: "absent" } } },
        codex: { canonical: { state: "installed", compatibility: { state: "current", reason: "current" } }, legacy: { state: "absent", compatibility: { state: "absent", reason: "absent" } } },
      },
    }),
    inspectHook: () => ({
      targets: {
        claudeSettings: "/Users/private/.claude/settings.json", codexHooks: "/Users/private/.codex/hooks.json",
        codexConfig: "/Users/private/.codex/config.toml", opencodePlugin: "/Users/private/.config/opencode/plugins/superbee.js",
        legacyOpencodePlugin: "/Users/private/.config/opencode/plugins/aslite.js",
      },
      hosts: {
        claude_code: { installed: true, compatibility: { state: "current", reason: "current" } },
        codex: { installed: true, compatibility: { state: "current", reason: "current" } },
        opencode: { installed: true, compatibility: { state: "current", reason: "current" } },
      },
    }),
    inspectMcp: (targets) => targets.map((target) => ({
      host: target.id, label: target.label, state: "owned_current", config: "/Users/private/config.json",
      reason: "current", docs_url: target.docs_url,
    })),
    resolveBundle: async () => ({ root: "/Users/private/project/.superbee", canonicalRoot: "/Users/private/project/.superbee", selectedBy: "discovery" }),
    listCatalog: async () => [{
      id: "bnd_00000000000000000000000000000000", label: "project",
      locator: { kind: "local-path" as const, path: "/Users/private/project/.superbee" }, available: true,
    }],
    inspectState: async () => ({ state: "ready", reason: "current", records: 0 }),
    migrateState: async () => ({
      schema_version: 1, status: "migrated", changed: true,
      records: { catalog: "migrated", credentials: "absent", view_authorizations: 0, sync_state: "rederived", ephemeral_state: "rederived" },
      legacy_preserved: true, next: { command: "superbee setup" },
    }),
  };
}

test("hostless setup supplies an agent protocol and host-specific argv actions", async () => {
  let output = "";
  await setup(["--json"], deps((text) => { output += text; }));
  const parsed = JSON.parse(output) as { setup: {
    schema_version: number; protocol: string; status: string; agent_instruction: string;
    mode: string; hosts: Array<{ id: string; action: { command: string[]; mutates: boolean } }>;
    next: { action: string; mutates: boolean; approval: { required: boolean } };
  } };
  assert.equal(parsed.setup.schema_version, 2);
  assert.equal(parsed.setup.protocol, "agent_setup_v1");
  assert.equal(parsed.setup.status, "action_required");
  assert.match(parsed.setup.agent_instruction, /must not relay the command to the user/i);
  assert.equal(parsed.setup.mode, "select_host");
  assert.deepEqual(parsed.setup.hosts.map((row) => row.id), ["codex", "claude-code", "claude-desktop", "opencode"]);
  assert.deepEqual(parsed.setup.hosts[0]?.action, {
    action: "run", command: ["superbee", "setup", "--host", "codex", "--scope", "user", "--json"],
    description: "Inspect setup readiness for Codex / ChatGPT.", mutates: false,
    approval: { required: false, reason: null },
  });
  assert.equal(parsed.setup.next.action, "select_host");
  assert.equal(parsed.setup.next.mutates, false);
  assert.equal(parsed.setup.next.approval.required, false);
  assert.doesNotMatch(output, /\/Users\/private/);
});

test("hostless state recovery takes precedence and declares user-level approval", async () => {
  let output = "";
  const injected = deps((text) => { output += text; });
  injected.inspectState = async () => ({ state: "migratable", reason: "validated legacy private state is ready to migrate", records: 2 });
  await setup(["--json"], injected);
  const next = (JSON.parse(output) as { setup: { next: unknown } }).setup.next;
  assert.deepEqual(next, {
    action: "run", command: ["superbee", "setup", "migrate-state"],
    description: "Migrate validated legacy private state into Superbee's canonical user-state directory.", mutates: true,
    approval: { required: true, reason: "This writes to the user-level Superbee private-state directory." },
  });
});

test("hostless recovery inherits the resolved no-download launcher", async () => {
  let output = "";
  const injected = deps((text) => { output += text; });
  injected.invocation = () => "npx --no-install superbee";
  injected.inspectState = async () => ({ state: "migratable", reason: "validated legacy private state is ready to migrate", records: 2 });
  await setup(["--json"], injected);
  const next = (JSON.parse(output) as { setup: { next: { command: string[] } } }).setup.next;
  assert.deepEqual(next.command, ["npx", "--no-install", "superbee", "setup", "migrate-state"]);
});

test("host-scoped setup is ready only when the protocol needs no action", async () => {
  let output = "";
  const injected = deps((text) => { output += text; });
  injected.inspectSkill = () => { throw new Error("desktop setup must not inspect skills"); };
  injected.inspectHook = () => { throw new Error("desktop setup must not inspect hooks"); };
  await setup(["--host", "claude-desktop", "--json"], injected);
  const parsed = JSON.parse(output) as { setup: { status: string; ready: boolean; complete: boolean; next?: unknown; verify: { command: string[] } } };
  assert.equal(parsed.setup.status, "ready");
  assert.equal(parsed.setup.ready, true);
  assert.equal(parsed.setup.complete, true);
  assert.equal(parsed.setup.next, undefined);
  assert.deepEqual(parsed.setup.verify.command, ["superbee", "setup", "--host", "claude-desktop", "--scope", "user", "--json"]);
});

test("setup defaults to TOON rather than JSON", async () => {
  let output = "";
  await setup(["--host", "claude-desktop"], deps((text) => { output += text; }));
  assert.match(output, /^setup:/);
  assert.doesNotMatch(output, /^\{/);
});

test("user-level integration actions require approval while diagnostic actions do not", async () => {
  let output = "";
  const injected = deps((text) => { output += text; });
  injected.inspectMcp = (targets) => targets.map((target) => ({
    host: target.id, label: target.label, state: "absent", config: null, reason: "absent", docs_url: target.docs_url,
  }));
  await setup(["--host", "claude-desktop", "--json"], injected);
  const action = (JSON.parse(output) as { setup: { next: { command: string[]; mutates: boolean; approval: { required: boolean } } } }).setup.next;
  assert.deepEqual(action.command, ["superbee", "mcp", "install", "--host", "claude-desktop"]);
  assert.equal(action.mutates, true);
  assert.equal(action.approval.required, true);

  output = "";
  injected.inspectMcp = (targets) => targets.map((target) => ({
    host: target.id, label: target.label, state: "known_legacy", config: "~/.claude.json",
    reason: "registration 'aslite-views' is a legacy candidate; inspect it before migration", docs_url: target.docs_url,
  }));
  await setup(["--host", "claude-code", "--json"], injected);
  const inspection = (JSON.parse(output) as { setup: { status: string; next: { action: string; mutates: boolean; approval: { required: boolean } } } }).setup;
  assert.equal(inspection.status, "blocked");
  assert.equal(inspection.next.action, "inspect");
  assert.equal(inspection.next.mutates, false);
  assert.equal(inspection.next.approval.required, false);
});

test("setup help explicitly delegates execution to the calling agent", async () => {
  await assert.rejects(setup(["--host", "unknown"], deps(() => {})), (error: unknown) => error instanceof CliError && error.code === "USAGE");
  await assert.rejects(setup(["--scope", "machine"], deps(() => {})), (error: unknown) => error instanceof CliError && error.code === "USAGE");
  let help = "";
  await setup(["--help"], { stdout: (text) => { help += text; } });
  assert.match(help, /agent-driven workflow/);
  assert.match(help, /calling agent selects its exact host, executes the returned/);
  assert.match(help, /Do not ask the user to copy or run setup commands/);
  assert.match(help, /argv arrays plus mutation and approval metadata/);
});

test("setup executes the one-shot state migration without host inference", async () => {
  let output = "";
  let called = 0;
  const injected = deps((text) => { output += text; });
  injected.migrateState = async () => {
    called += 1;
    return deps(() => {}).migrateState("/Users/private");
  };
  await setup(["migrate-state", "--json"], injected);
  assert.equal(called, 1);
  const receipt = JSON.parse(output) as { migration: { status: string; legacy_preserved: boolean } };
  assert.equal(receipt.migration.status, "migrated");
  assert.equal(receipt.migration.legacy_preserved, true);
  await assert.rejects(setup(["migrate-state", "--host", "codex"], injected), (error: unknown) => error instanceof CliError && error.code === "USAGE");
});
