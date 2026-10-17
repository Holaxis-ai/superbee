// The one way `notify` and `inbox` reach a person's hosted inbox. Notifications are a hosted
// capability (decision notifications-hosted-only-2026-10-08, amended by notify-from-any-folder
// 2026-10-17): they act as the person's hosted sign-in, never emulate a local inbox, and do not
// need a checkout. Inside a hosted checkout they use its host, person and workspace; anywhere
// else (a local or Git bundle, or no bundle) they use the signed-in hosted login and choose the
// workspace by --workspace, then the default `setup hosted` recorded, then the account's only one.
// Signed out, they refuse with the one command that signs in, and send nothing.
import { homedir } from "node:os";

import { escapeHostJson, stripHostData } from "@superbee/core";
import type { HostedIdentity, HostedInbox } from "@superbee/core/hosted-client";

import { resolveLocalBundleTarget } from "../bundle.js";
import { bundleHomeAt } from "../bundle-home.js";
import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, type OutputMode } from "../output.js";
import type { HostedAccountDeps } from "./account.js";
import type { CheckoutBinding } from "./binding.js";
import type { CheckoutConnection } from "./checkout-connection.js";
import type { HostedSyncClient } from "./client.js";

type HostedTarget = CheckoutConnection["target"];

export interface InboxSessionDeps {
  stdout: (text: string) => void;
  /** The person's sign-in and the fetch the sync routes are reached with (tests inject both). */
  hosted?: HostedAccountDeps;
  cwd?: string;
}

/** What the person named: a folder, or the account path's host, workspace and bundle. */
export interface InboxScope {
  readonly dir?: string | undefined;
  readonly host?: string | undefined;
  readonly workspace?: string | undefined;
  /** `--bundle`: the hosted bundle a `--doc` names a document of, outside a checkout. */
  readonly bundle?: string | undefined;
}

/** The hosted bundle a document target names, and a client that reads it. */
export interface InboxDocumentBundle {
  readonly bundleId: string;
  readonly client: HostedSyncClient;
}

export interface InboxSession {
  readonly inbox: HostedInbox;
  /** How the session was reached: a hosted checkout's binding, or the person's signed-in account. */
  readonly via: "checkout" | "account";
  /** The checkout, when the session came from one. */
  readonly binding: CheckoutBinding | null;
  readonly client: HostedSyncClient;
  readonly target: HostedTarget;
  readonly identity: HostedIdentity;
  /** The workspace (tenant id) the inbox acts in. */
  readonly tenantId: string;
  readonly resume: CommandText;
  /** The arguments a next-step command carries to reach the same inbox (` --dir <path>` or ` --host <url> [--workspace <w>]`). */
  readonly scopeArgs: CommandText;
  /** The bundle a `--doc` names a document of: the checkout's, `--bundle`'s, or none. */
  readonly documents: InboxDocumentBundle | null;
}

/** The help of the verb a refusal is about. */
function helpFor(command: string): CommandText {
  return command === "notify" ? commandFragment`${cliInvocation()} notify --help` : commandFragment`${cliInvocation()} inbox --help`;
}

/** The hosted checkout the scope names, or null when it names none (no folder flag and no checkout). */
async function checkoutOf(scope: InboxScope, deps: Partial<InboxSessionDeps>): Promise<CheckoutBinding | null> {
  let canonicalRoot: string;
  try {
    canonicalRoot = (await resolveLocalBundleTarget(scope.dir, deps.cwd ?? process.cwd())).canonicalRoot;
  } catch (error) {
    // No bundle around the working folder is not an error here: the notification is the person's.
    if (scope.dir === undefined && error instanceof CliError && error.code === "NOT_FOUND") return null;
    throw error;
  }
  const facts = await bundleHomeAt(canonicalRoot, { home: deps.hosted?.auth?.home ?? homedir() });
  return facts.home === "hosted" ? facts.binding : null;
}

/**
 * The person's inbox: a hosted checkout's when the scope names no account flag and the folder is
 * one, else the signed-in account's. `resumeFor` builds the command that repeats this one with
 * the scope arguments it was reached under, carried on an AUTH_REQUIRED.
 */
export async function openInboxSession(
  command: string,
  scope: InboxScope,
  deps: Partial<InboxSessionDeps>,
  resumeFor: (scopeArgs: CommandText) => CommandText,
  options: { readonly documents?: boolean } = {},
): Promise<InboxSession> {
  const explicit = scope.host !== undefined || scope.workspace !== undefined || scope.bundle !== undefined;
  if (explicit && scope.dir !== undefined) {
    throw new CliError("USAGE", "--dir names a checkout, and --host, --workspace and --bundle name your account's inbox: pass one or the other", {
      help: helpFor(command),
    });
  }
  const binding = explicit ? null : await checkoutOf(scope, deps);
  const [{ createHostedInbox }, { resolveHostedVia }] = await Promise.all([import("@superbee/core/hosted-client"), import("./via.js")]);
  // The sign-in module reads the same environment when no test injects one.
  const via = resolveHostedVia(deps.hosted?.auth.env ?? process.env).token;
  const inboxFor = (client: HostedSyncClient, tenantId: string) => createHostedInbox(client, { tenantId, ...(via === undefined ? {} : { via }) });

  if (binding !== null) {
    const scopeArgs = commandFragment` --dir ${commandToken(binding.path)}`;
    const resume = resumeFor(scopeArgs);
    const { openCheckoutConnection } = await import("./checkout-connection.js");
    const { client, target, identity } = await openCheckoutConnection(binding, deps.hosted, resume);
    const tenantId = workspaceOf(binding, identity);
    if (tenantId === null) {
      throw new CliError("USAGE", `the checkout at ${binding.path} does not say which of your workspaces holds its bundle`, {
        details: { reason: "workspace_unknown", folder: binding.path, workspaces: identity.tenantIds },
        help: `${cliInvocation()} checkout --adopt ${commandToken(binding.path)} --workspace <id> binds it to its workspace again`,
      });
    }
    return { inbox: inboxFor(client, tenantId), via: "checkout", binding, client, target, identity, tenantId, resume, scopeArgs, documents: { bundleId: binding.bundle_id, client } };
  }

  // A document target names a hosted bundle: the checkout's, or one named with --bundle. Refused
  // before any request.
  if (options.documents === true && scope.bundle === undefined) {
    throw new CliError("USAGE", `--doc names a document of a hosted bundle: run ${command} in its hosted checkout, or name the bundle with --bundle <bundle-id>`, {
      details: { reason: "document_bundle_unknown" },
      help: helpFor(command),
    });
  }
  const { connectSignedInAccount, resolveBundleReference, workspaceNames } = await import("./account.js");
  const { parseHostedBundleReference } = await import("./reference.js");
  const typed = scope.bundle === undefined ? null : parseHostedBundleReference(scope.bundle);
  if (scope.bundle !== undefined && typed === null) {
    throw new CliError("USAGE", `'${scope.bundle}' is not a hosted bundle id or <workspace>/<bundle-id>`, { help: helpFor(command) });
  }
  const flags = (host: string | undefined, workspace: string | undefined) =>
    commandFragment`${host === undefined ? commandFragment`` : commandFragment` --host ${commandToken(host)}`}${workspace === undefined ? commandFragment`` : commandFragment` --workspace ${commandToken(workspace)}`}${
      scope.bundle === undefined ? commandFragment`` : commandFragment` --bundle ${commandToken(scope.bundle)}`
    }`;
  const account = await connectSignedInAccount({ host: scope.host, workspace: scope.workspace, resume: resumeFor(flags(scope.host, scope.workspace)), command }, deps.hosted);
  const { client, target, identity } = account;
  const named = (tenantId: string) => identity.workspaces.find((w) => w.tenantId === tenantId)?.slug ?? tenantId;

  let documents: InboxDocumentBundle | null = null;
  let tenantId = account.workspace;
  if (typed !== null) {
    const resolved = resolveBundleReference(typed, account, target, (reference) => commandFragment`${cliInvocation()} notify --bundle ${commandToken(reference)}`);
    // A bundle named in a workspace chooses that workspace (resolveBundleReference refuses a
    // --workspace that names another).
    if (resolved.tenantId !== null) tenantId = resolved.tenantId;
    documents = { bundleId: resolved.reference.bundleId, client: resolved.reference.slug === null ? client : client.within(resolved.reference.slug) };
  }
  if (tenantId === null) {
    const names = workspaceNames(identity);
    throw new CliError("USAGE", `you are in ${names.length} workspaces on ${target.origin}; name the one for ${command} with --workspace`, {
      details: { reason: "workspace_ambiguous", host: target.origin, workspaces: names, commands: names.map((name) => String(resumeFor(flags(scope.host ?? account.hostArgument, name)))) },
      help: `re-run with --workspace set to one of: ${names.join(", ")} (${cliInvocation()} setup hosted --workspace <id> records a default)`,
    });
  }
  const scopeArgs = flags(account.hostArgument, identity.tenantIds.length > 1 ? named(tenantId) : undefined);
  return { inbox: inboxFor(client, tenantId), via: "account", binding: null, client, target, identity, tenantId, resume: resumeFor(scopeArgs), scopeArgs, documents };
}

/** The tenant the checkout's bundle is in: the binding's, else its slug's, else the person's only one. */
function workspaceOf(binding: CheckoutBinding, identity: HostedIdentity): string | null {
  if (binding.workspace !== null && identity.tenantIds.includes(binding.workspace)) return binding.workspace;
  if (binding.workspace_slug) {
    const named = identity.workspaces.find((workspace) => workspace.slug === binding.workspace_slug);
    if (named) return named.tenantId;
  }
  return identity.tenantIds.length === 1 ? identity.tenantIds[0]! : null;
}

/**
 * A record that carries the host's and other people's data (notes, labels, titles, names). `--json`
 * keeps it exactly, with control and format characters escaped (`\uXXXX`); TOON prints it with
 * those characters removed and says so. Either way none reaches the terminal raw.
 */
export function renderInboxRecord(record: Record<string, unknown>, mode: OutputMode): string {
  if (mode === "json") return `${escapeHostJson(JSON.stringify(record))}\n`;
  const { value, removed } = stripHostData(record);
  const clean = value as Record<string, unknown>;
  if (!removed) return render(clean, mode);
  const notes = [...((clean.notes as string[] | undefined) ?? []), "removed control and format characters from the host's data; --json keeps them, escaped"];
  return render({ ...clean, notes }, mode);
}

/**
 * One translation from the inbox's typed failures to the CLI taxonomy, in this CLI's words. Anything
 * that is not an inbox failure goes through the hosted client's own translation.
 */
export async function inboxFailure(error: unknown, session: Pick<InboxSession, "target" | "resume" | "scopeArgs">, extra: { ticketHelp?: (ticket: string) => string } = {}): Promise<unknown> {
  const core = await import("@superbee/core/hosted-client");
  const { hostedFailure } = await import("./client.js");
  const host = session.target.origin;
  if (core.isAttentionOutcomeUnknown(error)) {
    // The answer that ended the retries, when there was one: a sign-in that ended needs a login
    // before the resend, and the resend still carries the ticket.
    const cause = error.cause;
    const after = cause instanceof core.RemoteError ? cause.code : cause instanceof core.HostedCarrierError ? cause.code : undefined;
    const signIn = cause instanceof core.RemoteError && (cause.status === 401 || cause.code === "unauthenticated");
    const resend = extra.ticketHelp ? extra.ticketHelp(error.ticket) : "retry the same command";
    return new CliError("TRANSIENT", `${host} did not answer the send: it may or may not have arrived`, {
      details: { host, code: error.code, ticket: error.ticket, retryable: true, ...(after === undefined ? {} : { after }) },
      help: signIn ? `sign in again (${cliInvocation()} login --host ${commandToken(host)}), then ` + resend : resend,
    });
  }
  if (core.isRouteNotServed(error)) {
    return new CliError("NOT_IMPLEMENTED", `${host} does not serve notifications yet`, {
      details: { host, route: error.route, status: 404 },
      help: "a later release of the host serves them",
    });
  }
  if (core.isAttentionRefusal(error)) {
    const details: Record<string, unknown> = { host, code: error.code, operation: error.operationId, retryable: error.retryable };
    if (error.serverTime !== undefined) details.server_time = new Date(error.serverTime).toISOString();
    const message = error.reason;
    const inboxList = commandFragment`${cliInvocation()} inbox list${session.scopeArgs}`;
    switch (error.code) {
      case "not_found":
        return new CliError("NOT_FOUND", message, { details, help: `${inboxList} shows the items addressed to you` });
      case "version_conflict":
        return new CliError("STALE_HEAD", message, { details, help: "read the item again (inbox open --peek) and repeat with its revision" });
      case "request_conflict":
        return new CliError("CONFLICT", message, { details, help: "send without --ticket: a new send gets a new ticket" });
      case "ticket_expired":
        return new CliError("USAGE", message, { details, help: "send without --ticket: a new send gets a new ticket" });
      case "target_unavailable":
        return new CliError("USAGE", message, { details, help: "sync your edits first, or send without --doc" });
      case "target_unsupported":
        return new CliError("USAGE", message, { details, help: "save the document once in Superbee (or change and sync it), then send again" });
      case "invalid_input":
        return new CliError("USAGE", message, { details, help: `${cliInvocation()} notify --help` });
      case "attention_disabled":
        return new CliError("FORBIDDEN", message, { details, help: "a workspace admin turns the inbox on for the workspace" });
      case "insufficient_scope":
      case "workspace_not_available":
      case "workspace_unsupported":
        return new CliError("FORBIDDEN", message, { details, help: `${cliInvocation()} whoami` });
      case "quota_exceeded":
        return new CliError("RUNTIME", message, { details, help: "wait before sending more" });
      default:
        return new CliError(error.retryable ? "TRANSIENT" : "RUNTIME", message, { details, ...(error.retryable ? { help: "retry the same command" } : {}) });
    }
  }
  if (error instanceof core.RemoteError && (error.code === "feature_disabled" || error.code === "temporarily_unavailable")) {
    const unavailable = error.code === "temporarily_unavailable";
    return new CliError(unavailable ? "TRANSIENT" : "FORBIDDEN", `${host} ${unavailable ? "is unavailable right now" : "has this sign-in turned off"} (${error.code})`, {
      details: { host, code: error.code, retryable: unavailable },
      ...(unavailable ? { help: "retry the same command" } : {}),
    });
  }
  return hostedFailure(error, session.target, session.resume);
}
