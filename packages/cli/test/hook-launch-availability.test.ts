import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildOpenCodePluginSource, hook, inspectHookStatus, sessionStartHookCommand } from "../src/commands/hook.js";
import { inspectHookLaunchAvailability } from "../src/hook-launch-availability.js";
import { buildSetupPlan, type SetupPlanInput } from "../src/setup-plan.js";

test("hook launch availability agrees across status and setup without changing generated ownership", async () => {
  for (const scenario of ["present", "missing_node", "missing_cli", "moved_prefix"] as const) {
    const root = await mkdtemp(path.join(tmpdir(), "superbee-hook-launch-"));
    try {
      const prefix = path.join(root, "prefix with spaces");
      const program = path.join(prefix, "bin", "node");
      const entry = path.join(prefix, "lib", "node_modules", "superbee", "dist", "superbee.mjs");
      await mkdir(path.dirname(program), { recursive: true });
      await mkdir(path.dirname(entry), { recursive: true });
      // Deliberately not executable code: inspection must never run either fixture.
      await writeFile(program, "not a Node executable\n");
      await chmod(program, 0o700);
      await writeFile(entry, "not JavaScript\n");
      const args = [entry, "session-start"];
      const command = sessionStartHookCommand(program, args);
      const settings = JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command, timeout: 10 }] }] } });
      for (const file of [".claude/settings.json", ".codex/hooks.json"]) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), settings);
      }
      const plugin = path.join(root, ".config/opencode/plugins/axi-superbee.js");
      await mkdir(path.dirname(plugin), { recursive: true });
      await writeFile(plugin, buildOpenCodePluginSource(program, args));
      if (scenario === "missing_node") await rm(program);
      if (scenario === "missing_cli") await rm(entry);
      if (scenario === "moved_prefix") await rename(prefix, path.join(root, "relocated-prefix"));

      const expected = scenario === "present" ? "available" : "unavailable";
      const inspection = inspectHookStatus("project", { base: root });
      let output = "";
      await hook(["status", "--scope", "project", "--json"], { base: root, stdout: (value) => { output += value; } });
      const status = JSON.parse(output).hook;
      for (const [key, host] of [["claude_code", "claude-code"], ["codex", "codex"], ["opencode", "opencode"]] as const) {
        const observed = inspection.hosts[key];
        assert.equal(observed.installed, true, `${scenario}: ${host} retains ownership`);
        assert.equal(observed.compatibility.state, "current", `${scenario}: syntax remains current`);
        assert.equal(observed.launchAvailability?.state, expected, `${scenario}: ${host}`);
        assert.equal(status.hosts[key].state, scenario === "present" ? "current" : "unavailable");
        assert.equal(status.hosts[key].compatibility.state, "current");
        assert.equal(status.hosts[key].launchAvailability.state, expected);
        const plan = buildSetupPlan({
          host, scope: "project",
          distribution: { allowed: true, state: "durable_global", reason: "durable", persistent: true },
          state: { state: "ready", reason: "current", records: 0 },
          skill: { canonical: { state: "installed" }, legacy: { state: "absent" } },
          hook: observed,
          mcp: { state: "owned_current", reason: "current" },
          workspace: { bundle: "selected", catalog: "ready", selected_registered: true },
        });
        const capability = plan.capabilities.find((item) => item.id === "hook");
        assert.equal(capability?.state, scenario === "present" ? "ready" : "needs_action");
        if (scenario !== "present") {
          assert.equal(plan.status, "action_required");
          assert.equal(plan.complete, false);
          assert.match(capability!.reason, /cannot launch/);
          assert.deepEqual(plan.next?.command, ["superbee", "hook", "install", "--scope", "project"]);
          const overlap = buildSetupPlan({
            host, scope: "user",
            distribution: { allowed: true, state: "durable_global", reason: "durable", persistent: true },
            state: { state: "ready", reason: "current", records: 0 },
            skill: { canonical: { state: "installed" }, legacy: { state: "absent" } },
            hook: { ...observed, launchAvailability: { state: "available", reason: "user launch files are accessible" } },
            projectHook: observed,
            mcp: { state: "owned_current", reason: "current" },
            workspace: { bundle: "selected", catalog: "ready", selected_registered: true },
          });
          const overlapCapability = overlap.capabilities.find((item) => item.id === "hook");
          assert.equal(overlapCapability?.state, "blocked", "unavailable project hook still creates an ownership overlap");
          assert.match(overlapCapability!.reason, /overlaps/);
          assert.equal(overlapCapability!.command, "superbee hook status --scope project");
        }
      }
      assert.equal(await readFile(path.join(root, ".claude/settings.json"), "utf8"), settings);
      assert.equal(await readFile(plugin, "utf8"), buildOpenCodePluginSource(program, args));
      // The expected-source shortcut must retain the same availability evidence.
      assert.equal(inspectHookStatus("project", { base: root, launchSpec: { program, args, command } }).hosts.opencode.launchAvailability?.state, expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("unmanaged hooks and plugins are never executed or treated as launchable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-hook-unmanaged-"));
  try {
    const sentinel = path.join(root, "must-not-exist");
    const command = `echo changed > "${sentinel}"`;
    const settings = JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command, timeout: 10 }] }] } });
    for (const file of [".claude/settings.json", ".codex/hooks.json"]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), settings);
    }
    const plugin = path.join(root, ".config/opencode/plugins/axi-superbee.js");
    await mkdir(path.dirname(plugin), { recursive: true });
    await writeFile(plugin, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)}, 'changed');`);
    const inspected = inspectHookStatus("project", { base: root });
    for (const status of Object.values(inspected.hosts)) {
      assert.equal(status.installed, false);
      assert.equal(status.compatibility.state, "unmanaged");
      assert.equal(status.launchAvailability?.state, "not_checked");
    }
    assert.equal(inspectHookLaunchAvailability(command).state, "not_checked");
    assert.equal(inspectHookLaunchAvailability("superbee session-start").state, "not_checked");
    await assert.rejects(access(sentinel));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing user launch files never bypass project hook overlap or inspection blockers", () => {
  for (const host of ["claude-code", "codex", "opencode"] as const) {
    const input: SetupPlanInput = {
      host, scope: "user",
      distribution: { allowed: true, state: "durable_global", reason: "durable", persistent: true },
      state: { state: "ready", reason: "current", records: 0 },
      skill: { canonical: { state: "installed" }, legacy: { state: "absent" } },
      hook: {
        installed: true, compatibility: { state: "current", reason: "generated" },
        launchAvailability: { state: "unavailable", reason: "Node launcher is missing or inaccessible" },
      },
      mcp: { state: "owned_current", reason: "current" },
      workspace: { bundle: "selected", catalog: "ready", selected_registered: true },
    };
    for (const project of [
      { projectHook: { installed: true, compatibility: { state: "current" as const, reason: "generated" } } },
      { projectHookUnavailable: true },
    ]) {
      const plan = buildSetupPlan({ ...input, ...project });
      const capability = plan.capabilities.find((item) => item.id === "hook");
      assert.equal(capability?.state, "blocked", host);
      assert.equal(capability?.command, "superbee hook status --scope project", host);
      assert.equal(plan.next?.action, "inspect", host);
    }
  }
});
