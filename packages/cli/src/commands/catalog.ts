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

export const CATALOG_USAGE = `superbee catalog — register and resolve this user's workspaces

Usage:
  superbee catalog add <label> [--dir <path>]
  superbee catalog list [--json]
  superbee catalog resolve <label-or-id> [--field path | --json]

Labels are user-defined or agent-defined on the user's behalf. They use 1-64 lowercase letters,
numbers, dots, dashes, or underscores, beginning and ending with a letter or number. Registration
is explicit: the catalog never crawls for or silently enrolls workspaces.

Commands:
  add       Register the resolved local bundle under a unique label (idempotent for the same pair)
  list      List registered workspaces and their currently derived availability
  resolve   Revalidate and return exactly one registered workspace

Options:
  --dir <path>   add: bundle root or project directory with a direct .superbee (or legacy .agentstate-lite) bundle
  --field path   resolve: print only the canonical path plus a newline
  --json         Emit compact JSON instead of TOON
  -h, --help     Show this help

The catalog only selects a target. Pass a resolved path explicitly to ordinary commands with
--dir; there is no process-global active workspace and no implicit cross-bundle operation.
`;

export interface CatalogCliDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: () => string;
  home: () => string;
  catalogOptions: CatalogOptions;
}

function entryReceipt(entry: CatalogEntryView): Record<string, unknown> {
  return {
    schema_version: 1,
    id: entry.id,
    label: entry.label,
    locator: entry.locator,
    available: entry.available,
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
    stdout(CATALOG_USAGE);
    return;
  }
  if (parsed.selection.kind === "unknown") usage(`unknown catalog subcommand: ${parsed.selection.token}`);
  const { subcommand, operand } = parsed.selection.payload!;
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
          ...entryReceipt({ ...result.entry, available: true }),
          help: [`${cliInvocation()} catalog resolve ${result.entry.label} --field path`],
        },
        resolveMode(parsed.values),
      ),
    );
    return;
  }

  if (subcommand === "list") {
    if (parsed.values.dir !== undefined) usage("--dir is only valid with catalog add");
    if (parsed.values.field !== undefined) usage("--field is only valid with catalog resolve");
    const entries = await listCatalogEntries(home());
    stdout(
      render(
        {
          schema_version: 1,
          count: entries.length,
          entries,
          help:
            entries.length === 0
              ? [`${cliInvocation()} catalog add <label> [--dir <path>]`]
              : [`${cliInvocation()} catalog resolve <label-or-id> --field path`],
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
