// `superbee notify <recipient> [<note>]`: put an item in a person's hosted inbox (yourself
// included), optionally about a document of the checkout's bundle, through the hosted client's
// inbox (`attention.request.v1`). Hosted-only: a local or Git bundle is refused naming the command
// that connects. Each send has one ticket; a send whose answer never came back is retried with it,
// and the error carries it so the same command with --ticket settles it without a second item.
import { parseArgs } from "node:util";

import type { AttentionRequestInput, InboxAppMeta, InboxRecipient, PersonItemKind } from "@superbee/core/hosted-client";

import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { renderUsage, resolveMode } from "../output.js";
import { inboxFailure, openInboxSession, renderInboxRecord, type InboxSessionDeps } from "../hosted/inbox-session.js";

export const NOTIFY_USAGE = `superbee notify — ask a person, or yourself, to look at something (hosted Superbee)

Usage:
  superbee notify <recipient> [<note>] [--kind <kind>] [--doc <document-id>] [--thread <thread-id>]
                  [--label <text> [--label-namespace <namespace>]] [--alert default|none]
                  [--ticket <ticket>] [--dir <path> | --host <url> [--workspace <id>] [--bundle <bundle-id>]] [--json]

Puts an item in the recipient's Superbee inbox, as you, signed in to hosted Superbee. Inside a
hosted checkout it uses the checkout's account and workspace. Anywhere else (a local or Git bundle,
or no bundle) it uses your signed-in hosted login, in the workspace --workspace names, else the
default setup hosted recorded, else your only one.
<recipient> is self (you: the usual case for an agent telling its person something) or a
workspace member's principal id. Naming someone by email is not supported yet.

Kinds: needs_input (default: this needs you), ready (this is ready for you), review_requested
(please review this), reply (on a thread: needs --thread). ready and review_requested need --doc.

--doc points the item at a document, at the version the host holds now: in a checkout, of its bundle
(sync your edits first); elsewhere, of the hosted bundle --bundle names. The recipient sees its live
title and a link, only if they can read it. The host must report its document authority.

Each send has one ticket. If the host's answer never arrives, the command retries with the same
ticket, and its error carries the ticket: re-run with --ticket <it> within 24 hours and the host
answers the first send's item instead of making a second one.

Notifications are part of hosted Superbee and there is no local inbox: signed out, notify is
refused (AUTH_REQUIRED) with the one command that signs in, and nothing is sent. Read replies with
superbee inbox.

Options:
  --kind <kind>                  needs_input | ready | review_requested | reply
  --doc <document-id>            A document of this checkout's bundle the item is about
  --thread <thread-id>           Continue a thread (its other participant must be the recipient)
  --label <text>                 Your tool's label for this send, such as a run or worktree name
                                 (shown to the recipient as your tool's own words, at most 200 characters)
  --label-namespace <namespace>  The app namespace the label is filed under (default dev.superbee.cli)
  --alert default|none           none: inbox only, no email (default: default)
  --ticket <ticket>              Re-send under the ticket a failed send reported
  --dir <path>                   A hosted checkout to send from (default: the cwd's, when it is one)
  --host <url>                   Outside a checkout: the hosted Superbee (default: your last sign-in)
  --workspace <id>               Outside a checkout: the workspace (default: the one setup hosted
                                 recorded, else your only one)
  --bundle <bundle-id>           Outside a checkout: the hosted bundle (or <workspace>/<bundle-id>)
                                 --doc names a document of
  --json                         Emit compact JSON instead of TOON
  -h, --help                     Show this help`;

const KINDS = ["needs_input", "ready", "review_requested", "reply"] as const satisfies readonly PersonItemKind[];
const NOTE_MAX = 2000;
const LABEL_MAX = 200;
const DEFAULT_NAMESPACE = "dev.superbee.cli";
const META_NAMESPACE = /^[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9][a-z0-9-]{0,62}){1,7}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A principal id as the host stores it: no spaces or controls, at most 256 characters. */
const PRINCIPAL_ID = /^[^\s\p{Cc}\p{Cf}@]{1,256}$/u;

export type NotifyDeps = InboxSessionDeps;

function usage(message: string, details?: Record<string, unknown>): CliError {
  return new CliError("USAGE", message, { help: `${cliInvocation()} notify --help`, ...(details ? { details } : {}) });
}

export async function notify(argv: string[], deps: Partial<NotifyDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          kind: { type: "string" },
          doc: { type: "string" },
          thread: { type: "string" },
          label: { type: "string" },
          "label-namespace": { type: "string" },
          alert: { type: "string" },
          ticket: { type: "string" },
          dir: { type: "string" },
          host: { type: "string" },
          workspace: { type: "string" },
          bundle: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.notify,
  );
  if (values.help) {
    stdout(renderUsage(NOTIFY_USAGE));
    return;
  }
  const mode = resolveMode(values);
  const [recipientArgument, note] = positionals as [string, string | undefined];

  // Everything checkable without the host is checked before any request.
  const kind = (values.kind ?? "needs_input") as PersonItemKind;
  if (!(KINDS as readonly string[]).includes(kind)) throw usage(`--kind must be one of ${KINDS.join(", ")}`);
  if (recipientArgument !== "self" && !PRINCIPAL_ID.test(recipientArgument)) {
    throw usage(
      recipientArgument.includes("@")
        ? "notify names a recipient by principal id or self; naming someone by email is not supported yet"
        : `'${recipientArgument}' is not a principal id or self`,
      { reason: "recipient", recipient: recipientArgument.includes("@") ? "email" : "malformed" },
    );
  }
  if (note !== undefined && note.length > NOTE_MAX) throw usage(`the note is longer than ${NOTE_MAX} characters`);
  if ((kind === "ready" || kind === "review_requested") && values.doc === undefined) throw usage(`--kind ${kind} needs --doc <document-id>`);
  if (kind === "reply" && values.thread === undefined) throw usage("--kind reply needs --thread <thread-id>");
  if (values.thread !== undefined && !UUID_V7.test(values.thread)) throw usage("--thread is a thread id as an earlier send or inbox list reported it");
  if (values.ticket !== undefined && !UUID_V7.test(values.ticket)) throw usage("--ticket is the ticket a failed send reported");
  if (values.alert !== undefined && values.alert !== "default" && values.alert !== "none") throw usage("--alert must be default or none");
  if (values["label-namespace"] !== undefined && values.label === undefined) throw usage("--label-namespace files a --label: pass --label too");
  const namespace = values["label-namespace"] ?? DEFAULT_NAMESPACE;
  if (!META_NAMESPACE.test(namespace)) throw usage("--label-namespace is a lowercase dotted app namespace, such as com.example.tool");
  if (values.label !== undefined && (values.label.trim() === "" || values.label.length > LABEL_MAX)) throw usage(`--label is 1 to ${LABEL_MAX} characters`);
  if (values.bundle !== undefined && values.doc === undefined) throw usage("--bundle names the bundle a --doc document is in: pass --doc too");
  const meta: InboxAppMeta | undefined = values.label === undefined ? undefined : { [namespace]: { run: values.label } };

  const resumeFor = (where: CommandText, ticket?: string) =>
    commandFragment`${cliInvocation()} notify ${commandToken(recipientArgument)}${note === undefined ? commandFragment`` : commandFragment` ${commandToken(note)}`}${
      values.kind === undefined ? commandFragment`` : commandFragment` --kind ${commandToken(kind)}`
    }${values.doc === undefined ? commandFragment`` : commandFragment` --doc ${commandToken(values.doc)}`}${values.thread === undefined ? commandFragment`` : commandFragment` --thread ${commandToken(values.thread)}`}${
      values.label === undefined ? commandFragment`` : commandFragment` --label ${commandToken(values.label)}`
    }${values["label-namespace"] === undefined ? commandFragment`` : commandFragment` --label-namespace ${commandToken(namespace)}`}${
      values.alert === undefined ? commandFragment`` : commandFragment` --alert ${commandToken(values.alert)}`
    }${ticket === undefined ? (values.ticket === undefined ? commandFragment`` : commandFragment` --ticket ${commandToken(values.ticket)}`) : commandFragment` --ticket ${commandToken(ticket)}`}${where}${values.json ? commandFragment` --json` : commandFragment``}`;

  const session = await openInboxSession(
    "notify",
    { dir: values.dir, host: values.host, workspace: values.workspace, bundle: values.bundle },
    deps,
    (where) => resumeFor(where),
    { documents: values.doc !== undefined },
  );
  const { identity, target: host } = session;
  const recipient: InboxRecipient = { kind: "principal", principalId: recipientArgument === "self" ? identity.principalId : recipientArgument };

  let target: AttentionRequestInput["target"];
  const documents = session.documents;
  if (values.doc !== undefined && documents !== null) {
    if (identity.targetAuthorityKey === undefined) {
      throw new CliError("NOT_IMPLEMENTED", `${host.origin} does not report its document authority yet, so notify cannot point at a document`, {
        details: { reason: "target_authority_unknown", host: host.origin },
        help: "send without --doc and name the document in the note; a later release of the host reports it",
      });
    }
    let version: string;
    try {
      version = (await documents.client.reader(documents.bundleId).read(values.doc)).version;
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") {
        throw new CliError("NOT_FOUND", `the host has no document '${values.doc}' in ${documents.bundleId}`, {
          details: { host: host.origin, bundle: documents.bundleId, document: values.doc },
          help: session.via === "checkout" ? "sync a new document first, then send" : "check the document id with superbee doc read in the bundle's checkout",
        });
      }
      throw await inboxFailure(error, session);
    }
    target = {
      document: {
        schemaVersion: "superbee.document-target.v1",
        authority: { mode: "hosted", authorityKey: identity.targetAuthorityKey, workspaceKey: session.tenantId },
        bundleKey: documents.bundleId,
        documentId: values.doc,
      },
      eventVersion: version,
    };
  }

  const input: AttentionRequestInput = {
    recipient,
    kind,
    ...(values.ticket === undefined ? {} : { ticket: values.ticket }),
    ...(values.thread === undefined ? {} : { threadId: values.thread }),
    ...(target === undefined ? {} : { target }),
    ...(note === undefined ? {} : { note }),
    ...(meta === undefined ? {} : { meta }),
    ...(values.alert === undefined ? {} : { alert: values.alert as "default" | "none" }),
  };
  let receipt;
  try {
    receipt = await session.inbox.request(input);
  } catch (error) {
    throw await inboxFailure(error, session, { ticketHelp: (ticket) => "re-run with the same ticket within 24 hours, which never makes a second item: " + resumeFor(session.notifyArgs, ticket) });
  }
  const toSelf = recipient.principalId === identity.principalId;
  stdout(
    renderInboxRecord(
      {
        notify: receipt.replayed ? "already sent" : "sent",
        host: host.origin,
        through: session.via,
        workspace: session.tenantId,
        item: receipt.itemId,
        thread: receipt.threadId,
        revision: receipt.itemRevision,
        kind,
        recipient: toSelf ? `self (${recipient.principalId})` : recipient.principalId,
        document: values.doc ?? null,
        email: receipt.delivery.email,
        ticket: receipt.ticket,
        help: [
          commandFragment`${cliInvocation()} inbox list --thread ${commandToken(receipt.threadId)}${session.scopeArgs}` + " reads this thread, replies included",
          commandFragment`${cliInvocation()} inbox cancel ${commandToken(receipt.itemId)}${session.scopeArgs}` + " withdraws it while it is unhandled",
        ],
      },
      mode,
    ),
  );
}
