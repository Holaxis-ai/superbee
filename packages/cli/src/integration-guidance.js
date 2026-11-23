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
  description: "Try the optional experimental MCP App with the macOS Claude Desktop extension or matching npm tarballs for macOS and Linux with Node 24. Check the preview separately with the installed superbee-mcp status --host <id> command or in your client. The guide covers setup, source builds and switching back to the bundled server.",
  guide: "https://github.com/Holaxis-ai/superbee-plugins/blob/40e327bc4f1f5a39e4159bba655026a11b12b967/apps/mcp/README.md",
});
