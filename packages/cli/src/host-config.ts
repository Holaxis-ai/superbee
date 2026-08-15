import { join } from "node:path";

/** Claude/Codex config-root conventions shared by hook targeting and skill discovery. */
export const HOST_CONFIG_ROOTS = {
  claude: { env: "CLAUDE_CONFIG_DIR", fallbackDirectory: ".claude" },
  codex: { env: "CODEX_HOME", fallbackDirectory: ".codex" },
} as const;

export type HostConfigRoot = (typeof HOST_CONFIG_ROOTS)[keyof typeof HOST_CONFIG_ROOTS];

/** Resolve a host root with shell `${VAR:-fallback}` semantics: empty overrides also fall back. */
export function resolveHostConfigRoot(
  config: HostConfigRoot,
  home: string,
  env: NodeJS.ProcessEnv,
): string {
  const configured = env[config.env];
  return configured === undefined || configured.length === 0
    ? join(home, config.fallbackDirectory)
    : configured;
}

/** Render the equivalent shell expression used by the generated skill's discovery loop. */
export function renderShellHostConfigRoot(config: HostConfigRoot): string {
  return `"\${${config.env}:-$HOME/${config.fallbackDirectory}}"`;
}

/** Resolve OpenCode's canonical global config root without project or resource-dir overrides. */
export function resolveOpenCodeGlobalConfigRoot(home: string, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(xdg, "opencode");
}

/** Resolve OpenCode's resource/plugin root; OPENCODE_CONFIG_DIR applies to this host surface. */
export function resolveOpenCodeConfigRoot(home: string, env: NodeJS.ProcessEnv): string {
  return env.OPENCODE_CONFIG_DIR?.trim() || resolveOpenCodeGlobalConfigRoot(home, env);
}

/** Resolve Claude Code's user-scoped MCP registry (distinct from its `.claude` settings root). */
export function resolveClaudeUserConfigFile(home: string, env: NodeJS.ProcessEnv): string {
  const relocated = env.CLAUDE_CONFIG_DIR?.trim();
  return join(relocated || home, ".claude.json");
}
