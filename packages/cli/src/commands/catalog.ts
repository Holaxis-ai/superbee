import { renderUsage } from "../output.js";
import { parseArgs } from "node:util";
import { homedir } from "node:os";

import { parseSelectorOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import {
  addCatalogEntry,
  listCatalogEntries,
  resolveCatalogEntry,
  type CatalogEntryView,
  type CatalogOptions,
} from "../catalog.js";
import { resolveLocalBundleTarget } from "../bundle.js";
import { asHandled, CliError, toExit } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, renderErrorEnvelope, resolveMode } from "../output.js";
import { commandFragment, commandToken } from "../command-text.js";
import { defaultHostedAuthDeps, hostArgument, requireHostedBundleHost, type HostedAuthDeps } from "../hosted-auth/session.js";
import { connectHostedAccount } from "../hosted/account.js";
import { hostedBundleRows, reachableHostedBundles } from "../hosted/reachable.js";

export const CATALOG_USAGE = `superbee catalog — register and resolve this user's workspaces

Usage:
  superbee catalog add <label> [--dir <path>]
  superbee catalog list [--local] [--json]
  superbee catalog list --hosted [--host <url>] [--json]
  superbee catalog resolve <label-or-id> [--field path | --json]

Labels are user-defined or agent-defined on the user's behalf. They use 1-64 lowercase letters,
numbers, dots, dashes, or underscores, beginning and ending with a letter or number. Registration
is explicit: the catalog never crawls for or silently enrolls workspaces.

Commands:
  add       Register the resolved local bundle under a unique label (idempotent for the same pair)
  list      List registered workspaces with their currently derived availability and home,
            and, while you are signed in, the hosted bundles you can reach that have no folder
            here; --hosted lists every hosted bundle you can reach instead (see below)
  resolve   Revalidate and return exactly one registered workspace

Options:
  --dir <path>   add: bundle root or project directory with a direct .superbee (or legacy .agentstate-lite) bundle
  --field path   resolve: print only the canonical path plus a newline
  --local        list: registered workspaces only; never asks a host
  --hosted       list: the hosted bundles you can reach, read live from the host
  --host <url>   list --hosted: Hosted Superbee URL (default: your last sign-in)
  --json         Emit compact JSON instead of TOON
  -h, --help     Show this help

Each entry reports its home, derived from the folder now and never stored: local, git (a Git
board) or hosted (a hosted checkout, with its host, bundle id and checked_out_at). The local MCP
app serves every entry through its folder; in a hosted checkout it refuses up front a write sync
cannot send.

Plain 'catalog list' asks a host only while you are signed in to it (the host of your last
sign-in, and of every checkout here): it never starts a sign-in, waits at most 3 seconds, and
adds 'hosted', per host, the bundles you can reach that have no folder here, each with the
'checkout' command that brings it into one. Signed out, or with --local, it lists the folders
alone and makes no request; when a host cannot be asked in time, a note says so. A hosted bundle
with a Git source is refused by checkout, which names the Git route instead.

'catalog list --hosted' signs in if needed (AUTH_REQUIRED, exit 4, carries the one link to relay and the command to re-run), then
lists every hosted bundle you can reach on that host, across all your workspaces: its bundle_id
(what 'checkout' takes), name and lifecycle, the folder of your checkout of it here (null when
there is none; the first, sorted, when there are several), and ambiguous: true when two of your
workspaces hold the same id (checkout refuses such an id). It lists hosted bundles only, never
your local entries, and caches nothing: the catalog file is unchanged. complete: false means the
host's list stopped at its cap.

The catalog only selects a target. Pass a resolved path explicitly to ordinary commands with
--dir; there is no process-global active workspace and no implicit cross-bundle operation.
`;

/** How long plain `catalog list` waits for the hosted bundles, sign-in refresh included. */
export const CATALOG_HOSTED_BUDGET_MS = 3_000;

export interface CatalogCliDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: () => string;
  home: () => string;
  catalogOptions: CatalogOptions;
  /** For `list --hosted`: sign-in state and the fetch the sync routes are reached with. */
  auth: HostedAuthDeps;
  fetch: typeof fetch;
}

function entryReceipt(entry: CatalogEntryView): Record<string, unknown> {
  return {
    schema_version: 1,
    id: entry.id,
    label: entry.label,
    locator: entry.locator,
    available: entry.available,
    home: entry.home,
    ...(entry.hosted ? { hosted: entry.hosted } : {}),
  };
}

function usage(message: string): never {
  throw new CliError("USAGE", message, { help: `${cliInvocation()} catalog --help` });
}

export async function catalog(argv: string[], deps: Partial<CatalogCliDeps> = {}): Promise<void> {
  const stderr = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  if (requestsPathField(argv)) {
    try {
      await catalogInner(argv, deps);
    } catch (err) {
      const { envelope, handled } = toExit(err);
      if (!handled) stderr(renderErrorEnvelope(envelope));
      throw handled ? err : asHandled(err);
    }
    return;
  }
  await catalogInner(argv, deps);
}

function requestsPathField(argv: string[]): boolean {
  return argv.some((arg, index) => arg === "--field=path" || (arg === "--field" && argv[index + 1] === "path"));
}

async function catalogInner(argv: string[], deps: Partial<CatalogCliDeps>): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const cwd = deps.cwd ?? (() => process.cwd());
  const home = deps.home ?? homedir;
  const parsed = parseSelectorOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          dir: { type: "string" },
          field: { type: "string" },
          hosted: { type: "boolean" },
          local: { type: "boolean" },
          host: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    "catalog",
    (positionals) => {
      const [subcommand, ...data] = positionals;
      if (subcommand === undefined) return { kind: "navigation" } as const;
      if (subcommand !== "add" && subcommand !== "list" && subcommand !== "resolve") {
        return { kind: "unknown", token: subcommand } as const;
      }
      return {
        kind: "selected",
        leaf: subcommand === "add"
          ? CLI_LEAVES.catalogAdd
          : subcommand === "list"
            ? CLI_LEAVES.catalogList
            : CLI_LEAVES.catalogResolve,
        data,
        payload: { subcommand, operand: data[0] },
      } as const;
    },
  );

  if (parsed.selection.kind === "help" || parsed.selection.kind === "navigation") {
    stdout(renderUsage(CATALOG_USAGE));
    return;
  }
  if (parsed.selection.kind === "unknown") usage(`unknown catalog subcommand: ${parsed.selection.token}`);
  const { subcommand, operand } = parsed.selection.payload!;
  if (subcommand !== "list" && parsed.values.hosted) usage("--hosted is only valid with catalog list");
  if (subcommand !== "list" && parsed.values.local) usage("--local is only valid with catalog list");
  if (!parsed.values.hosted && parsed.values.host !== undefined) usage("--host is only valid with catalog list --hosted");
  if (subcommand === "add") {
    if (parsed.values.field !== undefined) usage("--field is only valid with catalog resolve");
    const target = await resolveLocalBundleTarget(parsed.values.dir, cwd());
    const result = await addCatalogEntry(operand!, target.canonicalRoot, {
      ...(deps.catalogOptions ?? {}),
      home: home(),
    });
    stdout(
      render(
        {
          catalog: result.changed ? "added" : "unchanged",
          changed: result.changed,
          ...entryReceipt(await resolveCatalogEntry(result.entry.id, home())),
          help: [`${cliInvocation()} catalog resolve ${commandToken(result.entry.label)} --field path`],
        },
        resolveMode(parsed.values),
      ),
    );
    return;
  }

  if (subcommand === "list") {
    if (parsed.values.dir !== undefined) usage("--dir is only valid with catalog add");
    if (parsed.values.field !== undefined) usage("--field is only valid with catalog resolve");
    if (parsed.values.hosted) {
      if (parsed.values.local) usage("--local and --hosted are mutually exclusive");
      await listHosted(parsed.values, deps, home(), stdout);
      return;
    }
    const entries = await listCatalogEntries(home());
    // With a live sign-in, the hosted bundles with no folder here are listed too; signed out (or
    // with --local) nothing is asked, and the listing is the folders alone.
    const reachable = parsed.values.local
      ? null
      : await reachableHostedBundles({ budgetMs: CATALOG_HOSTED_BUDGET_MS, ...(deps.auth ? { auth: deps.auth } : { home: home() }), ...(deps.fetch ? { fetch: deps.fetch } : {}) }).catch(() => null);
    const firstCheckout = reachable?.hosts.flatMap((host) => host.bundles)[0]?.checkout;
    stdout(
      render(
        {
          schema_version: 1,
          count: entries.length,
          entries,
          ...(reachable
            ? {
                hosted: reachable.hosts.map((host) => ({ host: host.host, complete: host.complete, count: host.bundles.length, bundles: host.bundles })),
                ...(reachable.notes.length > 0 ? { note: reachable.notes.join("; ") } : {}),
              }
            : {}),
          help:
            entries.length === 0
              ? [`${cliInvocation()} catalog add <label> [--dir <path>]`, ...(firstCheckout ? [firstCheckout] : [])]
              : [`${cliInvocation()} catalog resolve <label-or-id> --field path`, ...(firstCheckout ? [firstCheckout] : [])],
        },
        resolveMode(parsed.values),
      ),
    );
    return;
  }

  if (subcommand === "resolve") {
    if (parsed.values.dir !== undefined) usage("--dir is only valid with catalog add");
    if (parsed.values.field !== undefined && parsed.values.field !== "path") {
      usage('catalog resolve --field supports only "path"');
    }
    if (parsed.values.field !== undefined && parsed.values.json) {
      usage("--field and --json are mutually exclusive");
    }
    const entry = await resolveCatalogEntry(operand!, home());
    if (parsed.values.field === "path") {
      stdout(entry.locator.path + "\n");
      return;
    }
    stdout(
      render(
        {
          ...entryReceipt(entry),
          help: [`pass this path explicitly: ${cliInvocation()} <command> --dir <resolved-path>`],
        },
        resolveMode(parsed.values),
      ),
    );
    return;
  }
}

/**
 * `catalog list --hosted`: the hosted bundles the signed-in person can reach, read live from the
 * host's bundle list and never stored, each with the folder of a live checkout of it here.
 */
async function listHosted(
  values: { host?: string | undefined; json?: boolean | undefined },
  deps: Partial<CatalogCliDeps>,
  home: string,
  stdout: (s: string) => void,
): Promise<void> {
  const auth = deps.auth ?? defaultHostedAuthDeps(home);
  const target = await requireHostedBundleHost(values.host, auth.home);
  const host = hostArgument(target);
  const resume = commandFragment`${cliInvocation()} catalog list --hosted --host ${commandToken(host)}${values.json ? commandFragment` --json` : commandFragment``}`;
  const { client, identity } = await connectHostedAccount(
    target,
    { resume },
    { auth, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
  );
  const { rows: bundles, complete } = await hostedBundleRows(client, target, auth.home);
  const listing = { complete };
  stdout(
    render(
      {
        schema_version: 1,
        host: target.origin,
        principal: identity.principalId,
        workspaces: identity.tenantIds,
        count: bundles.length,
        complete: listing.complete,
        bundles,
        ...(listing.complete ? {} : { note: "the host's bundle list stopped at its cap, so more bundles may exist; the Superbee app lists them all" }),
        ...(bundles.length === 0
          ? { message: "no hosted bundle is visible to you on this host: create one in the Superbee app, or move a local bundle there with publish --to hosted" }
          : {}),
        help:
          bundles.length === 0
            ? [`${cliInvocation()} publish --to hosted --host ${commandToken(host)}`]
            : [`${cliInvocation()} checkout <bundle-id> --host ${commandToken(host)}`],
      },
      resolveMode(values),
    ),
  );
}
