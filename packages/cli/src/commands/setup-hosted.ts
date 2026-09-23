// `superbee setup hosted` — sign in to hosted Superbee and choose the default hosted workspace in
// one step. The explicit leaf is the authorization event, like `setup migrate-state`; bare `setup`
// stays read-only.
//
// Sign-in is the ordinary device flow: without a session this returns AUTH_REQUIRED (exit 4) with
// the one link to relay, and re-running the same command after the person confirms completes it.
// Then the gateway names the person's workspaces: one is chosen by itself, `--workspace` picks among
// several, and a remembered choice that is still valid is kept.
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandToken } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode } from "../output.js";
import {
  defaultHostedAuthDeps,
  ensureHostedAccessToken,
  hostArgument,
  resolveHostSelection,
  writeDefaultHost,
  type HostedAuthDeps,
} from "../hosted-auth/session.js";
import { createHostedSyncClient } from "../hosted/client.js";
import { readDefaultWorkspace, writeDefaultWorkspace } from "../hosted/defaults.js";

export const SETUP_HOSTED_USAGE = `superbee setup hosted — sign in to hosted Superbee and choose your default workspace

Usage:
  superbee setup hosted [--url <hosted-url>] [--workspace <id>] [--json]

One step for an agent: signs in (device sign-in: without a session this returns AUTH_REQUIRED,
exit 4, with details.sign_in_url, the one link to relay to the person; re-run the same command
after they confirm), then asks the host which workspaces you belong to and records the default.
With one workspace it is chosen; with several, pass --workspace <id> (the receipt lists them and
the command for each). The host becomes the default for checkout and login. Re-running is safe.

Options:
  --url <url>        Hosted Superbee URL (default: SUPERBEE_HOST, then the last sign-in)
  --workspace <id>   Your default workspace on that host, when you belong to several
  --json             Emit compact JSON instead of TOON
  -h, --help         Show this help
`;

export interface SetupHostedDeps {
  stdout: (text: string) => void;
  auth: HostedAuthDeps;
  fetch?: typeof fetch;
}

export async function setupHosted(argv: string[], partial: Partial<SetupHostedDeps> = {}): Promise<void> {
  const stdout = partial.stdout ?? ((text: string) => void process.stdout.write(text));
  const auth = partial.auth ?? defaultHostedAuthDeps(homedir());
  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          url: { type: "string" },
          workspace: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.setupHosted,
  );
  if (values.help) {
    stdout(renderUsage(SETUP_HOSTED_USAGE));
    return;
  }
  const mode = resolveMode(values);
  let target;
  try {
    target = await resolveHostSelection(values.url, auth);
  } catch (error) {
    if (error instanceof CliError && error.code === "USAGE" && values.url === undefined) {
      throw new CliError("USAGE", "no hosted Superbee URL: pass --url", { help: `${cliInvocation()} setup hosted --url <hosted-url>` });
    }
    if (error instanceof CliError && error.code === "USAGE") {
      throw new CliError("USAGE", error.message.replace(/^--host\b/, "--url"), { help: `${cliInvocation()} setup hosted --url <hosted-url>` });
    }
    throw error;
  }
  const host = hostArgument(target);
  const resume = commandFragment`${cliInvocation()} setup hosted --url ${commandToken(host)}${
    values.workspace !== undefined ? commandFragment` --workspace ${commandToken(values.workspace)}` : commandFragment``
  }${values.json ? commandFragment` --json` : commandFragment``}`;

  // AUTH_REQUIRED passes through unchanged with its one link; the resume is this command.
  const token = await ensureHostedAccessToken(target, { resume }, auth);
  const client = createHostedSyncClient({ target, accessToken: token.accessToken, resume, ...(partial.fetch ? { fetch: partial.fetch } : {}) });
  const identity = await client.whoami();
  await writeDefaultHost(auth.home, host);

  const workspaces = identity.tenantIds;
  const remembered = await readDefaultWorkspace(auth.home, target.origin);
  if (values.workspace !== undefined && !workspaces.includes(values.workspace)) {
    throw new CliError("NOT_FOUND", `you are not a member of workspace '${values.workspace}' on ${target.origin}`, {
      details: { workspace: values.workspace, workspaces },
      help: `${cliInvocation()} setup hosted --url ${commandToken(host)} --workspace <id>`,
    });
  }
  const chosen =
    values.workspace ?? (workspaces.length === 1 ? workspaces[0]! : remembered !== null && workspaces.includes(remembered) ? remembered : null);
  const base = {
    host: target.origin,
    signed_in: true,
    principal: identity.principalId,
    workspaces,
  };
  if (workspaces.length === 0) {
    stdout(
      render(
        {
          setup_hosted: {
            ...base,
            status: "no_workspace",
            workspace: null,
            message: "you are signed in but belong to no workspace on this host; ask a workspace owner to invite you, or create one in the Superbee app",
          },
        },
        mode,
      ),
    );
    return;
  }
  if (chosen === null) {
    stdout(
      render(
        {
          setup_hosted: {
            ...base,
            status: "choose_workspace",
            workspace: null,
            message: "you belong to several workspaces: ask the person which one is their default, then run its command",
            help: workspaces.slice(0, 20).map((id) => `${cliInvocation()} setup hosted --url ${commandToken(host)} --workspace ${commandToken(id)}`),
          },
        },
        mode,
      ),
    );
    return;
  }
  await writeDefaultWorkspace(auth.home, { origin: target.origin, workspace: chosen });
  stdout(
    render(
      {
        setup_hosted: {
          ...base,
          status: "ready",
          workspace: chosen,
          help: [`${cliInvocation()} checkout <bundle-id>`],
        },
      },
      mode,
    ),
  );
}
