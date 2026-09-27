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
import { createHostedSyncClient, type HostedIdentity, type HostedSyncClient, type HostedWorkspace } from "./client.js";
import { readDefaultWorkspace } from "./defaults.js";
import { hostedBundleReferenceText, type HostedBundleReference } from "./reference.js";

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
  /**
   * The slug of the workspace `--workspace` named, when the host reports one: a qualified
   * reference may name the bundle in it. Never a remembered default, which may be stale.
   */
  readonly namedSlug: string | null;
}

export interface HostedAccountRequest {
  /** `--workspace`: a workspace id or slug, checked against the memberships. */
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
    ...(request.deadlineMs !== undefined ? { deadlineMs: request.deadlineMs } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const identity = await client.whoami();
  const named = request.workspace === undefined ? undefined : namedWorkspace(identity, request.workspace);
  if (request.workspace !== undefined && named === undefined) {
    throw new CliError("NOT_FOUND", `you are not a member of workspace '${request.workspace}' on ${target.origin}`, {
      details: { reason: "not_a_member", workspace: request.workspace, workspaces: workspaceNames(identity) },
      ...(request.otherWorkspace !== undefined ? { help: request.otherWorkspace } : {}),
    });
  }
  const remembered = identity.tenantIds.length > 1 ? await readDefaultWorkspace(deps.auth.home, target.origin) : null;
  const workspace =
    named?.tenantId ??
    (identity.tenantIds.length === 1 ? identity.tenantIds[0]! : remembered !== null && identity.tenantIds.includes(remembered) ? remembered : null);
  return { client, identity, workspace, namedSlug: named?.slug ?? null };
}

/**
 * The reference a command names a bundle by, from what the person typed and `--workspace`: the
 * typed reference's workspace, else the slug of the workspace `--workspace` named (by id or slug),
 * else the bare id. A recorded default never qualifies anything. Refused before any bundle
 * request: a typed workspace `--workspace` contradicts, a workspace the person is not in, and any
 * workspace at all on a host from before qualified references (it names no slugs). Returns the
 * reference and the tenant of the workspace it names (null for a bare id).
 */
export function resolveBundleReference(
  typed: HostedBundleReference,
  account: Pick<HostedAccount, "identity" | "namedSlug">,
  target: HostedTarget,
  command: (reference: string) => string,
): { readonly reference: HostedBundleReference; readonly tenantId: string | null } {
  const { identity, namedSlug } = account;
  if (typed.slug !== null && namedSlug !== null && typed.slug !== namedSlug) {
    throw new CliError("USAGE", `'${hostedBundleReferenceText(typed)}' names workspace '${typed.slug}', but --workspace names '${namedSlug}'`, {
      help: command(hostedBundleReferenceText(typed)),
    });
  }
  const reference: HostedBundleReference = { slug: typed.slug ?? namedSlug, bundleId: typed.bundleId };
  if (reference.slug === null) return { reference, tenantId: null };
  const holder = identity.workspaces.find((w) => w.slug === reference.slug);
  if (holder) return { reference, tenantId: holder.tenantId };
  // Only the person's own workspaces have slugs to name; a host from before qualified references reports none.
  const slugs = identity.workspaces.some((w) => w.slug !== null);
  throw new CliError(
    slugs ? "NOT_FOUND" : "USAGE",
    slugs ? `you are not a member of workspace '${reference.slug}' on ${target.origin}` : `${target.origin} does not accept <workspace>/<bundle-id> references yet`,
    {
      details: { reason: slugs ? "not_a_member" : "references_unsupported", workspace: reference.slug, workspaces: workspaceNames(identity) },
      help: slugs ? hostedListCommand(target) : command(reference.bundleId),
    },
  );
}

/** The person's workspace a `--workspace` value names: by its id, or by its slug. Undefined when none. */
function namedWorkspace(identity: HostedIdentity, value: string): HostedWorkspace | undefined {
  return identity.workspaces.find((w) => w.tenantId === value) ?? identity.workspaces.find((w) => w.slug === value);
}

/** Each workspace as `--workspace` takes it: its slug when the host reports one, else its id. */
export function workspaceNames(identity: HostedIdentity): string[] {
  return identity.workspaces.map((w) => w.slug ?? w.tenantId);
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
  const account = createHostedSyncClient({
    target,
    accessToken: token.accessToken,
    resume: request.resume,
    ...(request.deadlineMs !== undefined ? { deadlineMs: request.deadlineMs } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  // A checkout that names its workspace names its bundle there on every bundle request.
  const client = binding.workspace_slug ? account.within(binding.workspace_slug) : account;
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
