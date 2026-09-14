// `doc history <id>` — see `../doc.ts`'s header comment for the CAS-token / attribution rationale.
import { parseArgs } from "node:util";
import { docVersions, type VersionInfo } from "@superbee/core";
import { openBundle, resolveRemoteFlag } from "../../bundle.js";
import { CliError } from "../../errors.js";
import { parseLeafOrUsage } from "../../args.js";
import { CLI_LEAVES } from "../../command-spec.js";
import { render, resolveMode } from "../../output.js";
import { cliInvocation } from "../../invocation.js";
import { conceptIdFromCliArgument, resolveConceptIdCliArgument } from "../../concept-id.js";
import { DOC_HISTORY_USAGE, type DocCliDeps, readErrorToCliError } from "./common.js";
import { commandToken } from "../../command-text.js";

/**
 * AXI unbounded-output guard (same class as `list`/`status`/`blobs`'s row cap): a history-keeping
 * backend can return an arbitrarily long version chain, so `doc history` bounds it like every other
 * list-shaped command does. 20 (not `list`'s 100) matches `status`/`sync`'s "per-item finding list"
 * default rather than `list`'s "whole-bundle scan" default — a single doc's version chain is closer
 * in spirit to those than to a bundle-wide query. `--limit 0` is the escape (all versions), mirroring
 * every other capped command's 0-means-unlimited convention.
 */
const DEFAULT_LIMIT = 20;

export async function docHistory(argv: string[], deps: Partial<DocCliDeps>): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          limit: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.docHistory,
  );
  if (values.help) {
    stdout(DOC_HISTORY_USAGE);
    return;
  }

  const rawId = positionals[0]?.trim();
  if (!rawId) {
    throw new CliError("USAGE", "doc history requires a concept <id> positional", {
      help: `${cliInvocation()} doc history <id>`,
    });
  }
  let id = conceptIdFromCliArgument(rawId);

  // Same validation shape as `list`/`status`/`blobs`/`link`: a non-negative integer, 0 = unlimited.
  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    const raw = values.limit.trim();
    if (!/^\d+$/.test(raw)) {
      throw new CliError("USAGE", "--limit must be a non-negative integer (0 = unlimited)", {
        help: `${cliInvocation()} doc history ${commandToken(id)} --limit 20`,
      });
    }
    limit = Number(raw);
  }

  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));
  id = await resolveConceptIdCliArgument(bundle, rawId);
  let versions: VersionInfo[];
  try {
    versions = await docVersions(bundle, id);
  } catch (err) {
    throw readErrorToCliError(err, id, values.remote);
  }

  if (versions.length === 0) {
    // Definitive empty state (AXI §5): no history means the concept has never been written here — NOT
    // an error (exit 0), so an agent gets a clear "nothing to CAS against" rather than re-querying.
    stdout(
      render(
        {
          id,
          count: 0,
          versions: [],
          help: `no version history for '${id}' — it has not been written to this bundle`,
        },
        resolveMode(values),
      ),
    );
    return;
  }

  // Bound the page like `list`/`status`/`blobs` do: `count` always reports the TRUE total (the
  // filesystem backend's single-entry chain never triggers this — total<=DEFAULT_LIMIT means no new
  // fields appear and the render is byte-identical to the pre-cap output). `versions` is already
  // newest-first, so slicing from the front keeps the newest revision and drops only the oldest tail.
  const total = versions.length;
  const shown = limit > 0 ? versions.slice(0, limit) : versions;
  const truncated = shown.length < total;

  // Attributed history, newest-first (a history-keeping backend returns the full chain; the plain
  // filesystem keeps none, so honestly returns just the single current revision). The newest token is
  // offered inline as a ready-to-paste `--expected-version` for an optimistic update.
  const out: Record<string, unknown> = {
    id,
    count: total,
    versions: shown.map((v) =>
      v.agent === undefined
        ? { version: v.version, actor: v.actor, timestamp: v.timestamp }
        : { version: v.version, actor: v.actor, timestamp: v.timestamp, agent: v.agent },
    ),
  };
  if (truncated) out.shown = shown.length;

  const help: string[] = [];
  if (truncated) {
    help.push(
      `showing ${shown.length} of ${total} — run \`${cliInvocation()} doc history ${commandToken(id)} --limit 0\` (or a higher --limit) for all`,
    );
  }
  help.push(`${cliInvocation()} doc update ${commandToken(id)} --expected-version ${commandToken(versions[0]!.version)}`);
  out.help = help;

  stdout(render(out, resolveMode(values)));
}
