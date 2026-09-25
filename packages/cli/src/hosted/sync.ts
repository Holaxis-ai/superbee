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
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import {
  baseKey,
  commitLocal,
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
  type DeletionRefusal,
  type LocalBundle,
  type PullReport,
} from "@superbee/browser-local";
import { assertSafeConceptId, conceptIdFromPath, FilesystemMutationLockError, InvalidInputError, parseMarkdown, RemoteError, type JournaledBackend } from "@superbee/core";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { filesystemPushRoleLocks, PushRoleStaleOwnerError } from "@superbee/core/filesystem-push-role";
import {
  createWholeDocumentTransport,
  WHOLE_DOCUMENT_SETTLEMENT,
  type HostedCapabilities,
  type HostedCarrier,
  type HostedReadAdapter,
} from "@superbee/core/hosted-transport";
import { DELETION_VERSION, DOCUMENT_DELETE_KIND, JournalSnapshotConflict, type NewIntentRecord } from "@superbee/core/journaled-backend";
import { mintRequestId, type UncertainWriteOptions } from "@superbee/core/uncertain-write";

import { resolveLocalBundleTarget } from "../bundle.js";
import { parseSyncArgs } from "../commands/sync/orchestrate.js";
import { commandFragment, commandLiteral, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, resolveMode, type OutputMode } from "../output.js";
import { ACCESS_TOKEN_ENV, defaultHostedAuthDeps, ensureHostedAccessToken, readSession, SignedOutError, type HostedAuthDeps } from "../hosted-auth/session.js";
import { resolveHostedTarget, type HostedTarget } from "../hosted-auth/discovery.js";
import { bindingForPath, checkoutBindingDigest, checkoutLockName, checkoutStoreDir, type CheckoutBinding } from "./binding.js";
import { createHostedSyncClient, hostedFailure } from "./client.js";
import { buildRows, BUSY_REFUSAL_CODES, countRows, receiptFailure, rowsFailure, type NotSentReason, type SyncRow } from "./sync-rows.js";
import {
  exportCheckout,
  folderConflictFor,
  folderConflicts,
  inboundLinks,
  folderMatchesProjection,
  readProjection,
  removeGuarded,
  scanCheckout,
  unsendable,
  writeProjection,
  recoverPlacements,
  type FolderConflictReason,
  type HeldFile,
  type ProjectionRecord,
} from "./sync-scan.js";
import { digestOf, fold, replaceGuarded } from "./projection.js";
import { recordPulled } from "./freshness.js";

export const HOSTED_SYNC_USAGE = `In a hosted checkout (made by 'superbee checkout'), sync sends and receives whole documents:

Usage:
  superbee sync [--dir <folder>] [--limit <n>] [--json]
  superbee sync --inspect --doc <id> [--out <file>] [--dir <folder>] [--json]
  superbee sync --resolve keep|take|revise --doc <id> [--dir <folder>] [--json]
  superbee sync --restore-deletes | --accept-deletes <token> [--dir <folder>] [--json]
  superbee sync --take-host-deletions <token> [--dir <folder>] [--json]

Each edited file is sent as one whole document under your own access, with no approval step;
documents changed on the host are refreshed in the folder. A change to one document and a
change on the host to another both land. A document changed on both sides is never merged: it
comes back as a conflict row, and nothing is sent for it until you resolve it:
  --inspect --doc <id>
                      show the base, your version and the host's version (--out <file> writes
                      the host's exact bytes); --inspect <id> is an alias
  --resolve keep      send your version against the host's current one
  --resolve take      replace your version with the host's (remove the file first to discard
                      edits made since the conflict)
  --resolve revise    send the file as it is now: edit it to the result you want first
A resolution is recorded in the checkout; keep and revise are sent by the next plain sync, and
take sends nothing. keep and revise send over the host's version, so they need an --inspect
first, and are refused (stale_review) if the host's version changed after it; take needs none.
A deleted file (or 'doc delete') is sent as a delete of the version you had; the host keeps the
document's history. A mass delete is held: when the deletes of the last day (sent, unsent and
new) are more than half the checkout and at least 3 (or every document of a smaller one), the new
ones are not sent, and they stay held until restored or accepted. --restore-deletes puts held
and unsent deleted files back (so does --resolve take --doc <id> for one of them).
--accept-deletes <token> sends exactly the held set the receipt names, and only after the person
types the held count at the prompt: it needs an interactive terminal, and refuses any other
shell (needs_person_at_terminal), so an agent asks the person to run it themselves.
When the host removed so many documents at once that sync would empty most of the folder, the
pull refuses to remove any (refused_deletions); once the bundle is confirmed to have shrunk,
--take-host-deletions <token> takes the host's version: it removes the files of exactly that
refused set, keeping any file you edited.
On a document deleted on the host, --resolve keep re-creates it, and only after --inspect has
shown the deletion it re-creates; on a document you deleted that changed on the host, keep
deletes the host's version and take brings it back. A document id the folder cannot hold as a file is
held with a row (unsafe_id), and the rest of the bundle syncs. A file edited while the host changed or
deleted its document (during a sync, or while sync held it) is a conflict too; it is never sent
over the host's version without --resolve.
Rows are committed, conflict, held (sync cannot send the file: reserved files, conventions/ and
views/, a type change, a bulk deletion, a file over the host's bounds), refused, unknown (the
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
  /** The person's terminal, for the typed confirmation `--accept-deletes` needs; tests supply one. */
  terminal?: HostedTerminal;
  /** The rule a host document id must pass to be pulled; a test seam for a stricter future rule. */
  idRule?: (id: string) => void;
}

/**
 * Where a person can confirm, by typing, what an agent must not decide alone. The check keeps a
 * person in the loop on the ordinary agent path (an agent's shell has no terminal); it is not a
 * security boundary. Known ways past it: a pseudo-terminal wrapper (`script`, `expect`, a pty
 * module), typing into a person's terminal (`tmux send-keys`), and importing the CLI with another
 * `HostedTerminal`. The refusal and the skill text make each of these an explicit violation.
 */
export interface HostedTerminal {
  /** True only when a person can answer here: standard input and standard error are both a terminal. */
  readonly interactive: boolean;
  /** Show `prompt` (on standard error, so standard output stays the receipt) and read one typed line. */
  ask(prompt: string): Promise<string>;
}

function processTerminal(): HostedTerminal {
  return {
    interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    async ask(prompt) {
      const reader = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      try {
        return await reader.question(prompt);
      } finally {
        reader.close();
      }
    },
  };
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
    terminal: partial.terminal ?? processTerminal(),
    ...(partial.idRule ? { idRule: partial.idRule } : {}),
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
  return argv.some((token) => ["--inspect", "--resolve", "--doc", "--accept-deletes", "--restore-deletes", "--take-host-deletions"].some((flag) => token === flag || token.startsWith(`${flag}=`)));
}

const GIT_ONLY_FLAGS = ["establish", "pull-only", "show-incoming", "yes", "body-out", "migrate"] as const;

interface HostedValues {
  "accept-deletes"?: string;
  "restore-deletes"?: boolean;
  "take-host-deletions"?: string;
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
    throw new CliError("USAGE", "--inspect and --resolve are separate steps", { help: `${inv} sync --inspect --doc <id>` });
  }
  if (values.inspect !== undefined) {
    // `--inspect --doc <id>` is the spelling; `--inspect <id>` is its alias.
    if (values.inspect === "" && values.doc === undefined) throw new CliError("USAGE", "--inspect needs --doc <id>", { help: `${inv} sync --inspect --doc <id>` });
    if (values.inspect !== "" && values.doc !== undefined && values.inspect !== values.doc) {
      throw new CliError("USAGE", `--inspect names '${values.inspect}' and --doc names '${values.doc}'; name one document`, { help: `${inv} sync --inspect --doc ${commandToken(values.doc)}` });
    }
    values.inspect = values.inspect === "" ? values.doc : values.inspect;
    delete values.doc;
  }
  if (values.resolve !== undefined && values.doc === undefined) {
    throw new CliError("USAGE", "--resolve needs --doc <id>", { help: `${inv} sync --resolve ${commandToken(values.resolve)} --doc <id>` });
  }
  if (values.doc !== undefined && values.resolve === undefined) {
    throw new CliError("USAGE", "--doc names the document for --inspect or --resolve", { help: `${inv} sync --inspect --doc ${commandToken(values.doc)}` });
  }
  if (values.out !== undefined && values.inspect === undefined) {
    throw new CliError("USAGE", "--out writes the host's version for --inspect", { help: `${inv} sync --inspect --doc <id> --out <file>` });
  }
  if (values.resolve !== undefined && !["keep", "take", "revise"].includes(values.resolve)) {
    throw new CliError("USAGE", `--resolve takes keep, take or revise, not '${values.resolve}'`, { help: `${inv} sync --resolve keep|take|revise --doc <id>` });
  }
  const accept = values["accept-deletes"];
  if (accept !== undefined) {
    if (!/^[1-9][0-9]{0,6}:[0-9a-f]{12}$/.test(accept)) throw new CliError("USAGE", `--accept-deletes takes the token printed with the held deletions (<count>:<digest>), not '${accept}'`, { help: `${inv} sync (the receipt's deletions_held names the token)` });
    if (values.inspect !== undefined || values.resolve !== undefined || values["restore-deletes"]) throw new CliError("USAGE", "--accept-deletes goes with a plain sync", { help: `${inv} sync --accept-deletes ${commandToken(accept)}` });
  }
  if (values["restore-deletes"] && (values.inspect !== undefined || values.resolve !== undefined)) {
    throw new CliError("USAGE", "--restore-deletes is a step of its own", { help: `${inv} sync --restore-deletes` });
  }
  const take = values["take-host-deletions"];
  if (take !== undefined) {
    if (!/^[1-9][0-9]{0,6}:[0-9a-f]{12}$/.test(take)) throw new CliError("USAGE", `--take-host-deletions takes the token printed with the refused deletions (<count>:<digest>), not '${take}'`, { help: `${inv} sync (the receipt's pulled.refused_deletions names the token)` });
    if (values.inspect !== undefined || values.resolve !== undefined || values["restore-deletes"]) throw new CliError("USAGE", "--take-host-deletions goes with a plain sync", { help: `${inv} sync --take-host-deletions ${commandToken(take)}` });
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
  const id = conceptIdFromPath(input.trim());
  try {
    assertSafeConceptId(id);
  } catch (error) {
    throw new CliError("USAGE", `'${input}' is not a document id in this checkout (${(error as Error).message})`, { help: `${cliInvocation()} sync --inspect --doc <id>` });
  }
  return id;
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
  /** Host documents whose id cannot be a file in the folder, to the reason: left out of every listing, each held with a row. */
  readonly unsafeIds: Map<string, string>;
  /** Write the projection record now: after each phase that changed the folder or the store. */
  persist(): Promise<void>;
}

/**
 * The reader with every listed document whose id cannot be a file path in the checkout left out
 * (a path-like id such as `a/../b`, or a folder segment ending in `.md`). The private store and the
 * folder refuse such an id, so pulling it would stop the whole sync; left out, it is never
 * pulled, placed or deleted, and the run holds it with a row. The listing's digest was verified
 * over every row by the adapter before this filter; a filtered listing answers a derived digest
 * the host never sends, so no later conditional request is answered 304 while the document is
 * still there, and the next sync reports it again until it is renamed on the host.
 *
 * An id the checkout already holds (one a stricter rule refuses later) is kept in the listing at
 * the version it was pulled at, so its file is held as it is rather than removed.
 */
export function withoutUnsafeIds(reader: HostedReadAdapter, unsafe: Map<string, string>, store: JournaledBackend, idRule: (id: string) => void = assertSafeConceptId): HostedReadAdapter {
  const safe = (id: string): boolean => {
    try {
      idRule(id);
      return true;
    } catch (error) {
      unsafe.set(id, (error as Error).message);
      return false;
    }
  };
  return new Proxy(reader, {
    get(inner, prop) {
      if (prop === "heads") {
        return async (options?: Parameters<HostedReadAdapter["heads"]>[0]) => {
          const answer = await inner.heads(options);
          if (!answer) return answer;
          const heads: typeof answer.heads = [];
          for (const head of answer.heads) {
            if (safe(head.id)) {
              heads.push(head);
              continue;
            }
            // A document the checkout already holds stays listed at the version it was pulled at:
            // it is never refreshed, and never read as a host deletion that removes its file.
            const base = (await store.readMeta<{ version?: unknown }>(baseKey(head.id)))?.version;
            if (typeof base === "string") heads.push({ ...head, version: base });
          }
          // A filtered listing never carries the host's digest: recorded by a pull that a crash
          // stopped before the digest was forgotten, it would be answered 304 and hide the row.
          return unsafe.size === 0 ? answer : { ...answer, heads, digest: `${answer.digest}~held-unsafe-ids` };
        };
      }
      if (prop === "list") return async () => (await inner.list()).filter((id) => safe(id));
      const value = Reflect.get(inner, prop, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}

/** The held row for a host document whose id cannot be a file in the checkout. */
function unsafeIdRows(unsafe: ReadonlyMap<string, string>): HeldFile[] {
  return [...unsafe].map(([id, reason]) => ({
    id,
    path: `${id}.md`,
    reason: "unsafe_id" as const,
    message: `the host's document '${id}' has an id that cannot be a file in this folder (${reason}); it is not pulled, and the rest of the bundle syncs. Rename it in the Superbee app`,
  }));
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
  // A lock with no readable owner (a process killed while taking it) never clears on its own:
  // retrying cannot help, and the help names the one fix.
  if (error instanceof PushRoleStaleOwnerError || (error instanceof FilesystemMutationLockError && error.malformed)) {
    return new CliError("CONFLICT", `the checkout lock for ${folder} was left by a command that is gone`, {
      details: { reason: "lock_orphaned", folder, lock: error.lockPath, retryable: false },
      help: `confirm no superbee command is using ${folder}, remove ${error.lockPath}, then retry the same command`,
    });
  }
  if (error instanceof FilesystemMutationLockError) {
    return new CliError("CONFLICT", `another command holds the checkout lock for ${folder}`, {
      details: { reason: "sync_busy", folder, lock: error.lockPath, retryable: true },
      help: "wait for it to finish, then retry the same command",
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
async function withSession<T>(
  binding: CheckoutBinding,
  deps: HostedSyncDeps,
  resumeCommand: CommandText,
  body: (session: Session) => Promise<T>,
  options: { signIn?: boolean } = {},
): Promise<T> {
  const target = resolveHostedTarget(binding.audience);
  if (target.origin !== binding.origin) throw new CliError("RUNTIME", `the checkout binding for ${binding.path} is inconsistent`, { help: `${cliInvocation()} checkout --release ${commandToken(binding.path)}` });
  const locks = filesystemPushRoleLocks(deps.lockWaitMs !== undefined ? { waitMs: deps.lockWaitMs } : {});
  return locks
    .request(checkoutLockName(binding.path), {}, async () => {
      // Sign-in first: AUTH_REQUIRED passes through unchanged with its one link, before any request.
      const token = await ensureHostedAccessToken(target, { resume: resumeCommand, ...(options.signIn === false ? { signIn: false } : {}) }, deps.auth);
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
      const unsafeIds = new Map<string, string>();
      const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(deps.auth.home, binding.checkout_id) });
      const reader = withoutUnsafeIds(client.reader(binding.bundle_id), unsafeIds, store, deps.idRule);
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
        // Finish or undo any placement an interrupted run left, then record the baseline before
        // anything changes the store, so a crash from here on never leaves it describing a store
        // that moved.
        await recoverPlacements(binding.path, projection);
        const record = projection;
        const persist = () => writeProjection(deps.auth.home, binding.checkout_id, record);
        await persist();
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
          unsafeIds,
          persist,
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

/**
 * Push with creates first, then replaces, then deletes, each in journal order (new link targets
 * exist first, and a document leaves only after the edits that may repair links to it). A create
 * in `blocked` is not offered to the push at all.
 */
function createsFirst(store: JournaledBackend, blocked: ReadonlySet<string>): JournaledBackend {
  return new Proxy(store, {
    get(inner, prop) {
      if (prop === "listIntents") {
        return async (state?: Parameters<JournaledBackend["listIntents"]>[0]) => {
          const rows = await inner.listIntents(state);
          if (state !== "pending") return rows;
          const deleting = (row: (typeof rows)[number]) => row.kind === DOCUMENT_DELETE_KIND;
          return [
            ...rows.filter((row) => row.base === null && !deleting(row) && !blocked.has(row.target)),
            ...rows.filter((row) => row.base !== null && !deleting(row)),
            ...rows.filter(deleting),
          ];
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
 * Only a refusal that heads nothing is requeued; the document's bytes are rewritten unchanged. A
 * refusal that heads a never-sent edit is left to push, which folds the two into one fresh
 * intent carrying the edit, so the refused change is never sent separately.
 */
async function requeueBusy(store: JournaledBackend): Promise<number> {
  let requeued = 0;
  const unsettled = await store.listIntents(UNSETTLED_STATES);
  for (const row of unsettled) {
    if (row.state !== "refused" || !row.refusal || !BUSY_REFUSAL_CODES.has(row.refusal.code)) continue;
    if (unsettled.some((other) => other.after === row.requestId)) continue;
    const current = await store.readWithJournal(row.target);
    const latest = current.intents.filter((intent) => intent.state !== "acknowledged").at(-1);
    if (latest?.requestId !== row.requestId) continue;
    const supersede = { requestId: row.requestId, expectedState: "refused" as const, expectedAttempts: row.attempts };
    if (row.kind === DOCUMENT_DELETE_KIND) {
      // A deletion holds no document: the same deletion, recorded again under a fresh identity.
      if (current.document) continue;
      const intent: NewIntentRecord = { requestId: mintRequestId(), kind: DOCUMENT_DELETE_KIND, target: row.target, base: row.base, baseContent: row.baseContent, createdAt: new Date().toISOString(), ...(row.after !== undefined ? { after: row.after } : {}) };
      await store.deleteJournaled(row.target, { intent, supersede });
      requeued += 1;
      continue;
    }
    if (!current.document) continue;
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
        ...(row.recreates !== undefined ? { recreates: row.recreates } : {}),
      },
      supersede,
    });
    requeued += 1;
  }
  return requeued;
}

interface PushOutcome {
  readonly acknowledged: Map<string, string>;
  /** Of the acknowledged documents, those whose change was a delete. */
  readonly deleted: Set<string>;
  /** The deletes the host acknowledged in this run, for the mass-delete window. */
  readonly deletedIntents: { requestId: string; id: string }[];
  readonly signInRequired: boolean;
  /** The host answered 403: the grant was withdrawn, which signing in again cannot fix. */
  readonly accessWithdrawn: boolean;
  readonly notSent: NotSentReason;
  /** Creates not sent because the host holds a document whose id differs only in case. */
  readonly collisions: HeldFile[];
}

/**
 * Pending creates whose id differs only in letter case from another document the store now holds
 * (a host document the pull brought in): sending one would give the bundle two ids that one
 * case-insensitive disk cannot hold apart.
 */
async function caseCollidingCreates(store: JournaledBackend): Promise<HeldFile[]> {
  const creates = (await store.listIntents("pending")).filter((row) => row.base === null);
  if (creates.length === 0) return [];
  const byFold = new Map<string, string[]>();
  for (const id of await store.readHeads({ project: (head) => head.id })) {
    const key = id.split("/").map(fold).join("/");
    byFold.set(key, [...(byFold.get(key) ?? []), id]);
  }
  const out: HeldFile[] = [];
  for (const row of creates) {
    const twin = byFold.get(row.target.split("/").map(fold).join("/"))?.find((id) => id !== row.target);
    if (twin !== undefined) {
      out.push({ id: row.target, path: `${row.target}.md`, reason: "case_collision", message: `'${row.target}' differs only in letter case from the host's '${twin}', which a case-insensitive disk treats as the same file; rename your file` });
    }
  }
  return out;
}

async function pushChanges(session: Session, deps: HostedSyncDeps): Promise<PushOutcome> {
  const { store, local, binding, reader } = session;
  const acknowledged = new Map<string, string>();
  const deleted = new Set<string>();
  const deletedIntents: { requestId: string; id: string }[] = [];
  const pending = await store.listIntents("pending");
  const refused = await store.listIntents("refused");
  const none = { acknowledged, deleted, deletedIntents, signInRequired: false, accessWithdrawn: false, collisions: [] as HeldFile[] };
  if (pending.length === 0 && refused.length === 0) return { ...none, notSent: null };
  // A bundle whose host serves no identified writes refuses every one: say so without sending.
  if (!session.capabilities.operations) return { ...none, notSent: "read_only" };
  const collisions = await caseCollidingCreates(store);
  let denied = false;
  const carrier: HostedCarrier = {
    async json(route, input, signal, options) {
      const answer = await session.carrier.json(route, input, signal, options);
      if (answer.status === 403) denied = true;
      return answer;
    },
    stream: (route, input, signal) => session.carrier.stream(route, input, signal),
  };
  // Running sync is the person's decision to retry: a pause from an earlier run (sign-in, quota,
  // a withdrawn grant) is lifted and its refused changes are requeued under their identities.
  await resume(local);
  const transport = createWholeDocumentTransport({
    carrier,
    bundleId: binding.bundle_id,
    binding: checkoutBindingDigest(binding.checkout_id),
    intentFor: (requestId) => store.readIntent(requestId),
    remote: reader,
    routes: { create: `${session.routes}/create`, replace: `${session.routes}/replace`, delete: `${session.routes}/delete`, outcome: `${session.routes}/outcome` },
    ...(session.okfVersion ? { okfVersion: session.okfVersion } : {}),
  });
  const ordered = createsFirst(store, new Set(collisions.map((row) => row.id)));
  let signInRequired = false;
  for (let pass = 0; pass < PUSH_PASSES; pass += 1) {
    const report = await push(ordered, transport, { remote: reader, write: { ...deps.write, settlement: WHOLE_DOCUMENT_SETTLEMENT } });
    for (const settled of report.settled) {
      if (settled.state !== "acknowledged") continue;
      const row = await store.readIntent(settled.requestId);
      // A delete settled by read-back past retention names no tombstone: its row shows no version.
      acknowledged.set(settled.target, row?.acknowledgedVersion === DELETION_VERSION ? "" : row?.acknowledgedVersion ?? "");
      if (row?.kind === DOCUMENT_DELETE_KIND) {
        deleted.add(settled.target);
        deletedIntents.push({ requestId: row.requestId, id: row.target });
      } else deleted.delete(settled.target);
    }
    if (report.paused) {
      const control = await store.readMeta<{ reason?: string }>("sync");
      signInRequired = /^(AUTH_REQUIRED|UNAUTHORIZED)\b/.test(control?.reason ?? "") && !denied;
      break;
    }
    if (pass === PUSH_PASSES - 1 || (await requeueBusy(store)) === 0) break;
    await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(50 + Math.floor(Math.random() * 200));
  }
  return { acknowledged, deleted, deletedIntents, signInRequired, accessWithdrawn: denied, notSent: null, collisions };
}

/**
 * Make the next pull ask for the whole listing. A pull that held documents recorded the listing's
 * digest, yet the held documents were not refreshed from it; if the host changes one before its
 * local change settles, a later conditional pull would answer 304 and never bring it in.
 */
async function forgetPullDigest(store: JournaledBackend): Promise<void> {
  const marker = await store.readMeta<Record<string, unknown>>("pull");
  if (!marker || marker.headsDigest === undefined) return;
  const { headsDigest: _digest, ...rest } = marker;
  await store.writeMeta("pull", rest);
}

/** The token that takes exactly one refused set of host deletions: its count and a digest of the listing that implied it. */
export function hostDeletionsToken(refused: DeletionRefusal): string {
  return `${refused.deletions}:${createHash("sha256").update(refused.digest).digest("hex").slice(0, 12)}`;
}

/** The pull's last recorded refusal of host deletions, read before a pull replaces its marker. */
async function lastRefusedDeletions(store: JournaledBackend): Promise<DeletionRefusal | undefined> {
  const refused = (await store.readMeta<{ refused?: DeletionRefusal }>("pull"))?.refused;
  return refused && typeof refused.digest === "string" && Number.isSafeInteger(refused.deletions) ? refused : undefined;
}

function pulledView(binding: CheckoutBinding, report: PullReport | null, placed: string[], removed: string[], kept: string[]): Record<string, unknown> {
  const refused = report?.refused;
  const token = refused ? hostDeletionsToken(refused) : null;
  return {
    refreshed: placed.length,
    removed: removed.length,
    ...(kept.length > 0 ? { kept_local_edits: kept.slice(0, 20) } : {}),
    ...(refused && token
      ? {
          refused_deletions: {
            reason: refused.reason,
            count: refused.deletions,
            token,
            message: `the host no longer lists ${refused.deletions} documents this folder holds, ${refused.reason === "empty-listing" ? "which is every one of them" : "more than half of them"}, so none were removed: a bundle that was emptied or replaced by mistake looks the same. If the bundle really shrank (check it in the Superbee app), take the host's version with the take command; files you edited are kept`,
            take: syncCommand(binding, commandFragment` --take-host-deletions ${commandToken(token)}`),
          },
        }
      : {}),
  };
}

function rowHelp(rows: readonly SyncRow[], binding: CheckoutBinding): string[] {
  const help: string[] = [];
  const firstConflict = rows.find((row) => row.state === "conflict");
  if (firstConflict) help.push(`${cliInvocation()} sync --inspect --doc ${commandToken(firstConflict.id)} --dir ${commandToken(binding.path)}`);
  if (rows.some((row) => row.state === "paused" || row.state === "unknown")) help.push(syncCommand(binding));
  if (rows.some((row) => row.state === "held" || (row.state === "refused" && row.reason !== "read_only"))) {
    help.push(`edit or restore the files named in the held and refused rows, then: ${syncCommand(binding)}`);
  }
  return help;
}

/**
 * Refuse `--accept-deletes` where no person can type the confirmation: an agent's shell, a pipe,
 * a hook. Accepting a held mass delete is the one step that stays with the person, so the
 * refusal tells the agent to hand the command to them.
 */
function assertPersonAtTerminal(binding: CheckoutBinding, token: string, terminal: HostedTerminal): void {
  if (terminal.interactive) return;
  const command = syncCommand(binding, commandFragment` --accept-deletes ${commandToken(token)}`);
  throw new CliError("FORBIDDEN", "accepting held deletions needs the person to type a confirmation in their own terminal, and this shell is not interactive; nothing was accepted or sent", {
    details: {
      reason: "needs_person_at_terminal",
      token,
      folder: binding.path,
      agent_instruction: "Do not retry this or work around it. Name the held documents to the person and ask them to run the command in their own terminal if they want them removed from the bundle; otherwise restore the files.",
      command_for_person: command,
      restore: syncCommand(binding, commandLiteral(" --restore-deletes")),
    },
    help: `ask the person to run in their own terminal: ${command}`,
  });
}

/** Ask the person to confirm removing exactly this held set by typing its count. */
function confirmAtTerminal(binding: CheckoutBinding, terminal: HostedTerminal) {
  return async (hold: { count: number; ids: readonly string[]; token: string }): Promise<boolean> => {
    const shown = hold.ids.slice(0, 50).map((id) => `  ${id}`);
    const more = hold.ids.length > shown.length ? [`  ... and ${hold.ids.length - shown.length} more`] : [];
    const answer = await terminal.ask(
      [
        `superbee sync is holding ${hold.count} deleted document(s) in ${binding.path}:`,
        ...shown,
        ...more,
        `Accepting removes them from the hosted bundle '${binding.bundle_id}' for everyone; the host keeps their history.`,
        `Type ${hold.count} to remove them, or anything else to keep them held: `,
      ].join("\n"),
    );
    return answer.trim() === String(hold.count);
  };
}

async function runSync(binding: CheckoutBinding, values: HostedValues, deps: HostedSyncDeps, mode: OutputMode): Promise<void> {
  const limit = rowLimit(values.limit);
  const resumeCommand = syncCommand(binding, values.json ? commandLiteral(" --json") : commandFragment``);
  const acceptDeletes = values["accept-deletes"];
  const terminal = deps.terminal ?? processTerminal();
  if (acceptDeletes !== undefined) assertPersonAtTerminal(binding, acceptDeletes, terminal);
  const takeHostDeletions = values["take-host-deletions"];
  let failure: CliError | null = null;
  const receipt = await withSession(binding, deps, resumeCommand, async (session) => {
    const { store, local, reader, projection } = session;
    // An earlier run that died mid-push left its claims in flight; this run holds the lock, so no
    // push is live, and each such change is looked up before it is ever sent again.
    await reclaimInFlight(local);
    const scan = await scanCheckout({
      folder: binding.path,
      bundleId: binding.bundle_id,
      okfVersion: session.okfVersion,
      local,
      projection,
      ...(acceptDeletes !== undefined ? { acceptDeletes, confirmAccept: confirmAtTerminal(binding, terminal) } : {}),
    });
    await session.persist();
    const unsent = async () => (await store.listIntents(UNSETTLED_STATES)).length;
    // `--take-host-deletions` names the refusal the last pull recorded; it applies only while the
    // host still lists exactly the state that was refused, so a listing that moved is refused anew.
    const lastRefused = takeHostDeletions !== undefined ? await lastRefusedDeletions(store) : undefined;
    const accepted = lastRefused !== undefined && hostDeletionsToken(lastRefused) === takeHostDeletions ? lastRefused : undefined;
    let taken: Record<string, unknown> | undefined;
    const pullAndExport = async (acceptRefusedDeletions?: DeletionRefusal) => {
      let report: PullReport;
      try {
        report = await pull(local, reader, acceptRefusedDeletions ? { acceptRefusedDeletions } : {});
      } catch (error) {
        throw readFailure(error, session, resumeCommand, await unsent());
      }
      if (report.held.length > 0 || session.unsafeIds.size > 0) await forgetPullDigest(store);
      const placed = await exportCheckout(binding.path, store, projection);
      await session.persist();
      return { report, placed };
    };
    // Push always follows a pull in the same run, so nothing is sent against a stale listing.
    const first = await pullAndExport(accepted);
    if (takeHostDeletions !== undefined) {
      taken =
        accepted === undefined
          ? { taken: false, message: `the token given (${JSON.stringify(takeHostDeletions)}) does not name the host deletions the last sync refused${lastRefused ? ` (${hostDeletionsToken(lastRefused)})` : " (none is recorded)"}; nothing was removed` }
          : first.report.refused
            ? { taken: false, message: "the host's listing changed since that refusal, so nothing was removed; check the new refused_deletions" }
            : { taken: true, removed: first.placed.removed.length, message: "the host's deletions were taken: their files are removed from the folder, apart from files you edited" };
    }
    await recordPulled(deps.auth.home, binding.checkout_id);
    let outcome: PushOutcome;
    try {
      outcome = await pushChanges(session, deps);
    } catch (error) {
      throw readFailure(error, session, resumeCommand, await unsent());
    }
    // A document the pull held for a change that has now committed may have changed on the host
    // meanwhile: pull it once more so the folder is current when the run says so.
    const second = first.report.held.some((id) => outcome.acknowledged.has(id)) ? await pullAndExport() : null;
    const pulled = second?.report ?? first.report;
    const exported = {
      placed: [...first.placed.placed, ...(second?.placed.placed ?? [])],
      removed: [...first.placed.removed, ...(second?.placed.removed ?? [])],
      kept: second?.placed.kept ?? first.placed.kept,
      held: second?.placed.held ?? first.placed.held,
    };
    // The closing pass: a file edited during this run against a document the pull refreshed or
    // removed is a conflict now, so the run that saw it never reports itself in sync.
    const conflicts = await folderConflicts(binding.path, store, projection, session.okfVersion);
    const inbound = await inboundLinks(store, outcome.deleted, session.okfVersion);
    const rows = buildRows({
      folderConflicts: conflicts,
      unsettled: await store.listIntents(UNSETTLED_STATES),
      acknowledged: outcome.acknowledged,
      deleted: inbound,
      held: [...scan.held, ...exported.held, ...unsafeIdRows(session.unsafeIds)],
      blocked: outcome.collisions,
      accessWithdrawn: outcome.accessWithdrawn,
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
      pulled: pulledView(binding, pulled, exported.placed, exported.removed, exported.kept),
      ...(taken ? { take_host_deletions: taken } : {}),
      ...(scan.hold
        ? {
            deletions_held: {
              count: scan.hold.count,
              documents: scan.hold.ids.slice(0, 50),
              window_deletions: scan.hold.deletions,
              baseline: scan.hold.baseline,
              ...(scan.hold.basis === "originals" ? { counted_over: "the documents this checkout did not create itself" } : {}),
              ...(scan.hold.pending ? { held_since_earlier_sync: true } : {}),
              ...(scan.hold.acceptMismatch !== undefined ? { accept_mismatch: `the token given (${JSON.stringify(scan.hold.acceptMismatch)}) does not name the held set (${scan.hold.token}); nothing was accepted` } : {}),
              ...(scan.hold.acceptDeclined ? { accept_declined: `the typed confirmation was not ${scan.hold.count}; nothing was accepted` } : {}),
              restore: syncCommand(binding, commandLiteral(" --restore-deletes")),
              confirmation_required: {
                agent_instruction: `Do not run this yourself: it needs the person to type a confirmation in their own terminal, and it refuses any other shell. Name these ${scan.hold.count} documents to the person, and ask them to run the command in their terminal if they want them removed from the bundle; otherwise restore the files.`,
                token: scan.hold.token,
                command_for_person: syncCommand(binding, commandFragment` --accept-deletes ${commandToken(scan.hold.token)}`),
              },
            },
          }
        : {}),
      ...(scan.accepted !== undefined ? { deletions_accepted: scan.accepted } : {}),
      ...(scan.deleted.length > 0
        ? { deletions: scan.deleted.map((row) => ({ id: row.id, ...(row.inbound.length > 0 ? { still_linked_from: row.inbound.slice(0, 20), warning: `${row.inbound.length} document(s) still link to '${row.id}'; the links are left as they are` } : {}) })) }
        : {}),
      counts,
      rows: shown,
      ...(shown.length < rows.length ? { rows_shown: shown.length, rows_total: rows.length, rows_all: syncCommand(binding, commandFragment` --limit ${commandToken(String(rows.length))}`) } : {}),
      help: [
        ...rowHelp(rows, binding),
        ...(pulled.refused ? [`only if the bundle really shrank: ${syncCommand(binding, commandFragment` --take-host-deletions ${commandToken(hostDeletionsToken(pulled.refused))}`)}`] : []),
      ],
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

/** What a pull-only pass did, or why it did not run. */
export type HostedPullResult =
  | { readonly state: "pulled"; readonly refreshed: number; readonly removed: number; readonly kept: number }
  | { readonly state: "signed_out" }
  /** The checkout or session lock is held by another command; nothing was done. */
  | { readonly state: "busy" };

/**
 * A pull with no push: the first half of a sync. Edited files are recorded locally first, exactly
 * as sync records them, so a refreshed document never overtakes an edit; nothing is sent. Only a
 * stored session (or the access-token environment variable) is used: a pull that rides on a read
 * or a session start never starts a sign-in, and reports `signed_out` instead.
 */
export async function hostedPull(binding: CheckoutBinding, partial: Partial<HostedSyncDeps> = {}): Promise<HostedPullResult> {
  const deps = hostedDeps(partial);
  if (!deps.auth.env[ACCESS_TOKEN_ENV] && !(await readSession(deps.auth.home, resolveHostedTarget(binding.audience)))) {
    return { state: "signed_out" };
  }
  const resumeCommand = syncCommand(binding);
  try {
    return await withSession(binding, deps, resumeCommand, (session) => pullOnly(binding, session, deps, resumeCommand), { signIn: false });
  } catch (error) {
    if (error instanceof SignedOutError) return { state: "signed_out" };
    if (error instanceof CliError && ["sync_busy", "session_busy"].includes(String((error.details as { reason?: unknown } | undefined)?.reason))) {
      return { state: "busy" };
    }
    throw error;
  }
}

/**
 * Whether a sync of this checkout has anything to send: an unsettled change in the private store,
 * or a file that differs from what the last sync or pull placed. Nothing is written and nothing
 * leaves the machine; `busy` when another command holds the checkout.
 */
export async function hostedLocalState(binding: CheckoutBinding, home: string): Promise<"changed" | "clean" | "busy"> {
  return filesystemPushRoleLocks().request(checkoutLockName(binding.path), { ifAvailable: true }, async (lock) => {
    if (!lock) return "busy" as const;
    const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(home, binding.checkout_id) });
    try {
      if ((await store.listIntents(UNSETTLED_STATES)).length > 0) return "changed" as const;
      const projection = await readProjection(home, binding.checkout_id, store);
      return (await folderMatchesProjection(binding.path, projection)) ? ("clean" as const) : ("changed" as const);
    } finally {
      await store.close();
    }
  });
}

async function pullOnly(binding: CheckoutBinding, session: Session, deps: HostedSyncDeps, resumeCommand: CommandText): Promise<HostedPullResult> {
  {
    const { store, local, reader, projection } = session;
    // As in sync: an interrupted push's claims are looked up before anything could send them.
    await reclaimInFlight(local);
    await scanCheckout({ folder: binding.path, bundleId: binding.bundle_id, okfVersion: session.okfVersion, local, projection });
    await session.persist();
    let report: PullReport;
    try {
      report = await pull(local, reader);
    } catch (error) {
      throw readFailure(error, session, resumeCommand, (await store.listIntents(UNSETTLED_STATES)).length);
    }
    if (report.held.length > 0 || session.unsafeIds.size > 0) await forgetPullDigest(store);
    const placed = await exportCheckout(binding.path, store, projection);
    await session.persist();
    await recordPulled(deps.auth.home, binding.checkout_id);
    return { state: "pulled", refreshed: placed.placed.length, removed: placed.removed.length, kept: placed.kept.length };
  }
}

function preview(content: string | null): { content: string | null; truncated: boolean; chars: number } {
  if (content === null) return { content: null, truncated: false, chars: 0 };
  return { content: content.length > INSPECT_PREVIEW_CHARS ? content.slice(0, INSPECT_PREVIEW_CHARS) : content, truncated: content.length > INSPECT_PREVIEW_CHARS, chars: content.length };
}

async function readIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The conflict on one document: one the push recorded in the journal (`journal`), or a file edited
 * against a version the host has since changed or deleted (`folder`); or the CLI error that says
 * there is none.
 */
type Conflict =
  | { kind: "journal"; review: ConflictReview; deleted: boolean }
  | { kind: "folder"; reason: FolderConflictReason; deleted: boolean; bytes: Buffer; remote: { version: string | null; content: string | null } };

async function conflictFor(session: Session, id: string, resumeCommand: CommandText): Promise<Conflict> {
  const file = path.join(session.binding.path, `${id}.md`);
  const bytes = await readIfPresent(file);
  const reason = await folderConflictFor(id, bytes, session.projection.files[id], session.store);
  if (reason !== null) {
    const stored = await session.store.readWithJournal(id, { meta: [baseKey(id)] });
    const shared = stored.meta.get(baseKey(id)) as { version?: string | null } | undefined;
    return {
      kind: "folder",
      reason,
      deleted: reason === "deleted_remotely",
      bytes: bytes!,
      remote: stored.document ? { version: shared?.version ?? stored.document.version, content: stored.raw } : { version: null, content: null },
    };
  }
  try {
    const review = await inspectConflict(session.local, session.reader, id);
    return { kind: "journal", review, deleted: review.remote.version === null };
  } catch (error) {
    if (error instanceof InvalidInputError || error instanceof JournalSnapshotConflict) {
      const intents = (await session.store.readWithJournal(id)).intents.filter((row) => row.state !== "acknowledged");
      const states = intents.map((row) => row.state);
      if (waitingToSend(states)) {
        throw new CliError("NOT_FOUND", `'${id}' has no conflict: its change is waiting to send; run sync to send it`, {
          details: { id, folder: session.binding.path, reason: "waiting_to_send", states },
          help: syncCommand(session.binding),
        });
      }
      throw new CliError("NOT_FOUND", `'${id}' has no conflict to resolve in this checkout`, {
        details: { id, folder: session.binding.path, states },
        help: syncCommand(session.binding),
      });
    }
    throw readFailure(error, session, resumeCommand, 0);
  }
}

/** True when a document's unsettled changes are all waiting for the next sync to send them. */
function waitingToSend(states: readonly string[]): boolean {
  return states.length > 0 && states.every((state) => state === "pending" || state === "in_flight");
}

/**
 * What every resolution prints, whatever the choice: a resolution is recorded in the checkout
 * and never sent by `--resolve` itself. keep and revise are sent by the next plain sync, which
 * the help names; take sends nothing.
 */
function resolvedRecord(binding: CheckoutBinding, id: string, choice: string, fileState: string, sends: boolean, already = false, replaces?: string): Record<string, unknown> {
  const sync = syncCommand(binding);
  return {
    resolved: id,
    // keep or revise again changes nothing: the earlier decision stands until the sync sends it.
    ...(already ? { already_resolved: true, requested: choice } : { choice }),
    ...(replaces !== undefined ? { replaces } : {}),
    file: path.join(binding.path, `${id}.md`),
    file_state: fileState,
    sent: false,
    next: sends
      ? already
        ? `already resolved; waiting to send: the earlier resolution stands, and ${sync} sends it`
        : `resolved, not sent yet: run ${sync} to send it against the host's current version`
      : "resolved: nothing to send for this document",
    help: sends ? [sync] : [],
  };
}

/** The meta row that records a keep or revise resolution waiting to send: its choice and the intents it journaled. */
function resolvedKey(id: string): string {
  return `cli-resolved:${id}`;
}

interface ResolutionRecord {
  choice?: string;
  /** The journal's latest sequence before the resolution journaled anything: its intents come after it. */
  after?: number;
  /** The intents the resolution journaled, once it completed. */
  requestIds?: string[];
}

/**
 * Record a keep or revise before it journals anything, so a crash between its journal write and
 * the record's completion still recognizes the pending change as this resolution.
 */
async function beginResolution(store: JournaledBackend, id: string, choice: "keep" | "take" | "revise"): Promise<void> {
  if (choice === "take") return;
  const after = (await store.listIntents()).reduce((max, row) => Math.max(max, row.sequence), 0);
  await store.writeMeta(resolvedKey(id), { choice, after } satisfies ResolutionRecord);
}

async function recordResolution(store: JournaledBackend, id: string, choice: "keep" | "take" | "revise"): Promise<void> {
  if (choice === "take") {
    await store.writeMeta(resolvedKey(id), null);
    return;
  }
  const requestIds = (await store.readWithJournal(id)).intents.filter((row) => row.state !== "acknowledged").map((row) => row.requestId);
  await store.writeMeta(resolvedKey(id), { choice, requestIds } satisfies ResolutionRecord);
}

/** True when `row` is the change the recorded resolution journaled. */
function isResolution(record: ResolutionRecord | null | undefined, row: { requestId: string; sequence: number }): boolean {
  if (!record?.choice) return false;
  if (Array.isArray(record.requestIds)) return record.requestIds.includes(row.requestId);
  return typeof record.after === "number" && row.sequence > record.after;
}

/**
 * A second `--resolve` on a document whose earlier keep or revise is waiting to send. keep or
 * revise again changes nothing: the next sync sends the file as it is (a later edit to it is sent
 * as well). take replaces the earlier decision while it was never sent: the pending change is
 * dropped and the host's version it was resolved against is placed back. A change that may
 * already have left, a re-create, or a file edited since is refused with the way forward; a later
 * resolution is never silently ignored.
 */
async function resolveAgain(session: Session, id: string, choice: "keep" | "take" | "revise", resumeCommand: CommandText): Promise<Record<string, unknown>> {
  const { binding, store, projection } = session;
  const file = path.join(binding.path, `${id}.md`);
  const earlier = await store.readMeta<ResolutionRecord | null>(resolvedKey(id));
  const rows = (await store.readWithJournal(id)).intents.filter((row) => row.state !== "acknowledged");
  const sync = syncCommand(binding);
  if (!earlier?.choice || rows.length === 0 || !isResolution(earlier, rows[0]!)) {
    throw new CliError("CONFLICT", `'${id}' has an unsent change but no conflict to resolve; the next sync sends it`, {
      details: { reason: "unsent_change", id, states: rows.map((row) => row.state) },
      help: sync,
    });
  }
  if (choice !== "take") return resolvedRecord(binding, id, choice, "unchanged", true, true);
  const row = rows[0]!;
  const refuse = (why: string) =>
    new CliError("CONFLICT", `'${id}' was resolved with ${earlier.choice}, and take cannot replace it: ${why}`, {
      details: { reason: "resolution_not_replaceable", id, earlier: earlier.choice, requested: choice, states: rows.map((r) => r.state) },
      help: `run ${sync}; if it reports a conflict on '${id}', resolve that one`,
    });
  if (rows.length !== 1) throw refuse("the file was edited again after it, and that edit is waiting to send too");
  if (row.state !== "pending" || row.attempts !== 0) throw refuse("it may already have been sent");
  if (row.base === null || row.baseContent === null) throw refuse("it re-creates a document the host deleted");
  const bytes = await readIfPresent(file);
  const entry = projection.files[id];
  if (bytes !== null && digestOf(bytes) !== entry?.digest) {
    throw new CliError("CONFLICT", `${file} has edits made since the resolution, which take would discard`, {
      details: { reason: "file_edited", id, file },
      help: `remove ${file} to discard your edits, then re-run: ${resumeCommand}`,
    });
  }
  const current = await store.readWithJournal(id);
  const parsed = parseMarkdown(row.baseContent, id, { okfVersion: session.okfVersion });
  await store.writeJournaled(id, { id, frontmatter: parsed.frontmatter, body: parsed.body }, {
    expectedVersion: current.document?.version ?? null,
    supersede: { requestId: row.requestId, expectedState: "pending", expectedAttempts: 0 },
    meta: [{ key: baseKey(id), value: { version: row.base, content: row.baseContent } }],
  });
  // A missing file (a kept deletion) is placed back; a file still holding its recorded bytes is replaced.
  if (bytes === null) delete projection.files[id];
  const exported = await exportCheckout(binding.path, store, projection, { only: new Set([id]), placeMissing: true });
  await store.writeMeta(resolvedKey(id), null);
  await session.persist();
  return resolvedRecord(binding, id, choice, exported.placed.length > 0 ? (bytes === null ? "restored" : "replaced") : "unchanged", false, false, earlier.choice);
}

/** The meta row that records the host's version a person was shown by `--inspect`. */
function inspectedKey(id: string): string {
  return `cli-inspected:${id}`;
}

function remoteVersionOf(conflict: Conflict): string | null {
  return conflict.kind === "journal" ? conflict.review.remote.version : conflict.remote.version;
}

/**
 * Refuse a resolution when the host's version moved since the person inspected it: `keep` would
 * otherwise overwrite a version they never saw. `keep` and `revise` send over the host's version,
 * so they need an inspection to bind to; `take` sends nothing and needs none.
 */
async function assertInspectedCurrent(session: Session, id: string, conflict: Conflict, choice: "keep" | "take" | "revise"): Promise<void> {
  const inspected = await session.store.readMeta<{ remote?: string | null } | null>(inspectedKey(id));
  const current = remoteVersionOf(conflict);
  if (!inspected || !("remote" in inspected)) {
    if (choice === "take") return;
    throw new CliError("CONFLICT", `'${choice}' sends your version over the host's, so inspect the host's version of '${id}' first`, {
      details: { reason: "not_inspected", id, choice, current },
      help: `${cliInvocation()} sync --inspect --doc ${commandToken(id)} --dir ${commandToken(session.binding.path)}`,
    });
  }
  if (inspected.remote !== current) {
    throw new CliError("CONFLICT", `the host's version of '${id}' changed since you inspected it`, {
      details: { reason: "stale_review", id, inspected: inspected.remote ?? null, current },
      help: `${cliInvocation()} sync --inspect --doc ${commandToken(id)} --dir ${commandToken(session.binding.path)}`,
    });
  }
}

/**
 * Keeping or revising a document the host deleted re-creates it: the create acknowledges the
 * deletion the conflict names (`X-Superbee-Recreate`), and the host admits it only while that is
 * the id's latest deletion. It is sent only once `--inspect` has shown the person exactly that
 * deletion (the PR 295 QA carry-over rule, applied to re-creation): without an inspection, or
 * after the conflict came back naming another deletion, it is refused here. A deletion made again
 * after the inspection is refused by the host and comes back as a new conflict, never as an
 * overwrite.
 */
async function assertInspectedTombstone(session: Session, id: string, current: string | null, choice: string): Promise<void> {
  const inspected = await session.store.readMeta<{ remote?: string | null; tombstone?: string | null } | null>(inspectedKey(id));
  const inspect = `${cliInvocation()} sync --inspect --doc ${commandToken(id)} --dir ${commandToken(session.binding.path)}`;
  if (!inspected || !("remote" in inspected)) {
    throw new CliError("CONFLICT", `'${id}' was deleted on the host; '${choice}' re-creates it, so inspect the deletion first`, {
      details: { reason: "not_inspected", id, choice, tombstone: current },
      help: inspect,
    });
  }
  if (inspected.remote !== null || (inspected.tombstone ?? null) !== current) {
    throw new CliError("CONFLICT", `the host's deletion of '${id}' is not the one you inspected`, {
      details: { reason: "stale_review", id, inspected: inspected.tombstone ?? inspected.remote ?? null, current },
      help: inspect,
    });
  }
}

async function runInspect(binding: CheckoutBinding, values: HostedValues, deps: HostedSyncDeps, mode: OutputMode): Promise<void> {
  const id = documentId(values.inspect!);
  const resumeCommand = commandFragment`${cliInvocation()} sync --inspect --doc ${commandToken(id)} --dir ${commandToken(binding.path)}`;
  let out: string | undefined;
  if (values.out !== undefined) {
    out = path.resolve(deps.cwd, values.out);
    // Judged by where the file would really land, so a link into the checkout is caught too.
    let landing = out;
    try {
      landing = path.join(await fs.realpath(path.dirname(out)), path.basename(out));
    } catch {
      // The parent does not exist yet; the write below fails on its own.
    }
    if (landing === binding.path || landing.startsWith(`${binding.path}${path.sep}`)) {
      throw new CliError("USAGE", "--out must be outside the checkout folder, or the file would be synced as a document", { help: `${resumeCommand} --out <file outside the folder>` });
    }
  }
  const record = await withSession(binding, deps, resumeCommand, async (session) => {
    const conflict = await conflictFor(session, id, resumeCommand);
    // The deletion shown with a "deleted remotely" conflict is recorded too: a re-create acknowledges exactly it.
    const tombstone = conflict.kind === "journal" && conflict.review.remote.version === null ? conflict.review.remote.tombstone ?? null : null;
    await session.store.writeMeta(inspectedKey(id), { remote: remoteVersionOf(conflict), tombstone });
    const sides =
      conflict.kind === "journal"
        ? {
            base: { version: conflict.review.base.version, ...preview(conflict.review.base.content) },
            local: conflict.review.local.deleted
              ? { version: null, deleted: true, ...preview(null) }
              : { version: conflict.review.local.version, ...preview(conflict.review.local.content) },
            remote: { version: conflict.review.remote.version, ...(tombstone !== null ? { deleted_as: tombstone } : {}), ...preview(conflict.review.remote.content) },
          }
        : {
            base: { version: null, ...preview(null) },
            local: { version: digestOf(conflict.bytes), ...preview(conflict.bytes.toString("utf8")) },
            remote: { version: conflict.remote.version, ...preview(conflict.remote.content) },
          };
    const remoteContent = conflict.kind === "journal" ? conflict.review.remote.content : conflict.remote.content;
    if (out !== undefined) {
      if (remoteContent === null) throw new CliError("NOT_FOUND", `the host has no version of '${id}' to write: it was deleted there`, { details: { id } });
      await fs.writeFile(out, remoteContent);
    }
    const doc = commandToken(id);
    const dir = commandToken(binding.path);
    const take = `${cliInvocation()} sync --resolve take --doc ${doc} --dir ${dir}`;
    const keep = `${cliInvocation()} sync --resolve keep --doc ${doc} --dir ${dir}`;
    const revise = `${cliInvocation()} sync --resolve revise --doc ${doc} --dir ${dir}`;
    const deleting = conflict.kind === "journal" && conflict.review.local.deleted === true;
    return {
      conflict: id,
      file: path.join(binding.path, `${id}.md`),
      reason: conflict.kind === "journal" ? (conflict.deleted ? "deleted_remotely" : "changed_remotely") : conflict.reason,
      ...sides,
      ...(out !== undefined ? { remote_written_to: out } : {}),
      choices: deleting
        ? conflict.deleted
          ? { keep: "keep your deletion: the host has no version left, so nothing is sent", take: "accept the host's state: nothing is sent" }
          : { keep: "keep your deletion: delete the host's current version", take: "bring the host's version back into the folder" }
        : conflict.deleted
          ? {
              take: "accept the deletion: the file is removed",
              keep: tombstone !== null
                ? "re-create the document from your version; it re-creates exactly the deletion shown here"
                : "send your version as a create; if the host has a deletion on record, it comes back naming it, to inspect and keep again",
              revise: "edit the file to the result you want, then re-create the document from it",
            }
          : {
              keep: "send your version against the host's current one",
              take: "replace your version with the host's",
              revise: "edit the file to the result you want, then send it as it is",
            },
      help: deleting ? [keep, take] : conflict.deleted ? [take, keep, revise] : [keep, take, revise],
    };
  });
  deps.stdout(render(record, mode));
}

/** Refuse a file sync cannot send as the resolved version. */
async function assertSendable(session: Session, id: string, file: string, bytes: Buffer, resumeCommand: CommandText): Promise<void> {
  const stored = await session.store.readWithJournal(id);
  const held = unsendable(id, `${id}.md`, bytes, stored.document?.doc ?? null, { bundleId: session.binding.bundle_id, okfVersion: session.okfVersion });
  if (held) throw new CliError("CONFLICT", `${file} cannot be sent: ${held.message}`, { details: { reason: held.reason, id, file }, help: `edit ${file}, then re-run: ${resumeCommand}` });
}

/** Resolve a folder conflict: take places the host's version (or removes the file); keep and revise send the file as it is. */
async function resolveFolder(session: Session, id: string, choice: "keep" | "take" | "revise", conflict: Extract<Conflict, { kind: "folder" }>, resumeCommand: CommandText): Promise<string> {
  const { binding, projection, store, local } = session;
  const file = path.join(binding.path, `${id}.md`);
  if (choice === "take") {
    // Recorded before the file moves, so a crash mid-take leaves nothing recovery must keep.
    projection.discarded = { ...projection.discarded, [id]: digestOf(conflict.bytes) };
    await session.persist();
    if (conflict.deleted) {
      const removed = await removeGuarded(file, conflict.bytes);
      delete projection.discarded[id];
      if (!removed) {
        throw new CliError("CONFLICT", `${file} changed while resolving it`, { details: { reason: "stale_review", id }, help: resumeCommand });
      }
      delete projection.files[id];
      return "removed";
    }
    const current = await store.readWithJournal(id);
    const next = Buffer.from(current.raw!, "utf8");
    const outcome = await replaceGuarded(file, conflict.bytes, next);
    delete projection.discarded[id];
    if (!outcome.placed) throw new CliError("CONFLICT", `${file} changed while resolving it`, { details: { reason: "stale_review", id }, help: resumeCommand });
    projection.files[id] = { digest: digestOf(next), version: current.document!.version };
    return "replaced";
  }
  // An explicit decision to send the file over the host's current version: journaled against it.
  // Over a deletion it is a create that acknowledges nothing (the folder never saw the deletion's
  // tombstone), so the host refuses it and it comes back as a "deleted remotely" conflict naming
  // the deletion, to inspect and keep.
  await assertSendable(session, id, file, conflict.bytes, resumeCommand);
  const parsed = parseMarkdown(conflict.bytes.toString("utf8"), id, { okfVersion: session.okfVersion });
  let committed;
  try {
    committed = await commitLocal(local, id, { mode: "replace-document", onAbsent: "create", buildCandidate: () => ({ frontmatter: parsed.frontmatter, body: parsed.body }) });
  } catch (error) {
    if (error instanceof InvalidInputError) throw new CliError("CONFLICT", `${file} is not a valid document: ${error.message}`, { details: { reason: "not_sendable", id, file }, help: `edit ${file}, then re-run: ${resumeCommand}` });
    throw error;
  }
  projection.files[id] = { digest: digestOf(conflict.bytes), version: committed.version };
  return "unchanged";
}

async function runResolve(binding: CheckoutBinding, values: HostedValues, deps: HostedSyncDeps, mode: OutputMode): Promise<void> {
  const id = documentId(values.doc!);
  const choice = values.resolve as "keep" | "take" | "revise";
  const resumeCommand = commandFragment`${cliInvocation()} sync --resolve ${commandToken(choice)} --doc ${commandToken(id)} --dir ${commandToken(binding.path)}`;
  const record = await withSession(binding, deps, resumeCommand, async (session) => {
    const { projection, store, local, reader } = session;
    const file = path.join(binding.path, `${id}.md`);
    // `take` on a deletion sync held or the host refused brings the file back, as --restore-deletes does.
    if (choice === "take" && (await readIfPresent(file)) === null) {
      const restored = await restoreDeletions(session, new Set([id]));
      if (restored.length > 0) {
        await session.persist();
        return resolvedRecord(binding, id, choice, "restored", false);
      }
    }
    let conflict: Conflict;
    try {
      conflict = await conflictFor(session, id, resumeCommand);
    } catch (error) {
      // A document whose change is waiting to send: a later resolution replaces or keeps the earlier one, or is refused.
      if (error instanceof CliError && (error.details as { reason?: unknown } | undefined)?.reason === "waiting_to_send") {
        return resolveAgain(session, id, choice, resumeCommand);
      }
      throw error;
    }
    await assertInspectedCurrent(session, id, conflict, choice);
    await beginResolution(store, id, choice);
    let fileState: string;
    if (conflict.kind === "folder") {
      // A folder conflict knows no tombstone; its re-create still waits for an inspection of the deletion.
      if (conflict.deleted && choice !== "take") await assertInspectedTombstone(session, id, null, choice);
      fileState = await resolveFolder(session, id, choice, conflict, resumeCommand);
    } else {
      const deleting = conflict.review.local.deleted === true;
      if (deleting && choice === "revise") {
        throw new CliError("USAGE", `'${id}' is your deletion in conflict; keep the deletion or take the host's version`, {
          details: { reason: "deletion_conflict", id },
          help: `${cliInvocation()} sync --inspect --doc ${commandToken(id)} --dir ${commandToken(binding.path)}`,
        });
      }
      if (conflict.deleted && !deleting && choice !== "take") await assertInspectedTombstone(session, id, conflict.review.remote.tombstone ?? null, choice);
      // Keeping your deletion deletes the host's current version: only one --inspect has shown.
      if (deleting && choice === "keep" && !conflict.deleted) await assertInspectedRemote(session, id, conflict.review.remote.version);
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
      if (choice === "keep" && bytes === null && !deleting) {
        throw new CliError("CONFLICT", `${file} was deleted, so there is no version of yours to keep`, {
          details: { reason: "file_deleted", id, file },
          help: `${cliInvocation()} sync --resolve take --doc ${commandToken(id)} --dir ${commandToken(binding.path)}`,
        });
      }
      let selected: ConflictChoice;
      if (choice === "revise") {
        if (bytes === null) throw new CliError("NOT_FOUND", `${file} does not exist; write the revised document there first`, { details: { id, file } });
        await assertSendable(session, id, file, bytes, resumeCommand);
        const parsed = parseMarkdown(bytes.toString("utf8"), id, { okfVersion: session.okfVersion });
        selected = { kind: "revise", frontmatter: parsed.frontmatter, body: parsed.body };
      } else selected = { kind: choice === "keep" ? "keep-local" : "take-remote" };
      let result;
      try {
        result = await resolveConflict(local, reader, conflict.review, selected);
      } catch (error) {
        if (error instanceof ConflictReviewStaleError) {
          throw new CliError("CONFLICT", `the conflict on '${id}' changed while resolving it`, {
            details: { reason: "stale_review", id },
            help: `${cliInvocation()} sync --inspect --doc ${commandToken(id)} --dir ${commandToken(binding.path)}`,
          });
        }
        if (error instanceof InvalidInputError) {
          throw new CliError("CONFLICT", `${file} is not a valid document: ${error.message}`, { details: { reason: "not_sendable", id, file }, help: `edit ${file}, then re-run: ${resumeCommand}` });
        }
        throw readFailure(error, session, resumeCommand, 0);
      }
      fileState = "unchanged";
      if (choice === "take") {
        const exported = await exportCheckout(binding.path, store, projection, { only: new Set([id]), placeMissing: true });
        fileState = exported.removed.length > 0 ? "removed" : exported.placed.length > 0 ? "replaced" : exported.kept.length > 0 ? "kept" : "unchanged";
      } else if (result.version !== null) {
        projection.files[id] = { digest: digestOf(bytes!), version: result.version };
      }
    }
    await store.writeMeta(inspectedKey(id), null);
    await recordResolution(store, id, choice);
    await session.persist();
    return resolvedRecord(binding, id, choice, fileState, choice !== "take");
  });
  deps.stdout(render(record, mode));
}

/**
 * Require that `--inspect` showed the host's current version before a resolution removes it; the
 * PR 295 QA carry-over rule, for keeping a deletion over a host change.
 */
async function assertInspectedRemote(session: Session, id: string, current: string | null): Promise<void> {
  const inspected = await session.store.readMeta<{ remote?: string | null } | null>(inspectedKey(id));
  const inspect = `${cliInvocation()} sync --inspect --doc ${commandToken(id)} --dir ${commandToken(session.binding.path)}`;
  if (!inspected || !("remote" in inspected)) {
    throw new CliError("CONFLICT", `'${id}' changed on the host; keeping your deletion deletes that version, so inspect it first`, { details: { reason: "not_inspected", id, choice: "keep", current }, help: inspect });
  }
  if (inspected.remote !== current) {
    throw new CliError("CONFLICT", `the host's version of '${id}' changed since you inspected it`, { details: { reason: "stale_review", id, inspected: inspected.remote ?? null, current }, help: inspect });
  }
}

/**
 * Put deleted files back from the checkout's own copy: a deletion the scan held (the file is
 * gone, the store still has the document and nothing is journaled for it), and a journaled
 * delete that never left (pending, never sent) or that the host refused (read-only). Anything
 * that may have reached the host, or is in conflict, is left to sync and `--resolve`. Returns
 * the ids whose files were placed back; a file written meanwhile is never overwritten.
 */
async function restoreDeletions(session: Session, only?: ReadonlySet<string>): Promise<string[]> {
  const { binding, store, projection } = session;
  const candidates = new Set<string>();
  const unsettled = await store.listIntents(UNSETTLED_STATES);
  for (const [id, entry] of Object.entries(projection.files)) {
    if ((only && !only.has(id)) || entry.deleted || unsettled.some((row) => row.target === id)) continue;
    if ((await readIfPresent(path.join(binding.path, `${id}.md`))) !== null) continue;
    if (!(await store.readWithJournal(id)).document) continue;
    delete projection.files[id];
    candidates.add(id);
  }
  const byTarget = new Map<string, typeof unsettled>();
  for (const row of unsettled) byTarget.set(row.target, [...(byTarget.get(row.target) ?? []), row]);
  for (const [id, rows] of byTarget) {
    if (only && !only.has(id)) continue;
    const row = rows[0]!;
    if (rows.length !== 1 || row.kind !== DOCUMENT_DELETE_KIND || row.base === null || row.baseContent === null) continue;
    if (!((row.state === "pending" && row.attempts === 0) || (row.state === "refused" && row.refusal !== undefined))) continue;
    if ((await readIfPresent(path.join(binding.path, `${id}.md`))) !== null) continue;
    const parsed = parseMarkdown(row.baseContent, id, { okfVersion: session.okfVersion });
    const meta = [{ key: baseKey(id), value: { version: row.base, content: row.baseContent } }];
    const doc = { id, frontmatter: parsed.frontmatter, body: parsed.body };
    await (row.state === "refused"
      ? store.writeJournaled(id, doc, { expectedVersion: null, resolveIntents: { expected: rows }, meta })
      : store.writeJournaled(id, doc, { expectedVersion: null, supersede: { requestId: row.requestId, expectedState: "pending", expectedAttempts: 0 }, meta }));
    delete projection.files[id];
    candidates.add(id);
  }
  if (candidates.size === 0) return [];
  const exported = await exportCheckout(binding.path, store, projection, { only: candidates, placeMissing: true });
  return exported.placed;
}

async function runRestore(binding: CheckoutBinding, deps: HostedSyncDeps, mode: OutputMode): Promise<void> {
  const resumeCommand = syncCommand(binding, commandLiteral(" --restore-deletes"));
  const record = await withSession(binding, deps, resumeCommand, async (session) => {
    const restored = await restoreDeletions(session);
    await session.persist();
    return {
      restored: restored.length,
      ...(restored.length > 0 ? { files: restored.slice(0, 50).map((id) => path.join(binding.path, `${id}.md`)) } : {}),
      next: restored.length > 0 ? "the files are back as the checkout last had them; nothing is sent for them" : "no held or unsent deletion to restore",
      help: [syncCommand(binding)],
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
  if (values["restore-deletes"]) return runRestore(binding, deps, mode);
  return runSync(binding, values, deps, mode);
}
