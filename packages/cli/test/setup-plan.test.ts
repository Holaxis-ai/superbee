import assert from "node:assert/strict";
import test from "node:test";
import { buildSetupPlan, type SetupAction, type SetupPlanInput } from "../src/setup-plan.js";
import { USER_STATE_QUARANTINE_COMMAND } from "../src/user-state.js";

const CURRENT_SKILL = { canonical: { state: "installed" as const }, legacy: { state: "absent" as const } };
const CURRENT_HOOK = { installed: true, compatibility: { state: "current" as const, reason: "current" } };

function input(overrides: Partial<SetupPlanInput> = {}): SetupPlanInput {
  return {
    host: "codex", scope: "user",
    distribution: { allowed: true, state: "durable_global", reason: "durable", persistent: true },
    state: { state: "ready", reason: "current", records: 0 }, skill: CURRENT_SKILL, hook: CURRENT_HOOK,
    mcp: { state: "owned_current", reason: "current" },
    workspace: { bundle: "selected", catalog: "ready", selected_registered: true }, ...overrides,
  };
}

function next(plan: ReturnType<typeof buildSetupPlan>): SetupAction {
  assert.ok(plan.next, "expected an actionable setup plan");
  return plan.next;
}

test("setup plan agreement: every supported host has a ready agent protocol", () => {
  for (const host of ["codex", "claude-code", "claude-desktop", "opencode"] as const) {
    const plan = buildSetupPlan(input({ host }));
    assert.equal(plan.schema_version, 2, host);
    assert.equal(plan.protocol, "agent_setup_v1", host);
    assert.equal(plan.status, "ready", host);
    assert.match(plan.agent_instruction, /calling agent executes the returned action/, host);
    assert.equal(plan.ready, true, host);
    assert.equal(plan.complete, true, host);
    assert.equal(plan.next, undefined, host);
    assert.deepEqual(plan.verify, {
      action: "run", command: ["superbee", "setup", "--host", host, "--scope", "user", "--json"],
      description: "Reinspect setup readiness after the preceding action.", mutates: false,
      approval: { required: false, reason: null },
    });
  }
});

test("mutating setup actions are argv-based and declare their approval scope", () => {
  const migration = next(buildSetupPlan(input({
    state: { state: "migratable", reason: "validated legacy operational state is ready to migrate", records: 2 },
    skill: { canonical: { state: "absent" }, legacy: { state: "absent" } },
  })));
  assert.deepEqual(migration, {
    action: "run", command: ["superbee", "setup", "migrate-state"],
    description: "Migrate validated legacy private state into Superbee's canonical user-state directory.", mutates: true,
    approval: { required: true, reason: "This writes to the user-level Superbee private-state directory." },
  });

  const projectSkill = next(buildSetupPlan(input({
    scope: "project", skill: { canonical: { state: "absent" }, legacy: { state: "absent" } },
  })));
  assert.deepEqual(projectSkill.command, ["superbee", "skill", "install", "--scope", "project"]);
  assert.equal(projectSkill.mutates, true);
  assert.deepEqual(projectSkill.approval, { required: false, reason: null });

  const mcp = next(buildSetupPlan(input({ host: "claude-desktop", mcp: { state: "absent", reason: "absent" } })));
  assert.deepEqual(mcp.command, ["superbee", "mcp", "install", "--host", "claude-desktop"]);
  assert.equal(mcp.mutates, true);
  assert.equal(mcp.approval.required, true);
  assert.match(mcp.approval.reason ?? "", /user-level host configuration/);
});

test("follow-up actions retain a no-download local invocation", () => {
  const action = next(buildSetupPlan(input({
    invocation: ["npx", "--no-install", "superbee"],
    skill: { canonical: { state: "absent" }, legacy: { state: "absent" } },
  })));
  assert.deepEqual(action.command, ["npx", "--no-install", "superbee", "skill", "install", "--scope", "user"]);
  assert.equal(action.approval.required, true);
});

test("fallback invocation rewrites executable heads, not operands or private-state paths", () => {
  const invocation = ["npx", "--no-install", "superbee"];
  const distribution = next(buildSetupPlan(input({
    invocation,
    distribution: { allowed: false, state: "unknown", reason: "missing", persistent: false },
  })));
  assert.deepEqual(distribution.command, ["npm", "install", "-g", "superbee"]);

  const quarantine = next(buildSetupPlan(input({
    invocation,
    state: {
      state: "blocked", reason: "the canonical Superbee user-state root is unrecognized", records: 0,
      command: 'superbee_quarantine="$(mktemp -d ~/.superbee-state.unrecognized.XXXXXX)" && mv ~/.superbee-state "$superbee_quarantine"/ && superbee setup',
    },
  })));
  assert.deepEqual(quarantine.command, [
    "sh", "-c",
    'superbee_quarantine="$(mktemp -d ~/.superbee-state.unrecognized.XXXXXX)" && mv ~/.superbee-state "$superbee_quarantine"/ && npx --no-install superbee setup',
  ]);
});

test("state recovery distinguishes a shell mutation from a read-only inspection", () => {
  const quarantine = next(buildSetupPlan(input({
    state: {
      state: "blocked", reason: "the canonical Superbee user-state root is unrecognized", records: 0,
      command: `${USER_STATE_QUARANTINE_COMMAND} && superbee setup`,
    },
  })));
  assert.equal(quarantine.action, "run");
  assert.deepEqual(quarantine.command, ["sh", "-c", `${USER_STATE_QUARANTINE_COMMAND} && superbee setup`]);
  assert.equal(quarantine.mutates, true);
  assert.equal(quarantine.approval.required, true);

  const inspect = next(buildSetupPlan(input({
    state: {
      state: "blocked", reason: "legacy operational state at ~/.agentstate exists but is not a real directory", records: 0,
      command: "ls -ld ~/.agentstate",
    },
  })));
  assert.deepEqual(inspect, {
    action: "inspect", command: ["sh", "-c", "ls -ld ~/.agentstate"],
    description: "legacy operational state at ~/.agentstate exists but is not a real directory", mutates: false,
    approval: { required: false, reason: null },
  });
});

test("recognized state-permission repair remains a user-approved mutation", () => {
  const action = next(buildSetupPlan(input({
    state: {
      state: "repairable", reason: "the canonical Superbee user-state root is recognized but its permissions are group- or world-accessible",
      records: 0, command: "chmod -R go-rwx ~/.superbee-state",
    },
  })));
  assert.deepEqual(action.command, ["sh", "-c", "chmod -R go-rwx ~/.superbee-state"]);
  assert.equal(action.mutates, true);
  assert.equal(action.approval.required, true);
});

test("dependency order still yields exactly one action", () => {
  const distribution = next(buildSetupPlan(input({
    distribution: { allowed: false, state: "unknown", reason: "transient", persistent: false },
    skill: { canonical: { state: "absent" }, legacy: { state: "absent" } }, mcp: { state: "absent", reason: "absent" },
  })));
  assert.deepEqual(distribution.command, ["npm", "install", "-g", "superbee"]);
  assert.equal(distribution.approval.required, true);

  const inspection = next(buildSetupPlan(input({
    distribution: {
      allowed: false, state: "unknown", persistent: false, failure: "npm_prefix_runtime_unavailable",
      reason: "npm global prefix does not provide the running Node launcher required for durable host integration",
    },
  })));
  assert.equal(inspection.action, "inspect");
  assert.deepEqual(inspection.command, ["sh", "-c", "npm prefix --global && command -v node && command -v superbee"]);
  assert.deepEqual(inspection.approval, { required: false, reason: null });
});

test("foreign integrations fail closed onto unapproved read-only inspection", () => {
  const skill = next(buildSetupPlan(input({
    skill: { canonical: { state: "unmanaged" }, legacy: { state: "absent" } },
  })));
  assert.equal(skill.action, "inspect");
  assert.deepEqual(skill.command, ["superbee", "skill", "status", "--scope", "user"]);
  assert.equal(skill.mutates, false);
  assert.deepEqual(skill.approval, { required: false, reason: null });
});

test("bundle creation and catalog templates remain distinguishable to the agent", () => {
  const missingBundle = next(buildSetupPlan(input({
    workspace: { bundle: "absent", catalog: "empty", selected_registered: false },
  })));
  assert.deepEqual(missingBundle.command, ["superbee", "init", "--create-only", "--recipe", "work-tracking", "--dir", ".superbee"]);
  assert.equal(missingBundle.approval.required, true);

  const uncataloged = next(buildSetupPlan(input({
    hook: { installed: false, compatibility: { state: "absent", reason: "absent" } },
    workspace: { bundle: "selected", catalog: "empty", selected_registered: false },
  })));
  assert.equal(uncataloged.action, "choose_value");
  assert.equal(uncataloged.command, undefined);
  assert.equal(uncataloged.command_template, "superbee catalog add <label>");
  assert.equal(uncataloged.mutates, true);
  assert.equal(uncataloged.approval.required, true);
});
