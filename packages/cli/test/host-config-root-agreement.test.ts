/**
 * Agreement contract for the two consumers of Claude/Codex config roots: global hook targeting
 * and user-scoped Agent Skill installation. OpenCode is hook-only and intentionally absent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";

import { globalHookTargets, type HookTargets } from "../src/commands/hook.js";
import { skillTargets, type SkillTargets } from "../src/commands/skill.js";

interface HostRow {
  name: string;
  env: "CLAUDE_CONFIG_DIR" | "CODEX_HOME";
  fallbackDirectory: ".claude" | ".codex";
  skillTarget: keyof SkillTargets;
  hookTarget: keyof Pick<HookTargets, "claudeSettings" | "codexHooks">;
}

const HOSTS: HostRow[] = [
  {
    name: "Claude Code",
    env: "CLAUDE_CONFIG_DIR",
    fallbackDirectory: ".claude",
    skillTarget: "claude",
    hookTarget: "claudeSettings",
  },
  {
    name: "Codex",
    env: "CODEX_HOME",
    fallbackDirectory: ".codex",
    skillTarget: "codex",
    hookTarget: "codexHooks",
  },
];

const CASES = [
  { name: "default", override: undefined },
  { name: "empty override falls back", override: "" },
  { name: "relocated", override: "relocated" },
] as const;

test("global hook targets and user-scoped skill installation share the host-root matrix", async (t) => {
  const home = "/tmp/aslite-host-root-home";
  for (const host of HOSTS) {
    for (const scenario of CASES) {
      await t.test(`${host.name}: ${scenario.name}`, () => {
        const relocated = `/tmp/${host.name.toLowerCase().replaceAll(" ", "-")}-config`;
        const override = scenario.override === "relocated" ? relocated : scenario.override;
        const env: NodeJS.ProcessEnv = { HOME: home };
        if (override !== undefined) env[host.env] = override;
        const expected = override ? relocated : join(home, host.fallbackDirectory);

        assert.equal(dirname(globalHookTargets(home, env)[host.hookTarget]), expected);
        assert.equal(dirname(dirname(skillTargets("user", { home, env })[host.skillTarget])), expected);
      });
    }
  }
});
