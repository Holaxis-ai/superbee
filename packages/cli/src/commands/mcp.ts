// `superbee mcp [--dir <path>] [--actor <name>]` — run the local MCP Apps adapter over the private
// workspace catalog or one fixed bundle. The command uses stdio as its transport, so stdout belongs exclusively to MCP
// protocol frames after startup; diagnostics and human receipts must never be written there.
import { parseArgs } from "node:util";
import {
  startMcpStdioServer,
  type CreateMcpAppServerOptions,
  type McpWorkspaceResolver,
} from "@superbee/mcp-app";
import type { Bundle } from "@superbee/core";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { resolveActor } from "../actor.js";
import { openBundle } from "../bundle.js";
import { deriveBundleDisplayName } from "../bundle-name.js";
import { asHandled, CliError, toExit } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, renderErrorEnvelope, resolveMode } from "../output.js";
import { LocalViewAuthorizationStore } from "../ui/view-authorizations.js";
import { cliVersion } from "../build-identity.js";
import { STABLE_MCP_LAUNCH_GUIDANCE } from "../integration-guidance.js";
import { createCatalogMcpWorkspaceResolver } from "../mcp-workspace-resolver.js";
import {
  inspectMcpHosts,
  MCP_INSTALL_TARGETS,
  resolveMcpInstallTarget,
  type McpHostStatus,
  type McpInstallTarget,
} from "../mcp-install-targets.js";
import {
  McpRegistrationError,
  mutateMcpRegistration,
  type McpRegistrationOperation,
  type McpRegistrationReceipt,
} from "../mcp-registration.js";

export const MCP_USAGE = `superbee mcp — expose Superbee documents and Views to an MCP Apps host

Usage:
  superbee mcp [--dir <path>] [--actor <name>]
  superbee mcp install --host <id> [--actor <label>] [--json]
  superbee mcp status [--host <id>] [--json]
  superbee mcp uninstall --host <id> [--json]

Options:
  --dir <path>          Fixed local bundle compatibility mode; omit for the private workspace catalog
  --actor <name>        Attribute confirmed human actions (overrides SUPERBEE_ACTOR; legacy
                        AGENTSTATE_LITE_ACTOR remains supported)
  -h, --help            Show this help

Run \`superbee mcp install --host <id>\` once for each host you use. Installation is user-level,
requires an explicit host, and never pins a bundle directory.

The server uses stdio. Without --dir it lists the user's private workspace catalog. Pass one exact
workspace label or ID to show_document, list_views, and show_view for a registered or
bundle-capable transient View. Use show_document with an exact document ID to display its
authoritative Markdown in Superbee's fixed reader without executable View approval. show_view
launches an exact registered View or standard transient View HTML through the shared View bridge;
every later bridge, navigation, save, and governed-action call stays pinned to that original
workspace. A transient View with explicit access:none may omit workspace and remains bundleless.
In fixed --dir compatibility mode, workspace is omitted. Transient Views with explicit
bundle-read or bundle-propose access can be saved after approval as registered Views without
transformation.
Views use the same query, render-document, graph, subscription, and governed-action bridge in MCP
and the web UI. Every bundle-propose action requires explicit human confirmation and a current
document version. The server accepts no remote targets or arbitrary filesystem paths.

${STABLE_MCP_LAUNCH_GUIDANCE}
`;

export const MCP_STATUS_USAGE = `superbee mcp status — inspect user-level MCP registrations without changing them

Usage:
  superbee mcp status [--host <id>] [--json]

Options:
  --host <id>           Inspect codex, claude-code, claude-desktop, or opencode
                        (aliases: chatgpt, chatgpt-desktop, claude, claude-app, open-code)
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help

The command reads only each host's bounded user-level registration surface. It never scans for
projects, chooses a bundle, writes configuration, or treats host detection as mutation authority.
`;

export const MCP_INSTALL_USAGE = `superbee mcp install — register the global Superbee MCP server in one host

Usage:
  superbee mcp install --host <id> [--actor <label>] [--json]

Options:
  --host <id>           Required: codex, claude-code, claude-desktop, or opencode
  --actor <label>       Optional advisory actor for confirmed human actions in this host
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help

The command writes one user-level registration using the durable npm installation. It never uses
npx, guesses the current host, pins a bundle, or replaces a foreign same-name entry.
`;

export const MCP_UNINSTALL_USAGE = `superbee mcp uninstall — remove one exact-owned Superbee MCP registration

Usage:
  superbee mcp uninstall --host <id> [--json]

Options:
  --host <id>           Required: codex, claude-code, claude-desktop, or opencode
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help

The command removes only a registration proven to belong to the durable Superbee installation.
Foreign and legacy registrations are left untouched.
`;

export interface McpCliDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  openBundle: (dir: string | undefined) => Promise<Bundle>;
  startServer: (options: CreateMcpAppServerOptions) => Promise<void>;
  createWorkspaceResolver: (actor?: string) => McpWorkspaceResolver;
  inspectHosts: (targets: readonly McpInstallTarget[]) => McpHostStatus[];
  mutateRegistration: (
    operation: McpRegistrationOperation,
    target: McpInstallTarget,
    options: { actor?: string },
  ) => McpRegistrationReceipt;
}

export async function mcp(argv: string[], deps: Partial<McpCliDeps> = {}): Promise<void> {
  if (argv[0] === "status") {
    await mcpStatus(argv.slice(1), deps);
    return;
  }
  if (argv[0] === "install" || argv[0] === "uninstall") {
    if (argv[0] === "install") await mcpInstall(argv.slice(1), deps);
    else await mcpUninstall(argv.slice(1), deps);
    return;
  }
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

interface McpRegistrationValues {
  readonly host?: string;
  readonly actor?: string;
  readonly json?: boolean;
  readonly help?: boolean;
}

async function mcpInstall(argv: string[], deps: Partial<McpCliDeps>): Promise<void> {
  const { values } = parseLeafOrUsage(
    () => parseArgs({
      args: argv,
      options: {
        host: { type: "string" },
        actor: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    }),
    CLI_LEAVES.mcpInstall,
  );
  await mcpRegistration("install", values, deps);
}

async function mcpUninstall(argv: string[], deps: Partial<McpCliDeps>): Promise<void> {
  const { values } = parseLeafOrUsage(
    () => parseArgs({
      args: argv,
      options: {
        host: { type: "string" },
        actor: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    }),
    CLI_LEAVES.mcpUninstall,
  );
  await mcpRegistration("uninstall", values, deps);
}

async function mcpRegistration(
  operation: McpRegistrationOperation,
  values: McpRegistrationValues,
  deps: Partial<McpCliDeps>,
): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  if (values.help) {
    stdout(operation === "install" ? MCP_INSTALL_USAGE : MCP_UNINSTALL_USAGE);
    return;
  }
  if (!values.host?.trim()) {
    throw new CliError("USAGE", `mcp ${operation} requires --host <id>`, {
      details: { supported_hosts: MCP_INSTALL_TARGETS.map(({ id }) => id) },
      help: `${cliInvocation()} mcp ${operation} --host <id>`,
    });
  }
  const target = resolveMcpInstallTarget(values.host);
  if (!target) {
    throw new CliError("USAGE", `unknown MCP host '${values.host}'`, {
      details: { supported_hosts: MCP_INSTALL_TARGETS.map(({ id }) => id) },
      help: `${cliInvocation()} mcp ${operation} --host <id>`,
    });
  }
  if (operation === "uninstall" && values.actor !== undefined) {
    throw new CliError("USAGE", "--actor applies only to mcp install", {
      help: `${cliInvocation()} mcp uninstall --host ${target.id}`,
    });
  }
  const actor = operation === "install"
    ? resolveActor(values.actor, {
        env: {},
        help: `${cliInvocation()} mcp install --host ${target.id} --actor <label>`,
      })
    : undefined;
  try {
    const receipt = (deps.mutateRegistration ?? mutateMcpRegistration)(operation, target, { actor });
    stdout(render({ mcp_registration: receipt }, resolveMode(values)));
  } catch (error) {
    if (!(error instanceof McpRegistrationError)) throw error;
    const code = error.category === "runtime" ? "RUNTIME" : error.category === "usage" ? "USAGE" : "CONFLICT";
    throw new CliError(code, error.message, {
      details: { ...error.details },
      help: error.help[0] ?? `${cliInvocation()} mcp status --host ${target.id}`,
    });
  }
}

async function mcpStatus(argv: string[], deps: Partial<McpCliDeps>): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          host: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.mcpStatus,
  );
  if (values.help) {
    stdout(MCP_STATUS_USAGE);
    return;
  }
  let targets: readonly McpInstallTarget[] = MCP_INSTALL_TARGETS;
  if (values.host !== undefined) {
    const target = resolveMcpInstallTarget(values.host);
    if (!target) {
      throw new CliError("USAGE", `unknown MCP host '${values.host}'`, {
        details: { supported_hosts: MCP_INSTALL_TARGETS.map(({ id }) => id) },
        help: `${cliInvocation()} mcp status --host <id>`,
      });
    }
    targets = [target];
  }
  const hosts = (deps.inspectHosts ?? ((selected) => inspectMcpHosts(selected)))(targets);
  stdout(render({
    mcp_status: {
      count: hosts.length,
      registration_mutation_available: true,
      hosts,
    },
  }, resolveMode(values)));
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
  const actor = resolveActor(values.actor, {
    help: `${cliInvocation()} mcp --actor <name>`,
  });
  if (values.dir === undefined) {
    const workspaceResolver = (
      deps.createWorkspaceResolver ??
      ((resolvedActor?: string) => createCatalogMcpWorkspaceResolver({ actor: resolvedActor }))
    )(actor);
    await start({
      workspaceResolver,
      version: cliVersion(),
    });
    return;
  }
  const bundle = await open(values.dir);
  const bundleName = (await deriveBundleDisplayName(bundle)).name;
  await start({
    bundle,
    version: cliVersion(),
    actor,
    bundleName,
    viewAuthorization: new LocalViewAuthorizationStore(bundle.root),
  });
}
