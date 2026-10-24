import { renderUsage } from "../output.js";
import { parseArgs } from "node:util";
import { listViewCatalog } from "@superbee/view-runtime";
import { parseSelectorOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { maybeAutoPull } from "../autopull.js";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, resolveMode } from "../output.js";
import { presentManagedLocalView, type UiCliDeps } from "./ui.js";

export const VIEW_USAGE = `superbee view — inspect and open durable bundle Views

Usage:
  superbee view list [--limit <n>] [--dir <path> | --remote <url>]
  superbee view open <viewId> [--dir <path>] [--actor <name>] [--no-open --json]

Lists the same registered durable Views used by the web launcher and MCP list_views tool. Rows are
sorted by stable View id and include the declared access and optional presentation hint.
Open selects one exact registered local View through the reusable managed UI. Its private,
one-use browser handoff expires after 60 seconds and establishes this UI authority's session;
the shell still requires approval for executable data-bearing View bytes. No reusable session
secret is included in the ordinary destination URL. Remote View opening is not supported here.

Options:
  --limit <n>          Cap rows (default: 100; 0 = unlimited)
  --dir <path>         Bundle directory (default: discovered from the cwd)
  --remote <url>       Talk to a wire-protocol server instead of a local bundle
  --actor <name>       Actor for the exact managed local authority (open only)
  --no-open           Prepare a private one-use handoff without opening a browser (open, --json only)
  --json               Emit compact JSON instead of TOON
  -h, --help           Show this help
`;

export interface ViewCliDeps extends Partial<UiCliDeps> {
  autoPull: (dir?: string) => Promise<unknown>;
}

export async function view(argv: string[], deps: Partial<ViewCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const { values, selection } = parseSelectorOrUsage(
    () => parseArgs({
      args: argv,
      options: {
        limit: { type: "string" },
        dir: { type: "string" },
        remote: { type: "string" },
        actor: { type: "string" },
        "no-open": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    }),
    "view",
    (positionals) => {
      if (positionals.length === 0) return { kind: "navigation" } as const;
      if (positionals[0] === "list") return { kind: "selected", leaf: CLI_LEAVES.viewList, data: positionals.slice(1), payload: undefined } as const;
      if (positionals[0] === "open") return { kind: "selected", leaf: CLI_LEAVES.viewOpen, data: positionals.slice(1), payload: undefined } as const;
      return { kind: "unknown", token: positionals[0] } as const;
    },
  );
  if (selection.kind === "help" || selection.kind === "navigation") {
    stdout(renderUsage(VIEW_USAGE));
    return;
  }
  if (selection.kind === "unknown") {
    throw new CliError("USAGE", `unknown view subcommand: ${selection.token ?? ""}`, {
      help: `${cliInvocation()} view --help`,
    });
  }
  if (selection.leaf === CLI_LEAVES.viewOpen) {
    if (values.limit !== undefined) throw new CliError("USAGE", "--limit is available only with view list");
    await presentManagedLocalView(selection.data[0]!, values, deps);
    return;
  }
  if (values.actor !== undefined || values["no-open"]) throw new CliError("USAGE", "--actor and --no-open are available only with view open");
  let limit = 100;
  if (values.limit !== undefined) {
    const raw = values.limit.trim();
    if (!/^\d+$/.test(raw)) {
      throw new CliError("USAGE", "--limit must be a non-negative integer (0 = unlimited)", {
        help: `${cliInvocation()} view list --limit 100`,
      });
    }
    limit = Number(raw);
  }

  const remote = await resolveRemoteFlag(values.remote, values.dir);
  if (!remote) await (deps.autoPull ?? maybeAutoPull)(values.dir);
  const catalog = await listViewCatalog(await openBundle(values.dir, remote));
  const rows = limit === 0 ? catalog.entries : catalog.entries.slice(0, limit);
  const truncated = rows.length < catalog.total;
  stdout(render({
    views: {
      count: catalog.total,
      shown: rows.length,
      truncated,
      rows,
    },
    invalid_registrations: catalog.invalidRegistrations,
    unavailable_entries: catalog.unavailableEntries,
    skipped_documents: catalog.skippedDocuments,
    ...(truncated ? { help: [`${cliInvocation()} view list --limit 0`] } : {}),
  }, resolveMode(values)));
}
