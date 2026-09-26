// The signed-in account on a hosted host, as every command that reaches `/sync/v1` first needs it:
// sign in (AUTH_REQUIRED passes through with its one link), ask the host who this is, check a named
// workspace against the person's memberships, and choose the workspace the command records.
// `checkout`, `setup hosted` and `catalog list --hosted` share it, so their membership refusal and
// workspace choice cannot drift apart. A command that works in an existing checkout (`sync`,
// `export`, `doc history`) connects through `connectCheckout` instead: the checkout's own host,
// workspace and person.
import { commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { ensureHostedAccessToken, hostArgument, type HostedAuthDeps } from "../hosted-auth/session.js";
import { resolveHostedTarget, type HostedTarget } from "../hosted-auth/discovery.js";
import type { CheckoutBinding } from "./binding.js";
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

export interface CheckoutConnectionRequest {
  /** The command that repeats this one, carried on AUTH_REQUIRED. */
  readonly resume: CommandText;
  /** The client's per-request deadline, when the command needs longer than the default. */
  readonly deadlineMs?: number;
  /** False: a signed-out person is refused (SignedOutError) rather than asked to sign in. */
  readonly signIn?: boolean;
}

export interface CheckoutConnection {
  readonly target: HostedTarget;
  readonly client: HostedSyncClient;
  readonly identity: HostedIdentity;
}

/**
 * The checkout's host, reached as the checkout's own person: the binding's target (refused when
 * the binding is inconsistent), sign-in first, the binding's workspace sent, and the signed-in
 * principal checked against the one the checkout was made under before any other request.
 */
export async function connectCheckout(binding: CheckoutBinding, request: CheckoutConnectionRequest, deps: HostedAccountDeps): Promise<CheckoutConnection> {
  const target = resolveHostedTarget(binding.audience);
  if (target.origin !== binding.origin) {
    throw new CliError("RUNTIME", `the checkout binding for ${binding.path} is inconsistent`, { help: `${cliInvocation()} checkout --release ${commandToken(binding.path)}` });
  }
  const token = await ensureHostedAccessToken(target, { resume: request.resume, ...(request.signIn === false ? { signIn: false } : {}) }, deps.auth);
  const client = createHostedSyncClient({
    target,
    accessToken: token.accessToken,
    resume: request.resume,
    ...(binding.workspace !== null ? { workspace: binding.workspace } : {}),
    ...(request.deadlineMs !== undefined ? { deadlineMs: request.deadlineMs } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const identity = await client.whoami();
  if (identity.principalId !== binding.principal_id) {
    throw new CliError("FORBIDDEN", `you are signed in to ${binding.origin} as another person than the one this checkout belongs to`, {
      details: { reason: "other_principal", folder: binding.path, checkout_principal: binding.principal_id, signed_in_principal: identity.principalId },
      help: `sign in as the checkout's person (${cliInvocation()} login --host ${commandToken(hostArgument(target))}), or check the bundle out again for yourself in a new folder`,
    });
  }
  return { target, client, identity };
}

/** The command that lists the hosted bundles the person can reach on this host. */
export function hostedListCommand(target: HostedTarget): string {
  return `${cliInvocation()} catalog list --hosted --host ${commandToken(hostArgument(target))}`;
}
