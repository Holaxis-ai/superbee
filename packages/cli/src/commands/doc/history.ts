import { renderUsage } from "../../output.js";
// `doc history <id>` — see `../doc.ts`'s header comment for the CAS-token / attribution rationale.
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { docVersions, parseMarkdown, RemoteError, type VersionInfo } from "@superbee/core";
import { openBundle, resolveRemoteFlag } from "../../bundle.js";
import { CliError } from "../../errors.js";
import { parseLeafOrUsage } from "../../args.js";
import { CLI_LEAVES } from "../../command-spec.js";
import { render, resolveMode, type OutputMode } from "../../output.js";
import { cliInvocation } from "../../invocation.js";
import { conceptIdFromCliArgument, resolveConceptIdCliArgument } from "../../concept-id.js";
import { DOC_HISTORY_USAGE, HOSTED_HISTORY_CEILING, type DocCliDeps, readErrorToCliError } from "./common.js";
import { commandFragment, commandToken, type CommandText } from "../../command-text.js";
import { hostedCheckoutAt } from "../../autopull.js";
import type { CheckoutBinding } from "../../hosted/binding.js";
import type { HostedAccountDeps } from "../../hosted/account.js";
import type { HostedSyncClient } from "../../hosted/client.js";
import type { HostedTarget } from "../../hosted-auth/discovery.js";
import { HISTORY_PAGE_LIMIT, readHistoryListing, type HostedHistoryVersion, type HostedOperationRefusal } from "@superbee/core/hosted-transport";
import { attachBodyPreview } from "../../body-replace-guards.js";

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
          seq: { type: "string" },
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
    stdout(renderUsage(DOC_HISTORY_USAGE));
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
  let seq: number | undefined;
  if (values.seq !== undefined) {
    const raw = values.seq.trim();
    seq = /^\d+$/.test(raw) ? Number(raw) : 0;
    if (!Number.isSafeInteger(seq + 1) || seq < 1) {
      throw new CliError("USAGE", "--seq must be a positive integer (a version's seq from doc history)", {
        help: `${cliInvocation()} doc history ${commandToken(id)}`,
      });
    }
    if (values.limit !== undefined) {
      throw new CliError("USAGE", "pass --seq or --limit, not both", { help: `${cliInvocation()} doc history ${commandToken(id)} --seq ${commandToken(String(seq))}` });
    }
  }

  const remote = await resolveRemoteFlag(values.remote, values.dir);
  // A hosted checkout reads the host's chain; an explicit --remote wins over the folder's binding.
  const home = deps.hosted?.auth?.home ?? homedir();
  const checkout = remote ? null : await hostedCheckoutAt(values.dir, home).catch(() => null);
  if (seq !== undefined && !checkout) {
    throw new CliError("USAGE", "--seq reads one version from a hosted checkout's history; a local bundle or --remote has no such history", {
      details: { reason: "no_hosted_history" },
      help: `${cliInvocation()} doc read ${commandToken(id)}`,
    });
  }

  const bundle = await openBundle(values.dir, remote);
  id = await resolveConceptIdCliArgument(bundle, rawId);
  const mode = resolveMode(values);

  if (checkout) {
    const resume = commandFragment`${cliInvocation()} doc history ${commandToken(id)} --dir ${commandToken(checkout.path)}${
      seq !== undefined ? commandFragment` --seq ${commandToken(String(seq))}` : values.limit !== undefined ? commandFragment` --limit ${commandToken(String(limit))}` : commandFragment``
    }${values.json ? commandFragment` --json` : commandFragment``}`;
    const connection = await hostedConnection(checkout, deps.hosted, resume);
    if (seq !== undefined) {
      await hostedVersion(connection, checkout, id, seq, mode, stdout);
      return;
    }
    await hostedList(connection, checkout, id, limit, mode, stdout);
    return;
  }

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
        mode,
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
    help.push(truncationHelp(id, shown.length, total));
  }
  help.push(`${cliInvocation()} doc update ${commandToken(id)} --expected-version ${commandToken(versions[0]!.version)}`);
  out.help = help;

  stdout(render(out, mode));
}

function truncationHelp(id: string, shown: number, total: number): string {
  return `showing ${shown} of ${total} — run \`${cliInvocation()} doc history ${commandToken(id)} --limit 0\` (or a higher --limit) for all`;
}

interface Connection {
  readonly client: HostedSyncClient;
  readonly target: HostedTarget;
  readonly resume: CommandText;
}

/** The checkout's host, reached as the checkout's own person. */
async function hostedConnection(checkout: CheckoutBinding, hosted: HostedAccountDeps | undefined, resume: CommandText): Promise<Connection> {
  // Loaded only in a hosted checkout, so an ordinary history never loads the hosted modules.
  const [{ connectCheckout }, { defaultHostedAuthDeps }] = await Promise.all([import("../../hosted/account.js"), import("../../hosted-auth/session.js")]);
  const { client, target } = await connectCheckout(checkout, { resume }, hosted ?? { auth: defaultHostedAuthDeps(homedir()) });
  return { client, target, resume };
}

/**
 * The CLI error a history refusal means. `document_not_found` and `result_too_large` are this
 * command's own; a bundle the host no longer serves is the checkout's conflict, as sync reports
 * it; every other code goes through the hosted client's one translation.
 */
async function refusalError(refusal: HostedOperationRefusal, connection: Connection, checkout: CheckoutBinding, id: string, path: "list" | "seq"): Promise<unknown> {
  if (refusal.code === "document_not_found") {
    return new CliError("NOT_FOUND", `no document '${id}' on ${checkout.origin}`, {
      details: { host: checkout.origin, id, code: refusal.code },
      help: `${cliInvocation()} doc history ${commandToken(id)}`,
    });
  }
  if (refusal.code === "result_too_large") {
    return new CliError("RUNTIME", path === "list" ? `one page of the history of '${id}' is larger than a history read carries` : `version content of '${id}' is larger than a history read carries (1 MiB)`, {
      details: { host: checkout.origin, id, code: refusal.code, retryable: false },
      help:
        path === "list"
          ? `${cliInvocation()} doc history ${commandToken(id)} --limit 10`
          : `this version cannot be read from the CLI; the current version is ${cliInvocation()} doc read ${commandToken(id)}`,
    });
  }
  const [{ bundleGone }, { hostedFailure }] = await Promise.all([import("../../hosted/refusals.js"), import("../../hosted/client.js")]);
  if (refusal.code === "bundle_not_found") return bundleGone(checkout);
  return hostedFailure(new RemoteError(refusal.message, refusal.code, refusal.retryable ? 503 : 422), connection.target, connection.resume);
}

function row(version: HostedHistoryVersion): Record<string, unknown> {
  return {
    seq: version.seq,
    version: version.version,
    actor: version.actor,
    timestamp: version.timestamp,
    ...(version.agent === undefined ? {} : { agent: version.agent }),
  };
}

/** The host's chain, newest first: `limit` versions (0 = every one), never more than the ceiling. */
async function hostedList(connection: Connection, checkout: CheckoutBinding, id: string, limit: number, mode: OutputMode, stdout: (s: string) => void): Promise<void> {
  const { client } = connection;
  const wanted = Math.min(limit === 0 ? HOSTED_HISTORY_CEILING : limit, HOSTED_HISTORY_CEILING);
  const listing = await readHistoryListing(
    (request) => client.history(checkout.bundle_id, request),
    { documentId: id, wanted, pageSize: HISTORY_PAGE_LIMIT },
    { signal: client.signal },
  );
  if (listing.status === "moved") {
    throw new CliError("TRANSIENT", `'${id}' was deleted or recreated on ${checkout.origin} while its history was read`, {
      details: { host: checkout.origin, id, reason: "history_moved", retryable: true },
      help: "retry the same command",
    });
  }
  if (listing.status === "refused") throw await refusalError(listing.refusal, connection, checkout, id, "list");
  if (listing.status === "absent") {
    // Definitive empty state, as a local bundle answers a document it has never written.
    stdout(
      render(
        {
          id,
          count: 0,
          versions: [],
          help: [
            `no version history for '${id}' on ${checkout.origin}: the host has no such document; one created in this checkout has history once sync sends it`,
            `${cliInvocation()} sync --dir ${commandToken(checkout.path)}`,
          ],
        },
        mode,
      ),
    );
    return;
  }
  const { versions, total } = listing;
  const out: Record<string, unknown> = { id, count: total, versions: versions.map(row) };
  const truncated = versions.length < total;
  if (truncated) out.shown = versions.length;
  const help: string[] = [];
  if (truncated && versions.length === HOSTED_HISTORY_CEILING) {
    help.push(`showing the newest ${versions.length} of ${total} — a listing stops at ${HOSTED_HISTORY_CEILING}; read an older version with \`${cliInvocation()} doc history ${commandToken(id)} --seq <n>\``);
  } else if (truncated) {
    help.push(truncationHelp(id, versions.length, total));
  }
  // A document whose head exists with no rows of its own: its versions came in with an import.
  if (total === 0) help.push(`the host lists no versions for '${id}' (imported history is not served yet); its current version is \`${cliInvocation()} doc read ${commandToken(id)}\``);
  // No --expected-version line: the host's newest version is not this folder's compare-and-swap base.
  if (versions.length > 0) help.push(`${cliInvocation()} doc history ${commandToken(id)} --seq ${commandToken(String(versions[0]!.seq))}`);
  if (help.length > 0) out.help = help;
  stdout(render(out, mode));
}

/**
 * One version with its stored content. `--json` carries the row and the whole content; the
 * default record carries the row, the version's frontmatter and a bounded body preview (AXI: no
 * unbounded document on stdout), with the `--json` command as the complete-content channel.
 */
async function hostedVersion(connection: Connection, checkout: CheckoutBinding, id: string, seq: number, mode: OutputMode, stdout: (s: string) => void): Promise<void> {
  const answer = await connection.client.history(checkout.bundle_id, { documentId: id, limit: 1, before: seq + 1, includeContent: true });
  if (!answer.ok) throw await refusalError(answer.refusal, connection, checkout, id, "seq");
  const version = answer.page.versions[0];
  if (!version || version.seq !== seq) {
    throw new CliError("NOT_FOUND", `'${id}' has no version ${seq} on ${checkout.origin}`, {
      details: { host: checkout.origin, id, seq },
      help: `${cliInvocation()} doc history ${commandToken(id)}`,
    });
  }
  const content = version.content!;
  if (mode === "json") {
    stdout(render({ id, ...row(version), content }, mode));
    return;
  }
  const record: Record<string, unknown> = { id, ...row(version) };
  let body = content;
  try {
    const parsed = parseMarkdown(content, `${id} version ${seq}`);
    record.frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch {
    // Stored bytes that do not parse are shown whole, as the body.
  }
  attachBodyPreview(record, body, [`${cliInvocation()} doc history ${commandToken(id)} --seq ${commandToken(String(seq))} --json`]);
  stdout(render(record, mode));
}
