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
    inspectState: async () => ({ state: "ready", reason: "current", records: 0 }),
    migrateState: async () => ({
      schema_version: 1,
      status: "migrated",
      changed: true,
      records: {
        catalog: "migrated",
        credentials: "absent",
        view_authorizations: 0,
        sync_state: "rederived",
        ephemeral_state: "rederived",
      },
      legacy_preserved: true,
      next: { command: "superbee setup" },
    }),
    hardenState: async () => ({
      schema_version: 1,
      operation: "harden-state",
      status: "hardened",
      changed: true,
      root: "~/.superbee-state",
      next: { command: "superbee setup" },
    }),
    quarantineState: async () => ({
      schema_version: 1,
      operation: "quarantine-state",
      status: "quarantined",
      changed: true,
      root: "~/.superbee-state",
      preserved_at: "~/.superbee-state.unrecognized/token/.superbee-state",
      next: { command: "superbee setup" },
    }),
  };
}

test("setup without a host returns a bounded path-free four-host selector", async () => {
  let output = "";
  await setup(["--json"], deps((text) => { output += text; }));
  const parsed = JSON.parse(output) as {
    setup: {
      mode: string;
      hosts: Array<{ id: string; command: string }>;
      capabilities: Array<{ id: string; state: string }>;
      next: { action: string };
    };
  };
  assert.equal(parsed.setup.mode, "select_host");
  assert.deepEqual(parsed.setup.hosts.map((row) => row.id), ["codex", "claude-code", "claude-desktop", "opencode"]);
  assert.equal(parsed.setup.hosts[0]?.command, "superbee setup --host codex --scope user");
  assert.deepEqual(parsed.setup.capabilities, [{
    id: "state",
    requirement: "required",
    state: "ready",
    reason: "current",
  }]);
  assert.equal(parsed.setup.next.action, "select_host");
  assert.doesNotMatch(output, /\/Users\/private/);
});

test("hostless setup makes private-state recovery the next action before host selection", async () => {
  for (const state of [
    {
      state: "migratable" as const,
      reason: "validated legacy private state is ready to migrate",
      records: 2,
      action: "run",
      command: "superbee setup migrate-state",
    },
    {
      state: "blocked" as const,
      reason: "canonical private state is unrecognized",
      records: 0,
      action: "inspect",
      command: "mv ~/.superbee-state ~/.superbee-state.quarantine",
    },
  ]) {
    let output = "";
    const injected = deps((text) => { output += text; });
    injected.inspectState = async () => state;
    await setup(["--json"], injected);
    const parsed = JSON.parse(output) as {
      setup: {
        capabilities: Array<{ id: string; state: string; command?: string }>;
        next: { action: string; command: string; reason: string };
      };
    };
    assert.equal(parsed.setup.capabilities[0]?.id, "state");
    assert.equal(parsed.setup.capabilities[0]?.state, state.state === "blocked" ? "blocked" : "needs_action");
    assert.equal(parsed.setup.capabilities[0]?.command, state.command);
    assert.deepEqual(parsed.setup.next, {
      action: state.action,
      command: state.command,
      reason: state.reason,
    });
    assert.doesNotMatch(output, /\/Users\/private/);
  }
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

test("host-scoped setup turns a package-only npm prefix into path-free runtime inspection", async () => {
  let output = "";
  const injected = deps((text) => { output += text; });
  injected.inspectDistribution = () => ({
    allowed: false,
    state: "unknown",
    reason: "npm global prefix does not provide the running Node launcher required for durable host integration",
    failure: "npm_prefix_runtime_unavailable",
    evidence: {
      npm_prefix: "/Users/private/npm",
      bin_path: "/Users/private/npm/bin/superbee",
      executable_path: "/Users/private/npm/lib/node_modules/superbee/dist/superbee.mjs",
      runtime_path: "/opt/private/node",
    },
  });

  await setup(["--host", "codex", "--json"], injected);
  const parsed = JSON.parse(output) as {
    setup: { next: { action: string; command: string; reason: string } };
  };
  assert.deepEqual(parsed.setup.next, {
    action: "inspect",
    command: "npm prefix --global && command -v node && command -v superbee",
    reason: "npm global prefix does not provide the running Node launcher required for durable host integration; use the npm-global prefix owned by the running Node installation, reinstall Superbee there, then rerun setup",
  });
  assert.doesNotMatch(output, /\/Users\/private|\/opt\/private/);
});

test("user setup surfaces a project overlay without recommending an all-host uninstall", async () => {
  let output = "";
  const injected = deps((text) => { output += text; });
  const inspectHook = injected.inspectHook;
  injected.inspectHook = (scope) => {
    const inspection = inspectHook(scope);
    if (scope === "user") {
      inspection.hosts.claude_code = {
        installed: false,
        compatibility: { state: "absent", reason: "Claude user hook is absent" },
      };
    }
    if (scope === "project") {
      inspection.hosts.codex = {
        installed: true,
        compatibility: { state: "legacy_identity", reason: "legacy project hook" },
      };
      inspection.hosts.claude_code = {
        installed: true,
        compatibility: { state: "current", reason: "Claude project hook is the only effective hook" },
      };
    }
    return inspection;
  };
  await setup(["--host", "codex", "--scope", "user", "--json"], injected);
  const parsed = JSON.parse(output) as {
    setup: { complete: boolean; next: { action: string; command: string } };
  };
  assert.equal(parsed.setup.complete, false);
  assert.deepEqual(parsed.setup.next, {
    action: "inspect",
    command: "superbee hook status --scope project",
    reason: "a managed project SessionStart hook overlaps the current user hook",
  });
});

test("an absent user hook is installed before a current project hook is retired", async () => {
  let output = "";
  const injected = deps((text) => { output += text; });
  const inspectHook = injected.inspectHook;
  injected.inspectHook = (scope) => {
    const inspection = inspectHook(scope);
    if (scope === "user") {
      inspection.hosts.codex = {
        installed: false,
        compatibility: { state: "absent", reason: "absent" },
      };
    }
    return inspection;
  };
  await setup(["--host", "codex", "--scope", "user", "--json"], injected);
  const parsed = JSON.parse(output) as {
    setup: { complete: boolean; next: { action: string; command: string } };
  };
  assert.equal(parsed.setup.complete, false);
  assert.deepEqual(parsed.setup.next, {
    action: "run",
    command: "superbee hook install --scope user",
    reason: "the SessionStart orientation hook is absent",
  });
});

test("user setup blocks on an unmanaged project OpenCode plugin instead of hiding it behind a current user hook", async () => {
  let output = "";
  const injected = deps((text) => { output += text; });
  const inspectHook = injected.inspectHook;
  injected.inspectHook = (scope) => {
    const inspection = inspectHook(scope);
    if (scope === "project") {
      inspection.hosts.opencode = {
        installed: false,
        compatibility: { state: "unmanaged", reason: "unrecognized legacy project plugin" },
      };
    }
    return inspection;
  };
  await setup(["--host", "opencode", "--scope", "user", "--json"], injected);
  const parsed = JSON.parse(output) as {
    setup: { complete: boolean; next: { action: string; command: string } };
  };
  assert.equal(parsed.setup.complete, false);
  assert.deepEqual(parsed.setup.next, {
    action: "inspect",
    command: "superbee hook status --scope project",
    reason: "the reserved project OpenCode plugin path is not managed by Superbee",
  });
});

test("user setup fails closed when project hook inspection is unavailable", async () => {
  let output = "";
  const injected = deps((text) => { output += text; });
  injected.inspectHook = (scope) => {
    if (scope === "project") throw new Error("unreadable project settings");
    return deps(() => {}).inspectHook(scope);
  };
  await setup(["--host", "codex", "--scope", "user", "--json"], injected);
  const parsed = JSON.parse(output) as {
    setup: { complete: boolean; next: { action: string; command: string } };
  };
  assert.equal(parsed.setup.complete, false);
  assert.deepEqual(parsed.setup.next, {
    action: "inspect",
    command: "superbee hook status --scope project",
    reason: "the codex project hook settings could not be inspected",
  });
});

test("cataloging a legacy workspace never selects it as the current project bundle", async () => {
  let output = "";
  const injected = deps((text) => { output += text; });
  injected.resolveBundle = async () => {
    throw new CliError("NOT_FOUND", "no bundle in the current checkout");
  };
  injected.listCatalog = async () => [{
    id: "bnd_00000000000000000000000000000000",
    label: "legacy-project",
    locator: { kind: "local-path", path: "/Users/private/other-project/.agentstate-lite" },
    available: true,
  }];
  const inspectHook = injected.inspectHook;
  injected.inspectHook = (scope) => {
    const inspection = inspectHook(scope);
    if (scope === "project") {
      inspection.hosts.codex = {
        installed: false,
        compatibility: { state: "absent", reason: "no project hook" },
      };
    }
    return inspection;
  };

  await setup(["--host", "codex", "--json"], injected);
  const parsed = JSON.parse(output) as {
    setup: {
      complete: boolean;
      workspace: {
        current_project_bundle: string;
        catalog_access: string;
        catalog_selects_current_project: boolean;
      };
      capabilities: Array<{ id: string; state: string; reason: string }>;
      next?: unknown;
    };
  };
  assert.equal(parsed.setup.complete, true);
  assert.equal(parsed.setup.next, undefined);
  assert.deepEqual(parsed.setup.workspace, {
    current_project_bundle: "absent",
    catalog_access: "ready",
    catalog_selects_current_project: false,
  });
  const bundle = parsed.setup.capabilities.find((row) => row.id === "bundle")!;
  assert.equal(bundle.state, "not_applicable");
  assert.match(bundle.reason, /not project context/);
  assert.doesNotMatch(output, /other-project|\/Users\/private/);
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

test("known legacy MCP state returns inspection instead of an install command that will refuse it", async () => {
  let output = "";
  const injected = deps((text) => { output += text; });
  injected.inspectMcp = (targets) => targets.map((target) => ({
    host: target.id,
    label: target.label,
    state: "known_legacy",
    config: "~/.claude.json",
    reason: "registration 'aslite-views' is a legacy candidate; inspect it before migration",
    docs_url: target.docs_url,
  }));
  await setup(["--host", "claude-code", "--json"], injected);
  const parsed = JSON.parse(output) as {
    setup: { ready: boolean; next: { action: string; command: string } };
  };
  assert.equal(parsed.setup.ready, false);
  assert.deepEqual(parsed.setup.next, {
    action: "inspect",
    command: "superbee mcp status --host claude-code",
    reason: "registration 'aslite-views' is a legacy candidate; inspect it before migration",
  });
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
  assert.match(help, /setup migrate-state/);
  assert.match(help, /setup harden-state/);
  assert.match(help, /setup quarantine-state/);
  assert.match(help, /catalog entry preserves a workspace for explicit MCP selection/);
  assert.match(help, /never selects that workspace\s+as the current project's context/);
});

test("setup executes the product-owned state recovery leaves without host inference", async () => {
  for (const operation of ["harden-state", "quarantine-state"] as const) {
    let output = "";
    let called = 0;
    const injected = deps((text) => { output += text; });
    if (operation === "harden-state") {
      injected.hardenState = async (home) => {
        called += 1;
        assert.equal(home, "/Users/private");
        return deps(() => {}).hardenState(home);
      };
    } else {
      injected.quarantineState = async (home) => {
        called += 1;
        assert.equal(home, "/Users/private");
        return deps(() => {}).quarantineState(home);
      };
    }
    await setup([operation, "--json"], injected);
    assert.equal(called, 1);
    const receipt = JSON.parse(output) as { state_recovery: { operation: string; changed: boolean } };
    assert.equal(receipt.state_recovery.operation, operation);
    assert.equal(receipt.state_recovery.changed, true);
    await assert.rejects(setup([operation, "--scope", "user"], injected), (error: unknown) =>
      error instanceof CliError && error.code === "USAGE");
  }
});

test("setup projects and executes the one-shot state migration without host inference", async () => {
  let output = "";
  const injected = deps((text) => { output += text; });
  injected.inspectState = async () => ({
    state: "migratable",
    reason: "validated legacy operational state is ready to migrate",
    records: 1,
  });
  await setup(["--host", "codex", "--json"], injected);
  const plan = JSON.parse(output) as { setup: { next: { command: string } } };
  assert.equal(plan.setup.next.command, "superbee setup migrate-state");

  output = "";
  let called = 0;
  const expected = await deps(() => {}).migrateState("/Users/private");
  injected.migrateState = async () => {
    called += 1;
    return expected;
  };
  await setup(["migrate-state", "--json"], injected);
  assert.equal(called, 1);
  const receipt = JSON.parse(output) as { migration: { status: string; legacy_preserved: boolean } };
  assert.equal(receipt.migration.status, "migrated");
  assert.equal(receipt.migration.legacy_preserved, true);
  assert.doesNotMatch(output, /\/Users\/private/);
  await assert.rejects(setup(["migrate-state", "--host", "codex"], injected), (error: unknown) =>
    error instanceof CliError && error.code === "USAGE");
});
