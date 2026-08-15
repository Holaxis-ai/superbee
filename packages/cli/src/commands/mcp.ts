// `superbee mcp [--dir <path>] [--actor <name>]` — run the local MCP Apps adapter over one
// AgentState bundle. The command uses stdio as its transport, so stdout belongs exclusively to MCP
// protocol frames after startup; diagnostics and human receipts must never be written there.
import { parseArgs } from "node:util";
import { startMcpStdioServer } from "@superbee/mcp-app";
import type { Bundle } from "@superbee/core";
import type { ViewAuthorizationStore } from "@superbee/view-runtime";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { resolveActor } from "../actor.js";
import { openBundle } from "../bundle.js";
import { deriveBundleDisplayName } from "../bundle-name.js";
import { asHandled, CliError, toExit } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { renderErrorEnvelope } from "../output.js";
import { LocalViewAuthorizationStore } from "../ui/view-authorizations.js";
import { cliVersion } from "../build-identity.js";
import { STABLE_MCP_LAUNCH_GUIDANCE } from "../integration-guidance.js";

export const MCP_USAGE = `superbee mcp — expose invocation-specific Superbee Views to an MCP Apps host

Usage:
  superbee mcp [--dir <path>] [--actor <name>]

Options:
  --dir <path>          Local bundle directory (default: discovered from the cwd)
  --actor <name>        Attribute confirmed human actions (overrides SUPERBEE_ACTOR; legacy
                        AGENTSTATE_LITE_ACTOR remains supported)
  -h, --help            Show this help

The server uses stdio. Use show_document with an exact document ID to display its
authoritative Markdown in Superbee's fixed reader without executable View approval. Use show_view
to provide an exact registered View ID and launch its current HTML unchanged through the shared
View bridge, after trusted-shell approval of those exact bytes. Or the agent can launch standard
View HTML transiently for the current MCP process, with explicit bundle-read or bundle-propose
access, then save the approved exact bytes as a registered View without transformation.
Views use the same query, render-document, graph, subscription, and governed-action bridge in MCP
and the web UI. Every bundle-propose action requires explicit human confirmation and a current
document version. The server accepts no remote targets or arbitrary filesystem paths.

${STABLE_MCP_LAUNCH_GUIDANCE}
`;

export interface McpCliDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  openBundle: (dir: string | undefined) => Promise<Bundle>;
  startServer: (options: {
    bundle: Bundle;
    version?: string;
    actor?: string;
    bundleName?: string;
    viewAuthorization?: ViewAuthorizationStore;
  }) => Promise<void>;
}

export async function mcp(argv: string[], deps: Partial<McpCliDeps> = {}): Promise<void> {
  const stderr = deps.stderr ?? ((text: string) => void process.stderr.write(text));
  // Reserve the JSON-RPC channel before parsing args or discovering a bundle: every failure path
  // must be routed once to stderr, then marked handled so the outer AXI wrapper emits no stdout.
  try {
    await mcpInner(argv, deps);
  } catch (error) {
    const { envelope, handled } = toExit(error);
    if (!handled) stderr(renderErrorEnvelope(envelope));
    throw handled ? error : asHandled(error);
  }
}

async function mcpInner(argv: string[], deps: Partial<McpCliDeps>): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const open = deps.openBundle ?? ((dir: string | undefined) => openBundle(dir));
  const start = deps.startServer ?? startMcpStdioServer;
  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          dir: { type: "string" },
          actor: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.mcp,
  );
  if (values.help) {
    stdout(MCP_USAGE);
    return;
  }
  const bundle = await open(values.dir);
  const actor = resolveActor(values.actor, {
    help: `${cliInvocation()} mcp --actor <name>`,
  });
  const bundleName = (await deriveBundleDisplayName(bundle)).name;
  await start({
    bundle,
    version: cliVersion(),
    actor,
    bundleName,
    viewAuthorization: new LocalViewAuthorizationStore(bundle.root),
  });
}
