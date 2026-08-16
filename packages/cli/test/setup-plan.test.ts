import assert from "node:assert/strict";
import test from "node:test";
import { buildSetupPlan, type SetupPlanInput } from "../src/setup-plan.js";

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
    assert.equal(plan.capabilities.length, 6, host);
    const skill = plan.capabilities.find((row) => row.id === "skill")!;
    const hook = plan.capabilities.find((row) => row.id === "hook")!;
    assert.equal(skill.state, host === "claude-desktop" || host === "opencode" ? "not_applicable" : "ready", host);
    assert.equal(hook.state, host === "claude-desktop" ? "not_applicable" : "ready", host);
  }
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
});

test("bundle and catalog complete the conversational workspace journey without inventing a label", () => {
  const missingBundle = buildSetupPlan(input({
    workspace: { bundle: "absent", catalog: "empty", selected_registered: false },
  }));
  assert.equal(missingBundle.next?.command, "superbee init --create-only --recipe work-tracking --dir .agentstate-lite");

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
});
