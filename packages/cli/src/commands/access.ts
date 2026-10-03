// `superbee access list|grant|revoke` — who reaches a hosted bundle, and sharing it with a named
// member of its workspace from the CLI (superbee-hosted lane share-retire, `/sync/v1/access-*`).
//
// `list` reads: your own level and admin standing, and, for an admin, everyone with access.
// `grant` and `revoke` preview without --yes (no request, the command to run in `help`), as
// `publish` does; with --yes each is one identified request (`X-Superbee-Write-Request`). Only a
// workspace admin may change access, never above their own level. The person must already be a
// member of the workspace: inviting someone stays in the app.
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { stripHostText } from "@superbee/core";

import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import type { HostedTarget } from "../hosted-auth/discovery.js";
import { defaultHostedAuthDeps, hostArgument, requireHostedBundleHost, type HostedAuthDeps } from "../hosted-auth/session.js";
import { accessRefusal, accessRequestId, postRoute, settleAccessRequest } from "../hosted/access.js";
import { connectHostedAccount, resolveBundleReference } from "../hosted/account.js";
import type { HostedSyncClient } from "../hosted/client.js";
import { hostedBundleReferenceText, parseHostedBundleReference, type HostedBundleReference } from "../hosted/reference.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode } from "../output.js";

export const ACCESS_USAGE = `superbee access — who can reach a hosted bundle, and sharing it with a member of its workspace

Usage:
  superbee access list <bundle> [--host <url>] [--workspace <id>] [--json]
  superbee access grant <bundle> <email-or-principal> --level read|write [--host <url>] [--workspace <id>] [--yes] [--json]
  superbee access revoke <bundle> <email-or-principal> [--host <url>] [--workspace <id>] [--yes] [--json]

Commands:
  list      Your own access to the bundle; for a workspace admin, everyone with access and their level
  grant     Give a member of the bundle's workspace read or write access (or change their level)
  revoke    Take a person's access to the bundle away

<bundle> is a hosted bundle id, or <workspace>/<bundle-id> for an id more than one of your
workspaces holds. A person is named by their email (any case) or by the principal id 'access list'
shows (person:...), needed when two members share an email.

Without --yes, grant and revoke only preview, with no request: what will change, and the command
that does it. With --yes they sign in if needed and send one request. Only a workspace admin may
change access, and never above their own level on the bundle. The person must already be a member
of the workspace: invite them from the Members page in the Superbee app first. Granting the level a
person already has, or revoking someone with no access, succeeds and changes nothing, so a re-run is
always safe; after an unknown outcome (TRANSIENT) a re-run within the hour re-sends the same request.

Options:
  --level read|write  With grant: the access to give
  --host <url>        Hosted Superbee URL (default: your last sign-in)
  --workspace <id>    Your workspace that holds the bundle, by id or slug
  --yes               With grant or revoke: make the change (default: preview only)
  --json              Emit compact JSON instead of TOON
  -h, --help          Show this help

Examples:
  superbee access list team.notes
  superbee access grant team.notes ana@example.com --level write --yes
  superbee access revoke team.notes ana@example.com --yes
`;

export interface AccessDeps {
  stdout: (text: string) => void;
  auth: HostedAuthDeps;
  /** The fetch the sync routes are reached with (the sign-in module keeps its own). */
  fetch?: typeof fetch;
}

function accessDeps(partial: Partial<AccessDeps>): AccessDeps {
  return {
    stdout: partial.stdout ?? ((text) => void process.stdout.write(text)),
    auth: partial.auth ?? defaultHostedAuthDeps(homedir()),
    ...(partial.fetch ? { fetch: partial.fetch } : {}),
  };
}

const usage = (message: string) => new CliError("USAGE", message, { help: `${cliInvocation()} access --help` });

export async function access(argv: string[], partial: Partial<AccessDeps> = {}): Promise<void> {
  const deps = accessDeps(partial);
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "list") return accessList(rest, deps);
  if (sub === "grant") return accessChange("grant", rest, deps);
  if (sub === "revoke") return accessChange("revoke", rest, deps);
  if (sub === undefined || sub === "-h" || sub === "--help") {
    deps.stdout(renderUsage(ACCESS_USAGE));
    return;
  }
  throw new CliError("USAGE", `unknown access subcommand: ${sub} (expected list|grant|revoke)`, { help: `${cliInvocation()} access --help` });
}

/** The bundle reference typed, refused when it is not one. */
function typedReference(value: string): HostedBundleReference {
  const reference = parseHostedBundleReference(value);
  if (!reference) throw usage(`'${value}' is not a hosted bundle id or <workspace>/<bundle-id>`);
  return reference;
}

/** A person as the host takes them: an email or a principal id, one line of printable text. */
function typedPerson(value: string): string {
  const person = value.trim();
  if (person === "" || person.length > 320 || /[\p{Cc}\p{Cf}\s]/u.test(person)) throw usage(`'${value}' is not an email or a principal id`);
  return person;
}

const hostFlag = (target: HostedTarget) => commandFragment` --host ${commandToken(hostArgument(target))}`;
const workspaceFlag = (workspace: string | undefined) => (workspace !== undefined ? commandFragment` --workspace ${commandToken(workspace)}` : commandFragment``);

interface Reached {
  readonly client: HostedSyncClient;
  /** The reference the host was asked about, as the person names it. */
  readonly reference: string;
  readonly bundleId: string;
}

/** Sign in, check the reference against the person's workspaces, and the client that names it there. */
async function reach(typed: HostedBundleReference, target: HostedTarget, workspace: string | undefined, resume: CommandText, deps: AccessDeps, again: (reference: string) => string): Promise<Reached> {
  const account = await connectHostedAccount(target, { ...(workspace !== undefined ? { workspace } : {}), resume }, { auth: deps.auth, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const { reference } = resolveBundleReference(typed, account, target, again);
  return {
    client: reference.slug === null ? account.client : account.client.within(reference.slug),
    reference: hostedBundleReferenceText(reference),
    bundleId: reference.bundleId,
  };
}

const text = (value: unknown, max = 320): string | null => (typeof value === "string" ? stripHostText(value, max) : null);
const LEVELS = new Set(["none", "read", "write"]);
const level = (value: unknown): string | null => (typeof value === "string" && LEVELS.has(value) ? value : null);

function malformed(target: HostedTarget, route: string): CliError {
  return new CliError("RUNTIME", `${target.origin} answered ${route} with an answer this CLI cannot read (client/host contract mismatch)`, {
    details: { host: target.origin, route, retryable: false },
    help: "upgrade Superbee (npm install -g superbee); if it persists, report this route",
  });
}

async function accessList(argv: string[], deps: AccessDeps): Promise<void> {
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: { host: { type: "string" }, workspace: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
        allowPositionals: true,
      }),
    CLI_LEAVES.accessList,
  );
  if (values.help) {
    deps.stdout(renderUsage(ACCESS_USAGE));
    return;
  }
  const typed = typedReference(positionals[0]!);
  const target = await requireHostedBundleHost(values.host, deps.auth.home, deps.auth.env);
  const command = (reference: string) => commandFragment`${cliInvocation()} access list ${commandToken(reference)}${hostFlag(target)}`;
  const resume = commandFragment`${command(hostedBundleReferenceText(typed))}${workspaceFlag(values.workspace)}${values.json ? commandFragment` --json` : commandFragment``}`;
  const reached = await reach(typed, target, values.workspace, resume, deps, command);
  const answer = await postRoute({ client: reached.client, resume, reference: reached.reference }, "access-list", { bundleId: reached.bundleId });
  if (!answer.ok) throw accessRefusal(answer.code, answer.message, { reference: reached.reference, host: target, again: resume });
  const data = answer.data;
  const you = data.you as Record<string, unknown> | undefined;
  const people = data.people;
  if (typeof you !== "object" || you === null || level(you.level) === null || typeof you.admin !== "boolean" || (people !== null && !Array.isArray(people))) throw malformed(target, "access-list");
  const rows = Array.isArray(people)
    ? people.map((row: Record<string, unknown> | null) => {
        if (typeof row?.principalId !== "string" || (row.level !== "read" && row.level !== "write")) throw malformed(target, "access-list");
        return { principal_id: text(row.principalId), name: text(row.name, 200), email: text(row.email), level: row.level };
      })
    : null;
  const grant = commandFragment`${cliInvocation()} access grant ${commandToken(reached.reference)} <email> --level read${hostFlag(target)}`;
  deps.stdout(
    render(
      {
        bundle: reached.reference,
        host: target.origin,
        workspace: text(data.workspace),
        you: { principal_id: text(you.principalId), level: you.level, admin: you.admin },
        people: rows === null ? null : { count: rows.length, complete: data.complete !== false, rows },
        ...(rows === null
          ? { note: "only a workspace admin sees who else has access" }
          : data.complete === false
            ? { note: `the host listed the first ${rows.length} people with access, not all of them` }
            : {}),
        help: you.admin ? [String(grant)] : [],
      },
      resolveMode(values),
    ),
  );
}

function parseGrant(argv: string[]) {
  return parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          level: { type: "string" },
          host: { type: "string" },
          workspace: { type: "string" },
          yes: { type: "boolean" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.accessGrant,
  );
}

function parseRevoke(argv: string[]) {
  return parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          host: { type: "string" },
          workspace: { type: "string" },
          yes: { type: "boolean" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.accessRevoke,
  );
}

async function accessChange(action: "grant" | "revoke", argv: string[], deps: AccessDeps): Promise<void> {
  const { values, positionals } = action === "grant" ? parseGrant(argv) : parseRevoke(argv);
  if (values.help) {
    deps.stdout(renderUsage(ACCESS_USAGE));
    return;
  }
  const typed = typedReference(positionals[0]!);
  const person = typedPerson(positionals[1]!);
  const wanted = action === "grant" ? (values as { level?: string }).level : "none";
  if (wanted !== "read" && wanted !== "write" && wanted !== "none") {
    throw usage(wanted === undefined ? "grant needs --level read or --level write" : `'${wanted}' is not a level: read or write`);
  }
  const mode = resolveMode(values);
  const target = await requireHostedBundleHost(values.host, deps.auth.home, deps.auth.env);
  const command = (reference: string) =>
    commandFragment`${cliInvocation()} access ${commandToken(action)} ${commandToken(reference)} ${commandToken(person)}${action === "grant" ? commandFragment` --level ${commandToken(wanted)}` : commandFragment``}${hostFlag(target)}${workspaceFlag(values.workspace)} --yes`;
  const typedText = hostedBundleReferenceText(typed);
  const yesCommand = commandFragment`${command(typedText)}${values.json ? commandFragment` --json` : commandFragment``}`;

  if (!values.yes) {
    deps.stdout(
      render(
        {
          access: "preview",
          action,
          bundle: typedText,
          person,
          ...(action === "grant" ? { level: wanted } : {}),
          host: target.origin,
          ...(values.workspace !== undefined ? { workspace: values.workspace } : {}),
          will:
            action === "grant"
              ? `give ${person} ${wanted} access to '${typedText}' (or change their level to ${wanted}); they must already be a member of the workspace (invite them from the Members page in the Superbee app first)`
              : `take ${person}'s access to '${typedText}' away; they stay a member of the workspace`,
          needs: "a workspace admin, granting no more than your own level on the bundle",
          network: "none (preview)",
          help: [String(yesCommand)],
        },
        mode,
      ),
    );
    return;
  }

  const reached = await reach(typed, target, values.workspace, yesCommand, deps, (reference) => command(reference));
  const route = action === "grant" ? "access-grant" : "access-revoke";
  const home = deps.auth.home;
  const requestId = await accessRequestId(home, target.origin, reached.reference, person, action === "grant" ? `grant:${wanted}` : "revoke", deps.auth.now());
  const body = action === "grant" ? { bundleId: reached.bundleId, person, level: wanted } : { bundleId: reached.bundleId, person };
  const answer = await postRoute({ client: reached.client, resume: yesCommand, reference: reached.reference }, route, body, requestId);
  // Settled either way: the host made the change, or refused it before writing anything.
  await settleAccessRequest(home, target.origin, reached.reference, person);
  if (!answer.ok) throw accessRefusal(answer.code, answer.message, { reference: reached.reference, host: target, person, again: yesCommand });
  const data = answer.data;
  const after = level(data.level);
  const before = level(data.before);
  if (typeof data.principalId !== "string" || after === null || before === null || after !== wanted) throw malformed(target, route);
  deps.stdout(
    render(
      {
        access: before === after ? "unchanged" : action === "grant" ? (before === "none" ? "granted" : "changed") : "revoked",
        bundle: reached.reference,
        host: target.origin,
        workspace: text(data.workspace),
        person: { principal_id: text(data.principalId), email: text(data.email) },
        level: after,
        before,
        ...(typeof data.changeId === "string" ? { change_id: text(data.changeId, 200) } : {}),
        ...(typeof data.at === "string" ? { at: text(data.at, 64) } : {}),
        help: [String(commandFragment`${cliInvocation()} access list ${commandToken(reached.reference)}${hostFlag(target)}`)],
      },
      mode,
    ),
  );
}
