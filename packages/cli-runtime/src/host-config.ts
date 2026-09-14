import path from "node:path";

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
  platform: string = process.platform,
): string {
  const configured = env[config.env];
  return configured === undefined || configured.length === 0
    ? (platform === "win32" ? path.win32 : path.posix).join(home, config.fallbackDirectory)
    : configured;
}

/** Render the equivalent shell expression used by the generated skill's discovery loop. */
export function renderShellHostConfigRoot(config: HostConfigRoot): string {
  return `"\${${config.env}:-$HOME/${config.fallbackDirectory}}"`;
}

/** Resolve OpenCode's canonical global config root without project or resource-dir overrides. */
export function resolveOpenCodeGlobalConfigRoot(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: string = process.platform,
): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  // OpenCode documents the same USERPROFILE/.config convention on Windows. XDG remains a
  // supported explicit override, but AppData is not an authority for this host surface.
  const xdg = env.XDG_CONFIG_HOME?.trim() || paths.join(home, ".config");
  return paths.join(xdg, "opencode");
}

/** Resolve OpenCode's resource/plugin root; OPENCODE_CONFIG_DIR applies to this host surface. */
export function resolveOpenCodeConfigRoot(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: string = process.platform,
): string {
  return env.OPENCODE_CONFIG_DIR?.trim() || resolveOpenCodeGlobalConfigRoot(home, env, platform);
}

/** Resolve Claude Code's user-scoped MCP registry (distinct from its `.claude` settings root). */
export function resolveClaudeUserConfigFile(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: string = process.platform,
): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const relocated = env.CLAUDE_CONFIG_DIR?.trim();
  return paths.join(relocated || home, ".claude.json");
}
