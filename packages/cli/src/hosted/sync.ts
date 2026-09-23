// `superbee sync` in a hosted checkout (slice C2 of the hosted client contract, sections 3.3 and
// 3.4): pull, per-document refresh and push of whole documents under the signed-in person's own
// grants, with no approval step.
//
// One run, under the checkout lock:
//   1. sign in (AUTH_REQUIRED passes through with its one link) and confirm the principal;
//   2. scan: each edited file becomes one whole-document intent in the private store, or is held;
//   3. pull: documents with no local intent are refreshed; the rest keep their base;
//   4. export: refreshed documents are placed in the folder, never over an edited file;
//   5. push: creates, then replaces, one identified request each, CAS-bound to the intent's base.
//
// Automatic merge happens only across different documents (Mike's frozen-scope rule, docs/core,
// 2026-09-22): a remote change to one document and a local change to another both land. Any
// concurrent change to one document comes back as a `conflict` row, whatever fields it touched,
// and is resolved explicitly with `--inspect` and `--resolve keep|take|revise`.
import { homedir } from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  ConflictReviewStaleError,
  inspectConflict,
  openLocalBundle,
  pull,
  push,
  reclaimInFlight,
  resolveConflict,
  resume,
  UNSETTLED_STATES,
  type ConflictChoice,
  type ConflictReview,
  type LocalBundle,
  type PullReport,
} from "@superbee/browser-local";
import { conceptIdFromPath, FilesystemMutationLockError, InvalidInputError, parseMarkdown, RemoteError, type JournaledBackend } from "@superbee/core";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { filesystemPushRoleLocks, PushRoleStaleOwnerError } from "@superbee/core/filesystem-push-role";
import {
  createWholeDocumentTransport,
  WHOLE_DOCUMENT_SETTLEMENT,
  type HostedCapabilities,
  type HostedReadAdapter,
} from "@superbee/core/hosted-transport";
import { JournalSnapshotConflict } from "@superbee/core/journaled-backend";
import { mintRequestId, type UncertainWriteOptions } from "@superbee/core/uncertain-write";

import { resolveLocalBundleTarget } from "../bundle.js";
import { parseSyncArgs } from "../commands/sync/orchestrate.js";
import { commandFragment, commandLiteral, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, resolveMode, type OutputMode } from "../output.js";
import { defaultHostedAuthDeps, ensureHostedAccessToken, type HostedAuthDeps } from "../hosted-auth/session.js";
import { resolveHostedTarget, type HostedTarget } from "../hosted-auth/discovery.js";
import { bindingForPath, checkoutBindingDigest, checkoutLockName, checkoutStoreDir, type CheckoutBinding } from "./binding.js";
import { createHostedSyncClient, hostedFailure } from "./client.js";
import { buildRows, BUSY_REFUSAL_CODES, countRows, receiptFailure, rowsFailure, type NotSentReason, type SyncRow } from "./sync-rows.js";
import { exportCheckout, readProjection, scanCheckout, unsendable, writeProjection, type ProjectionRecord } from "./sync-scan.js";
import { digestOf } from "./projection.js";

export const HOSTED_SYNC_USAGE = `In a hosted checkout (made by 'superbee checkout'), sync sends and receives whole documents:

Usage:
  superbee sync [--dir <folder>] [--limit <n>] [--json]
  superbee sync --inspect <id> [--out <file>] [--dir <folder>] [--json]
  superbee sync --resolve keep|take|revise --doc <id> [--dir <folder>] [--json]

Each edited file is sent as one whole document under your own access, with no approval step;
documents changed on the host are refreshed in the folder. A change to one document and a
change on the host to another both land. A document changed on both sides is never merged: it
comes back as a conflict row, and nothing is sent for it until you resolve it:
  --inspect <id>      show the base, your version and the host's version (--out <file> writes
                      the host's exact bytes)
  --resolve keep      send your version against the host's current one
  --resolve take      replace your version with the host's (remove the file first to discard
                      edits made since the conflict)
  --resolve revise    send the file as it is now: edit it to the result you want first
Rows are committed, conflict, held (sync cannot send the file: reserved files, conventions/ and
views/, a type change, a deleted file, a file over the host's bounds), refused, unknown (the
answer was lost; the next sync looks it up by the same request) and paused (sign-in, or your
sync quota for this bundle). The exit is 0 only when every row is committed: 5 when a row needs
your decision, 2 when the host refuses writes to the bundle, 1 for a pause or a lost answer, and
4 (AUTH_REQUIRED, with the sign-in link) when you must sign in.
`;

/** Rows shown by default; --limit changes it. */
const DEFAULT_ROW_LIMIT = 50;
/** Content shown per side by --inspect; --out writes the host's version whole. */
const INSPECT_PREVIEW_CHARS = 4000;
/** Push passes in one run: the first, and requeues after the host reported itself busy. */
const PUSH_PASSES = 3;

export interface HostedSyncDeps {
  stdout: (text: string) => void;
  auth: HostedAuthDeps;
  cwd: string;
  fetch?: typeof fetch;
  /** The uncertain-write timing (deadline, lookups, sleep); tests make it instant. */
  write?: Omit<UncertainWriteOptions, "settlement">;
  /** Wait between push passes; tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
  /** How long a second sync waits for the checkout lock before it reports sync_busy. */
  lockWaitMs?: number;
}

function hostedDeps(partial: Partial<HostedSyncDeps>): HostedSyncDeps {
  return {
    stdout: partial.stdout ?? ((text) => void process.stdout.write(text)),
    auth: partial.auth ?? defaultHostedAuthDeps(homedir()),
    cwd: partial.cwd ?? process.cwd(),
    ...(partial.fetch ? { fetch: partial.fetch } : {}),
    ...(partial.write ? { write: partial.write } : {}),
    ...(partial.sleep ? { sleep: partial.sleep } : {}),
    ...(partial.lockWaitMs !== undefined ? { lockWaitMs: partial.lockWaitMs } : {}),
  };
}

/** The `--dir` value in raw argv, in either spelling; malformed argv is left to the parser. */
function dirArgument(argv: readonly string[]): string | undefined {
  let dir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") break;
    if (token === "--dir") dir = argv[index + 1];
    else if (token.startsWith("--dir=")) dir = token.slice("--dir=".length);
  }
  return dir;
}

/**
 * The hosted checkout a sync invocation targets, or null for every other target (a Git board, a
 * plain folder, or nothing resolvable, which the Git sync reports itself). The folder is found the
 * way every other command finds its bundle, and also by its own real path, so a checkout without a
 * root index and a symlinked `--dir` both resolve.
 */
export async function hostedCheckoutFor(argv: readonly string[], home: string = homedir(), cwd: string = process.cwd()): Promise<CheckoutBinding | null> {
  const dir = dirArgument(argv);
  const candidates: string[] = [];
  try {
    candidates.push((await resolveLocalBundleTarget(dir, cwd)).canonicalRoot);
  } catch {
    // Not a local bundle; the folder's own path is still checked below.
  }
  try {
    candidates.push(await fs.realpath(path.resolve(cwd, dir ?? ".")));
  } catch {
    // Nothing there.
  }
  for (const candidate of candidates) {
    const binding = await bindingForPath(home, candidate).catch(() => null);
    if (binding) return binding;
  }
  return null;
}

/** True when raw argv asks for a hosted-only verb. */
export function requestsHostedVerb(argv: readonly string[]): boolean {
  return argv.some((token) => token === "--inspect" || token.startsWith("--inspect=") || token === "--resolve" || token.startsWith("--resolve=") || token === "--doc" || token.startsWith("--doc="));
}

const GIT_ONLY_FLAGS = ["establish", "pull-only", "show-incoming", "yes", "body-out", "migrate"] as const;

interface HostedValues {
  inspect?: string;
  resolve?: string;
  doc?: string;
  out?: string;
  limit?: string;
  json?: boolean;
}

function parseHosted(argv: string[]): HostedValues {
  const { values } = parseSyncArgs(argv);
  const inv = cliInvocation();
  for (const flag of GIT_ONLY_FLAGS) {
    if ((values as Record<string, unknown>)[flag] !== undefined) {
      throw new CliError("USAGE", `--${flag} is for a Git board; a hosted checkout syncs with plain 'sync'`, { help: `${inv} sync --help` });
    }
  }
  if (values.inspect !== undefined && values.resolve !== undefined) {
    throw new CliError("USAGE", "--inspect and --resolve are separate steps", { help: `${inv} sync --inspect <id>` });
  }
  if (values.resolve !== undefined && values.doc === undefined) {
    throw new CliError("USAGE", "--resolve needs --doc <id>", { help: `${inv} sync --resolve ${commandToken(values.resolve)} --doc <id>` });
  }
  if (values.doc !== undefined && values.resolve === undefined) {
    throw new CliError("USAGE", "--doc names the document for --resolve", { help: `${inv} sync --resolve keep|take|revise --doc ${commandToken(values.doc)}` });
  }
  if (values.out !== undefined && values.inspect === undefined) {
    throw new CliError("USAGE", "--out writes the host's version for --inspect", { help: `${inv} sync --inspect <id> --out <file>` });
  }
  if (values.resolve !== undefined && !["keep", "take", "revise"].includes(values.resolve)) {
    throw new CliError("USAGE", `--resolve takes keep, take or revise, not '${values.resolve}'`, { help: `${inv} sync --resolve keep|take|revise --doc <id>` });
  }
  return values;
}

function rowLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_ROW_LIMIT;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new CliError("USAGE", `--limit takes a positive integer, not '${value}'`, { help: `${cliInvocation()} sync --limit 200` });
  return limit;
}

/** The document id a person typed: a concept id, or the file path of one. */
function documentId(input: string): string {
  return conceptIdFromPath(input.trim());
}

function syncCommand(binding: CheckoutBinding, extra: CommandText = commandFragment``): CommandText {
  return commandFragment`${cliInvocation()} sync --dir ${commandToken(binding.path)}${extra}`;
}

/** Everything one hosted verb needs once the lock is held, the person is signed in and the store is open. */
interface Session {
  readonly binding: CheckoutBinding;
  readonly target: HostedTarget;
  readonly reader: HostedReadAdapter;
  readonly capabilities: HostedCapabilities;
  readonly carrier: ReturnType<typeof createHostedSyncClient>["carrier"];
  readonly routes: string;
  readonly store: FileJournaledBackend;
  readonly local: LocalBundle;
  readonly okfVersion: "0.1" | "0.2" | undefined;
  readonly projection: ProjectionRecord;
}

function bundleGone(binding: CheckoutBinding, unsent: number): CliError {
  return new CliError(
    "CONFLICT",
    `hosted bundle '${binding.bundle_id}' is no longer served to you on ${binding.origin}: it was deleted there, or your access was removed`,
    {
      details: { reason: "bundle_deleted_remotely", bundle_id: binding.bundle_id, host: binding.origin, folder: binding.path, unsent_changes: unsent },
      help: `your files stay in ${binding.path}; to keep them as a plain folder: ${cliInvocation()} checkout --release ${commandToken(binding.path)}`,
    },
  );
}

/** A read-side failure in CLI terms: a bundle the host no longer serves is a conflict with the checkout. */
function readFailure(error: unknown, session: Pick<Session, "binding" | "target">, resumeCommand: CommandText, unsent: number): unknown {
  if (error instanceof RemoteError && (error.code === "bundle_not_found" || error.status === 404)) return bundleGone(session.binding, unsent);
  return hostedFailure(error, session.target, resumeCommand);
}

function lockFailure(error: unknown, folder: string): unknown {
  if (error instanceof PushRoleStaleOwnerError || error instanceof FilesystemMutationLockError) {
    return new CliError("CONFLICT", `another command holds the checkout lock for ${folder}`, {
      details: { reason: "sync_busy", folder, lock: error.lockPath, retryable: true },
      help: `wait for it to finish, then retry; if no superbee command is using ${folder}, remove ${error.lockPath}`,
    });
  }
  return error;
}

async function storeOkfVersion(store: JournaledBackend): Promise<"0.1" | "0.2" | undefined> {
  const root = await store.readReserved("", "index.md");
  if (!root) return undefined;
  try {
    const version = parseMarkdown(root.content, "index").frontmatter.okf_version;
    return version === "0.1" || version === "0.2" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run `body` under the checkout lock with the person signed in, the principal confirmed, the
 * host's capabilities read and the private store open. The projection record is written back
 * whatever happens after it was read, so a journaled edit is never scanned twice.
 */
async function withSession<T>(binding: CheckoutBinding, deps: HostedSyncDeps, resumeCommand: CommandText, body: (session: Session) => Promise<T>): Promise<T> {
  const target = resolveHostedTarget(binding.audience);
  if (target.origin !== binding.origin) throw new CliError("RUNTIME", `the checkout binding for ${binding.path} is inconsistent`, { help: `${cliInvocation()} checkout --release ${commandToken(binding.path)}` });
  const locks = filesystemPushRoleLocks(deps.lockWaitMs !== undefined ? { waitMs: deps.lockWaitMs } : {});
  return locks
    .request(checkoutLockName(binding.path), {}, async () => {
      // Sign-in first: AUTH_REQUIRED passes through unchanged with its one link, before any request.
      const token = await ensureHostedAccessToken(target, { resume: resumeCommand }, deps.auth);
      const client = createHostedSyncClient({
        target,
        accessToken: token.accessToken,
        resume: resumeCommand,
        ...(binding.workspace !== null ? { workspace: binding.workspace } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      const identity = await client.whoami();
      if (identity.principalId !== binding.principal_id) {
        throw new CliError("FORBIDDEN", `you are signed in to ${binding.origin} as another person than the one this checkout belongs to`, {
          details: { reason: "other_principal", folder: binding.path, checkout_principal: binding.principal_id, signed_in_principal: identity.principalId },
          help: `sign in as the checkout's person (${cliInvocation()} login --host ${commandToken(binding.origin)}), or check the bundle out again for yourself in a new folder`,
        });
      }
      const reader = client.reader(binding.bundle_id);
      const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(deps.auth.home, binding.checkout_id) });
      let projection: ProjectionRecord | undefined;
      try {
        const local = openLocalBundle(binding.checkout_id, { backend: store });
        const unsent = async () => (await store.listIntents(UNSETTLED_STATES)).length;
        let capabilities: HostedCapabilities;
        try {
          capabilities = await reader.hostedCapabilities();
        } catch (error) {
          throw readFailure(error, { binding, target }, resumeCommand, await unsent());
        }
        projection = await readProjection(deps.auth.home, binding.checkout_id, store);
        return await body({
          binding,
          target,
          reader,
          capabilities,
          carrier: client.carrier,
          routes: client.prefix,
          store,
          local,
          okfVersion: await storeOkfVersion(store),
          projection,
        });
      } finally {
        try {
          if (projection) await writeProjection(deps.auth.home, binding.checkout_id, projection);
        } finally {
          await store.close();
        }
      }
    })
    .catch((error: unknown) => {
      throw lockFailure(error, binding.path);
    });
}

/** Push with creates first, then replaces, each in journal order (new link targets exist first). */
function createsFirst(store: JournaledBackend): JournaledBackend {
  return new Proxy(store, {
    get(inner, prop) {
      if (prop === "listIntents") {
        return async (state?: Parameters<JournaledBackend["listIntents"]>[0]) => {
          const rows = await inner.listIntents(state);
          return state === "pending" ? [...rows.filter((row) => row.base === null), ...rows.filter((row) => row.base !== null)] : rows;
        };
      }
      const value = Reflect.get(inner, prop, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}

/**
 * Requeue, under a fresh identity, each change the host refused only because it was busy (a
 * recorded `concurrent_change` after its own retries, or a transient refusal). The recorded
 * identity can only ever answer that refusal again, so a new one is the only way to resend it.
 * Only a refusal that heads nothing is requeued; the document's bytes are rewritten unchanged.
 */
async function requeueBusy(store: JournaledBackend): Promise<number> {
  let requeued = 0;
  const unsettled = await store.listIntents(UNSETTLED_STATES);
  for (const row of unsettled) {
    if (row.state !== "refused" || !row.refusal || !BUSY_REFUSAL_CODES.has(row.refusal.code)) continue;
    if (unsettled.some((other) => other.after === row.requestId)) continue;
    const current = await store.readWithJournal(row.target);
    const latest = current.intents.filter((intent) => intent.state !== "acknowledged").at(-1);
    if (!current.document || latest?.requestId !== row.requestId) continue;
    await store.writeJournaled(row.target, current.document.doc, {
      expectedVersion: current.document.version,
      intent: {
        requestId: mintRequestId(),
        kind: "document.write",
        target: row.target,
        base: row.base,
        baseContent: row.baseContent,
        createdAt: new Date().toISOString(),
        ...(row.after !== undefined ? { after: row.after } : {}),
      },
      supersede: { requestId: row.requestId, expectedState: "refused", expectedAttempts: row.attempts },
    });
    requeued += 1;
  }
  return requeued;
}

interface PushOutcome {
  readonly acknowledged: Map<string, string>;
  readonly signInRequired: boolean;
  readonly notSent: NotSentReason;
}

async function pushChanges(session: Session, deps: HostedSyncDeps): Promise<PushOutcome> {
  const { store, local, binding, reader } = session;
  const acknowledged = new Map<string, string>();
  const pending = await store.listIntents("pending");
  const refused = await store.listIntents("refused");
  if (pending.length === 0 && refused.length === 0) return { acknowledged, signInRequired: false, notSent: null };
  // A bundle whose host serves no identified writes refuses every one: say so without sending.
  if (!session.capabilities.operations) return { acknowledged, signInRequired: false, notSent: "read_only" };
  // Running sync is the person's decision to retry: a pause from an earlier run (sign-in, quota,
  // a withdrawn grant) is lifted and its refused changes are requeued under their identities.
  await resume(local);
  const transport = createWholeDocumentTransport({
    carrier: session.carrier,
    bundleId: binding.bundle_id,
    binding: checkoutBindingDigest(binding.checkout_id),
    intentFor: (requestId) => store.readIntent(requestId),
    remote: reader,
    routes: { create: `${session.routes}/create`, replace: `${session.routes}/replace`, outcome: `${session.routes}/outcome` },
    ...(session.okfVersion ? { okfVersion: session.okfVersion } : {}),
  });
  const ordered = createsFirst(store);
  let signInRequired = false;
  for (let pass = 0; pass < PUSH_PASSES; pass += 1) {
    const report = await push(ordered, transport, { remote: reader, write: { ...deps.write, settlement: WHOLE_DOCUMENT_SETTLEMENT } });
    for (const settled of report.settled) {
      if (settled.state !== "acknowledged") continue;
      const row = await store.readIntent(settled.requestId);
      acknowledged.set(settled.target, row?.acknowledgedVersion ?? "");
    }
    if (report.paused) {
      const control = await store.readMeta<{ reason?: string }>("sync");
      signInRequired = /^(AUTH_REQUIRED|UNAUTHORIZED)\b/.test(control?.reason ?? "");
      break;
    }
    if (pass === PUSH_PASSES - 1 || (await requeueBusy(store)) === 0) break;
    await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(50 + Math.floor(Math.random() * 200));
  }
  return { acknowledged, signInRequired, notSent: null };
}

function pulledView(report: PullReport | null, placed: string[], removed: string[], kept: string[]): Record<string, unknown> {
  return {
    refreshed: placed.length,
    removed: removed.length,
    ...(kept.length > 0 ? { kept_local_edits: kept.slice(0, 20) } : {}),
    ...(report?.refused
      ? {
          refused_deletions: {
            reason: report.refused.reason,
            count: report.refused.deletions,
            message: "the host's listing would remove too many documents at once, so none were removed; check the bundle in the Superbee app",
          },
        }
      : {}),
  };
}

function rowHelp(rows: readonly SyncRow[], binding: CheckoutBinding): string[] {
  const help: string[] = [];
  const firstConflict = rows.find((row) => row.state === "conflict");
  if (firstConflict) help.push(`${cliInvocation()} sync --inspect ${commandToken(firstConflict.id)} --dir ${commandToken(binding.path)}`);
  if (rows.some((row) => row.state === "paused" || row.state === "unknown")) help.push(syncCommand(binding));
  if (rows.some((row) => row.state === "held" || (row.state === "refused" && row.reason !== "read_only"))) {
    help.push(`edit or restore the files named in the held and refused rows, then: ${syncCommand(binding)}`);
  }
  return help;
}

async function runSync(binding: CheckoutBinding, values: HostedValues, deps: HostedSyncDeps, mode: OutputMode): Promise<void> {
  const limit = rowLimit(values.limit);
  const resumeCommand = syncCommand(binding, values.json ? commandLiteral(" --json") : commandFragment``);
  let failure: CliError | null = null;
  const receipt = await withSession(binding, deps, resumeCommand, async (session) => {
    const { store, local, reader, projection } = session;
    // An earlier run that died mid-push left its claims in flight; this run holds the lock, so no
    // push is live, and each such change is looked up before it is ever sent again.
    await reclaimInFlight(local);
    const scan = await scanCheckout({ folder: binding.path, bundleId: binding.bundle_id, okfVersion: session.okfVersion, local, projection });
    let pulled: PullReport;
    try {
      pulled = await pull(local, reader);
    } catch (error) {
      throw readFailure(error, session, resumeCommand, (await store.listIntents(UNSETTLED_STATES)).length);
    }
    const exported = await exportCheckout(binding.path, store, projection);
    let outcome: PushOutcome;
    try {
      outcome = await pushChanges(session, deps);
    } catch (error) {
      throw readFailure(error, session, resumeCommand, (await store.listIntents(UNSETTLED_STATES)).length);
    }
    const rows = buildRows({
      unsettled: await store.listIntents(UNSETTLED_STATES),
      acknowledged: outcome.acknowledged,
      held: scan.held,
      notSent: outcome.notSent,
    });
    const counts = countRows(rows);
    const shown = rows.slice(0, limit);
    const record: Record<string, unknown> = {
      sync: "hosted",
      bundle_id: binding.bundle_id,
      host: binding.origin,
      folder: binding.path,
      status: rows.every((row) => row.state === "committed") ? (rows.length === 0 ? "up_to_date" : "synced") : "incomplete",
      pulled: pulledView(pulled, exported.placed, exported.removed, exported.kept),
      counts,
      rows: shown,
      ...(shown.length < rows.length ? { rows_shown: shown.length, rows_total: rows.length, rows_all: syncCommand(binding, commandFragment` --limit ${commandToken(String(rows.length))}`) } : {}),
      help: rowHelp(rows, binding),
    };
    if (outcome.signInRequired) {
      failure = new CliError("AUTH_REQUIRED", `${binding.origin} ended the hosted session during sync; the changes not sent are kept`, {
        details: { host: binding.origin, audience: binding.audience, resume: resumeCommand, counts, rows: shown },
        help: `${cliInvocation()} login --host ${commandToken(binding.origin)}, then re-run: ${resumeCommand}`,
      });
      return null;
    }
    const exit = rowsFailure(rows);
    if (exit) failure = receiptFailure(exit, { counts });
    return record;
  });
  if (receipt) deps.stdout(render(receipt, mode));
  if (failure) throw failure;
}

function preview(content: string | null): { content: string | null; truncated: boolean; chars: number } {
  if (content === null) return { content: null, truncated: false, chars: 0 };
  return { content: content.length > INSPECT_PREVIEW_CHARS ? content.slice(0, INSPECT_PREVIEW_CHARS) : content, truncated: content.length > INSPECT_PREVIEW_CHARS, chars: content.length };
}

/** The conflict on one document, or the CLI error that says why there is none to inspect. */
async function reviewFor(session: Session, id: string, resumeCommand: CommandText): Promise<ConflictReview> {
  try {
    return await inspectConflict(session.local, session.reader, id);
  } catch (error) {
    if (error instanceof InvalidInputError || error instanceof JournalSnapshotConflict) {
      const intents = (await session.store.readWithJournal(id)).intents.filter((row) => row.state !== "acknowledged");
      throw new CliError("NOT_FOUND", `'${id}' has no conflict to resolve in this checkout`, {
        details: { id, folder: session.binding.path, states: intents.map((row) => row.state) },
        help: syncCommand(session.binding),
      });
    }
    throw readFailure(error, session, resumeCommand, 0);
  }
}

async function runInspect(binding: CheckoutBinding, values: HostedValues, deps: HostedSyncDeps, mode: OutputMode): Promise<void> {
  const id = documentId(values.inspect!);
  const resumeCommand = commandFragment`${cliInvocation()} sync --inspect ${commandToken(id)} --dir ${commandToken(binding.path)}`;
  const out = values.out === undefined ? undefined : path.resolve(deps.cwd, values.out);
  if (out !== undefined && (out === binding.path || out.startsWith(`${binding.path}${path.sep}`))) {
    throw new CliError("USAGE", "--out must be outside the checkout folder, or the file would be synced as a document", { help: `${resumeCommand} --out <file outside the folder>` });
  }
  const record = await withSession(binding, deps, resumeCommand, async (session) => {
    const review = await reviewFor(session, id, resumeCommand);
    const deleted = review.remote.version === null;
    if (out !== undefined) {
      if (review.remote.content === null) throw new CliError("NOT_FOUND", `the host has no version of '${id}' to write: it was deleted there`, { details: { id } });
      await fs.writeFile(out, review.remote.content);
    }
    const doc = commandToken(id);
    const dir = commandToken(binding.path);
    return {
      conflict: id,
      file: path.join(binding.path, `${id}.md`),
      reason: deleted ? "deleted_remotely" : "changed_remotely",
      base: { version: review.base.version, ...preview(review.base.content) },
      local: { version: review.local.version, ...preview(review.local.content) },
      remote: { version: review.remote.version, ...preview(review.remote.content) },
      ...(out !== undefined ? { remote_written_to: out } : {}),
      choices: {
        keep: deleted ? "send your version, re-creating the document on the host" : "send your version against the host's current one",
        take: deleted ? "accept the deletion: the file is removed" : "replace your version with the host's",
        revise: "edit the file to the result you want, then send it as it is",
      },
      help: [
        `${cliInvocation()} sync --resolve keep --doc ${doc} --dir ${dir}`,
        `${cliInvocation()} sync --resolve take --doc ${doc} --dir ${dir}`,
        `${cliInvocation()} sync --resolve revise --doc ${doc} --dir ${dir}`,
      ],
    };
  });
  deps.stdout(render(record, mode));
}

async function readIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function runResolve(binding: CheckoutBinding, values: HostedValues, deps: HostedSyncDeps, mode: OutputMode): Promise<void> {
  const id = documentId(values.doc!);
  const choice = values.resolve as "keep" | "take" | "revise";
  const resumeCommand = commandFragment`${cliInvocation()} sync --resolve ${commandToken(choice)} --doc ${commandToken(id)} --dir ${commandToken(binding.path)}`;
  const record = await withSession(binding, deps, resumeCommand, async (session) => {
    const { projection, store, local, reader } = session;
    const file = path.join(binding.path, `${id}.md`);
    const bytes = await readIfPresent(file);
    const entry = projection.files[id];
    const edited = bytes !== null && digestOf(bytes) !== entry?.digest;
    if (choice !== "revise" && edited) {
      throw new CliError("CONFLICT", `${file} has edits made since the conflict, which '${choice}' would ${choice === "keep" ? "not send" : "discard"}`, {
        details: { reason: "file_edited", id, file },
        help: choice === "keep"
          ? `${cliInvocation()} sync --resolve revise --doc ${commandToken(id)} --dir ${commandToken(binding.path)} (sends the file as it is now)`
          : `remove ${file} to discard your edits, then re-run: ${resumeCommand}`,
      });
    }
    if (choice === "keep" && bytes === null) {
      throw new CliError("CONFLICT", `${file} was deleted, so there is no version of yours to keep`, {
        details: { reason: "file_deleted", id, file },
        help: `${cliInvocation()} sync --resolve take --doc ${commandToken(id)} --dir ${commandToken(binding.path)}`,
      });
    }
    let selected: ConflictChoice;
    if (choice === "revise") {
      if (bytes === null) throw new CliError("NOT_FOUND", `${file} does not exist; write the revised document there first`, { details: { id, file } });
      const stored = await store.readWithJournal(id);
      const held = unsendable(id, `${id}.md`, bytes, stored.document?.doc ?? null, { bundleId: binding.bundle_id, okfVersion: session.okfVersion });
      if (held) {
        throw new CliError("CONFLICT", `${file} cannot be sent: ${held.message}`, { details: { reason: held.reason, id, file }, help: `edit ${file}, then re-run: ${resumeCommand}` });
      }
      const parsed = parseMarkdown(bytes.toString("utf8"), id, { okfVersion: session.okfVersion });
      selected = { kind: "revise", frontmatter: parsed.frontmatter, body: parsed.body };
    } else selected = { kind: choice === "keep" ? "keep-local" : "take-remote" };
    const review = await reviewFor(session, id, resumeCommand);
    let result;
    try {
      result = await resolveConflict(local, reader, review, selected);
    } catch (error) {
      if (error instanceof ConflictReviewStaleError) {
        throw new CliError("CONFLICT", `the conflict on '${id}' changed while resolving it`, {
          details: { reason: "stale_review", id },
          help: `${cliInvocation()} sync --inspect ${commandToken(id)} --dir ${commandToken(binding.path)}`,
        });
      }
      if (error instanceof InvalidInputError) {
        throw new CliError("CONFLICT", `${file} is not a valid document: ${error.message}`, { details: { reason: "not_sendable", id, file }, help: `edit ${file}, then re-run: ${resumeCommand}` });
      }
      throw readFailure(error, session, resumeCommand, 0);
    }
    let fileState = "unchanged";
    if (choice === "take") {
      const exported = await exportCheckout(binding.path, store, projection, { only: new Set([id]), placeMissing: true });
      fileState = exported.removed.length > 0 ? "removed" : exported.placed.length > 0 ? "replaced" : exported.kept.length > 0 ? "kept" : "unchanged";
    } else if (result.version !== null) {
      projection.files[id] = { digest: digestOf(bytes!), version: result.version };
    }
    return {
      resolved: id,
      choice,
      file,
      file_state: fileState,
      next: choice === "take" ? "nothing to send for this document" : "the next sync sends it against the host's current version",
      help: choice === "take" ? [] : [syncCommand(binding)],
    };
  });
  deps.stdout(render(record, mode));
}

/** `superbee sync` in a hosted checkout: sync, `--inspect`, or `--resolve`. */
export async function hostedSync(argv: string[], binding: CheckoutBinding, partial: Partial<HostedSyncDeps> = {}): Promise<void> {
  const deps = hostedDeps(partial);
  const values = parseHosted(argv);
  const mode = resolveMode(values);
  if (values.inspect !== undefined) return runInspect(binding, values, deps, mode);
  if (values.resolve !== undefined) return runResolve(binding, values, deps, mode);
  return runSync(binding, values, deps, mode);
}
