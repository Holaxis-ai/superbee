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
  description: 'Try the optional experimental MCP App on macOS or Linux with Node 24 using the matching offline tarballs. Keep your bundled registration. In the guide’s installation shell, run `"$mcp" status --host <id>` to check the preview registration. In Claude Desktop on macOS, both the extension and the bundled server can return a document title while the reader fails to display its body. With the CLI installed, run `superbee doc open <id> --dir "<bundle-folder>"` using the same local bundle folder you selected in Desktop to read the document in your browser.',
  guide: "https://github.com/Holaxis-ai/superbee-plugins/blob/40e327bc4f1f5a39e4159bba655026a11b12b967/apps/mcp/README.md",
});
