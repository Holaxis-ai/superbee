// `superbee bundle retire <bundle>` — retire a hosted bundle (superbee-hosted lane share-retire,
// `/sync/v1/bundle-retire-preview` and `bundle-retire`).
//
// The host's preview is read first and shown as the host words it (what retiring does, who has
// access, the invitations it cancels). Then the person at the terminal types the bare bundle id;
// nothing else confirms it, no flag skips it, and a shell no person can answer in (an agent's, a
// pipe, a hook) is refused before anything is sent, telling the agent to hand the command to the
// person. Only then is the one retire request sent, carrying what was typed.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { stripHostText } from "@superbee/core";

import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandToken } from "../command-text.js";
import { CliError } from "../errors.js";
import { defaultHostedAuthDeps, hostArgument, requireHostedBundleHost, type HostedAuthDeps } from "../hosted-auth/session.js";
import { accessRefusal, postRoute } from "../hosted/access.js";
import { connectHostedAccount, resolveBundleReference } from "../hosted/account.js";
import { hostedBundleReferenceText, parseHostedBundleReference } from "../hosted/reference.js";
import { needsPersonAtTerminal, processTerminal, type HostedTerminal } from "../hosted/terminal.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode } from "../output.js";

export const BUNDLE_RETIRE_USAGE = `superbee bundle retire — retire a hosted bundle

Usage:
  superbee bundle retire <bundle> [--host <url>] [--workspace <id>] [--json]

Reads the host's preview of retiring the bundle and shows it: what retiring does, in the host's
own words, how many people have access and how many invitations it cancels. Then the person types
the bundle id in their own terminal to confirm. No flag skips that: in a shell no person can answer
in (an agent's, a pipe, a hook) it is refused before anything is sent, so an agent asks the person
to run it. Only a workspace admin, or the bundle's owner, may retire it.

To keep a copy first: superbee export <bundle> --to <folder> --git

Options:
  --host <url>        Hosted Superbee URL (default: your last sign-in)
  --workspace <id>    Your workspace that holds the bundle, by id or slug
  --json              Emit compact JSON instead of TOON
  -h, --help          Show this help
`;

export interface BundleRetireDeps {
  stdout: (text: string) => void;
  auth: HostedAuthDeps;
  fetch?: typeof fetch;
  /** The person's terminal, for the typed bundle id; tests supply one. */
  terminal: HostedTerminal;
}

/** The host's statement is shown whole, without control or format characters. */
const STATEMENT_CHARS = 4000;

export async function bundleRetire(argv: string[], partial: Partial<BundleRetireDeps> = {}): Promise<void> {
  const deps: BundleRetireDeps = {
    stdout: partial.stdout ?? ((text) => void process.stdout.write(text)),
    auth: partial.auth ?? defaultHostedAuthDeps(homedir()),
    ...(partial.fetch ? { fetch: partial.fetch } : {}),
    terminal: partial.terminal ?? processTerminal(),
  };
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: { host: { type: "string" }, workspace: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
        allowPositionals: true,
      }),
    CLI_LEAVES.bundleRetire,
  );
  if (values.help) {
    deps.stdout(renderUsage(BUNDLE_RETIRE_USAGE));
    return;
  }
  const mode = resolveMode(values);
  const typed = parseHostedBundleReference(positionals[0]!);
  if (!typed) {
    throw new CliError("USAGE", `'${positionals[0]!}' is not a hosted bundle id or <workspace>/<bundle-id>`, { help: `${cliInvocation()} bundle retire --help` });
  }
  const target = await requireHostedBundleHost(values.host, deps.auth.home, deps.auth.env);
  const host = commandToken(hostArgument(target));
  const command = (reference: string) =>
    commandFragment`${cliInvocation()} bundle retire ${commandToken(reference)} --host ${host}${values.workspace !== undefined ? commandFragment` --workspace ${commandToken(values.workspace)}` : commandFragment``}`;
  const resume = commandFragment`${command(hostedBundleReferenceText(typed))}${values.json ? commandFragment` --json` : commandFragment``}`;
  const account = await connectHostedAccount(target, { ...(values.workspace !== undefined ? { workspace: values.workspace } : {}), resume }, { auth: deps.auth, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const resolved = resolveBundleReference(typed, account, target, command).reference;
  const client = resolved.slug === null ? account.client : account.client.within(resolved.slug);
  const reference = hostedBundleReferenceText(resolved);
  const bundleId = resolved.bundleId;
  const context = { client, resume, reference };
  const subject = { reference, host: target, again: resume, retire: true };

  const previewed = await postRoute(context, "bundle-retire-preview", { bundleId });
  if (!previewed.ok) throw accessRefusal(previewed.code, previewed.message, subject);
  const preview = previewed.data;
  const people = preview.people;
  const invitations = preview.pendingInvitations;
  const allowed = preview.allowed;
  if (typeof people !== "number" || typeof invitations !== "number" || typeof preview.statement !== "string" || (allowed !== null && allowed !== "admin" && allowed !== "owner")) {
    throw new CliError("RUNTIME", `${target.origin} answered bundle-retire-preview with an answer this CLI cannot read (client/host contract mismatch)`, {
      details: { host: target.origin, route: "bundle-retire-preview", retryable: false },
      help: "upgrade Superbee (npm install -g superbee); if it persists, report this route",
    });
  }
  const statement = stripHostText(preview.statement, STATEMENT_CHARS);
  const name = typeof preview.name === "string" ? stripHostText(preview.name, 200) : null;
  const shown = { bundle: reference, name, host: target.origin, workspace: typeof preview.workspace === "string" ? stripHostText(preview.workspace, 200) : null, statement, people, pending_invitations: invitations };
  const keepCopy = commandFragment`${cliInvocation()} export ${commandToken(reference)} --host ${host} --to <folder> --git`;

  if (preview.state === "retired") {
    deps.stdout(render({ retire: "already_retired", ...shown, help: [] }, mode));
    return;
  }
  if (allowed === null) {
    throw new CliError("FORBIDDEN", `you may not retire '${reference}' on ${target.origin}: only a workspace admin, or the bundle's owner, may`, {
      details: { reason: "not_allowed", ...shown },
      help: "ask a workspace admin to retire it",
    });
  }
  if (!deps.terminal.interactive) {
    throw needsPersonAtTerminal(`retiring '${reference}' needs the person to type its id in their own terminal, and this shell is not interactive; nothing was retired`, String(command(reference)), {
      bundle: reference,
      host: target.origin,
      statement,
      people,
      pending_invitations: invitations,
      agent_instruction:
        "Do not retry this or work around it. Show the person the statement above, and ask them to run the command in their own terminal if they want the bundle retired.",
      command_for_person: String(command(reference)),
      keep_a_copy_first: String(keepCopy),
    });
  }

  const typedId = (
    await deps.terminal.ask(
      [
        `Retiring '${reference}'${name ? ` (${name})` : ""} on ${target.origin}:`,
        statement,
        `${people} ${people === 1 ? "person has" : "people have"} access; ${invitations} pending invitation(s) will be canceled.`,
        `To keep a copy first, stop here and run: ${keepCopy}`,
        `Type ${bundleId} to retire it, or anything else to keep it: `,
      ].join("\n"),
    )
  ).trim();
  if (typedId !== bundleId) {
    throw new CliError("USAGE", `the typed text did not match '${bundleId}'; nothing was retired`, {
      details: { reason: "not_confirmed", bundle: reference, host: target.origin },
      help: `run it again and type ${bundleId} to retire it: ${command(reference)}`,
    });
  }

  const answer = await postRoute(context, "bundle-retire", { bundleId, confirm: typedId }, randomUUID());
  if (!answer.ok) {
    if (answer.code === "already_retired") {
      deps.stdout(render({ retire: "already_retired", ...shown, help: [] }, mode));
      return;
    }
    throw accessRefusal(answer.code, answer.message, subject);
  }
  const data = answer.data;
  deps.stdout(
    render(
      {
        retire: "retired",
        bundle: reference,
        name,
        host: target.origin,
        workspace: shown.workspace,
        revoked_grants: typeof data.revokedGrants === "number" ? data.revokedGrants : null,
        canceled_invitations: typeof data.canceledInvitations === "number" ? data.canceledInvitations : null,
        help: [String(commandFragment`${cliInvocation()} catalog list --hosted --host ${host}`)],
      },
      mode,
    ),
  );
}
