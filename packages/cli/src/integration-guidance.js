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

export function stableMcpLaunchGuidance(packageName='superbee',binName='superbee') {
 return STABLE_MCP_LAUNCH_GUIDANCE.replace('npm install -g superbee','npm install -g '+packageName).replaceAll('`superbee mcp','`'+binName+' mcp');
}

export const OPTIONAL_MCP_PREVIEW = Object.freeze({
  description: 'Try the experimental MCP App in Claude Desktop on macOS to read a document or approve a registered View in chat. Select a local bundle folder in the extension. The guide also includes offline tarballs for other clients on macOS and Linux with Node 24. In the guide’s installation shell, run `"$mcp" status --host <id>` to check the preview registration. You can keep the bundled server installed.',
  guide: "https://github.com/Holaxis-ai/superbee-plugins/blob/ebf1dcc931560282de75f44ef21ab5167d327e96/apps/mcp/README.md",
});
