// `superbee access list|grant|revoke` — who reaches a hosted bundle (superbee-hosted lane
// share-retire, `/sync/v1/access-*`).
//
// `list` reads your own level. Hosted keeps sharing administration on the web Access page
// (superbee-hosted docs/share-and-retire-bundles.md): its sync routes report `admin: false` and
// answer `grant` and `revoke` with `admin_on_web` and, when it has one, the page's address. The
// verbs stay so an older host and a script keep their shape: without --yes they preview (no
// request), and with --yes they send one identified request (`X-Superbee-Write-Request`), which
// today's hosted refuses with nothing changed.
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { stripHostText } from "@superbee/core";

import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import type { HostedTarget } from "../hosted-auth/discovery.js";
import { defaultHostedAuthDeps, hostArgument, requireHostedBundleHost, workspaceForNamedHost, type HostedAuthDeps } from "../hosted-auth/session.js";
import { accessPageUrl, accessRefusal, accessRequestId, postRoute, settleAccessRequest } from "../hosted/access.js";
import { connectHostedAccount, resolveBundleReference } from "../hosted/account.js";
import type { HostedSyncClient } from "../hosted/client.js";
import { hostedBundleReferenceText, parseHostedBundleReference, type HostedBundleReference } from "../hosted/reference.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode } from "../output.js";

export const ACCESS_USAGE = `superbee access — who can reach a hosted bundle

Usage:
  superbee access list <bundle> [--host <url>] [--workspace <id>] [--json]
  superbee access grant <bundle> <email-or-principal> --level read|write [--host <url>] [--workspace <id>] [--yes] [--json]
  superbee access revoke <bundle> <email-or-principal> [--host <url>] [--workspace <id>] [--yes] [--json]

Commands:
  list      Your own access to the bundle, and the workspace's Access page when the host names it
  grant     Hosted Superbee refuses this (admin_on_web): give access on the web Access page
  revoke    Hosted Superbee refuses this (admin_on_web): take access away on the web Access page

Sharing is managed on the web, not from the CLI: a workspace admin opens the workspace's Access
page in the Superbee app (https://<workspace host>/settings/access) and gives a member read or
write on the bundle there, or takes it away. A new bundle is readable only by the person who
created it until an admin does that. The person must already be a member of the workspace: invite
them from the Members page first. 'access list' reports admin: false from hosted Superbee, which
lists only your own access over the CLI.

grant and revoke keep their shape for scripts: without --yes they only preview, with no request;
with --yes they send one request, which hosted Superbee answers with admin_on_web (nothing
changed) and the Access page's address when it has one.

<bundle> is a hosted bundle id, or <workspace>/<bundle-id> for an id more than one of your
workspaces holds. A person is named by their email (any case) or by a principal id (person:...).

Options:
  --level read|write  With grant: the access to give
  --host <url>        Hosted Superbee URL (default: your last sign-in)
  --workspace <id>    Your workspace that holds the bundle, by id or slug
  --yes               With grant or revoke: send the request (default: preview only)
  --json              Emit compact JSON instead of TOON
  -h, --help          Show this help

Examples:
  superbee access list team.notes
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
  const named = await requireHostedBundleHost(values.host, deps.auth);
  const target = named.target;
  const workspace = workspaceForNamedHost(named, values.workspace);
  const command = (reference: string) => commandFragment`${cliInvocation()} access list ${commandToken(reference)}${hostFlag(target)}`;
  const resume = commandFragment`${command(hostedBundleReferenceText(typed))}${workspaceFlag(workspace)}${values.json ? commandFragment` --json` : commandFragment``}`;
  const reached = await reach(typed, target, workspace, resume, deps, command);
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
  const accessPage = accessPageUrl(data.accessUrl);
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
        ...(accessPage ? { access_page: accessPage } : {}),
        help: you.admin ? [String(grant)] : accessPage ? [`a workspace admin gives or takes access on ${accessPage}`] : [],
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
  // The preview makes no request, so a workspace origin is followed to its gateway only at --yes.
  const named = await requireHostedBundleHost(values.host, { ...deps.auth, fetch: values.yes ? deps.auth.fetch : null });
  const target = named.target;
  const workspace = workspaceForNamedHost(named, values.workspace);
  const command = (reference: string) =>
    commandFragment`${cliInvocation()} access ${commandToken(action)} ${commandToken(reference)} ${commandToken(person)}${action === "grant" ? commandFragment` --level ${commandToken(wanted)}` : commandFragment``}${hostFlag(target)}${workspaceFlag(workspace)} --yes`;
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
          ...(workspace !== undefined ? { workspace } : {}),
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

  const reached = await reach(typed, target, workspace, yesCommand, deps, (reference) => command(reference));
  const route = action === "grant" ? "access-grant" : "access-revoke";
  const home = deps.auth.home;
  const requestId = await accessRequestId(home, target.origin, reached.reference, person, action === "grant" ? `grant:${wanted}` : "revoke", deps.auth.now());
  const body = action === "grant" ? { bundleId: reached.bundleId, person, level: wanted } : { bundleId: reached.bundleId, person };
  const answer = await postRoute({ client: reached.client, resume: yesCommand, reference: reached.reference }, route, body, requestId);
  // Settled either way: the host made the change, or refused it before writing anything.
  await settleAccessRequest(home, target.origin, reached.reference, person);
  if (!answer.ok) throw accessRefusal(answer.code, answer.message, { reference: reached.reference, host: target, person, again: yesCommand, ...(answer.accessUrl ? { accessUrl: answer.accessUrl } : {}) });
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
