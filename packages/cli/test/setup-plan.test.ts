import assert from "node:assert/strict";
import test from "node:test";
import { buildSetupPlan, type SetupPlanInput } from "../src/setup-plan.js";
import { USER_STATE_QUARANTINE_COMMAND } from "../src/user-state.js";

const CURRENT_SKILL = {
  canonical: { state: "installed" as const },
  legacy: { state: "absent" as const },
};
const CURRENT_HOOK = {
  installed: true,
  compatibility: { state: "current" as const, reason: "current" },
};

function input(overrides: Partial<SetupPlanInput> = {}): SetupPlanInput {
  return {
    host: "codex",
    scope: "user",
    distribution: { allowed: true, state: "durable_global", reason: "durable", persistent: true },
    state: { state: "ready", reason: "current", records: 0 },
    skill: CURRENT_SKILL,
    hook: CURRENT_HOOK,
    mcp: { state: "owned_current", reason: "current" },
    workspace: { bundle: "selected", catalog: "ready", selected_registered: true },
    ...overrides,
  };
}

test("setup plan agreement: every supported host can reach a complete host-native plan", () => {
  for (const host of ["codex", "claude-code", "claude-desktop", "opencode"] as const) {
    const plan = buildSetupPlan(input({ host }));
    assert.equal(plan.ready, true, host);
    assert.equal(plan.complete, true, host);
    assert.equal(plan.next, undefined, host);
    assert.equal(plan.capabilities.length, 7, host);
    const skill = plan.capabilities.find((row) => row.id === "skill")!;
    const hook = plan.capabilities.find((row) => row.id === "hook")!;
    assert.equal(skill.state, host === "claude-desktop" || host === "opencode" ? "not_applicable" : "ready", host);
    assert.equal(hook.state, host === "claude-desktop" ? "not_applicable" : "ready", host);
  }
});

test("legacy operational state is one explicit setup action before host integration", () => {
  const plan = buildSetupPlan(input({
    state: { state: "migratable", reason: "validated legacy operational state is ready to migrate", records: 2 },
    skill: { canonical: { state: "absent" }, legacy: { state: "absent" } },
  }));
  assert.deepEqual(plan.next, {
    action: "run",
    command: "superbee setup migrate-state",
    reason: "validated legacy operational state is ready to migrate",
  });
  assert.equal(plan.ready, false);
});

test("uncertain canonical user state blocks setup with a real exit node, not a self-pointing rerun", () => {
  const plan = buildSetupPlan(input({
    state: { state: "blocked", reason: "the canonical Superbee user-state root is unrecognized", records: 0 },
  }));
  assert.deepEqual(plan.next, {
    action: "inspect",
    command: `${USER_STATE_QUARANTINE_COMMAND} && superbee setup`,
    reason: "the canonical Superbee user-state root is unrecognized",
  });
  // The whole point: rerunning the command that reported the block cannot clear it, so the emitted
  // command must CHANGE something first — by rename, never by delete.
  assert.notEqual(plan.next?.command, "superbee setup");
  assert.match(plan.next?.command ?? "", /^mv /);
  assert.doesNotMatch(plan.next?.command ?? "", /\brm\b/);
});

test("setup plan emits exactly one deterministic next command in dependency order", () => {
  const distribution = buildSetupPlan(input({
    distribution: { allowed: false, state: "unknown", reason: "transient", persistent: false },
    skill: { canonical: { state: "absent" }, legacy: { state: "absent" } },
    mcp: { state: "absent", reason: "absent" },
  }));
  assert.deepEqual(distribution.next, {
    action: "run",
    command: "npm install -g superbee",
    reason: "transient",
  });

  const skill = buildSetupPlan(input({
    skill: { canonical: { state: "absent" }, legacy: { state: "absent" } },
    mcp: { state: "absent", reason: "absent" },
  }));
  assert.equal(skill.next?.command, "superbee skill install --scope user");

  const desktop = buildSetupPlan(input({ host: "claude-desktop", mcp: { state: "absent", reason: "absent" } }));
  assert.equal(desktop.next?.command, "superbee mcp install --host claude-desktop");
});

test("foreign integration state fails closed onto a read-only inspector", () => {
  const skill = buildSetupPlan(input({
    skill: { canonical: { state: "unmanaged" }, legacy: { state: "absent" } },
  }));
  assert.equal(skill.next?.action, "inspect");
  assert.equal(skill.next?.command, "superbee skill status --scope user");

  const mcp = buildSetupPlan(input({
    host: "claude-desktop",
    mcp: { state: "foreign", reason: "reserved name is foreign" },
  }));
  assert.equal(mcp.next?.action, "inspect");
  assert.equal(mcp.next?.command, "superbee mcp status --host claude-desktop");

  const legacyMcp = buildSetupPlan(input({
    host: "claude-code",
    mcp: { state: "known_legacy", reason: "registration 'aslite-views' is a legacy candidate" },
  }));
  assert.equal(legacyMcp.next?.action, "inspect");
  assert.equal(legacyMcp.next?.command, "superbee mcp status --host claude-code");
  assert.equal(
    legacyMcp.capabilities.find((row) => row.id === "mcp")?.state,
    "blocked",
  );

  for (const host of ["codex", "claude-code"] as const) {
    const hook = buildSetupPlan(input({
      host,
      hook: {
        installed: true,
        installSafe: false,
        compatibility: { state: "current", reason: "current entry beside malformed settings" },
      },
    }));
    assert.equal(hook.next?.action, "inspect", host);
    assert.equal(hook.next?.command, "superbee hook status --scope user", host);
  }

  const openCodeHook = buildSetupPlan(input({
    host: "opencode",
    hook: { installed: false, compatibility: { state: "unmanaged", reason: "foreign" } },
  }));
  assert.equal(openCodeHook.next?.action, "inspect");
  assert.equal(openCodeHook.next?.command, "superbee hook status --scope user");

  for (const host of ["codex", "claude-code"] as const) {
    const foreignProjectHook = buildSetupPlan(input({
      host,
      projectHook: {
        installed: false,
        installSafe: true,
        compatibility: { state: "unmanaged", reason: "foreign project hook coexists" },
      },
    }));
    assert.equal(foreignProjectHook.complete, true, host);
    assert.equal(foreignProjectHook.next, undefined, host);
  }

  const staleProjectHook = buildSetupPlan(input({
    projectHook: {
      installed: true,
      compatibility: { state: "legacy_identity", reason: "legacy project hook" },
    },
  }));
  assert.equal(staleProjectHook.next?.action, "inspect");
  assert.equal(staleProjectHook.next?.command, "superbee hook status --scope project");

  for (const state of ["installed", "stale"] as const) {
    const newerSkill = buildSetupPlan(input({
      skill: {
        canonical: { state, compatibility: { state: "newer_contract" } },
        legacy: { state: "absent", compatibility: { state: "absent" } },
      },
    }));
    assert.equal(newerSkill.next?.action, "inspect", state);
    assert.equal(newerSkill.next?.command, "superbee skill status --scope user", state);
  }

  for (const state of ["installed", "stale"] as const) {
    const newerLegacySkill = buildSetupPlan(input({
      skill: {
        canonical: { state: "absent", compatibility: { state: "absent" } },
        legacy: { state, compatibility: { state: "newer_contract" } },
      },
    }));
    assert.equal(newerLegacySkill.next?.action, "inspect", state);
    assert.equal(newerLegacySkill.next?.command, "superbee skill status --scope user", state);
  }
});

test("bundle and catalog complete the conversational workspace journey without inventing a label", () => {
  const missingBundle = buildSetupPlan(input({
    workspace: { bundle: "absent", catalog: "empty", selected_registered: false },
  }));
  assert.equal(missingBundle.next?.command, "superbee init --create-only --recipe work-tracking --dir .superbee");

  const uncataloged = buildSetupPlan(input({
    hook: { installed: false, compatibility: { state: "absent", reason: "absent" } },
    workspace: { bundle: "selected", catalog: "empty", selected_registered: false },
  }));
  assert.equal(uncataloged.next?.command, "superbee catalog add <label>");
  assert.equal(uncataloged.next?.action, "choose_value");
  assert.equal(uncataloged.ready, false);

  const catalogOnly = buildSetupPlan(input({
    workspace: { bundle: "absent", catalog: "ready", selected_registered: false },
  }));
  assert.equal(catalogOnly.complete, true);
  assert.equal(catalogOnly.next, undefined);
  assert.deepEqual(catalogOnly.workspace, {
    current_project_bundle: "absent",
    catalog_access: "ready",
    catalog_selects_current_project: false,
  });
  const projectBundle = catalogOnly.capabilities.find((row) => row.id === "bundle")!;
  assert.equal(projectBundle.state, "not_applicable");
  assert.match(projectBundle.reason, /not project context/);
  const catalog = catalogOnly.capabilities.find((row) => row.id === "catalog")!;
  assert.equal(catalog.state, "ready");
  assert.match(catalog.reason, /does not select current project context/);
});
