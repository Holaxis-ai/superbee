import { renderUsage } from "../../output.js";
// `doc history <id>` — see `../doc.ts`'s header comment for the CAS-token / attribution rationale.
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { docVersions, type VersionInfo } from "@superbee/core";
import { openBundle, resolveRemoteFlag } from "../../bundle.js";
import { CliError } from "../../errors.js";
import { parseLeafOrUsage } from "../../args.js";
import { CLI_LEAVES } from "../../command-spec.js";
import { render, resolveMode, type OutputMode } from "../../output.js";
import { cliInvocation } from "../../invocation.js";
import { conceptIdFromCliArgument, resolveConceptIdCliArgument } from "../../concept-id.js";
import { DOC_HISTORY_USAGE, HOSTED_HISTORY_CEILING, type DocCliDeps, type DocHostedDeps, readErrorToCliError } from "./common.js";
import { commandFragment, commandToken, type CommandText } from "../../command-text.js";
import { hostedCheckoutAt } from "../../autopull.js";
import type { CheckoutBinding } from "../../hosted/binding.js";
import type { HostedSyncClient } from "../../hosted/client.js";
import type { HostedHistoryRefusal, HostedHistoryVersion } from "@superbee/core/hosted-transport";

/**
 * AXI unbounded-output guard (same class as `list`/`status`/`blobs`'s row cap): a history-keeping
 * backend can return an arbitrarily long version chain, so `doc history` bounds it like every other
 * list-shaped command does. 20 (not `list`'s 100) matches `status`/`sync`'s "per-item finding list"
 * default rather than `list`'s "whole-bundle scan" default — a single doc's version chain is closer
 * in spirit to those than to a bundle-wide query. `--limit 0` is the escape (all versions), mirroring
 * every other capped command's 0-means-unlimited convention.
 */
const DEFAULT_LIMIT = 20;
/** Versions one hosted history request asks for (the host's page cap). */
const HOSTED_PAGE = 100;

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
    const client = await hostedClient(checkout, deps.hosted, resume);
    if (seq !== undefined) {
      await hostedVersion(client, checkout, id, seq, mode, stdout);
      return;
    }
    await hostedList(client, checkout, id, limit, mode, stdout);
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

/** A client for the checkout's host, signed in as the checkout's own person (as `export` checks it). */
async function hostedClient(checkout: CheckoutBinding, hosted: DocHostedDeps | undefined, resume: CommandText): Promise<HostedSyncClient> {
  // Loaded only in a hosted checkout, so an ordinary history never loads the hosted modules.
  const [{ resolveHostedTarget }, { defaultHostedAuthDeps, ensureHostedAccessToken, hostArgument }, { createHostedSyncClient }] = await Promise.all([
    import("../../hosted-auth/discovery.js"),
    import("../../hosted-auth/session.js"),
    import("../../hosted/client.js"),
  ]);
  const target = resolveHostedTarget(checkout.audience);
  if (target.origin !== checkout.origin) {
    throw new CliError("RUNTIME", `the checkout binding for ${checkout.path} is inconsistent`, { help: `${cliInvocation()} checkout --release ${commandToken(checkout.path)}` });
  }
  const auth = hosted?.auth ?? defaultHostedAuthDeps(homedir());
  const token = await ensureHostedAccessToken(target, { resume }, auth);
  const client = createHostedSyncClient({
    target,
    accessToken: token.accessToken,
    resume,
    ...(checkout.workspace !== null ? { workspace: checkout.workspace } : {}),
    ...(hosted?.fetch ? { fetch: hosted.fetch } : {}),
  });
  const identity = await client.whoami();
  if (identity.principalId !== checkout.principal_id) {
    throw new CliError("FORBIDDEN", `the checkout at ${checkout.path} was made by another hosted identity than the one signed in`, {
      details: { reason: "other_principal", folder: checkout.path, checkout_principal: checkout.principal_id, signed_in_principal: identity.principalId },
      help: `${cliInvocation()} login --host ${commandToken(hostArgument(target))}`,
    });
  }
  return client;
}

/** The CLI error a history refusal means; `document_not_found` is the caller's to decide. */
function refusalError(refusal: HostedHistoryRefusal, checkout: CheckoutBinding, id: string): CliError {
  const details = { host: checkout.origin, bundle_id: checkout.bundle_id, id, code: refusal.code };
  if (refusal.code === "document_not_found") {
    return new CliError("NOT_FOUND", `no document '${id}' on ${checkout.origin}`, { details, help: `${cliInvocation()} doc history ${commandToken(id)}` });
  }
  if (refusal.code === "bundle_not_found" || refusal.code === "insufficient_scope" || refusal.code === "access_denied") {
    return new CliError("FORBIDDEN", `${checkout.origin} refused to read '${checkout.bundle_id}' (${refusal.code})`, { details, help: `${cliInvocation()} whoami --host ${commandToken(checkout.origin)}` });
  }
  if (refusal.code === "result_too_large") {
    return new CliError("RUNTIME", `the history of '${id}' is larger than one history read carries`, {
      details: { ...details, retryable: false },
      help: "the version's content is over 1 MiB; open it in the Superbee app",
    });
  }
  if (refusal.retryable) {
    return new CliError("TRANSIENT", `${checkout.origin} could not read the history of '${id}' (${refusal.code})`, { details: { ...details, retryable: true }, help: "retry the same command" });
  }
  return new CliError("RUNTIME", `${checkout.origin} refused the history of '${id}' (${refusal.code})`, { details });
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

/** How many times a paged listing starts again from the first page when the chain moved under it. */
const LISTING_ATTEMPTS = 3;

type Listing = { versions: HostedHistoryVersion[]; total: number } | "absent" | "moved";

/**
 * One reading of the newest `wanted` versions, paged back with `before`. Older versions never
 * change, but a write, or a delete and recreate (a new lineage whose seq restarts), can land
 * between pages; a listing of more than one page is checked against a fresh first page, and any
 * difference in the total or the newest version is "moved": the pages are never merged across it.
 */
async function readListing(client: HostedSyncClient, checkout: CheckoutBinding, id: string, wanted: number): Promise<Listing> {
  const versions: HostedHistoryVersion[] = [];
  let total = 0;
  let before: number | undefined;
  for (;;) {
    const size = Math.min(HOSTED_PAGE, wanted - versions.length);
    const answer = await client.history(checkout.bundle_id, { documentId: id, limit: size, ...(before === undefined ? {} : { before }) });
    if (!answer.ok) {
      // Absent on the first page is the answer; absent on a later one, the document was deleted meanwhile.
      if (answer.refusal.code === "document_not_found") return before === undefined ? "absent" : "moved";
      throw refusalError(answer.refusal, checkout, id);
    }
    const { page } = answer;
    if (before === undefined) total = page.total!;
    versions.push(...page.versions);
    if (!page.more || versions.length >= wanted) break;
    before = page.versions.at(-1)!.seq;
  }
  if (before === undefined) return { versions, total };
  const check = await client.history(checkout.bundle_id, { documentId: id, limit: 1 });
  if (!check.ok) {
    if (check.refusal.code === "document_not_found") return "moved";
    throw refusalError(check.refusal, checkout, id);
  }
  const newest = check.page.versions[0];
  if (check.page.total !== total || newest?.seq !== versions[0]?.seq || newest?.version !== versions[0]?.version) return "moved";
  return { versions, total };
}

/** The host's chain, newest first: `limit` versions (0 = every one up to the ceiling). */
async function hostedList(client: HostedSyncClient, checkout: CheckoutBinding, id: string, limit: number, mode: OutputMode, stdout: (s: string) => void): Promise<void> {
  const wanted = limit === 0 ? HOSTED_HISTORY_CEILING : limit;
  let listing: Listing = "moved";
  for (let attempt = 1; attempt <= LISTING_ATTEMPTS && listing === "moved"; attempt += 1) listing = await readListing(client, checkout, id, wanted);
  if (listing === "moved") {
    throw new CliError("TRANSIENT", `the history of '${id}' changed on ${checkout.origin} while it was read, ${LISTING_ATTEMPTS} times`, {
      details: { host: checkout.origin, id, reason: "history_moved", retryable: true },
      help: `retry the same command, or read fewer versions at once (${cliInvocation()} doc history ${commandToken(id)} --limit 100)`,
    });
  }
  if (listing === "absent") {
    // Definitive empty state, as a local bundle answers a document it has never written.
    stdout(
      render(
        {
          id,
          count: 0,
          versions: [],
          help: `no version history for '${id}' on ${checkout.origin} — the host has no such document (one created in this checkout has history once \`${cliInvocation()} sync\` sends it)`,
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
  if (truncated && limit === 0) {
    help.push(`showing the newest ${versions.length} of ${total} — the listing stops at ${HOSTED_HISTORY_CEILING}; read an older version with \`${cliInvocation()} doc history ${commandToken(id)} --seq <n>\``);
  } else if (truncated) {
    help.push(truncationHelp(id, versions.length, total));
  }
  // No --expected-version line: the host's newest version is not this folder's compare-and-swap base.
  if (versions.length > 0) help.push(`${cliInvocation()} doc history ${commandToken(id)} --seq ${commandToken(String(versions[0]!.seq))}`);
  if (help.length > 0) out.help = help;
  stdout(render(out, mode));
}

/** One version with its stored content: the row and the content with --json, the content alone otherwise. */
async function hostedVersion(client: HostedSyncClient, checkout: CheckoutBinding, id: string, seq: number, mode: OutputMode, stdout: (s: string) => void): Promise<void> {
  const answer = await client.history(checkout.bundle_id, { documentId: id, limit: 1, before: seq + 1, includeContent: true });
  if (!answer.ok) throw refusalError(answer.refusal, checkout, id);
  const version = answer.page.versions[0];
  if (!version || version.seq !== seq) {
    throw new CliError("NOT_FOUND", `'${id}' has no version ${seq} on ${checkout.origin}`, {
      details: { host: checkout.origin, id, seq },
      help: `${cliInvocation()} doc history ${commandToken(id)}`,
    });
  }
  if (mode === "json") {
    stdout(render({ id, ...row(version), content: version.content! }, mode));
    return;
  }
  stdout(version.content!);
}
