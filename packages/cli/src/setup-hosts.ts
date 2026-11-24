export const SETUP_HOSTS = [
  { id: "codex", label: "Codex / ChatGPT" },
  { id: "claude-code", label: "Claude Code" },
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "opencode", label: "OpenCode" },
] as const;

export type SetupHost = (typeof SETUP_HOSTS)[number];
export type SetupHostId = SetupHost["id"];
