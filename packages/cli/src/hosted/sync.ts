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

import {
  baseKey,
  commitLocal,
  ConflictReviewStaleError,
  inspectConflict,
  openLocalBundle,
  pull,
  push,
  reclaimInFlight,
  readConflictResolution,
  resolveConflict,
  resume,
  UNSETTLED_STATES,
  type ConflictChoice,
  type ConflictReview,
  type DeletionRefusal,
  type LocalBundle,
  type PullReport,
  type SharedBase,
} from "@superbee/browser-local";
import { assertSafeConceptId, conceptIdFromPath, FilesystemMutationLockError, isConventionId, InvalidInputError, parseMarkdown, RemoteError, type JournaledBackend } from "@superbee/core";
import { decodePreparedBlobIntent, isOrdinaryBlobKey, type BlobIntentRecord, type BlobTargetScope } from "@superbee/core/storage";
import { performHostedBlobDelivery } from "@superbee/core/hosted-client";
import { createHostedBlobReadAdapter, createHostedBlobWriteAdapter } from "@superbee/core/hosted-transport";
import { FileJournaledBackend, FileJournalUnavailableError } from "@superbee/core/file-journaled-backend";
import { filesystemPushRoleLocks, PushRoleStaleOwnerError } from "@superbee/core/filesystem-push-role";
import {
  createWholeDocumentTransport,
  sendRootWrite,
  WHOLE_DOCUMENT_SETTLEMENT,
  type HostedCapabilities,
  type HostedCarrier,
  type HostedReadAdapter,
} from "@superbee/core/hosted-transport";
import { DELETION_VERSION, DOCUMENT_DELETE_KIND, JournalGuardConflict, JournalSnapshotConflict, equalJournalValue, type IntentRecord, type NewIntentRecord } from "@superbee/core/journaled-backend";
import { mintRequestId, type UncertainWriteOptions } from "@superbee/core/uncertain-write";

import { resolveLocalBundleTarget } from "../bundle.js";
import { parseSyncArgs } from "../commands/sync/orchestrate.js";
import { commandFragment, commandLiteral, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { BLOB_UNRECORDED_REFUSAL_CODES } from "@superbee/core/hosted-client";
import { retirableBlobRefusal, retireBlobRefusals, BLOB_SYNC_META_KEY, recoverBlobPlacements, refreshBlobCheckout, blobHostDeletionsToken, readBlobSyncState, settleBlobSyncReceipt, projectBlobSyncReceipt, blobFrozenPhysicalMatches, decodeBlobSyncMap, readBlobConflict, resolveBlobConflict, settledBlobConflict, blobConflictMessage, type BlobConflictResolution, type BlobSyncSnapshot, type OfflineBlobAdmission, type BlobRefreshReport, type BlobCaptureContext } from "./blob-sync.js";
import { resolveHostedVia } from "./via.js";
import { cliInvocation } from "../invocation.js";
import { render, resolveMode, type OutputMode } from "../output.js";
import { ACCESS_TOKEN_ENV, defaultHostedAuthDeps, readSession, SignedOutError, type HostedAuthDeps } from "../hosted-auth/session.js";
import { resolveHostedTarget, type HostedTarget } from "../hosted-auth/discovery.js";
import { bindingForPath, checkoutBindingDigest, checkoutLockName, checkoutStoreDir, recordHostStatement, type CheckoutBinding } from "./binding.js";
import { hostedFailure, type createHostedSyncClient } from "./client.js";
import { connectCheckout } from "./account.js";
import { storeOkfVersion, withIdleCheckoutStore } from "./checkout-store.js";
import { bundleAbsent } from "./refusals.js";
import { buildRows, BUSY_REFUSAL_CODES, countRows, receiptFailure, rowsFailure, type NotSentReason, type SyncRow } from "./sync-rows.js";
import {
  exportCheckout,
  folderConflictFor,
  folderConflicts,
  inboundLinks,
  folderMatchesProjection,
  heldPathMessage,
  readProjection,
  removeGuarded,
  scanCheckout,
  unsendable,
  writeProjection,
  recoverPlacements,
  recordHostHold,
  supersedeDeletion,
  type FolderConflictReason,
  type HeldFile,
  type ProjectionRecord,
} from "./sync-scan.js";
import { digestOf, fold, replaceGuarded, ROOT_INDEX } from "./projection.js";
import { refuseTreePrivateState } from "../private-state-publication.js";
import { adoptHostRoot, moveRootBase, readRootFile, rootConflict, settleRootSent, syncRoot, type HostRoot, type RootStepReport } from "./root-sync.js";
import { declaredHostedSyncGate, runHostedSyncGate, SYNC_GATE_CONFIG, type HostedGateDeclaration } from "../commands/sync/gate.js";
import { recordPulled, recordSynced } from "./freshness.js";
import { needsPersonAtTerminal, processTerminal, type HostedTerminal } from "./terminal.js";
export type { HostedTerminal } from "./terminal.js";
import { syncEnvelope, syncVerbNotApplicable, withSyncEnvelope, type SyncEnvelope } from "../sync-outcomes.js";

export const HOSTED_SYNC_USAGE = `In a hosted checkout (made by 'superbee checkout'), sync sends and receives documents and admitted ordinary files:

Usage:
  superbee sync [--dir <folder>] [--limit <n>] [--json]
  superbee sync --inspect --doc <id> [--out <file>] [--dir <folder>] [--json]
  superbee sync --resolve keep|take|revise --doc <id> [--dir <folder>] [--json]
  superbee sync --restore-deletes | --accept-deletes <token> [--dir <folder>] [--json]
  superbee sync --take-host-deletions <token> [--dir <folder>] [--json]

Edited documents are sent whole under your own access. Tracked ordinary files send frozen
opaque bytes with exact version and MIME pins, up to 16 MiB or a smaller advertised host bound;
new local files require explicit promote. Documents changed on the host are refreshed in the folder.
Conflict inspection and resolution: A change to one document and a
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
A tracked ordinary file in a version conflict uses the same flags with --doc <file path>:
--inspect shows the recorded versions and MIME; keep (revise is the same) moves the base to the
host's version, and the next sync sends the file as it is under a new request; take removes the
conflicted bytes and places the host's version (refused if the file changed since the conflict).
Neither resends the conflicted request; promote --expected-version <host version> is keep plus send.
Document-only deletion recovery: a deleted document file (or 'doc delete') is sent as a delete of the version you had; the host keeps the
document's history. A mass delete is held: when the deletes of the last day (sent, unsent and
new) are more than half the checkout and at least 3 (or every document of a smaller one), the new
ones are not sent, and they stay held until restored or accepted. The host applies the same
rule to the whole bundle, over everyone's deletes of the last day: a delete it holds
(deletions_held, counted_over naming the bundle) is parked the same way and never resent by a
plain sync. --restore-deletes puts held and unsent deleted document files back (so does --resolve take
--doc <id> for one of them).
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
The bundle's front page (the root index.md) is sent and refreshed like a document where the host
takes front-page changes from you; a conflict on it is resolved with --doc index.md (take, or keep
after --inspect). Elsewhere it is held, and a subdirectory index.md and every log.md always are.
Rows are committed, conflict, held (sync cannot send the file: reserved files, conventions/ and
views/, a type change, a bulk deletion, a file over the host's bounds), refused, unknown (the
answer was lost; the next sync looks it up by the same request) and paused (sign-in, or your
sync quota for this bundle). The exit is 0 only when every row is committed: 5 when a row needs
your decision, 2 when the host refuses writes to the bundle, 1 for a pause or a lost answer, and
4 (AUTH_REQUIRED, with the sign-in link) when you must sign in.
An uncertain blob request is looked up by its original identity. Absence alone does not
authorize resubmission; it can remain unknown. Unknown ordinary-file outcomes do not use
--inspect/--resolve/--restore-deletes. Artifact commands remain refused in hosted checkouts.
The blobs: token for --accept-deletes authorizes only its exact held outgoing write set, after
person confirmation; this targeted delivery does not run unrelated sync work. The separate
blobs: token for --take-host-deletions authorizes only a recorded refused incoming deletion set;
the two token families are not interchangeable.
A sync gate declared with git config superbee.syncGate '<command>' (as Git resolves it from the
checkout folder: system, global, or a repository that contains the folder; never from the
bundle's documents or the host) runs after the pull in normal sync and before anything is sent.
Exact-request promote/delete and blob acceptance delivery run it without a pull, whenever they
have a fresh submission to send. It runs through the shell from the checkout folder with
SUPERBEE_SYNC_GATE=1, SUPERBEE_SYNC_HOME=hosted, SUPERBEE_BOARD_PATH, SUPERBEE_HOSTED_ORIGIN and
SUPERBEE_HOSTED_BUNDLE_ID set (superbee.syncGateTimeoutSeconds overrides the 600s timeout). A
non-zero exit, a timeout, or any change it makes to the folder sends nothing at all: your edits
stay recorded in the checkout, and sync exits 5 with code GATE_FAILED and the gate's last output
lines. A Git configuration that cannot be read fails the same way (reason gate_config_unreadable)
rather than send ungated. A front page edited after the gate judged it is not sent (paused,
changed_since_gate) until the next sync's gate judges it. --inspect, --resolve and
--restore-deletes send nothing and never run it.
Each write names the agent the sync runs under, recorded with it on the host as unverified
attribution (never authority): claude-code under Claude Code (CLAUDECODE=1), or SUPERBEE_VIA=<token>
(1 to 32 of a-z 0-9 . _ -, not starting with superbee); SUPERBEE_NO_VIA=<any value> names none.
Another agent started from a Claude Code shell inherits CLAUDECODE=1 and is named claude-code
unless SUPERBEE_VIA says otherwise. SUPERBEE_ACTOR does not set it.
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
export function dirArgument(argv: readonly string[]): string | undefined {
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
      throw syncVerbNotApplicable([flag], "hosted", "it is for a Git board; a hosted checkout syncs with plain 'sync'", `${inv} sync --help`);
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
    if (!/^(?:blobs:)?[1-9][0-9]{0,6}:[0-9a-f]{12}$/.test(accept)) throw new CliError("USAGE", `--accept-deletes takes the token printed with the held deletions (<count>:<digest>), not '${accept}'`, { help: `${inv} sync (the receipt's deletions_held names the token)` });
    if (accept.startsWith("blobs:") && values["take-host-deletions"] !== undefined) throw new CliError("USAGE", "blob write confirmation and taking host deletions are separate operations");
    if (values.inspect !== undefined || values.resolve !== undefined || values["restore-deletes"]) throw new CliError("USAGE", "--accept-deletes goes with a plain sync", { help: `${inv} sync --accept-deletes ${commandToken(accept)}` });
  }
  if (values["restore-deletes"] && (values.inspect !== undefined || values.resolve !== undefined)) {
    throw new CliError("USAGE", "--restore-deletes is a step of its own", { help: `${inv} sync --restore-deletes` });
  }
  const take = values["take-host-deletions"];
  if (take !== undefined) {
    if (!/^(?:blobs:)?[1-9][0-9]{0,6}:[0-9a-f]{12}$/.test(take)) throw new CliError("USAGE", `--take-host-deletions takes the token printed with the refused deletions (<count>:<digest>), not '${take}'`, { help: `${inv} sync (the receipt's pulled.refused_deletions names the token)` });
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
  /** The checkout's client, for a second read after a refusal (the bundle list), or a fresh capabilities read. */
  readonly client: Pick<ReturnType<typeof createHostedSyncClient>, "bundles" | "reader">;
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

/** A read-side failure in CLI terms: a bundle the host no longer serves (or whose id became
 * ambiguous for a checkout naming no workspace) is a conflict with the checkout. */
async function readFailure(error: unknown, session: Pick<Session, "binding" | "target" | "client">, resumeCommand: CommandText, unsent: number): Promise<unknown> {
  if (error instanceof RemoteError && (error.code === "bundle_not_found" || error.status === 404)) return bundleAbsent(session.binding, session.client, unsent);
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
      const currentBinding = await bindingForPath(deps.auth.home, binding.path);
      if (!currentBinding || currentBinding.checkout_id !== binding.checkout_id || currentBinding.principal_id !== binding.principal_id || !equalJournalValue([currentBinding.origin, currentBinding.routes, currentBinding.bundle_id, currentBinding.workspace_slug ?? null], [binding.origin, binding.routes, binding.bundle_id, binding.workspace_slug ?? null])) throw new CliError("CONFLICT", "checkout binding changed before delivery; nothing was submitted");
      // Sign-in first: AUTH_REQUIRED passes through unchanged with its one link, before any request.
      const { client } = await connectCheckout(binding, { resume: resumeCommand, ...(options.signIn === false ? { signIn: false } : {}) }, deps);
      const unsafeIds = new Map<string, string>();
      const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(deps.auth.home, binding.checkout_id) });
      const reader = withoutUnsafeIds(client.reader(binding.bundle_id), unsafeIds, store, deps.idRule);
      let projection: ProjectionRecord | undefined;
      try {
        const local = openLocalBundle(binding.checkout_id, { backend: store });
        const unsent = async () => (await store.listIntents(UNSETTLED_STATES)).length + (await store.listBlobIntents()).filter(row => !row.receipt).length;
        let capabilities: HostedCapabilities;
        try {
          capabilities = await reader.hostedCapabilities();
        } catch (error) {
          throw await readFailure(error, { binding, target, client }, resumeCommand, await unsent());
        }
        // The up-front Kind refusals read what the host last said, with no request of their own.
        const bound = await recordHostStatement(deps.auth.home, binding, { definitionWrites: capabilities.definitionWrites, documentInputBytes: capabilities.documentInputBytes });
        projection = await readProjection(deps.auth.home, binding.checkout_id, store);
        // What the host said about root writes, for a status preview that makes no request.
        if (capabilities.rootWrites === "allowed") projection.rootWrites = "allowed";
        else delete projection.rootWrites;
        // Finish or undo any placement an interrupted run left, then record the baseline before
        // anything changes the store, so a crash from here on never leaves it describing a store
        // that moved.
        await recoverPlacements(binding.path, projection);
        const blobRecovery = await recoverBlobPlacements(binding.path, store, { origin: binding.origin, prefix: binding.routes, bundleId: binding.bundle_id, workspaceSlug: binding.workspace_slug ?? null });
        if (blobRecovery.held.some(row => row.key === null)) throw new CliError("CONFLICT", "unreferenced blob placement evidence needs attention before capture", { details: { reason: "blob_placement_recovery", folder: binding.path }, help: "preserve the staged files and inspect the checkout before syncing" });
        const record = projection;
        const persist = () => writeProjection(deps.auth.home, binding.checkout_id, record);
        await persist();
        return await body({
          binding: bound,
          target,
          reader,
          capabilities,
          carrier: client.carrier,
          client,
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
 * exist first, and a document leaves only after the edits that may repair links to it). A change
 * to the bundle's model brackets them (designs/hosted-model-evolution.md section 5.3): convention
 * creates and replaces go before every document, so a widening lands before the documents that
 * use it, and convention deletes go last, after the document deletes that leave the Kind unused.
 * A create in `blocked` is not offered to the push at all, whatever its folder; nor, unless the
 * host answers `allowed` now (`models`), is a convention change journaled while it did.
 */
function createsFirst(store: JournaledBackend, blocked: ReadonlySet<string>, models: boolean): JournaledBackend {
  return new Proxy(store, {
    get(inner, prop) {
      if (prop === "listIntents") {
        return async (state?: Parameters<JournaledBackend["listIntents"]>[0]) => {
          const rows = (await inner.listIntents(state)).filter(
            (row) => !(state === "pending" && ((row.base === null && row.kind !== DOCUMENT_DELETE_KIND && blocked.has(row.target)) || (!models && isConventionId(row.target)))),
          );
          if (state !== "pending") return rows;
          const deleting = (row: (typeof rows)[number]) => row.kind === DOCUMENT_DELETE_KIND;
          const model = (row: (typeof rows)[number]) => isConventionId(row.target);
          return [
            ...rows.filter((row) => model(row) && !deleting(row)),
            ...rows.filter((row) => !model(row) && row.base === null && !deleting(row)),
            ...rows.filter((row) => !model(row) && row.base !== null && !deleting(row)),
            ...rows.filter((row) => !model(row) && deleting(row)),
            ...rows.filter((row) => model(row) && deleting(row)),
          ];
        };
      }
      const value = Reflect.get(inner, prop, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}

/** A refusal that says only that the host was busy (a recorded `concurrent_change` after its own retries, or a transient refusal). */
const busyRefusal = (row: IntentRecord) => row.refusal !== undefined && BUSY_REFUSAL_CODES.has(row.refusal.code);

/**
 * Requeue, under a fresh identity, each refused change `eligible` admits: one the host refused
 * only because it was busy, or a model-change refusal that this run's writes may have cleared
 * ({@link definitionRetry}). The recorded identity can only ever answer that refusal again, so a
 * new one is the only way to resend it. Only a refusal that heads nothing is requeued; the
 * document's bytes are rewritten unchanged. A refusal that heads a never-sent edit is left to
 * push, which folds the two into one fresh intent carrying the edit, so the refused change is
 * never sent separately. Returns the documents requeued.
 */
async function requeueRefused(store: JournaledBackend, eligible: (row: IntentRecord) => boolean): Promise<string[]> {
  const requeued: string[] = [];
  const unsettled = await store.listIntents(UNSETTLED_STATES);
  for (const row of unsettled) {
    if (row.state !== "refused" || !row.refusal || !eligible(row)) continue;
    if (unsettled.some((other) => other.after === row.requestId)) continue;
    const current = await store.readWithJournal(row.target);
    const latest = current.intents.filter((intent) => intent.state !== "acknowledged").at(-1);
    if (latest?.requestId !== row.requestId) continue;
    const supersede = { requestId: row.requestId, expectedState: "refused" as const, expectedAttempts: row.attempts };
    if (row.kind === DOCUMENT_DELETE_KIND) {
      // A deletion holds no document: the same deletion, recorded again under a fresh identity.
      if (await supersedeDeletion(store, row)) requeued.push(row.target);
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
    requeued.push(row.target);
  }
  return requeued;
}

/** The frontmatter an intent's document carries: its content, or for a delete the version it removes. */
function intentFrontmatter(row: IntentRecord, okfVersion: "0.1" | "0.2" | undefined): Record<string, unknown> | null {
  const text = row.kind === DOCUMENT_DELETE_KIND ? row.baseContent : row.content;
  if (!text) return null;
  try {
    return parseMarkdown(text, row.target, { okfVersion }).frontmatter as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The documents of this run the host acknowledged at bytes other than those sent, whose files
 * still hold what this run scanned. A file edited while its own send was in flight keeps its
 * edit: its base drops the refetch mark, so the pull leaves it and the next run sends the edit
 * against the acknowledged version (and takes the host's bytes after that send).
 */
async function hostRestamped(
  store: JournaledBackend,
  acknowledged: ReadonlyMap<string, string>,
  folder: string,
  projection: ProjectionRecord,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const id of acknowledged.keys()) {
    const base = await store.readMeta<SharedBase>(baseKey(id));
    if (base?.refetch !== true) continue;
    const bytes = await fs.readFile(path.join(folder, `${id}.md`)).catch(() => null);
    const entry = projection.files[id];
    if (bytes !== null && entry !== undefined && !entry.deleted && digestOf(bytes) === entry.digest) ids.add(id);
    else {
      const { refetch: _refetch, ...kept } = base;
      try {
        await store.writeMeta(baseKey(id), kept, { expected: { present: true, value: base } });
      } catch (error) {
        // The base moved under this run: whatever moved it decides, not this mark.
        if (!(error instanceof JournalGuardConflict)) throw error;
      }
    }
  }
  return ids;
}

/** What this run's acknowledged writes changed that a model-change refusal can depend on. */
interface Landed {
  /** The types of documents (not conventions) written or deleted. */
  readonly types: Set<string>;
  /** The types whose governing convention was written or deleted. */
  readonly governed: Set<string>;
  /** A convention was written or deleted: the registry another convention is proved against moved. */
  conventionChanged: boolean;
}

function recordLanded(landed: Landed, row: IntentRecord, okfVersion: "0.1" | "0.2" | undefined): void {
  const frontmatter = intentFrontmatter(row, okfVersion);
  if (isConventionId(row.target)) {
    if (typeof frontmatter?.governs === "string") landed.governed.add(frontmatter.governs);
    landed.conventionChanged = true;
  } else if (typeof frontmatter?.type === "string") landed.types.add(frontmatter.type);
}

/**
 * Whether a refused change may now land because of what this run acknowledged (section 5.3, one
 * retry pass): a convention the host refused as incompatible, once documents of the type it
 * governs were written or deleted, or another convention changed; a document its Kind refused,
 * once a convention governing its type changed. Refusals from earlier runs count too, so fixing
 * the documents in a later sync lands the Kind without touching its file. Anything else is not
 * resent: each resend spends the person's sync capacity.
 */
function definitionRetry(row: IntentRecord, landed: Landed, okfVersion: "0.1" | "0.2" | undefined, models: boolean): boolean {
  const code = row.refusal?.code;
  if (isConventionId(row.target)) {
    // Only while the host answers `allowed`: otherwise the resend could only be refused.
    if (!models || code !== "definition_incompatible") return false;
    const governs = intentFrontmatter(row, okfVersion)?.governs;
    return landed.conventionChanged || (typeof governs === "string" && landed.types.has(governs));
  }
  if (code !== "validation_failed") return false;
  const type = intentFrontmatter(row, okfVersion)?.type;
  return typeof type === "string" && landed.governed.has(type);
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
  /** The agent the writes named (`X-Superbee-Via`), or why a named one was not sent. */
  readonly via?: { readonly token?: string; readonly ignored?: string };
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

async function pushChanges(session: Session, deps: HostedSyncDeps, acceptDeletes?: number, heldSink: { value?: { deletions: number; baseline: number } } = {}): Promise<PushOutcome> {
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
  const via = resolveHostedVia(deps.auth.env);
  const transport = createWholeDocumentTransport({
    carrier,
    bundleId: binding.bundle_id,
    binding: checkoutBindingDigest(binding.checkout_id),
    intentFor: (requestId) => store.readIntent(requestId),
    remote: reader,
    routes: { create: `${session.routes}/create`, replace: `${session.routes}/replace`, delete: `${session.routes}/delete`, outcome: `${session.routes}/outcome` },
    ...(session.okfVersion ? { okfVersion: session.okfVersion } : {}),
    documentInputBytes: session.capabilities.documentInputBytes,
    ...(via.token !== undefined ? { via: via.token } : {}),
    // Only the person's typed confirmation in this run sets it (scanCheckout's acceptance).
    ...(acceptDeletes !== undefined ? { acceptDeletes } : {}),
    onDeletionsHeld: ({ deletions, baseline }) => {
      heldSink.value ??= { deletions, baseline };
    },
  });
  // A convention change journaled while the host allowed it waits, held, while it does not: the
  // host would refuse it, and each refusal spends the person's sync capacity.
  const models = session.capabilities.definitionWrites === "allowed";
  const withheld: HeldFile[] = models
    ? []
    : [...new Set((await store.listIntents("pending")).filter((row) => isConventionId(row.target)).map((row) => row.target))].map((id) => ({
        id,
        path: `${id}.md`,
        reason: "convention_folder" as const,
        message: heldPathMessage(`${id}.md`, session.capabilities.definitionWrites),
      }));
  const ordered = createsFirst(store, new Set(collisions.map((row) => row.id)), models);
  let signInRequired = false;
  const landed: Landed = { types: new Set(), governed: new Set(), conventionChanged: false };
  // A model-change refusal is resent at most once per document per run.
  const retried = new Set<string>();
  for (let pass = 0; pass < PUSH_PASSES; pass += 1) {
    const report = await push(ordered, transport, { remote: reader, write: { ...deps.write, settlement: WHOLE_DOCUMENT_SETTLEMENT } });
    for (const settled of report.settled) {
      if (settled.state !== "acknowledged") continue;
      const row = await store.readIntent(settled.requestId);
      if (row) recordLanded(landed, row, session.okfVersion);
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
    if (pass === PUSH_PASSES - 1) break;
    const model = new Set<string>();
    const requeued = await requeueRefused(store, (row) => {
      if (busyRefusal(row)) return true;
      if (retried.has(row.target) || !definitionRetry(row, landed, session.okfVersion, models)) return false;
      model.add(row.target);
      return true;
    });
    if (requeued.length === 0) break;
    for (const id of requeued) if (model.has(id)) retried.add(id);
    await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(50 + Math.floor(Math.random() * 200));
  }
  return { acknowledged, deleted, deletedIntents, signInRequired, accessWithdrawn: denied, notSent: null, collisions: [...collisions, ...withheld], via };
}

/**
 * Whether this run may send anything: a change not yet settled, or a front page edited where the
 * host takes front-page writes. When unsure it says yes, so the gate is skipped only when nothing
 * is known to be sent.
 */
async function wouldSend(session: Session): Promise<boolean> {
  if ((await session.store.listIntents(UNSETTLED_STATES)).length > 0) return true;
  if (session.capabilities.blobWrites === "allowed" && (await session.store.listBlobIntents()).some(row => !row.receipt && row.attempts === 0 && (row.state === "pending" || row.state === "unknown"))) return true;
  if (session.capabilities.rootWrites !== "allowed") return false;
  const root = await readRootFile(session.binding.path);
  return root.kind === "file" && digestOf(root.bytes) !== session.projection.root;
}

/** The host's root as the run's capabilities answer serves it (re-read once a heads answer named another root). */
async function hostRoot(reader: Pick<HostedReadAdapter, "hostedCapabilities">): Promise<HostRoot> {
  const { root } = await reader.hostedCapabilities();
  return root ? { content: root.content, version: root.version } : null;
}

/** The run's front-page step (`root-sync.ts`); `send` false only reads (a pull). */
function rootStep(session: Session, deps: HostedSyncDeps, send: boolean, judged?: string | null): Promise<RootStepReport> {
  const { binding } = session;
  const via = resolveHostedVia(deps.auth.env).token;
  return syncRoot({
    folder: binding.path,
    bundleId: binding.bundle_id,
    projection: session.projection,
    store: session.store,
    rootWrites: session.capabilities.rootWrites,
    current: () => hostRoot(session.reader),
    // A new adapter: the run's own holds the answer it already read.
    reread: () => hostRoot(session.client.reader(binding.bundle_id)),
    ...(send
      ? {
          send: (content: string, base: string | null) =>
            sendRootWrite({ carrier: session.carrier, route: `${session.routes}/root`, bundleId: binding.bundle_id, binding: checkoutBindingDigest(binding.checkout_id), content, base, ...(via !== undefined ? { via } : {}) }),
        }
      : {}),
    persist: session.persist,
    ...(judged !== undefined ? { judged } : {}),
  });
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
function assertPersonAtTerminal(binding: CheckoutBinding, token: string, terminal: HostedTerminal, family: "documents" | "blobs" = "documents"): void {
  if (terminal.interactive) return;
  const command = syncCommand(binding, commandFragment` --accept-deletes ${commandToken(token)}`);
  throw needsPersonAtTerminal("accepting held deletions needs the person to type a confirmation in their own terminal, and this shell is not interactive; nothing was accepted or sent", String(command), {
    token,
    folder: binding.path,
    agent_instruction: family === "blobs" ? "Do not retry this or work around it. Name the held ordinary files and their window allowance to the person; only their terminal confirmation may accept them." : "Do not retry this or work around it. Name the held documents to the person and ask them to run the command in their own terminal if they want them removed from the bundle; otherwise restore the files.",
    command_for_person: command,
    ...(family === "documents" ? { restore: syncCommand(binding, commandLiteral(" --restore-deletes")) } : {}),
  });
}

/** Ask the person to confirm removing exactly this held set by typing its count. */
function confirmAtTerminal(binding: CheckoutBinding, terminal: HostedTerminal, family: "documents" | "blobs" = "documents") {
  return async (hold: { count: number; ids: readonly string[]; token: string; allowance?: number; observations?: { deletions: number; baseline: number }[]; bundle?: { deletions: number; baseline: number } }): Promise<boolean> => {
    const shown = hold.ids.slice(0, 50).map((id) => `  ${id}`);
    const more = hold.ids.length > shown.length ? [`  ... and ${hold.ids.length - shown.length} more`] : [];
    const answer = await terminal.ask(
      [
        `superbee sync is holding ${hold.count} deleted ${family === "blobs" ? "ordinary file(s)" : "document(s)"} in ${binding.path}:`,
        ...shown,
        ...more,
        family === "blobs" ? `Accepting removes these named files from hosted bundle '${binding.bundle_id}' for everyone. The rolling-window allowance is ${hold.allowance}, distinct from the ${hold.count} named files; the host rechecks its current window.` : `Accepting removes them from the hosted bundle '${binding.bundle_id}' for everyone; the host keeps their history.`,
        ...(family === "blobs" ? (hold.observations ?? []).map(row => `Historical observed proposed deletions ${row.deletions}, baseline ${row.baseline}; these baselines are not combined into a current count.`) : []),
        ...(hold.bundle ? [`With every deletion in the bundle over the last 24 hours when the host last answered, that is ${hold.bundle.deletions} of the ${hold.bundle.baseline} documents it held; the host counts again when they are sent.`] : []),
        `Type ${hold.count} to remove them, or anything else to keep them held: `,
      ].join("\n"),
    );
    return answer.trim() === String(hold.count);
  };
}

/** One declared gate owner for ordinary sync and exact-request delivery. */
async function judgeHostedWrites(session: Session, declared: HostedGateDeclaration, resumeCommand: CommandText, shouldWrite: boolean, unsent: number, pulled?: Record<string, unknown>): Promise<{ gateDetails?: Record<string, unknown>; judgedRoot?: string | null }> {
  if (declared.kind === "none" || !shouldWrite) return {};
  const binding = session.binding;
  if (declared.kind === "unreadable") throw new CliError("GATE_FAILED", `Git could not read ${declared.key} (git config exited ${declared.status}), so a declared sync gate cannot be ruled out; nothing was sent`, {
    details: { reason: "gate_config_unreadable", folder: binding.path, unsent, gate: { key: declared.key, exit_status: declared.status, ...(declared.stderr ? { output_tail: declared.stderr } : {}) } },
    help: `fix what git config --get ${commandToken(declared.key)} reports when run from ${binding.path}, then ${resumeCommand}`,
  });
  const root = await readRootFile(binding.path), judgedRoot = root.kind === "file" ? digestOf(root.bytes) : null;
  const judged = await runHostedSyncGate({ folder: binding.path, origin: binding.origin, bundleId: binding.bundle_id }, declared.gate);
  if (!judged.passed) throw new CliError("GATE_FAILED", `the sync gate ${judged.reason ?? "failed"}; nothing was sent`, {
    details: { reason: "gate_failed", folder: binding.path, unsent, ...(pulled ? { pulled } : {}), gate: judged.details },
    help: `run the gate yourself from ${binding.path} (git config --get ${SYNC_GATE_CONFIG}), fix what it reports, then ${resumeCommand}`,
  });
  return { gateDetails: judged.details, judgedRoot };
}
function sessionBlobScope(session: Session): BlobTargetScope {
  const b = session.binding;
  return { origin: b.origin, prefix: b.routes, bundleId: b.bundle_id, workspaceSlug: b.workspace_slug ?? null };
}
interface BlobDriveRow { request_id: string; key: string; state: "committed" | "conflict" | "refused" | "unknown" | "held"; attempts: number; message?: string; result?: unknown }
interface BlobDriveReport { kept_local_edits?: string[]; rows: BlobDriveRow[]; counts: Record<BlobDriveRow["state"], number>; deletions_held?: { count: number; token: string; files: string[]; allowance: number; observations: { deletions: number; baseline: number }[]; command: CommandText } }
function blobAcceptance(scope: BlobTargetScope, rows: readonly BlobIntentRecord[]): { token: string; allowance: number } {
  const exact = [...rows].sort((a, b) => a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0);
  const allowance = Math.max(...exact.map(row => row.deletionHold!.deletions - 1)) + exact.length;
  if (!exact.length || !Number.isSafeInteger(allowance) || allowance < 1 || allowance > 100000) throw new CliError("CONFLICT", "the held ordinary-file window allowance is outside the supported bound; nothing was accepted");
  return { token: `blobs:${exact.length}:${createHash("sha256").update(JSON.stringify(["superbee.blobs.write-acceptance.v1", scope, exact.map(row => [row.requestId, row.prepared, row.attempts, row.notAppliedThrough, row.deletionHold])])).digest("hex").slice(0, 12)}`, allowance };
}
function prefixHeld(row: BlobIntentRecord): boolean {
  return !row.receipt && (row.state === "pending" || row.state === "unknown") && row.attempts > 0 && row.notAppliedThrough === row.attempts && row.deletionHold !== undefined && decodePreparedBlobIntent(row.prepared).intent.operationId === "blobs.delete.v1";
}
/** Existing lock/session and core loop own authority/delivery; this composition owns selection and persistence. */
async function driveBlobRequests(session: Session, deps: HostedSyncDeps, options: { requestIds?: readonly string[]; acceptToken?: string; gatePresent: boolean; gate: (hasSubmissions: boolean, count: number) => Promise<void> }): Promise<BlobDriveReport> {
  const scope = sessionBlobScope(session), store = session.store;
  const all = await store.listBlobIntents(), requested = options.requestIds === undefined ? undefined : new Set(options.requestIds);
  let selected = all.filter(row => requested ? requested.has(row.requestId) : !row.receipt);
  if (requested && selected.length !== requested.size) throw new CliError("CONFLICT", "an exact ordinary-file request no longer exists; nothing was submitted");
  const out: BlobDriveReport = { rows: [], counts: { committed: 0, conflict: 0, refused: 0, unknown: 0, held: 0 } };
  const report = (row: BlobIntentRecord, message?: string, state?: BlobDriveRow["state"]) => {
    const shown = state ?? (row.state === "acknowledged" ? "committed" : row.state === "conflict" || row.state === "refused" ? row.state : prefixHeld(row) || row.attempts === 0 ? "held" : "unknown");
    const note = message ?? (shown === "conflict" && settledBlobConflict(row) ? blobConflictMessage(row.target) : undefined);
    out.rows.push({ request_id: row.requestId, key: row.target, state: shown, attempts: row.attempts, ...(note ? { message: note } : {}), ...(row.receipt ? { result: row.receipt.result } : {}) });
  };
  const initial = new Map<string, BlobIntentRecord[]>();
  let expectedMap: BlobSyncSnapshot["map"] | undefined;
  for (const row of selected) {
    if (!equalJournalValue(decodePreparedBlobIntent(row.prepared).scope, scope) || !isOrdinaryBlobKey(row.target)) throw new CliError("CONFLICT", `request ${row.requestId} does not match this checkout's ordinary-file scope`);
    const snapshot = await readBlobSyncState(store, row.target, scope);
    if (expectedMap && !equalJournalValue(expectedMap, snapshot.map)) throw new JournalGuardConflict(row.target);
    expectedMap ??= snapshot.map; initial.set(row.target, snapshot.journal.intents);
  }
  const heldCandidates: BlobIntentRecord[] = [];
  for (const row of selected.filter(prefixHeld)) {
    const intents = initial.get(row.target)!;
    if (intents.some(other => other.requestId !== row.requestId && !other.receipt) || !await blobFrozenPhysicalMatches(session.binding.path, { map: expectedMap! }, row)) continue;
    heldCandidates.push(row);
  }
  let acceptance: { token: string; allowance: number } | undefined;
  if (options.acceptToken !== undefined) {
    const candidates = requested ? [heldCandidates] : [heldCandidates, ...heldCandidates.map(row => [row])];
    const matches = candidates.filter(rows => rows.length && blobAcceptance(scope, rows).token === options.acceptToken);
    const unique = new Map(matches.map(rows => [rows.map(row => row.requestId).sort().join(","), rows]));
    if (unique.size !== 1) {
      for (const row of selected) report(row, "the blob acceptance token no longer names the exact eligible held set; nothing was submitted", "held");
      selected = [];
    } else {
      selected = [...unique.values()][0]!;
      acceptance = blobAcceptance(scope, selected);
      const terminal = deps.terminal ?? processTerminal(); assertPersonAtTerminal(session.binding, options.acceptToken, terminal, "blobs");
      const accepted = await confirmAtTerminal(session.binding, terminal, "blobs")({ count: selected.length, ids: selected.map(row => row.target), token: options.acceptToken, allowance: acceptance.allowance, observations: selected.map(row => row.deletionHold!) });
      if (!accepted) { for (const row of selected) report(row, "the person did not confirm this exact held file set", "held"); selected = []; }
      else {
        // Reconstruct before claims; no acceptance survives changes during the prompt.
        const current: BlobIntentRecord[] = [];
        for (const row of selected) {
          const snapshot = await readBlobSyncState(store, row.target, scope), actual = snapshot.journal.intents.find(other => other.requestId === row.requestId);
          if (!actual || !equalJournalValue(snapshot.map, expectedMap) || !equalJournalValue(actual, row) || snapshot.journal.intents.some(other => other.requestId !== row.requestId && !other.receipt) || !await blobFrozenPhysicalMatches(session.binding.path, snapshot, row)) break;
          current.push(actual);
        }
        // A full-set token cannot silently become a subset when another hold appears.
        // Singleton tokens intentionally remain addressable beside unrelated holds.
        let fullSetUnchanged = true;
        if (!requested && selected.length > 1) {
          const eligibleNow: BlobIntentRecord[] = [];
          for (const row of (await store.listBlobIntents()).filter(prefixHeld)) {
            if (!equalJournalValue(decodePreparedBlobIntent(row.prepared).scope, scope)) continue;
            const snapshot = await readBlobSyncState(store, row.target, scope);
            if (snapshot.journal.intents.some(other => other.requestId !== row.requestId && !other.receipt) || !await blobFrozenPhysicalMatches(session.binding.path, snapshot, row)) continue;
            eligibleNow.push(row);
          }
          fullSetUnchanged = eligibleNow.length === selected.length && blobAcceptance(scope, eligibleNow).token === options.acceptToken;
        }
        if (!fullSetUnchanged || current.length !== selected.length || blobAcceptance(scope, current).token !== options.acceptToken) { for (const row of selected) report(row, "the held set changed during confirmation; nothing was submitted", "held"); selected = []; }
      }
    }
  }
  const eligible = new Set<string>();
  for (const row of selected) {
    if (row.receipt) continue;
    const fresh = (row.state === "pending" || row.state === "unknown") && (row.notAppliedThrough ?? 0) === row.attempts && (row.attempts === 0 || acceptance !== undefined);
    if (!fresh || session.capabilities.blobWrites !== "allowed") continue;
    const intents = initial.get(row.target)!;
    if (expectedMap!.entries.find(entry => entry.key === row.target)?.placement || intents.some(other => other.requestId !== row.requestId && !other.receipt)) continue;
    if (options.gatePresent && !await blobFrozenPhysicalMatches(session.binding.path, { map: expectedMap! }, row)) continue;
    eligible.add(row.requestId);
  }
  await options.gate(eligible.size > 0, eligible.size);
  // Gate mutation of any named premise invalidates all affected candidates before a claim.
  for (const row of selected) {
    if (row.receipt) { report(row); continue; }
    let snapshot: BlobSyncSnapshot;
    try {
      snapshot = await readBlobSyncState(store, row.target, scope);
      if (!equalJournalValue(snapshot.map, expectedMap) || !equalJournalValue(snapshot.journal.intents, initial.get(row.target)!)) throw new JournalGuardConflict(row.target);
      if ((options.gatePresent && eligible.has(row.requestId) || acceptance !== undefined) && !await blobFrozenPhysicalMatches(session.binding.path, snapshot, row)) { report(row, "the frozen file or MIME no longer matches what was confirmed or judged by the gate", "held"); continue; }
      const complete = (row.notAppliedThrough ?? 0) === row.attempts;
      if (complete && !eligible.has(row.requestId)) { report(row, row.attempts > 0 ? "this proven held deletion needs current person confirmation" : "this frozen representation cannot be submitted under current capability, gate or journal premises", "held"); continue; }
      const fresh = eligible.has(row.requestId);
      const claimed = fresh ? await store.updateBlobIntent(row.requestId, row.state, { state: "in_flight", attempts: row.attempts + 1 }, { guard: snapshot.journal.guard }) : row;
      const selectedResult = await performHostedBlobDelivery({ scope, adapterFor: signal => createHostedBlobWriteAdapter({ carrier: session.carrier, bundleId: scope.bundleId, prefix: session.routes, signal, capabilities: () => session.client.reader(scope.bundleId).hostedCapabilities() }) }, claimed, {
        start: fresh ? "submit-claimed" : "lookup", ...(fresh && acceptance ? { acceptDeletes: acceptance.allowance } : {}),
        ...(deps.write?.deadlineMs === undefined ? {} : { deadlineMs: deps.write.deadlineMs }), ...(deps.write?.maxLookups === undefined ? {} : { maxLookups: deps.write.maxLookups }), ...(deps.write?.lookupDelayMs === undefined ? {} : { lookupDelayMs: deps.write.lookupDelayMs }), ...(deps.write?.sleep === undefined ? {} : { sleep: deps.write.sleep }), ...(deps.write?.signal === undefined ? {} : { signal: deps.write.signal }),
      });
      const after = await readBlobSyncState(store, row.target, scope);
      if (!equalJournalValue(after.map, expectedMap) || !after.journal.intents.some(actual => equalJournalValue(actual, claimed))) throw new JournalGuardConflict(row.target);
      let saved: BlobIntentRecord;
      if (selectedResult.patch.receipt) {
        const projected = projectBlobSyncReceipt(after.map, claimed, selectedResult.patch);
        saved = await settleBlobSyncReceipt(store, after, claimed, selectedResult.patch); expectedMap = projected;
      } else saved = await store.updateBlobIntent(claimed.requestId, claimed.state, selectedResult.patch, { guard: after.journal.guard });
      report(saved, blobRefusalNote(saved));
      // Reported once: a settled refusal no longer holds its file, which the next sync captures anew.
      if (retirableBlobRefusal(saved)) await retireBlobRefusals(store, scope, [saved.target]);
      if (saved.receipt?.result.ok && !await blobFrozenPhysicalMatches(session.binding.path, { ...after, map: expectedMap! }, saved)) (out.kept_local_edits ??= []).push(saved.target);
    } catch (error) {
      if (!(error instanceof JournalGuardConflict || error instanceof FileJournalUnavailableError || error instanceof RangeError || error instanceof CliError)) throw error;
      report((await store.readBlobIntent(row.requestId)) ?? row, "delivery or receipt persistence is incomplete; durable original evidence is preserved", "unknown");
    }
  }
  const currentHeld: BlobIntentRecord[] = [];
  const reportIds = new Set(out.rows.map(row => row.request_id));
  for (const row of (await store.listBlobIntents()).filter(row => reportIds.has(row.requestId) && prefixHeld(row))) {
    const snapshot = await readBlobSyncState(store, row.target, scope);
    if (!snapshot.journal.intents.some(other => other.requestId !== row.requestId && !other.receipt) && await blobFrozenPhysicalMatches(session.binding.path, snapshot, row)) currentHeld.push(row);
  }
  if (currentHeld.length) {
    const summary = blobAcceptance(scope, currentHeld);
    out.deletions_held = { count: currentHeld.length, token: summary.token, files: currentHeld.map(row => row.target), allowance: summary.allowance, observations: currentHeld.map(row => row.deletionHold!), command: syncCommand(session.binding, commandFragment` --accept-deletes ${commandToken(summary.token)}`) };
  }
  for (const row of out.rows) out.counts[row.state]++;
  return out;
}

/** Exact-request command/confirmation path: no scan, pull, export, document push or root write. */
export async function deliverHostedBlobRequests(binding: CheckoutBinding, requestIds: readonly string[] | undefined, partial: Partial<HostedSyncDeps> = {}, acceptToken?: string, resume?: CommandText): Promise<BlobDriveReport> {
  const deps = hostedDeps(partial), ids = requestIds === undefined ? undefined : [...requestIds];
  const resumeCommand = resume ?? syncCommand(binding, acceptToken ? commandFragment` --accept-deletes ${commandToken(acceptToken)}` : commandFragment``);
  const declared = declaredHostedSyncGate(binding.path);
  return withSession(binding, deps, resumeCommand, session => driveBlobRequests(session, deps, { ...(ids === undefined ? {} : { requestIds: ids }), ...(acceptToken === undefined ? {} : { acceptToken }), gatePresent: declared.kind !== "none", gate: async (fresh, count) => { await judgeHostedWrites(session, declared, resumeCommand, fresh, count); } }));
}
/** Commands enter here only after the offline journal was durably closed. */
export async function finishAdmittedBlob(admitted: OfflineBlobAdmission, operation: "promote" | "delete", partial: Partial<HostedSyncDeps>, mode: OutputMode, resume: CommandText): Promise<void> {
  const deps = hostedDeps(partial);
  let report: BlobDriveReport;
  try { report = await deliverHostedBlobRequests(admitted.binding, admitted.requestIds, deps, undefined, resume); }
  catch (error) {
    if (error instanceof CliError) throw Object.assign(new CliError(error.code, error.message, { details: { ...error.details, request_ids: admitted.requestIds, durable_intent: "preserved", resume }, help: `${error.help ?? "resolve the reported refusal"}; then ${resume}`, handled: error.handled }), { cause: error });
    throw error;
  }
  const failure = blobDeliveryFailure(report), { submitted: _submitted, ...receipt } = admitted.receipt;
  const conflicted = report.rows.filter(row => row.state === "conflict").map(row => row.key);
  const result = { ...receipt, [operation]: failure ? "incomplete" : "committed", status: failure ? "incomplete" : "synced", resumed: admitted.resumed, blobs: report, help: report.deletions_held ? [String(report.deletions_held.command)] : conflicted.length ? blobConflictHelp(admitted.binding, conflicted) : failure ? [String(resume)] : [] };
  deps.stdout(render(result, mode));
  if (failure) throw receiptFailure(failure, result);
}

/** The resolve commands for the first conflicted ordinary file. */
export function blobConflictHelp(binding: CheckoutBinding, keys: readonly string[]): string[] {
  const key = keys[0];
  if (key === undefined) return [];
  return (["keep", "take"] as const).map(choice => `${cliInvocation()} sync --resolve ${choice} --doc ${commandToken(key)} --dir ${commandToken(binding.path)}`);
}

/** The code of a blob row's refusal, when its receipt names one. */
function blobRefusalCode(row: BlobDriveRow): string | undefined {
  const result = row.result as { ok?: unknown; error?: { code?: unknown } } | undefined;
  return row.state === "refused" && result?.ok === false && typeof result.error?.code === "string" ? result.error.code : undefined;
}
/** Refusals of the host's own access (as a document write's PERMISSION_DENIED reads): the bundle is not writable to this person. */
const BLOB_ACCESS_REFUSALS: ReadonlySet<string> = new Set(["insufficient_scope", "bundle_not_found"]);
const BLOB_UNRECORDED: ReadonlySet<string> = new Set(BLOB_UNRECORDED_REFUSAL_CODES);
/** What a refusal the host never recorded means for the person; the file is captured anew on the next sync. */
function blobRefusalNote(row: BlobIntentRecord): string | undefined {
  const result = row.receipt?.result;
  if (row.state !== "refused" || !result || result.ok || !BLOB_UNRECORDED.has(result.error.code)) return undefined;
  return result.error.code === "request_capacity"
    ? `${row.target} was not sent: the sync quota is used up. Nothing was lost; run sync again later and it is sent again.`
    : `${row.target} was not sent: the host refused writes to this bundle for this sign-in. Nothing was lost; it is sent again on a sync once access returns.`;
}

/**
 * The exit for a blob delivery, classed as document writes are: a held file, a conflict or a
 * content refusal needs the person (CONFLICT); a refusal of access to the bundle is FORBIDDEN, as
 * a document write's PERMISSION_DENIED is; the sync quota and lost answers are TRANSIENT.
 */
export function blobDeliveryFailure(report: BlobDriveReport): { code: "CONFLICT" | "FORBIDDEN" | "TRANSIENT"; message: string } | null {
  if (report.rows.every(row => row.state === "committed") && !report.kept_local_edits?.length) return null;
  const message = "ordinary-file delivery is incomplete; preserved requests remain available for recovery";
  if (report.rows.some(row => row.state === "held" || row.state === "conflict" || (row.state === "refused" && !BLOB_UNRECORDED.has(blobRefusalCode(row) ?? "")))) return { code: "CONFLICT", message };
  if (report.rows.some(row => BLOB_ACCESS_REFUSALS.has(blobRefusalCode(row) ?? ""))) return { code: "FORBIDDEN", message: "ordinary-file delivery is incomplete: the host refused writes to this bundle" };
  return { code: "TRANSIENT", message };
}

async function blobCaptureContext(session: Session, deps: HostedSyncDeps): Promise<BlobCaptureContext | undefined> {
  if (await session.store.readMeta(BLOB_SYNC_META_KEY) === undefined) return undefined;
  const { binding } = session, via = resolveHostedVia(deps.auth.env).token;
  return { store: session.store, scope: { origin: binding.origin, prefix: binding.routes, bundleId: binding.bundle_id, workspaceSlug: binding.workspace_slug ?? null }, binding: checkoutBindingDigest(binding.checkout_id), ...(via === undefined ? {} : { via }), createdAt: new Date(deps.auth.now()).toISOString(), allowed: session.capabilities.blobWrites === "allowed" };
}

function blobRefresh(session: Session, acceptToken?: string): Promise<BlobRefreshReport | undefined> {
  const { binding } = session;
  return refreshBlobCheckout({ folder: binding.path, store: session.store, scope: { origin: binding.origin, prefix: binding.routes, bundleId: binding.bundle_id, workspaceSlug: binding.workspace_slug ?? null }, carrier: session.carrier, capabilities: async () => session.capabilities, ...(acceptToken?.startsWith("blobs:") ? { acceptToken } : {}) });
}
function blobPulledView(report: BlobRefreshReport): Record<string, unknown> {
  return { refreshed: report.refreshed.length, removed: report.removed.length, metadata_updated: report.metadataUpdated.length,
    ...(report.kept.length ? { kept_local_edits: [...new Set(report.kept)].slice(0, 20) } : {}),
    ...(report.refused ? { refused_deletions: { reason: report.refused.reason, count: report.refused.deletions, token: blobHostDeletionsToken(report.refused), message: "The host's ordinary-file listing would remove an unusually large set; none of these files were removed. Confirm the bundle really shrank before taking the host deletions." } } : {}) };
}

async function runSync(binding: CheckoutBinding, values: HostedValues, deps: HostedSyncDeps, mode: OutputMode): Promise<void> {
  const limit = rowLimit(values.limit);
  const resumeCommand = syncCommand(binding, values.json ? commandLiteral(" --json") : commandFragment``);
  const acceptDeletes = values["accept-deletes"];
  if (acceptDeletes?.startsWith("blobs:")) {
    const report = await deliverHostedBlobRequests(binding, undefined, deps, acceptDeletes);
    const failure = blobDeliveryFailure(report);
    deps.stdout(render(withSyncEnvelope({ sync: "hosted", bundle_id: binding.bundle_id, host: binding.origin, folder: binding.path, status: failure ? "incomplete" : "synced", blobs: report }, syncEnvelope("hosted", { sent: report.counts.committed, received: 0, conflicts: report.counts.conflict, held: report.counts.held, next: report.deletions_held ? [String(report.deletions_held.command)] : [] })), mode));
    if (failure) throw receiptFailure(failure, { blobs: report });
    return;
  }
  const terminal = deps.terminal ?? processTerminal();
  if (acceptDeletes !== undefined) assertPersonAtTerminal(binding, acceptDeletes, terminal);
  // F8: private state copied into the checkout refuses the run before anything is journaled or sent.
  refuseTreePrivateState(binding.path, "sync", String(resumeCommand));
  const takeHostDeletions = values["take-host-deletions"];
  // From the person's own Git configuration, never from the folder's documents or the host.
  const declared: HostedGateDeclaration = declaredHostedSyncGate(binding.path);
  let failure: CliError | null = null;
  const receipt = await withSession(binding, deps, resumeCommand, async (session) => {
    const { store, local, reader, projection } = session;
    // An earlier run that died mid-push left its claims in flight; this run holds the lock, so no
    // push is live, and each such change is looked up before it is ever sent again.
    await reclaimInFlight(local);
    const scan = await scanCheckout({
      blobs: await blobCaptureContext(session, deps),
      folder: binding.path,
      bundleId: binding.bundle_id,
      okfVersion: session.okfVersion,
      local,
      projection,
      definitionWrites: session.capabilities.definitionWrites,
      rootWrites: session.capabilities.rootWrites,
      documentInputBytes: session.capabilities.documentInputBytes,
      ...(acceptDeletes !== undefined ? { acceptDeletes, confirmAccept: confirmAtTerminal(binding, terminal) } : {}),
    });
    await session.persist();
    const unsent = async () => (await store.listIntents(UNSETTLED_STATES)).length;
    // `--take-host-deletions` names the refusal the last pull recorded; it applies only while the
    // host still lists exactly the state that was refused, so a listing that moved is refused anew.
    const lastRefused = takeHostDeletions !== undefined && !takeHostDeletions.startsWith("blobs:") ? await lastRefusedDeletions(store) : undefined;
    const accepted = lastRefused !== undefined && hostDeletionsToken(lastRefused) === takeHostDeletions ? lastRefused : undefined;
    let taken: Record<string, unknown> | undefined;
    const pullAndExport = async (acceptRefusedDeletions?: DeletionRefusal) => {
      let report: PullReport;
      try {
        report = await pull(local, reader, acceptRefusedDeletions ? { acceptRefusedDeletions } : {});
      } catch (error) {
        throw await readFailure(error, session, resumeCommand, await unsent());
      }
      if (report.held.length > 0 || session.unsafeIds.size > 0) await forgetPullDigest(store);
      const placed = await exportCheckout(binding.path, store, projection);
      await session.persist();
      return { report, placed };
    };
    // Push always follows a pull in the same run, so nothing is sent against a stale listing.
    const first = await pullAndExport(accepted);
    const blobs = await blobRefresh(session, takeHostDeletions);
    if (takeHostDeletions !== undefined && !takeHostDeletions.startsWith("blobs:")) {
      taken =
        accepted === undefined
          ? { taken: false, message: `the token given (${JSON.stringify(takeHostDeletions)}) does not name the host deletions the last sync refused${lastRefused ? ` (${hostDeletionsToken(lastRefused)})` : " (none is recorded)"}; nothing was removed` }
          : first.report.refused
            ? { taken: false, message: "the host's listing changed since that refusal, so nothing was removed; check the new refused_deletions" }
            : { taken: true, removed: first.placed.removed.length, message: "the host's deletions were taken: their files are removed from the folder, apart from files you edited" };
    }
    if (takeHostDeletions?.startsWith("blobs:")) taken = { taken: blobs?.taken === true, removed: blobs?.removed.length ?? 0, message: blobs?.taken ? "the confirmed ordinary-file deletions were taken where the files remained clean" : "the blob token does not authorize this current deletion set; check pulled.blobs.refused_deletions if present, or run sync without that token to use ordinary deletion policy" };
    await recordPulled(deps.auth.home, binding.checkout_id);
    // The declared sync gate judges the folder after the pull placed the host's changes and before
    // anything is sent: a failure sends nothing, no document and no front page.
    let gateDetails: Record<string, unknown> | undefined;
    let judgedRoot: string | null | undefined;
    const blobOutcome = await driveBlobRequests(session, deps, { gatePresent: declared.kind !== "none", gate: async (fresh, count) => {
      const judged = await judgeHostedWrites(session, declared, resumeCommand, fresh || await wouldSend(session), await unsent() + count, { ...pulledView(binding, first.report, first.placed.placed, first.placed.removed, first.placed.kept), ...(blobs ? { blobs: blobPulledView(blobs) } : {}) });
      gateDetails = judged.gateDetails; judgedRoot = judged.judgedRoot;
    } });
    let outcome: PushOutcome;
    const heldSink: { value?: { deletions: number; baseline: number } } = {};
    try {
      outcome = await pushChanges(session, deps, scan.acceptDeletes, heldSink);
    } catch (error) {
      // The deletes the host held before the push failed stay parked; keep its counts with them.
      await recordHostHold(store, heldSink.value, scan.hold).catch(() => undefined);
      throw await readFailure(error, session, resumeCommand, await unsent());
    }
    // The deletes the host held join the scan's held set: one hold, one token to accept it. Kept
    // before anything else can fail, so the host's counts are never lost.
    const hold = await recordHostHold(store, heldSink.value, scan.hold);
    // A document the pull held for a change that has now committed may have changed on the host
    // meanwhile: pull it once more so the folder is current when the run says so.
    // The host may also have stored a sent document with fields of its own (actor, clock); that
    // pull brings its bytes into the folder in place of the ones sent.
    const restamped = await hostRestamped(store, outcome.acknowledged, binding.path, projection);
    const second =
      first.report.held.some((id) => outcome.acknowledged.has(id)) || restamped.size > 0 ? await pullAndExport() : null;
    const pulled = second?.report ?? first.report;
    // The front page, after the documents: settled, pulled, or sent against its base.
    let root: RootStepReport;
    try {
      root = await rootStep(session, deps, true, judgedRoot);
    } catch (error) {
      throw await readFailure(error, session, resumeCommand, await unsent());
    }
    const exported = {
      // A document this run sent and only took back with the host's stamps is not one received
      // (accepted: a change by someone else in the same instant is not counted either, and after
      // a crash between the acknowledgement and this pull, the next run counts it once).
      placed: [
        ...first.placed.placed,
        ...(second?.placed.placed ?? []).filter((id) => !restamped.has(id)),
        ...(root.refreshed ? [ROOT_INDEX] : []),
      ],
      removed: [...first.placed.removed, ...(second?.placed.removed ?? [])],
      kept: second?.placed.kept ?? first.placed.kept,
      held: second?.placed.held ?? first.placed.held,
    };
    // The closing pass: a file edited during this run against a document the pull refreshed or
    // removed is a conflict now, so the run that saw it never reports itself in sync.
    const conflicts = await folderConflicts(binding.path, store, projection, session.okfVersion);
    // After the run's last placement: a file changed later is an edit this run did not see.
    await recordSynced(deps.auth.home, binding.checkout_id);
    const inbound = await inboundLinks(store, outcome.deleted, session.okfVersion);
    const rows = buildRows({
      folderConflicts: conflicts,
      unsettled: await store.listIntents(UNSETTLED_STATES),
      acknowledged: outcome.acknowledged,
      deleted: inbound,
      held: [...scan.held.filter(row => !blobOutcome.rows.some(blob => blob.key === row.id && blob.key === row.path)), ...exported.held, ...(blobs?.held.filter(row => !blobOutcome.rows.some(blob => blob.key === row.key)).map(row => ({ id: row.key, path: row.key, reason: row.reason, message: row.message })) ?? []), ...unsafeIdRows(session.unsafeIds)],
      blocked: outcome.collisions,
      accessWithdrawn: outcome.accessWithdrawn,
      notSent: outcome.notSent,
      ...(root.row ? { root: root.row } : {}),
    });
    const counts = countRows(rows);
    const shown = rows.slice(0, limit);
    const record: Record<string, unknown> = {
      sync: "hosted",
      bundle_id: binding.bundle_id,
      host: binding.origin,
      folder: binding.path,
      status: rows.every((row) => row.state === "committed") && blobDeliveryFailure(blobOutcome) === null ? (rows.length === 0 && blobOutcome.rows.length === 0 ? "up_to_date" : "synced") : "incomplete",
      pulled: { ...pulledView(binding, pulled, exported.placed, exported.removed, exported.kept), ...(blobs ? { blobs: blobPulledView(blobs) } : {}) },
      ...(taken ? { take_host_deletions: taken } : {}),
      ...(hold
        ? {
            deletions_held: {
              count: hold.count,
              documents: hold.ids.slice(0, 50),
              window_deletions: hold.deletions,
              baseline: hold.baseline,
              ...(hold.basis === "originals" ? { counted_over: "the documents this checkout did not create itself" } : {}),
              ...(hold.basis === "bundle" ? { counted_over: "every deletion in the hosted bundle over the last 24 hours, by anyone", held_by: "host" } : {}),
              ...(hold.pending ? { held_since_earlier_sync: true } : {}),
              ...(hold.acceptMismatch !== undefined ? { accept_mismatch: `the token given (${JSON.stringify(hold.acceptMismatch)}) does not name the held set (${hold.token}); nothing was accepted` } : {}),
              ...(hold.acceptDeclined ? { accept_declined: `the typed confirmation was not ${hold.count}; nothing was accepted` } : {}),
              restore: syncCommand(binding, commandLiteral(" --restore-deletes")),
              confirmation_required: {
                agent_instruction: `Do not run this yourself: it needs the person to type a confirmation in their own terminal, and it refuses any other shell. Name these ${hold.count} documents to the person, and ask them to run the command in their terminal if they want them removed from the bundle; otherwise restore the files.`,
                token: hold.token,
                command_for_person: syncCommand(binding, commandFragment` --accept-deletes ${commandToken(hold.token)}`),
              },
            },
          }
        : {}),
      ...(scan.accepted !== undefined ? { deletions_accepted: scan.accepted } : {}),
      ...(outcome.via?.ignored !== undefined ? { via_ignored: outcome.via.ignored } : {}),
      ...(scan.deleted.length > 0
        ? { deletions: scan.deleted.map((row) => ({ id: row.id, ...(row.inbound.length > 0 ? { still_linked_from: row.inbound.slice(0, 20), warning: `${row.inbound.length} document(s) still link to '${row.id}'; the links are left as they are` } : {}) })) }
        : {}),
      ...(gateDetails ? { gate: `passed: ${String(gateDetails.command)} (attempt ${String(gateDetails.attempt)})` } : {}),
      counts,
      ...(blobOutcome.rows.length ? { blobs: blobOutcome } : {}),
      rows: shown,
      ...(shown.length < rows.length ? { rows_shown: shown.length, rows_total: rows.length, rows_all: syncCommand(binding, commandFragment` --limit ${commandToken(String(rows.length))}`) } : {}),
      help: [
        ...blobConflictHelp(binding, [...new Set((await store.listBlobIntents("conflict")).filter(settledBlobConflict).map(row => row.target))]),
        ...rowHelp(rows, binding),
        ...(blobOutcome.deletions_held ? [String(blobOutcome.deletions_held.command)] : []),
        ...(blobs?.refused ? [`only if the ordinary-file set really shrank: ${syncCommand(binding, commandFragment` --take-host-deletions ${commandToken(blobHostDeletionsToken(blobs.refused))}`)}`] : []),
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
    const exit = rowsFailure(rows, blobs !== undefined) ?? blobDeliveryFailure(blobOutcome);
    if (exit) failure = receiptFailure(exit, { counts });
    return record;
  });
  if (receipt) deps.stdout(render(withSyncEnvelope(receipt, hostedSyncEnvelope(receipt)), mode));
  if (failure) throw failure;
}

/** The one sync envelope, from a hosted run receipt's own keys (its counts, pulled and help). */
function hostedSyncEnvelope(receipt: Record<string, unknown>): SyncEnvelope {
  const counts = (receipt.counts ?? {}) as Record<string, number | undefined>;
  const pulled = (receipt.pulled ?? {}) as Record<string, number | undefined>;
  const blobs = (receipt.pulled as { blobs?: { refreshed: number; removed: number; metadata_updated: number } } | undefined)?.blobs;
  const help = Array.isArray(receipt.help) ? receipt.help.map(String) : [];
  const delivered = receipt.blobs as BlobDriveReport | undefined;
  return syncEnvelope("hosted", { sent: (counts.committed ?? 0) + (delivered?.counts.committed ?? 0), received: (pulled.refreshed ?? 0) + (pulled.removed ?? 0) + (blobs ? blobs.refreshed + blobs.removed + blobs.metadata_updated : 0), conflicts: (counts.conflict ?? 0) + (delivered?.counts.conflict ?? 0), held: (counts.held ?? 0) + (delivered?.counts.held ?? 0), next: help });
}

/** What a pull-only pass did, or why it did not run. */
export type HostedPullResult =
  | { readonly state: "pulled"; readonly refreshed: number; readonly removed: number; readonly kept: number; readonly held?: number; readonly blobs?: Record<string, unknown> }
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
  const state = await withIdleCheckoutStore(
    binding,
    home,
    async (store) => {
      if ((await store.listIntents(UNSETTLED_STATES)).length > 0) return "changed" as const;
      const projection = await readProjection(home, binding.checkout_id, store);
      return (await folderMatchesProjection(binding.path, projection)) ? ("clean" as const) : ("changed" as const);
    },
    { readOnly: false },
  );
  return state ?? "busy";
}

async function pullOnly(binding: CheckoutBinding, session: Session, deps: HostedSyncDeps, resumeCommand: CommandText): Promise<HostedPullResult> {
  {
    const { store, local, reader, projection } = session;
    // As in sync: an interrupted push's claims are looked up before anything could send them.
    await reclaimInFlight(local);
    const scan = await scanCheckout({ blobs: await blobCaptureContext(session, deps), folder: binding.path, bundleId: binding.bundle_id, okfVersion: session.okfVersion, local, projection, definitionWrites: session.capabilities.definitionWrites, documentInputBytes: session.capabilities.documentInputBytes, rootWrites: session.capabilities.rootWrites });
    await session.persist();
    let report: PullReport;
    try {
      report = await pull(local, reader);
    } catch (error) {
      throw await readFailure(error, session, resumeCommand, (await store.listIntents(UNSETTLED_STATES)).length);
    }
    if (report.held.length > 0 || session.unsafeIds.size > 0) await forgetPullDigest(store);
    const placed = await exportCheckout(binding.path, store, projection);
    await session.persist();
    const blobs = await blobRefresh(session);
    // The front page too: an unedited one takes the host's bytes; nothing is sent.
    let root: RootStepReport;
    try {
      root = await rootStep(session, deps, false);
    } catch (error) {
      throw await readFailure(error, session, resumeCommand, (await store.listIntents(UNSETTLED_STATES)).length);
    }
    await recordPulled(deps.auth.home, binding.checkout_id);
    return { state: "pulled", refreshed: placed.placed.length + (root.refreshed ? 1 : 0), removed: placed.removed.length, kept: placed.kept.length, ...((scan.blobHeld !== undefined || blobs?.held.length) ? { held: new Set([...scan.held.map(row => row.id), ...(blobs?.held.map(row => row.key) ?? [])]).size } : {}), ...(blobs ? { blobs: blobPulledView(blobs) } : {}) };
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
    throw await readFailure(error, session, resumeCommand, 0);
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
    file: path.join(binding.path, id === ROOT_INDEX ? ROOT_INDEX : `${id}.md`),
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

/** Filesystem conflict resolutions have no engine receipt, so retain their local recovery evidence. */
function folderResolutionKey(id: string): string {
  return `cli-folder-resolved:${id}`;
}

interface ResolutionRecord {
  choice?: string;
  /** Interrupted resolution evidence only; sequence order cannot identify its replacement intent. */
  after?: number;
  /** The intents the resolution journaled, once it completed. */
  requestIds?: string[];
}

/**
 * Record an unfinished filesystem choice before it journals anything. Until exact identities
 * are recorded, recovery preserves pending work rather than inferring identity from sequence order.
 */
async function beginFolderResolution(store: JournaledBackend, id: string, choice: "keep" | "take" | "revise"): Promise<void> {
  if (choice === "take") return;
  const after = (await store.listIntents()).reduce((max, row) => Math.max(max, row.sequence), 0);
  await store.writeMeta(folderResolutionKey(id), { choice, after } satisfies ResolutionRecord);
}

async function recordFolderResolution(store: JournaledBackend, id: string, choice: "keep" | "take" | "revise"): Promise<void> {
  if (choice === "take") {
    await store.writeMeta(folderResolutionKey(id), null);
    return;
  }
  const requestIds = (await store.readWithJournal(id)).intents.filter((row) => row.state !== "acknowledged").map((row) => row.requestId);
  await store.writeMeta(folderResolutionKey(id), { choice, requestIds } satisfies ResolutionRecord);
}

/** True when `row` is the change the recorded resolution journaled. */
function isResolution(record: ResolutionRecord | null | undefined, row: { requestId: string }): boolean {
  return !!record?.choice && Array.isArray(record.requestIds) && record.requestIds.includes(row.requestId);
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
  const { binding, store, projection, local } = session;
  const file = path.join(binding.path, `${id}.md`);
  const rows = (await store.readWithJournal(id)).intents.filter((row) => row.state !== "acknowledged");
  const receipt = await readConflictResolution(local, id);
  const folder = await store.readMeta<ResolutionRecord | null>(folderResolutionKey(id));
  const journal: ResolutionRecord | undefined = receipt
    ? { choice: receipt.choice === "keep-local" ? "keep" : receipt.choice === "revise" ? "revise" : "take", requestIds: receipt.replacementRequestId === null ? [] : [receipt.replacementRequestId] }
    : undefined;
  // Legacy metadata is read only for stores predating the engine index. New journal resolutions
  // never write it; keep this fallback until those pending resolutions have been drained.
  const earlier = folder && rows[0] && isResolution(folder, rows[0]) ? folder
    : journal ?? folder ?? await store.readMeta<ResolutionRecord | null>(`cli-resolved:${id}`);
  const sync = syncCommand(binding);
  if (earlier?.choice && rows.length > 0 && !Array.isArray(earlier.requestIds) && typeof earlier.after === "number") {
    throw new CliError("CONFLICT", `'${id}' has an interrupted resolution whose replacement identity is unknown; its pending work is preserved`, {
      details: { reason: "resolution_identity_unknown", id, earlier: earlier.choice, states: rows.map((row) => row.state) },
      help: `run ${sync} to send the existing edit; if it reports a conflict on '${id}', inspect and resolve that one`,
    });
  }
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
    meta: [
      { key: baseKey(id), value: { version: row.base, content: row.baseContent } },
      { key: folderResolutionKey(id), value: null },
      { key: `cli-resolved:${id}`, value: null },
    ],
  });
  // A missing file (a kept deletion) is placed back; a file still holding its recorded bytes is replaced.
  if (bytes === null) delete projection.files[id];
  const exported = await exportCheckout(binding.path, store, projection, { only: new Set([id]), placeMissing: true });
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
async function assertInspectedCurrent(session: Session, id: string, current: string | null, choice: "keep" | "take" | "revise"): Promise<void> {
  const inspected = await session.store.readMeta<{ remote?: string | null } | null>(inspectedKey(id));
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

/** True when a person's `--doc` names the bundle's root `index.md` (the front page), not a document. */
function namesRoot(input: string): boolean {
  return conceptIdFromPath(input.trim()) === "index";
}

/** `--out` resolved, refused when it would land inside the checkout (it would sync as a document). */
async function inspectOut(binding: CheckoutBinding, values: HostedValues, deps: HostedSyncDeps, resumeCommand: CommandText): Promise<string | undefined> {
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
  return out;
}

/** The front page's conflict now, or the CLI error that says there is none. */
async function rootConflictFor(session: Session): Promise<{ host: HostRoot; base: string | null; bytes: Buffer }> {
  const host = await hostRoot(session.reader);
  // A write whose answer was lost is settled first: it may be the very change the host now holds.
  await settleRootSent(session.projection, session.store, host, session.persist);
  const conflict = await rootConflict(session.binding.path, session.projection, session.store, host);
  if (!conflict) {
    throw new CliError("NOT_FOUND", `'${ROOT_INDEX}' has no conflict to resolve in this checkout`, {
      details: { id: ROOT_INDEX, folder: session.binding.path },
      help: syncCommand(session.binding),
    });
  }
  return conflict;
}

/** `--inspect --doc index.md`: the front page's base, your file and the host's version. */
async function runInspectRoot(binding: CheckoutBinding, values: HostedValues, deps: HostedSyncDeps, mode: OutputMode): Promise<void> {
  const doc = commandToken(ROOT_INDEX);
  const dir = commandToken(binding.path);
  const resumeCommand = commandFragment`${cliInvocation()} sync --inspect --doc ${doc} --dir ${dir}`;
  const out = await inspectOut(binding, values, deps, resumeCommand);
  const record = await withSession(binding, deps, resumeCommand, async (session) => {
    let conflict;
    try {
      conflict = await rootConflictFor(session);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw await readFailure(error, session, resumeCommand, 0);
    }
    const { host, base, bytes } = conflict;
    await session.store.writeMeta(inspectedKey(ROOT_INDEX), { remote: host?.version ?? null, tombstone: null });
    if (out !== undefined) {
      if (host === null) throw new CliError("NOT_FOUND", `the host has no front page to write for this bundle`, { details: { id: ROOT_INDEX } });
      await fs.writeFile(out, host.content);
    }
    const stored = await session.store.readReserved("", "index.md");
    const keep = `${cliInvocation()} sync --resolve keep --doc ${doc} --dir ${dir}`;
    const take = `${cliInvocation()} sync --resolve take --doc ${doc} --dir ${dir}`;
    return {
      conflict: ROOT_INDEX,
      file: path.join(binding.path, ROOT_INDEX),
      reason: "changed_remotely",
      base: { version: base, ...preview(stored && stored.version === base ? stored.content : null) },
      local: { version: digestOf(bytes), ...preview(bytes.toString("utf8")) },
      remote: { version: host?.version ?? null, ...preview(host?.content ?? null) },
      ...(out !== undefined ? { remote_written_to: out } : {}),
      choices: {
        keep: "keep your front page: the next sync sends it over the host's version (edit the file first to combine the two)",
        take: "replace your front page with the host's",
      },
      help: [keep, take],
    };
  });
  deps.stdout(render(record, mode));
}

/**
 * `--resolve take|keep|revise --doc index.md`. take places the host's front page; keep (and
 * revise, the same for a file that is never journaled) moves the base to the host's version, so
 * the next sync sends the file as it is then against it. keep needs an `--inspect` of exactly that
 * version, as a document's does. Nothing is sent here.
 */
async function runResolveRoot(binding: CheckoutBinding, choice: "keep" | "take" | "revise", deps: HostedSyncDeps, mode: OutputMode): Promise<void> {
  const resumeCommand = commandFragment`${cliInvocation()} sync --resolve ${commandToken(choice)} --doc ${commandToken(ROOT_INDEX)} --dir ${commandToken(binding.path)}`;
  const record = await withSession(binding, deps, resumeCommand, async (session) => {
    const { projection, store } = session;
    let conflict;
    try {
      conflict = await rootConflictFor(session);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw await readFailure(error, session, resumeCommand, 0);
    }
    const { host, bytes } = conflict;
    if (choice !== "take" && session.capabilities.rootWrites !== "allowed") {
      throw new CliError("CONFLICT", `the host does not take changes to this bundle's front page from you, so '${choice}' could never be sent`, {
        details: { reason: "root_writes_refused", id: ROOT_INDEX },
        help: `${cliInvocation()} sync --resolve take --doc ${commandToken(ROOT_INDEX)} --dir ${commandToken(binding.path)} (or edit the front page in the Superbee app)`,
      });
    }
    await assertInspectedCurrent(session, ROOT_INDEX, host?.version ?? null, choice);
    const file = path.join(binding.path, ROOT_INDEX);
    let fileState = "unchanged";
    if (choice === "take") {
      // Recorded before the file moves, so a crash mid-take leaves nothing recovery must keep.
      const key = conceptIdFromPath(ROOT_INDEX);
      projection.discarded = { ...projection.discarded, [key]: digestOf(bytes) };
      await session.persist();
      const placed = host ? (await replaceGuarded(file, bytes, Buffer.from(host.content, "utf8"))).placed : await removeGuarded(file, bytes);
      delete projection.discarded[key];
      if (!placed) throw new CliError("CONFLICT", `${file} changed while resolving it`, { details: { reason: "stale_review", id: ROOT_INDEX }, help: resumeCommand });
      if (host) await adoptHostRoot(projection, store, host);
      else {
        projection.root = null;
        projection.rootBase = null;
      }
      delete projection.rootConflicted;
      fileState = host ? "replaced" : "removed";
    } else {
      await moveRootBase(projection, store, host);
    }
    await store.writeMeta(inspectedKey(ROOT_INDEX), null);
    await session.persist();
    return resolvedRecord(binding, ROOT_INDEX, choice, fileState, choice !== "take");
  });
  deps.stdout(render(record, mode));
}

async function runInspect(binding: CheckoutBinding, values: HostedValues, deps: HostedSyncDeps, mode: OutputMode): Promise<void> {
  if (namesRoot(values.inspect!)) return runInspectRoot(binding, values, deps, mode);
  const id = documentId(values.inspect!);
  const resumeCommand = commandFragment`${cliInvocation()} sync --inspect --doc ${commandToken(id)} --dir ${commandToken(binding.path)}`;
  const out = await inspectOut(binding, values, deps, resumeCommand);
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
  const held = unsendable(id, `${id}.md`, bytes, stored.document?.doc ?? null, { bundleId: session.binding.bundle_id, okfVersion: session.okfVersion, documentInputBytes: session.capabilities.documentInputBytes }, { definitionWrites: session.capabilities.definitionWrites });
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
  const choice = values.resolve as "keep" | "take" | "revise";
  if (namesRoot(values.doc!)) return runResolveRoot(binding, choice, deps, mode);
  const id = documentId(values.doc!);
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
    await assertInspectedCurrent(session, id, remoteVersionOf(conflict), choice);
    let fileState: string;
    if (conflict.kind === "folder") {
      // A folder conflict knows no tombstone; its re-create still waits for an inspection of the deletion.
      if (conflict.deleted && choice !== "take") await assertInspectedTombstone(session, id, null, choice);
      await beginFolderResolution(store, id, choice);
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
        throw await readFailure(error, session, resumeCommand, 0);
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
    if (conflict.kind === "folder") await recordFolderResolution(store, id, choice);
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
  const named = values.inspect ?? values.doc;
  const blobKey = named !== undefined && (values.inspect !== undefined || values.resolve !== undefined) ? await trackedBlobKey(binding, deps, named) : undefined;
  if (blobKey !== undefined && values.inspect !== undefined) return runInspectBlob(binding, blobKey, values, deps, mode);
  if (blobKey !== undefined && values.resolve !== undefined) return runResolveBlob(binding, blobKey, values.resolve as "keep" | "take" | "revise", deps, mode);
  if (values.inspect !== undefined) return runInspect(binding, values, deps, mode);
  if (values.resolve !== undefined) return runResolve(binding, values, deps, mode);
  if (values["restore-deletes"]) return runRestore(binding, deps, mode);
  return runSync(binding, values, deps, mode);
}

function bindingBlobScope(binding: CheckoutBinding): BlobTargetScope {
  return { origin: binding.origin, prefix: binding.routes, bundleId: binding.bundle_id, workspaceSlug: binding.workspace_slug ?? null };
}
/** The private store under the checkout lock (waited for, as sync waits), with no sign-in and no request. */
function withLocalStore<T>(binding: CheckoutBinding, deps: HostedSyncDeps, body: (store: FileJournaledBackend) => Promise<T>, readOnly = true): Promise<T> {
  return filesystemPushRoleLocks(deps.lockWaitMs !== undefined ? { waitMs: deps.lockWaitMs } : {})
    .request(checkoutLockName(binding.path), {}, async () => {
      const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(deps.auth.home, binding.checkout_id), readOnly });
      try { return await body(store); } finally { await store.close(); }
    })
    .catch((error: unknown) => { throw lockFailure(error, binding.path); });
}

/** The ordinary-file key `input` names when this checkout tracks it (a baseline or a journal row); read offline. */
async function trackedBlobKey(binding: CheckoutBinding, deps: HostedSyncDeps, input: string): Promise<string | undefined> {
  const key = input.trim();
  if (key.endsWith(".md") || !isOrdinaryBlobKey(key)) return undefined;
  const tracked = await withLocalStore(binding, deps, async store =>
    decodeBlobSyncMap(await store.readMeta(BLOB_SYNC_META_KEY), bindingBlobScope(binding)).entries.some(entry => entry.key === key) || (await store.listBlobIntents()).some(row => row.target === key));
  return tracked ? key : undefined;
}

/** `--inspect --doc <file>` for an ordinary file: the recorded conflict's pins, read offline. */
async function runInspectBlob(binding: CheckoutBinding, key: string, values: HostedValues, deps: HostedSyncDeps, mode: OutputMode): Promise<void> {
  if (values.out !== undefined) throw new CliError("USAGE", "--out writes a document's host version; an ordinary-file inspection reports versions and MIME only", { help: `${cliInvocation()} sync --inspect --doc ${commandToken(key)} --dir ${commandToken(binding.path)}` });
  const found = await withLocalStore(binding, deps, store => readBlobConflict(store, bindingBlobScope(binding), key));
  if (found.state !== "conflict") throw new CliError(found.state === "none" ? "NOT_FOUND" : "CONFLICT", found.state === "none" ? `'${key}' has no ordinary-file conflict to inspect in this checkout` : `'${key}' has ${found.state === "placement" ? "unfinished placement evidence" : "a request still awaiting delivery or its answer"}`, { details: { reason: found.state === "none" ? "no_conflict" : found.state === "placement" ? "blob_placement_recovery" : "blob_outstanding", key }, help: String(syncCommand(binding)) });
  const e = found.evidence, file = path.join(binding.path, ...key.split("/"));
  const bytes = await readIfPresent(file);
  const [keep, take] = blobConflictHelp(binding, [key]);
  deps.stdout(render({
    conflict: key, route: "blob", file, reason: e.actual === null ? "deleted_remotely" : "changed_remotely", request_id: e.requestId, operation: e.operation,
    base: { version: e.expected, content_type: e.expectedContentType },
    local: e.version === null ? { deleted: true } : { version: e.version, content_type: e.contentType },
    remote: e.actual === null ? { deleted: true } : { version: e.actual, content_type: e.actualContentType },
    file_now: bytes === null ? "missing" : e.version !== null && digestOf(bytes) === e.version ? "as_conflicted" : "edited_since_conflict",
    choices: {
      keep: e.actual === null ? "re-create the file on the host from your copy (a new create request), or keep your deletion" : bytes === null && e.operation !== "blobs.delete.v1" ? "refused while the file is missing: put it back first (keep would delete the host's version)" : "keep your file: the next sync sends it as it is then over the host's version",
      take: e.actual === null ? "accept the deletion: the file is removed" : "replace your file with the host's version",
    },
    help: [keep, take],
  }, mode));
}

/** `--resolve keep|take|revise --doc <file>` for an ordinary file; revise is keep (the next sync sends the file as it is). */
async function runResolveBlob(binding: CheckoutBinding, key: string, requested: "keep" | "take" | "revise", deps: HostedSyncDeps, mode: OutputMode): Promise<void> {
  const choice = requested === "take" ? "take" : "keep";
  const resumeCommand = commandFragment`${cliInvocation()} sync --resolve ${commandToken(requested)} --doc ${commandToken(key)} --dir ${commandToken(binding.path)}`;
  const scope = bindingBlobScope(binding);
  let resolution: BlobConflictResolution;
  if (choice === "keep") {
    const via = resolveHostedVia(deps.auth.env).token;
    const identity = { binding: checkoutBindingDigest(binding.checkout_id), ...(via === undefined ? {} : { via }), createdAt: new Date(deps.auth.now()).toISOString() };
    resolution = await withLocalStore(binding, deps, store => resolveBlobConflict({ folder: binding.path, store, scope, key, choice, identity }), false);
  } else {
    // A refusal needs no sign-in: settle it from local state first.
    const found = await withLocalStore(binding, deps, store => readBlobConflict(store, scope, key));
    if (found.state !== "conflict") await withLocalStore(binding, deps, store => resolveBlobConflict({ folder: binding.path, store, scope, key, choice }));
    resolution = await withSession(binding, deps, resumeCommand, session => resolveBlobConflict({ folder: binding.path, store: session.store, scope, key, choice, read: async head => {
      const controller = new AbortController();
      try { return (await createHostedBlobReadAdapter({ carrier: session.carrier, bundleId: scope.bundleId, prefix: scope.prefix, signal: controller.signal, capabilities: async () => session.capabilities }).read(head)).bytes; }
      finally { controller.abort(); }
    } }));
  }
  const r = resolution, sync = String(syncCommand(binding));
  const next = r.choice === "take"
    ? r.file === "placed" ? "resolved: the host's version is in the folder; nothing is sent" : r.placementDeferred ? `resolved: the conflicted bytes are discarded and ${sync} places the host's version` : "resolved: the host deleted it, and the file is removed; nothing is sent"
    : r.admitted ? `resolved, not sent yet: the host deleted it, so a create of your file is admitted; ${sync} sends it` : r.sends ? `resolved, not sent yet: ${sync} sends the file as it is then over the host's version` : "resolved: nothing to send for this file";
  deps.stdout(render({
    resolved: key, route: "blob", choice: r.choice, ...(requested !== r.choice ? { requested } : {}), retired_request_ids: r.evidence.requestIds,
    host: r.evidence.actual === null ? { deleted: true } : { version: r.evidence.actual, content_type: r.evidence.actualContentType },
    file: path.join(binding.path, ...key.split("/")), file_state: r.file, ...(r.admitted ? { request_id: r.admitted } : {}),
    next, help: r.sends || r.placementDeferred ? [sync] : [],
  }, mode));
}
