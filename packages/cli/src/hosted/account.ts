// The signed-in account on a hosted host, as every command that reaches `/sync/v1` first needs it:
// sign in (AUTH_REQUIRED passes through with its one link), ask the host who this is, check a named
// workspace against the person's memberships, and choose the workspace the command records.
// `checkout`, `setup hosted` and `catalog list --hosted` share it, so their membership refusal and
// workspace choice cannot drift apart.
import { commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { ensureHostedAccessToken, hostArgument, type HostedAuthDeps } from "../hosted-auth/session.js";
import type { HostedTarget } from "../hosted-auth/discovery.js";
import { createHostedSyncClient, type HostedIdentity, type HostedSyncClient } from "./client.js";
import { readDefaultWorkspace } from "./defaults.js";

export interface HostedAccountDeps {
  readonly auth: HostedAuthDeps;
  /** The fetch the sync routes are reached with (the sign-in module keeps its own). */
  readonly fetch?: typeof fetch;
}

export interface HostedAccount {
  readonly client: HostedSyncClient;
  readonly identity: HostedIdentity;
  /** Named, else the only one, else the default `setup hosted` recorded for this host (if still yours). */
  readonly workspace: string | null;
}

export interface HostedAccountRequest {
  /** `--workspace`: checked against the memberships and sent as the workspace header. */
  readonly workspace?: string | undefined;
  /** The command that repeats this one, carried on AUTH_REQUIRED. */
  readonly resume: CommandText;
  /** With `workspace`: the command a person not in it runs instead (with `<id>` to fill in). */
  readonly otherWorkspace?: string;
  /** The client's per-request deadline, when the command needs longer than the default. */
  readonly deadlineMs?: number;
}

export async function connectHostedAccount(target: HostedTarget, request: HostedAccountRequest, deps: HostedAccountDeps): Promise<HostedAccount> {
  // Sign-in first: AUTH_REQUIRED passes through unchanged with its one link, before any request.
  const token = await ensureHostedAccessToken(target, { resume: request.resume }, deps.auth);
  const client = createHostedSyncClient({
    target,
    accessToken: token.accessToken,
    resume: request.resume,
    ...(request.workspace !== undefined ? { workspace: request.workspace } : {}),
    ...(request.deadlineMs !== undefined ? { deadlineMs: request.deadlineMs } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const identity = await client.whoami();
  if (request.workspace !== undefined && !identity.tenantIds.includes(request.workspace)) {
    throw new CliError("NOT_FOUND", `you are not a member of workspace '${request.workspace}' on ${target.origin}`, {
      details: { reason: "not_a_member", workspace: request.workspace, workspaces: identity.tenantIds },
      ...(request.otherWorkspace !== undefined ? { help: request.otherWorkspace } : {}),
    });
  }
  const remembered = identity.tenantIds.length > 1 ? await readDefaultWorkspace(deps.auth.home, target.origin) : null;
  const workspace =
    request.workspace ??
    (identity.tenantIds.length === 1 ? identity.tenantIds[0]! : remembered !== null && identity.tenantIds.includes(remembered) ? remembered : null);
  return { client, identity, workspace };
}

/** The command that lists the hosted bundles the person can reach on this host. */
export function hostedListCommand(target: HostedTarget): string {
  return `${cliInvocation()} catalog list --hosted --host ${commandToken(hostArgument(target))}`;
}
