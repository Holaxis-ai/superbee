/**
 * One bounded, generic migration contract shared by help, generated skills, and release receipt
 * summaries. It intentionally names no host config path and makes no claim that the CLI inspected
 * a host.
 */
export const STABLE_MCP_LAUNCH_GUIDANCE = `## Stable MCP launch

For a persistent MCP integration, install the supported CLI with
\`npm install -g superbee\`. Configure the host command \`superbee\` with first argument \`mcp\`;
do not bind the host to an absolute, version-keyed cache executable. Replace such a transient path
manually, then verify the selected bytes with \`superbee version --json\`. The MCP
initialize response reports the same running release. Superbee does not scan or rewrite host MCP configuration.`;
