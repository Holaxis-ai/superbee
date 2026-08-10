// `agentstate-lite blobs [--prefix <p>] [--limit <n>]` — enumerate the store's blob (non-document) keys.
//
// Blobs are opaque byte artifacts (generated HTML, images, binary assets) addressed by key — the
// non-'.md' half of the store that 'promote'/'pull'/'delete --doc-key' operate on ONE key at a time.
// This is their enumeration surface, symmetric with `list`/`query` for documents: `listBlobs` already
// exists on the StorageBackend seam AND on RemoteBackend + the wire (GET /blobs), so this command is a
// thin, backend-agnostic consumer — it rides `--remote` for free, exactly like `list`.
import { parseArgs } from "node:util";
import { listBlobs } from "@agentstate-lite/core";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode } from "../output.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";

export const BLOBS_USAGE = `agentstate-lite blobs — list the store's blob (non-document) keys

Usage:
  agentstate-lite blobs [--prefix <p>] [--limit <n>] [--dir <path> | --remote <url>]

Blobs are opaque byte artifacts (generated HTML, images, …) addressed by key — the non-'.md' half
of the store that 'promote'/'pull'/'delete --doc-key' operate on individually. This lists their
KEYS; documents are listed by 'list'/'query' instead.

Options:
  --prefix <p>    Restrict to keys starting with this prefix
  --limit <n>     Cap the number of keys returned (default: 100; 0 = unlimited). A truncated result
                  reports 'shown' alongside the total 'count'.
  --dir <path>    Bundle directory (default: discovered from the cwd)
  --remote <url>  Talk to a wire-protocol server instead of a local bundle
                  (mutually exclusive with --dir; remote access is always explicit)
  --json          Emit compact JSON instead of TOON
  -h, --help      Show this help
`;

export interface BlobsCliDeps {
  stdout: (s: string) => void;
}

export async function blobs(argv: string[], deps: Partial<BlobsCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          prefix: { type: "string" },
          limit: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.blobs,
  );
  if (values.help) {
    stdout(BLOBS_USAGE);
    return;
  }

  // Row cap, mirroring `list` (§9): default 100, 0 = unlimited; `count` is the true total.
  const DEFAULT_LIMIT = 100;
  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    const raw = values.limit.trim();
    if (!/^\d+$/.test(raw)) {
      throw new CliError("USAGE", "--limit must be a non-negative integer (0 = unlimited)", {
        help: `${cliInvocation()} blobs --limit 100`,
      });
    }
    limit = Number(raw);
  }

  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));
  const keys = (await listBlobs(bundle, values.prefix?.trim() || undefined)).slice().sort();

  const total = keys.length;
  const shownKeys = limit > 0 ? keys.slice(0, limit) : keys;
  const truncated = shownKeys.length < total;

  const out: Record<string, unknown> = { count: total, blobs: shownKeys };
  if (truncated) out.shown = shownKeys.length;

  const help: string[] = [];
  if (truncated) {
    help.push(
      `showing ${shownKeys.length} of ${total} — run \`${cliInvocation()} blobs --limit 0\` for all`,
    );
  }
  help.push(
    total > 0
      ? `${cliInvocation()} pull --doc-key <key> --out <path>`
      : `no blobs in the store — add one with \`${cliInvocation()} promote <file> --doc-key <key>\``,
  );
  out.help = help;

  stdout(render(out, resolveMode(values)));
}
