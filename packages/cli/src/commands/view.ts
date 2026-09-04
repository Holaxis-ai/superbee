import { parseArgs } from "node:util";
import { listViewCatalog } from "@superbee/view-runtime";
import { parseSelectorOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { maybeAutoPull } from "../autopull.js";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, resolveMode } from "../output.js";

export const VIEW_USAGE = `superbee view — inspect durable bundle Views

Usage:
  superbee view list [--limit <n>] [--dir <path> | --remote <url> --bundle <bundle_id>]

Lists the same registered durable Views used by the web launcher and MCP list_views tool. Rows are
sorted by stable View id and include the declared access and optional presentation hint.

Options:
  --limit <n>          Cap rows (default: 100; 0 = unlimited)
  --dir <path>         Bundle directory (default: discovered from the cwd)
  --remote <url>       Talk to a wire-protocol server instead of a local bundle
  --bundle <bundle_id> Select the exact hosted bundle (requires --remote)
  --json               Emit compact JSON instead of TOON
  -h, --help           Show this help
`;

export interface ViewCliDeps {
  stdout: (text: string) => void;
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
          bundle: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    }),
    "view",
    (positionals) => {
      if (positionals.length === 0) return { kind: "navigation" } as const;
      if (positionals[0] !== "list") return { kind: "unknown", token: positionals[0] } as const;
      return { kind: "selected", leaf: CLI_LEAVES.viewList, data: positionals.slice(1), payload: undefined } as const;
    },
  );
  if (selection.kind === "help" || selection.kind === "navigation") {
    stdout(VIEW_USAGE);
    return;
  }
  if (selection.kind === "unknown") {
    throw new CliError("USAGE", `unknown view subcommand: ${selection.token ?? ""}`, {
      help: `${cliInvocation()} view --help`,
    });
  }
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

  const remote = await resolveRemoteFlag(values.remote, values.dir, values.bundle);
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
