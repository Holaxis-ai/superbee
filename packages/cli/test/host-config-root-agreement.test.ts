/**
 * Agreement contract for global hook targeting and user-scoped Agent Skill installation. OpenCode
 * deliberately shares the default Claude-compatible Skill root but not Claude's relocation knob.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { globalHookTargets, type HookTargets } from "../src/commands/hook.js";
import { skillTargets, type SkillTargets } from "../src/commands/skill.js";
import {
  resolveClaudeUserConfigFile,
  resolveOpenCodeConfigRoot,
  resolveOpenCodeGlobalConfigRoot,
} from "../src/host-config.js";

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
        const expected = override ? relocated : path.posix.join(home, host.fallbackDirectory);

        assert.equal(path.posix.dirname(globalHookTargets(home, env, "darwin")[host.hookTarget]), expected);
        assert.equal(path.posix.dirname(path.posix.dirname(skillTargets("user", { home, env, platform: "darwin" })[host.skillTarget])), expected);
      });
    }
  }
});

test("OpenCode resource and global-config roots keep their distinct override authorities", () => {
  const home = "/tmp/aslite-host-root-home";
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: "/tmp/xdg",
    OPENCODE_CONFIG_DIR: "/tmp/opencode-profile",
  };
  assert.equal(
    path.posix.dirname(path.posix.dirname(globalHookTargets(home, env, "darwin").opencodePlugin)),
    resolveOpenCodeConfigRoot(home, env, "darwin"),
  );
  assert.equal(resolveOpenCodeGlobalConfigRoot(home, env, "darwin"), "/tmp/xdg/opencode");
});

test("OpenCode skill discovery stays on the documented Claude-compatible path when Claude is relocated", () => {
  const home = "/tmp/aslite-host-root-home";
  const targets = skillTargets("user", {
    home,
    env: { CLAUDE_CONFIG_DIR: "/tmp/relocated-claude" },
    platform: "darwin",
  });
  assert.equal(targets.claude, "/tmp/relocated-claude/skills/superbee");
  assert.equal(targets.opencode, "/tmp/aslite-host-root-home/.claude/skills/superbee");
});

test("Claude Code user MCP registry honors CLAUDE_CONFIG_DIR without nesting the default", () => {
  assert.equal(resolveClaudeUserConfigFile("/users/mike", {}, "darwin"), "/users/mike/.claude.json");
  assert.equal(
    resolveClaudeUserConfigFile("/users/mike", { CLAUDE_CONFIG_DIR: "/profiles/claude" }, "darwin"),
    "/profiles/claude/.claude.json",
  );
});

test("Windows host roots use the user profile conventions of each host", () => {
  const home = String.raw`C:\Users\Mike`;
  const env = {
    USERPROFILE: home,
    APPDATA: String.raw`C:\Users\Mike\AppData\Roaming`,
  };
  assert.deepEqual(globalHookTargets(home, env, "win32"), {
    claudeSettings: String.raw`C:\Users\Mike\.claude\settings.json`,
    codexHooks: String.raw`C:\Users\Mike\.codex\hooks.json`,
    codexConfig: String.raw`C:\Users\Mike\.codex\config.toml`,
    opencodePlugin: String.raw`C:\Users\Mike\.config\opencode\plugins\axi-superbee.js`,
    legacyOpencodePlugin: String.raw`C:\Users\Mike\.config\opencode\plugins\axi-agentstate-lite.js`,
  });
  assert.deepEqual(skillTargets("user", { home, env, platform: "win32" }), {
    claude: String.raw`C:\Users\Mike\.claude\skills\superbee`,
    codex: String.raw`C:\Users\Mike\.codex\skills\superbee`,
    opencode: String.raw`C:\Users\Mike\.claude\skills\superbee`,
  });
});
