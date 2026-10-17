// The one way `notify` and `inbox` reach a person's hosted inbox: the folder must be a hosted
// checkout, whose binding names the host, the person and the workspace. Notifications are a hosted
// capability only (decision notifications-hosted-only-2026-10-08): a local or Git bundle is refused
// with the one command that connects, and no local inbox is ever emulated. The hosted modules load
// only for a folder bound as a checkout.
import { homedir } from "node:os";

import { escapeHostJson, stripHostData } from "@superbee/core";
import type { HostedIdentity, HostedInbox } from "@superbee/core/hosted-client";

import { resolveLocalBundleTarget } from "../bundle.js";
import { bundleHomeAt, type BundleHome } from "../bundle-home.js";
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
  /** The checkout's person and the fetch the sync routes are reached with (tests inject both). */
  hosted?: HostedAccountDeps;
  cwd?: string;
}

export interface InboxSession {
  readonly inbox: HostedInbox;
  readonly binding: CheckoutBinding;
  readonly client: HostedSyncClient;
  readonly target: HostedTarget;
  readonly identity: HostedIdentity;
  /** The workspace (tenant id) the inbox acts in. */
  readonly tenantId: string;
  readonly resume: CommandText;
  /** The folder argument a next-step command carries. */
  readonly dirArgument: CommandText;
}

const HOSTED_ONLY = "Notifications need hosted Superbee";

/** The refusal outside a hosted checkout: the one command that connects. */
function hostedOnly(command: string, home: BundleHome | "none"): CliError {
  const where = home === "none" ? "this folder is not a bundle" : `this is a ${home} bundle`;
  return new CliError("NOT_IMPLEMENTED", `${HOSTED_ONLY}: ${command} works in a hosted checkout, and ${where}`, {
    details: { reason: "hosted_only", home, command },
    help: `${cliInvocation()} checkout <bundle-id> --dir <new-folder> mirrors a hosted bundle into a folder where notify and inbox work`,
  });
}

/** The folder's hosted checkout, or the hosted-only refusal. No request is made for any other folder. */
async function checkoutOf(command: string, dir: string | undefined, deps: Partial<InboxSessionDeps>): Promise<CheckoutBinding> {
  let canonicalRoot: string;
  try {
    canonicalRoot = (await resolveLocalBundleTarget(dir, deps.cwd ?? process.cwd())).canonicalRoot;
  } catch (error) {
    if (error instanceof CliError && error.code === "NOT_FOUND") throw hostedOnly(command, "none");
    throw error;
  }
  const facts = await bundleHomeAt(canonicalRoot, { home: deps.hosted?.auth?.home ?? homedir() });
  if (facts.home !== "hosted") throw hostedOnly(command, facts.home);
  return facts.binding;
}

/**
 * The checkout's person signed in, the workspace the checkout's bundle is in, and that workspace's
 * inbox. `resumeFor` builds the command that repeats this one, carried on an AUTH_REQUIRED.
 */
export async function openInboxSession(
  command: string,
  dir: string | undefined,
  deps: Partial<InboxSessionDeps>,
  resumeFor: (dirArgument: CommandText) => CommandText,
): Promise<InboxSession> {
  const binding = await checkoutOf(command, dir, deps);
  const dirArgument = commandToken(binding.path);
  const resume = resumeFor(dirArgument);
  const [{ openCheckoutConnection }, { createHostedInbox }, { resolveHostedVia }] = await Promise.all([
    import("./checkout-connection.js"),
    import("@superbee/core/hosted-client"),
    import("./via.js"),
  ]);
  const { client, target, identity } = await openCheckoutConnection(binding, deps.hosted, resume);
  const tenantId = workspaceOf(binding, identity);
  if (tenantId === null) {
    throw new CliError("USAGE", `the checkout at ${binding.path} does not say which of your workspaces holds its bundle`, {
      details: { reason: "workspace_unknown", folder: binding.path, workspaces: identity.tenantIds },
      help: `${cliInvocation()} checkout --adopt ${commandToken(binding.path)} --workspace <id> binds it to its workspace again`,
    });
  }
  // The sign-in module reads the same environment when no test injects one.
  const via = resolveHostedVia(deps.hosted?.auth.env ?? process.env).token;
  const inbox = createHostedInbox(client, { tenantId, ...(via === undefined ? {} : { via }) });
  return { inbox, binding, client, target, identity, tenantId, resume, dirArgument };
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
export async function inboxFailure(error: unknown, session: Pick<InboxSession, "target" | "resume" | "binding" | "dirArgument">, extra: { ticketHelp?: (ticket: string) => string } = {}): Promise<unknown> {
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
    const inboxList = `${cliInvocation()} inbox list --dir ${session.dirArgument}`;
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
        return new CliError("USAGE", message, { details, help: `sync your edits first (${cliInvocation()} sync --dir ${session.dirArgument}), or send without --doc` });
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
