import { parseArgs } from "node:util";
import { versionOfBytes } from "@superbee/core";
import { backendFor } from "@superbee/core/bundle-ops";
import { SEARCH_MAX_OUTPUT_BYTES, searchSourceFromBackend, searchDocuments, validateSearchRequest, SearchInputError, SearchLimitError } from "@superbee/core/search";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { CliError } from "../errors.js";
import { render, renderUsage, resolveMode } from "../output.js";
import { cliInvocation } from "../invocation.js";

export const SEARCH_USAGE = `superbee search — search the selected local bundle

Usage:
  superbee search <query> [--type <t>] [--tag <t>] [--prefix <p>] [--match auto|all|any]
    [--limit <1..50>] [--cursor <token>] [--facets type,tags] [--json] [--dir <path>]

Searches current local bytes, including unsent checkout edits. Default limit: 10.
Prefixes are literal canonical bundle-relative ID prefixes; a trailing / is allowed.
Use --cursor with the same query, filters and unchanged bundle to continue.
--remote is unavailable; select a local folder or checkout with --dir.
Read a full match with superbee doc read <id>.
`;
const OPTIONS = {
  type: { type: "string" }, tag: { type: "string" }, prefix: { type: "string" },
  match: { type: "string" }, limit: { type: "string" }, cursor: { type: "string" },
  facets: { type: "string" }, dir: { type: "string" }, remote: { type: "string" },
  json: { type: "boolean" }, help: { type: "boolean", short: "h" },
} as const;

export async function search(argv: string[], deps: { stdout?: (s: string) => void } = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const { values, positionals } = parseLeafOrUsage(
    () => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }),
    CLI_LEAVES.search, { optionNames: Object.keys(OPTIONS) },
  );
  if (values.help) { stdout(renderUsage(SEARCH_USAGE)); return; }
  if (await resolveRemoteFlag(values.remote, values.dir) !== undefined)
    throw new CliError("USAGE", "Search requires a local bundle or checkout; --remote search is unavailable.");
  try {
    const request = validateSearchRequest({
      query: positionals[0],
      ...(values.type === undefined ? {} : { type: values.type }),
      ...(values.tag === undefined ? {} : { tag: values.tag }),
      ...(values.prefix === undefined ? {} : { prefix: values.prefix }),
      ...(values.match === undefined ? {} : { match: values.match }),
      ...(values.limit === undefined ? {} : { limit: /^\d+$/.test(values.limit) ? Number(values.limit) : NaN }),
      ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
      ...(values.facets === undefined ? {} : { facets: values.facets.split(",") }),
    });
    const bundle = await openBundle(values.dir);
    const source = await searchSourceFromBackend(backendFor(bundle));
    const result = await searchDocuments(source, request, { scope: versionOfBytes(bundle.root) }, undefined, { maxResultBytes: SEARCH_MAX_OUTPUT_BYTES });
    const cell = (s: string | undefined) => s && s.length > 80 ? `${s.slice(0, 80)}…` : s ?? "";
    stdout(render({
      count: result.total,
      docs: result.hits.map((hit) => ({ id: hit.id, type: cell(hit.type), title: cell(hit.title),
        score: hit.score, matched: hit.matchedTerms, excerpt: cell(hit.excerpt) })),
      ...(result.total > result.hits.length ? { shown: result.hits.length } : {}),
      ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
      query: { match: result.query.effectiveMatch, fallback: result.query.fallbackUsed,
        ignored: result.query.ignoredTerms ?? [] },
      corpus: result.corpus,
      ...(result.facets ? { facets: result.facets } : {}),
      ...(result.guidance ? { guidance: result.guidance } : {}),
      help: `${cliInvocation()} doc read <id>`,
    }, resolveMode(values)));
  } catch (error) {
    if (error instanceof SearchInputError || error instanceof SearchLimitError)
      throw new CliError("USAGE", error.message, { help: `${cliInvocation()} search --help` });
    throw error;
  }
}
