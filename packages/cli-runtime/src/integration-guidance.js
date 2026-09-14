/**
 * One bounded, generic migration contract shared by help, generated skills, and release receipt
 * summaries. It intentionally names no host config path and makes no claim that the CLI inspected
 * a host.
 */
export const STABLE_MCP_LAUNCH_GUIDANCE = `## Stable MCP launch

For a persistent MCP integration, install the supported CLI with
\`npm install -g superbee\`, then run \`superbee mcp install --host <id>\` with the exact
current host: \`codex\`, \`claude-code\`, \`claude-desktop\`, or \`opencode\`. The command
registers the durable npm runtime once at user scope, never an npx cache or one bundle directory.
Use \`superbee mcp status --host <id>\` to verify it and restart the host after a change.`;
