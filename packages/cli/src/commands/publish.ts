// `superbee publish --to hosted` — move a local bundle or a Git board to hosted Superbee.
//
// Without --yes it only previews, from the folder and local Git: what travels (documents,
// reserved files, other files, and with --with-history the Git history of a board), what stays,
// every bound the host enforces, and what will happen. No request is made.
//
// With --yes it signs in, creates the bundle in the person's own workspace (hosted
// `docs/person-bundle-create.md`; no create limit unless the workspace sets one, D1) in one
// `bundles.create.v1` request when it fits that request's bounds, or else as a staged creation
// (`hosted/publish-staged.ts`: a manifest, parts, raw files, then commits, reporting progress on
// stderr), and converts the folder in place into a hosted checkout: the read-only
// marker, a private binding, and the files left exactly as they are. A Git board is unbound first:
// the folder stops being a worktree of the `board` branch, and the branch itself, local and on
// origin, is left where it was (the receipt names its commit). Git history travels only with
// --with-history, as labeled, unverified rows (D2).
//
// A retry after an unknown outcome reuses the same request id, recorded in private state, so the
// host finishes or confirms the one creation instead of starting another; a staged creation resumes,
// sending only what the host is still missing.
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { runGit } from "@superbee/board-git";
import { parseMarkdown, RemoteError, stripHostText } from "@superbee/core";
import { CURRENT_HOST_DOCUMENT_INPUT_BYTES, HostedCarrierError } from "@superbee/core/hosted-transport";

import { parseLeafOrUsage } from "../args.js";
import { findBundleRoot, openBundle, resolveLocalBundleTarget, resolveProjectBinding } from "../bundle.js";
import { bundleHomeAt, gitBoardSyncBlock, type BundleHomeFacts, type GitBoardFacts } from "../bundle-home.js";
import { deriveBundleDisplayName } from "../bundle-name.js";
import { loadCatalog } from "../catalog.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import type { HostedTarget } from "../hosted-auth/discovery.js";
import { defaultHostedAuthDeps, hostedWriteHost, hostSourceText, type HostedWriteHost } from "../hosted-auth/session.js";
import { isHostedBundleId } from "../hosted/bundle-id.js";
import { unboundCopyRefusal } from "../hosted/refusals.js";
import { hostedFailure, type HostedSyncClient } from "../hosted/client.js";
import { connectHostedAccount, hostedListCommand, workspaceNames } from "../hosted/account.js";
import { bindingHostArgument, writeCheckoutMarker } from "../hosted/marker.js";
import { createBody, manifestBody, planDigest, planPublish, stagedContent, type PublishPlan } from "../hosted/publish-plan.js";
import { isFinalBeforeReservation, runStagedCreate, StagedRefusal, type StagedProgress } from "../hosted/publish-staged.js";
import { clearPendingCreate, clearPublishedExtras, listPendingCreates, readPendingCreate, writePendingCreate, writePublishedExtras, type PendingCreate } from "../hosted/publish-state.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode } from "../output.js";
import { assertBundleOutsidePrivateState } from "../private-state-bundle-boundary.js";
import { bindFolderInPlace } from "./checkout-adopt.js";
import { CHECKOUT_DOCUMENT_LIMIT, connectHostedBundle, registerInCatalog, type CheckoutDeps } from "./checkout.js";

export const PUBLISH_USAGE = `superbee publish — move a local bundle or Git board to hosted Superbee

Usage:
  superbee publish --to hosted [--dir <bundle>] [--host <url>] [--workspace <id>]
                   [--bundle-id <id>] [--name <name>] [--with-history] [--yes] [--json]

Without --yes, previews only, with no network: what travels (documents, reserved files, other
files), what stays (dot-files, links), how it is sent, every bound the host enforces, the history
plan, and what will happen to the folder.

A bundle within one request's bounds (at most 1,000 documents, 100 other files of 1 MB each,
1,000 earlier versions, 1,500 objects in all, 3 MiB) is sent in one request. A larger one is sent
staged: a list of everything, then parts of about 1 MiB, then each file, then commits until the
host has created it, with progress on stderr (JSON lines with --json). Staged, a bundle holds at
most 10,000 documents, 1,000 reserved files, 1,000 other files of 16 MiB each and 64 MiB of
current files in all, and 5,000 earlier versions (64 MiB); the list of everything is at most
3 MiB. Every way: each document within the host's bound (983,040 bytes as sent on current
hosts, about 950 KiB of Markdown; 64 KiB on older ones), 64 KiB per reserved file, 16 KiB of
frontmatter.

With --yes, signs in if needed (AUTH_REQUIRED, exit 4, carries the one link to relay and the
command to re-run), creates the bundle in your workspace (only you can reach it, at write, until
you share it in the app), then converts this folder in place into a hosted checkout: nothing in it
is rewritten, a read-only .superbee/checkout.json marker is added, and 'superbee sync' then syncs
it with the host. A Git board is unbound first: the folder stops being a worktree of the board
branch, which stays as it is, locally and on origin (the receipt names its commit). Teammates who
use the Git board keep it until you tell them to check the hosted bundle out instead. A board
behind its upstream (as of the last fetch) is a blocker until 'superbee sync'; a clone of the board
branch, or any other folder that is its own Git working tree, is refused.

--with-history imports each document's earlier Git versions as labeled, unverified history
(imported:git/<commit>); without it, history starts at publish. A local bundle has only its current
versions. A retry after an unknown outcome (TRANSIENT) re-sends the same request, so the host
finishes or confirms the one creation; a staged one resumes, sending only what the host lacks.

Options:
  --to hosted         Required: the only destination
  --dir <bundle>      The bundle to publish (default: the one found from here)
  --host <url>        Hosted Superbee URL (default: your last sign-in, when it is the only host signed in)
  --workspace <id>    Your workspace to create it in (default: your only one, or your default)
  --bundle-id <id>    The hosted bundle id (default: from the bundle's name)
  --name <name>       The display name (default: the bundle's name)
  --with-history      Import a Git board's history as labeled, unverified rows
  --yes               Create the bundle and convert the folder (default: preview only)
  --json              Emit compact JSON instead of TOON
  -h, --help          Show this help

Examples:
  superbee publish --to hosted
  superbee publish --to hosted --bundle-id team.notes --with-history --yes
`;

const LISTED = 20;
const CREATE_ANSWER_BYTES = 64 * 1024;
const CREATE_DEADLINE_MS = 120_000;

export type PublishDeps = CheckoutDeps & {
  /** Where a staged creation's progress goes, one line per event. */
  stderr: (text: string) => void;
  /** Waits before a retry (a test passes one that does not wait). */
  sleep?: (ms: number) => Promise<void>;
};

function publishDeps(partial: Partial<PublishDeps>): PublishDeps {
  return {
    stdout: partial.stdout ?? ((text) => void process.stdout.write(text)),
    stderr: partial.stderr ?? ((text) => void process.stderr.write(text)),
    ...(partial.sleep ? { sleep: partial.sleep } : {}),
    auth: partial.auth ?? defaultHostedAuthDeps(homedir()),
    cwd: partial.cwd ?? process.cwd(),
    ...(partial.fetch ? { fetch: partial.fetch } : {}),
  };
}

/** A hosted bundle id from a display name: lower-case words joined by dashes, starting with a letter. */
export function bundleIdFrom(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const id = (/^[a-z]/.test(words) ? words : `bundle-${words}`).slice(0, 64).replace(/-+$/, "");
  return isHostedBundleId(id) ? id : "bundle";
}

/** The root index's `title`, or null. */
async function rootTitle(folder: string): Promise<string | null> {
  try {
    const title = parseMarkdown(await readFile(path.join(folder, "index.md"), "utf8"), "index").frontmatter.title;
    return typeof title === "string" && title.trim() !== "" ? title.trim() : null;
  } catch {
    return null;
  }
}

/** The host refuses control and format characters in a name. */
function cleanName(name: string): string {
  return stripHostText(name, 128);
}

/** Refuse a folder that is not its own authority: nested in another bundle, or bound elsewhere. */
async function assertPublishable(canonical: string, facts: BundleHomeFacts): Promise<void> {
  if (facts.home === "hosted") {
    throw new CliError("FORBIDDEN", `${canonical} is already a hosted checkout of '${facts.binding.bundle_id}' on ${facts.binding.origin}`, {
      details: { reason: "already_hosted", folder: canonical, bundle_id: facts.binding.bundle_id, host: facts.binding.origin },
      help: `${cliInvocation()} sync --dir ${commandToken(canonical)}`,
    });
  }
  if (facts.copy) {
    throw unboundCopyRefusal(facts.copy, "FORBIDDEN", `${canonical} is a copy of a hosted checkout of '${facts.copy.marker.bundle_id}'; adopt it instead of publishing a second bundle`);
  }
  if (facts.home === "git" && facts.board.channel === "in-tree") {
    throw new CliError("FORBIDDEN", `${canonical} is committed with the code on ${facts.board.branch ?? "this branch"}; publishing it would leave two authorities`, {
      details: { reason: "in_tree_board", folder: canonical },
      help: `move it to its own board branch first: ${cliInvocation()} sync --establish`,
    });
  }
  // A folder that is itself a Git working tree must be a linked worktree of the board branch
  // (which publish unbinds by removing its `.git` file); anything else (a clone of the board, a
  // detached worktree, a repository) would leave the folder two authorities.
  const dotGit = await lstat(path.join(canonical, ".git")).catch(() => null);
  if (dotGit) {
    const linkedBoard = facts.home === "git" && facts.board.channel === "branch" && dotGit.isFile() && isLinkedWorktree(canonical);
    if (!linkedBoard) {
      throw new CliError("FORBIDDEN", `${canonical} is a Git ${dotGit.isFile() ? "worktree" : "repository"} that publish cannot unbind${facts.home === "git" ? " (a clone of the board branch, not a project's board worktree)" : ""}`, {
        details: { reason: facts.home === "git" ? "board_clone" : "git_working_tree", folder: canonical },
        help: "copy the bundle's files (without .git) into a new folder and publish that, or publish from the project whose board worktree this is",
      });
    }
  }
  const enclosing = await findBundleRoot(path.dirname(canonical)).catch(() => null);
  if (enclosing && enclosing !== canonical) {
    throw new CliError("FORBIDDEN", `${canonical} is inside the bundle at ${enclosing}`, {
      details: { reason: "inside_bundle", enclosing },
      help: "publish the enclosing bundle, or move this one out of it first",
    });
  }
  const bound = await resolveProjectBinding(path.dirname(canonical)).catch(() => null);
  if (bound && (await realpath(bound.target).catch(() => bound.target)) !== canonical) {
    throw new CliError("FORBIDDEN", `${canonical} is inside a project bound to another bundle (${bound.file})`, {
      details: { reason: "inside_bound_project", binding: bound.file },
      help: "publish the project's own bundle, or move this one out of it first",
    });
  }
}

/** True when the folder is a linked worktree: its own Git dir is not the repository's common dir. */
function isLinkedWorktree(folder: string): boolean {
  const own = runGit(folder, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const common = runGit(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return own.status === 0 && common.status === 0 && own.stdout.trim() !== common.stdout.trim();
}

/**
 * A Git board that must not lose a teammate's change: publish sends this folder as it is now, so a
 * board behind or diverged from its upstream (as of the last fetch) is a blocker until synced.
 */
async function boardCheck(board: GitBoardFacts, canonical: string): Promise<{ block: Record<string, unknown>; blocker: { path: string; reason: string; message: string } | null }> {
  const block = await gitBoardSyncBlock(board);
  const blocker =
    block.state === "behind" || block.state === "diverged"
      ? {
          path: ".",
          reason: `board_${String(block.state)}`,
          message: `the Git board is ${String(block.state)} its upstream as of the last fetch; run ${cliInvocation()} sync --dir ${commandToken(canonical)} first so teammates' changes travel too`,
        }
      : null;
  return { block, blocker };
}

function boardHead(board: GitBoardFacts): string | null {
  const head = runGit(board.top, ["rev-parse", "HEAD"]);
  return head.status === 0 ? head.stdout.trim() : null;
}

/**
 * Detach the folder from Git: it stops being a worktree of the board branch, and every file stays.
 * The branch and its commits are untouched, locally and on origin.
 */
async function unbindBoard(board: GitBoardFacts, canonical: string): Promise<void> {
  const dotGit = path.join(canonical, ".git");
  const info = await lstat(dotGit);
  if (!info.isFile()) {
    throw new CliError("RUNTIME", `${canonical} is not a linked board worktree (${dotGit} is not a file)`, { details: { reason: "not_a_board_worktree" } });
  }
  const common = runGit(board.top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  await unlink(dotGit);
  if (common.status === 0) runGit(board.top === canonical ? path.dirname(canonical) : board.top, ["--git-dir", common.stdout.trim(), "worktree", "prune"]);
}

function summary(plan: PublishPlan): Record<string, unknown> {
  return {
    documents: plan.documents.length,
    reserved_files: plan.reserved.length,
    other_files: plan.blobs.length,
    sent: plan.path.mode === "one-shot" ? "one request" : `staged: ${plan.path.why}; a list of everything, parts of about 1 MiB, each file, then commits until created (resumable)`,
    history: { mode: plan.historyPlan.mode, versions: plan.historyPlan.versions, ...(plan.historyPlan.skipped > 0 ? { skipped: plan.historyPlan.skipped } : {}), note: plan.historyPlan.note },
  };
}

/** One refusal answer of `bundles.create.v1`, as the CLI taxonomy names it. */
function createRefusal(
  code: string,
  message: string,
  context: { bundleId: string; workspace: string; target: HostedTarget; resume: CommandText; folder: string; openCreations?: readonly PendingCreate[] },
): CliError {
  const details = { reason: code, bundle_id: context.bundleId, workspace: context.workspace, host: context.target.origin, host_message: message };
  switch (code) {
    case "bundle_exists":
      return new CliError("ALREADY_EXISTS", `the hosted bundle id '${context.bundleId}' is taken in ${context.workspace}`, { details, help: `${cliInvocation()} publish --to hosted --bundle-id <another id>` });
    case "workspace_not_found":
      return new CliError("NOT_FOUND", `'${context.workspace}' is not one of your workspaces on ${context.target.origin}`, { details, help: `${cliInvocation()} whoami --host ${commandToken(bindingHostArgument(context.target))}` });
    case "bundle_create_unavailable":
    case "bundle_create_limit": {
      // A staged creation's own limit shares the code: unfinished staged creations open at once.
      const open = code === "bundle_create_limit" && /staged creations open/i.test(message);
      return new CliError(
        "FORBIDDEN",
        open
          ? `you have too many unfinished large publishes open in ${context.workspace}`
          : code === "bundle_create_limit"
            ? `your bundle creation limit in ${context.workspace} is used up`
            : `${context.workspace} does not offer bundle creation to this client`,
        {
          details: open && context.openCreations ? { ...details, open: context.openCreations.map((record) => ({ bundle_id: record.bundle_id, ...(record.folder ? { folder: record.folder } : {}) })) } : details,
          help: open
            ? `finish one by re-running its publish${
                context.openCreations && context.openCreations.length > 0
                  ? ` (unfinished from here: ${context.openCreations.map((record) => `'${record.bundle_id}'${record.folder ? ` from ${record.folder}` : ""}`).join(", ")})`
                  : ""
              }, or wait for one to expire 7 days after it began`
            : "ask a workspace admin in the Superbee app",
        },
      );
    }
    case "request_conflict":
      return new CliError("CONFLICT", `an unfinished publish of '${context.bundleId}' from this folder carried other contents, and the host holds the id for it`, {
        details,
        help: `put the files back as they were and re-run the same command to finish it; if the creation already finished, bind this folder to it (your edits become sync conflicts): ${cliInvocation()} checkout --adopt ${commandToken(context.folder)} --host ${commandToken(bindingHostArgument(context.target))}`,
      });
    default:
      return new CliError("USAGE", `${context.target.origin} refused the bundle (${code}): ${message}`, { details, help: "fix the files it names, then preview again" });
  }
}

interface SendContext {
  readonly workspace: string;
  readonly bundleId: string;
  readonly name: string;
  readonly home: string;
  readonly canonical: string;
  readonly target: HostedTarget;
  readonly client: HostedSyncClient;
  readonly yesCommand: CommandText;
  readonly deps: PublishDeps;
  readonly json: boolean;
}

function targetLine(chosen: HostedWriteHost, bundleId: string, json: boolean): string {
  if (json) return `${JSON.stringify({ event: "publish.target", host: chosen.target.origin, host_from: chosen.source, bundle_id: bundleId })}\n`;
  return `publish: creating '${bundleId}' on ${chosen.target.origin} (host from ${hostSourceText(chosen.source)})\n`;
}

/** One staged creation's progress line: words, or a JSON event with --json. */
function progressLine(event: StagedProgress, json: boolean): string {
  if (json) return `${JSON.stringify({ event: "publish.progress", ...event })}\n`;
  const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  switch (event.phase) {
    case "begin":
      return `publish: ${event.state}: ${event.staged}/${event.versions} objects and ${event.stagedBlobs}/${event.blobs} files on the host\n`;
    case "stage":
      return `publish: sent part ${event.part}/${event.parts} (${event.objects} objects)\n`;
    case "blob":
      return `publish: sent file ${event.blob}/${event.blobs} ${event.key} (${mib(event.bytes)})\n`;
    case "commit":
      return `publish: commit ${event.call}: ${event.state}${event.written ? ` (written: ${Object.entries(event.written).map(([kind, count]) => `${count} ${kind}`).join(", ")})` : ""}\n`;
    case "wait":
      return `publish: waiting ${event.seconds} s: ${event.reason}\n`;
  }
}

/**
 * Creates the bundle: one `bundle-create` request, or a staged creation, under the request id an
 * unfinished creation of the same bundle id recorded (so the host finishes, resumes or confirms
 * it), and answers the host's success answer's `data`. The pending record is cleared on success
 * and on a refusal that holds nothing; it stays for an unknown outcome and a request conflict.
 */
async function sendCreation(plan: PublishPlan, context: SendContext): Promise<Record<string, unknown>> {
  const { workspace, bundleId, name, home, canonical, target, client, yesCommand } = context;
  const staged = plan.path.mode === "staged" ? stagedContent(plan) : null;
  const body = staged ? manifestBody(staged, { workspace, bundleId, name }) : createBody(plan, { workspace, bundleId, name });
  const digest = planDigest(body);
  // An unfinished creation of the same bundle keeps its request id whatever changed since: the
  // host then finishes, resumes or confirms it, or answers request_conflict, and never holds the id
  // for a request nobody can finish.
  const earlier = await readPendingCreate(home, canonical, bundleId);
  const resumes = earlier !== null && earlier.host === target.origin && earlier.workspace === workspace;
  const requestId = resumes ? earlier.request_id : randomUUID();
  const record: PendingCreate = resumes
    ? { ...earlier, ...(staged ? { staged: true, folder: canonical } : {}) }
    : { request_id: requestId, host: target.origin, workspace, bundle_id: bundleId, digest, ...(staged ? { staged: true, folder: canonical } : {}) };
  if (!resumes || (staged && earlier.staged !== true)) await writePendingCreate(home, canonical, record);
  const refusalContext = { bundleId, workspace, target, resume: yesCommand, folder: canonical };

  if (staged) {
    let data;
    try {
      data = await runStagedCreate({
        client,
        requestId,
        target: { workspace, bundleId, name },
        content: staged,
        resume: String(yesCommand),
        progress: (event) => context.deps.stderr(progressLine(event, context.json)),
        ...(context.deps.sleep ? { sleep: context.deps.sleep } : {}),
        // Once the host holds the id for this request, only this request id can finish it.
        onReserved: async () => {
          if (record.reserved !== true) await writePendingCreate(home, canonical, { ...record, reserved: true });
        },
      });
    } catch (error) {
      if (error instanceof StagedRefusal) {
        // Only a refusal that settles an unreserved creation forgets its request id; any other
        // (a switch turned off, a workspace gone, the limit) is kept, so a re-run finishes it.
        if (record.reserved !== true && isFinalBeforeReservation(error)) await clearPendingCreate(home, canonical, bundleId);
        const openCreations =
          error.code === "bundle_create_limit"
            ? (await listPendingCreates(home)).filter((other) => other.staged === true && other.host === target.origin && other.workspace === workspace && other.request_id !== requestId)
            : undefined;
        throw createRefusal(error.code, error.hostMessage, { ...refusalContext, ...(openCreations ? { openCreations } : {}) });
      }
      throw error;
    }
    await clearPendingCreate(home, canonical, bundleId);
    return data;
  }

  let answer;
  try {
    answer = await client.carrier.json(`${client.prefix}/bundle-create`, body, client.signal, { maximum: CREATE_ANSWER_BYTES, writeRequest: requestId });
  } catch (error) {
    if (error instanceof HostedCarrierError && error.code === "unavailable") {
      throw new CliError("TRANSIENT", `the answer from ${target.origin} did not arrive; the bundle may be partly created`, {
        details: { reason: "write_outcome_unknown", bundle_id: bundleId, workspace, host: target.origin, request_id: requestId, retryable: true },
        help: `re-run the same command; it re-sends the same request, which finishes or confirms the creation: ${yesCommand}`,
      });
    }
    throw hostedFailure(error, target, yesCommand);
  }
  const envelope = (answer.body ?? {}) as { ok?: unknown; data?: Record<string, unknown>; error?: { code?: unknown; message?: unknown } };
  const code = typeof envelope.error?.code === "string" ? envelope.error.code : null;
  const hostMessage = typeof envelope.error?.message === "string" ? envelope.error.message : "";
  if (answer.status === 503 && code === "write_outcome_unknown") {
    throw new CliError("TRANSIENT", `${target.origin} may have partly created '${bundleId}'`, {
      details: { reason: "write_outcome_unknown", bundle_id: bundleId, workspace, host: target.origin, request_id: requestId, retryable: true },
      help: `re-run the same command; it re-sends the same request, which finishes or confirms the creation: ${yesCommand}`,
    });
  }
  // A record a staged run marked reserved is never forgotten here: only its request id can finish it.
  const forgettable = record.reserved !== true;
  if (answer.status === 429 && code === "bundle_create_limit") {
    if (forgettable) await clearPendingCreate(home, canonical, bundleId);
    throw createRefusal(code, hostMessage, refusalContext);
  }
  if (answer.status === 200 && envelope.ok === false && code !== null) {
    if (code !== "request_conflict" && forgettable) await clearPendingCreate(home, canonical, bundleId);
    throw createRefusal(code, hostMessage, refusalContext);
  }
  if (answer.status !== 200 || envelope.ok !== true || typeof envelope.data !== "object" || envelope.data === null) {
    if (answer.status === 400 && forgettable) await clearPendingCreate(home, canonical, bundleId);
    throw hostedFailure(new RemoteError(`hosted bundle-create answered ${answer.status}`, code ?? "RUNTIME", answer.status), target, yesCommand);
  }
  await clearPendingCreate(home, canonical, bundleId);
  return envelope.data;
}

export async function publish(argv: string[], partial: Partial<PublishDeps> = {}): Promise<void> {
  const deps = publishDeps(partial);
  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          to: { type: "string" },
          dir: { type: "string" },
          host: { type: "string" },
          workspace: { type: "string" },
          "bundle-id": { type: "string" },
          name: { type: "string" },
          "with-history": { type: "boolean" },
          yes: { type: "boolean" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: false,
      }),
    CLI_LEAVES.publish,
  );
  if (values.help) {
    deps.stdout(renderUsage(PUBLISH_USAGE));
    return;
  }
  const mode = resolveMode(values);
  if (values.to !== "hosted") {
    throw new CliError("USAGE", values.to === undefined ? "publish needs --to hosted" : `'${values.to}' is not a destination; the only one is hosted`, {
      help: `${cliInvocation()} publish --to hosted`,
    });
  }
  const home = deps.auth.home;
  const located = await resolveLocalBundleTarget(values.dir, deps.cwd);
  const canonical = located.canonicalRoot;
  assertBundleOutsidePrivateState(canonical, home);
  const facts = await bundleHomeAt(canonical, { home });
  await assertPublishable(canonical, facts);
  const board = facts.home === "git" ? facts.board : null;
  const boardState = board ? await boardCheck(board, canonical) : null;

  const bundle = await openBundle(canonical);
  const display = await deriveBundleDisplayName(bundle).catch(() => ({ name: path.basename(canonical), source: "root-basename" as const }));
  // A folder name is a weak name: the root index's title, when it has one, is the bundle's own.
  const title = display.source === "root-basename" ? await rootTitle(canonical) : null;
  const derived = title ?? display.name;
  const name = cleanName(values.name ?? derived) || path.basename(canonical);
  const bundleId = values["bundle-id"] ?? bundleIdFrom(derived);
  if (!isHostedBundleId(bundleId)) {
    throw new CliError("USAGE", `'${bundleId}' is not a hosted bundle id (lower-case letters and digits, joined by . _ or -, starting with a letter)`, {
      help: `${cliInvocation()} publish --to hosted --bundle-id <id>`,
    });
  }
  const withHistory = values["with-history"] === true;
  const yesCommandFor = (host: string | null) =>
    commandFragment`${cliInvocation()} publish --to hosted${values.dir !== undefined ? commandFragment` --dir ${commandToken(canonical)}` : commandFragment``}${
      host !== null ? commandFragment` --host ${commandToken(host)}` : commandFragment``
    }${values.workspace !== undefined ? commandFragment` --workspace ${commandToken(values.workspace)}` : commandFragment``} --bundle-id ${commandToken(bundleId)}${
      values.name !== undefined ? commandFragment` --name ${commandToken(name)}` : commandFragment``
    }${withHistory ? commandFragment` --with-history` : commandFragment``} --yes${values.json ? commandFragment` --json` : commandFragment``}`;
  // An implicit host is used only when it is the one host signed in; the preview reports an
  // ambiguous one as a blocker, and --yes refuses it.
  let chosen: HostedWriteHost | null = null;
  let ambiguous: CliError | null = null;
  try {
    chosen = await hostedWriteHost(values.host, home, (host) => String(yesCommandFor(host)));
  } catch (error) {
    if (values.yes || !(error instanceof CliError) || error.details?.reason !== "ambiguous_host") throw error;
    ambiguous = error;
  }
  const target = chosen?.target ?? null;
  // The preview makes no request, so it plans against the bound current hosts state; `--yes` asks
  // the host and plans again under what it states, before anything is sent.
  const planFor = (documentInputBytes: number | null) =>
    planPublish(canonical, withHistory ? { history: true, ...(board ? { board } : {}), now: deps.auth.now(), documentInputBytes } : { history: false, documentInputBytes });
  let plan = await planFor(CURRENT_HOST_DOCUMENT_INPUT_BYTES);

  const yesCommand = yesCommandFor(target ? bindingHostArgument(target) : null);
  // A checkout holds at most CHECKOUT_DOCUMENT_LIMIT documents, read a page at a time, which is also
  // staged creation's own document bound; a larger bundle (never one this command creates) would be
  // created and the folder left as it is (a Git board stays bound), to use in the app.
  const converts = plan.documents.length <= CHECKOUT_DOCUMENT_LIMIT;
  const uncheckable = `leave this folder as it is${board ? " (still bound to the Git board)" : ""}: a hosted checkout holds at most ${CHECKOUT_DOCUMENT_LIMIT} documents, so use the bundle in the app; from then on, edits here do not reach the hosted bundle, nor its edits here`;
  const gitPlan = board
    ? {
        branch: board.branch,
        upstream: board.upstream,
        head: boardHead(board),
        sync: boardState?.block.state,
        ...(boardState && ((boardState.block.ahead as number | null) ?? 0) + ((boardState.block.uncommitted as number | null) ?? 0) > 0
          ? { not_on_branch: { ahead: boardState.block.ahead, uncommitted: boardState.block.uncommitted, note: "these travel to hosted but not to the board branch teammates still sync" } }
          : {}),
        will: converts
          ? "unbind this folder from the board branch; the branch and its commits stay, locally and on origin"
          : "keep this folder bound to the board branch: the board and the hosted bundle then diverge, and neither's edits reach the other",
      }
    : null;

  if (!values.yes) {
    const blockers = [...plan.blockers.map((b) => ({ path: b.path, reason: b.reason, message: b.message })), ...(boardState?.blocker ? [boardState.blocker] : [])];
    if (ambiguous) blockers.push({ path: "", reason: "ambiguous_host", message: ambiguous.message });
    else if (!target) blockers.push({ path: "", reason: "no_host", message: "no hosted Superbee host: sign in first, or pass --host" });
    deps.stdout(
      render(
        {
          publish: "preview",
          ready: blockers.length === 0,
          folder: canonical,
          home: facts.home,
          to: {
            host: target?.origin ?? null,
            ...(chosen ? { host_from: chosen.source } : ambiguous ? { signed_in_hosts: ambiguous.details?.hosts } : {}),
            bundle_id: bundleId,
            name,
            workspace: values.workspace ?? "chosen at --yes: your only workspace, or your default one",
          },
          travels: summary(plan),
          ...(plan.skipped.length > 0 ? { stays: { shown: Math.min(LISTED, plan.skipped.length), total: plan.skipped.length, rows: plan.skipped.slice(0, LISTED) } } : {}),
          ...(blockers.length > 0 ? { blockers: { shown: Math.min(LISTED, blockers.length), total: blockers.length, rows: blockers.slice(0, LISTED) } } : {}),
          ...(gitPlan ? { git: gitPlan } : {}),
          then: [
            "create the bundle in your workspace, reachable only by you (write) until you share it in the app",
            ...(converts
              ? [
                  "convert this folder in place into a hosted checkout: no file rewritten, a read-only .superbee/checkout.json added",
                  ...(board ? ["unbind the Git board first; teammates keep the board branch until you tell them"] : []),
                ]
              : [uncheckable]),
          ],
          network: "none (preview)",
          document_bound: `checked against ${CURRENT_HOST_DOCUMENT_INPUT_BYTES} bytes as sent per document (current hosts); --yes checks the host's own bound before anything is sent`,
          help: blockers.length === 0
            ? [String(yesCommand)]
            : ambiguous
              ? [...((ambiguous.details?.commands as string[] | undefined) ?? []), ...(blockers.length > 1 ? ["fix the blocking files, then preview again"] : [])]
              : !target
                ? [`${cliInvocation()} login --host <url>`]
                : ["fix the blocking files, then preview again"],
        },
        mode,
      ),
    );
    return;
  }

  if (!target) {
    throw new CliError("USAGE", "no hosted Superbee host: sign in first, or pass --host", { help: `${cliInvocation()} login --host <url>` });
  }
  if (boardState?.blocker) {
    throw new CliError("CONFLICT", boardState.blocker.message, {
      details: { reason: boardState.blocker.reason, sync: boardState.block },
      help: `${cliInvocation()} sync --dir ${commandToken(canonical)}`,
    });
  }
  if (plan.blockers.length > 0) {
    throw new CliError("USAGE", `${plan.blockers.length} thing(s) in the bundle cannot be published: ${plan.blockers[0]!.message}`, {
      details: { reason: "blocked", blockers: plan.blockers.slice(0, LISTED), blockers_total: plan.blockers.length },
      help: `preview them all: ${commandFragment`${cliInvocation()} publish --to hosted${values.dir !== undefined ? commandFragment` --dir ${commandToken(canonical)}` : commandFragment``}`}`,
    });
  }

  // Named before anything is asked or sent, on stderr so the receipt on stdout keeps its shape: the one
  // line that says which host this write is about to change.
  deps.stderr(targetLine(chosen!, bundleId, values.json === true));
  const otherWorkspace = `${cliInvocation()} publish --to hosted --host ${commandToken(bindingHostArgument(target))} --workspace <id> --bundle-id ${commandToken(bundleId)} --yes`;
  const { client, identity, workspace } = await connectHostedAccount(
    target,
    { workspace: values.workspace, resume: yesCommand, otherWorkspace, deadlineMs: CREATE_DEADLINE_MS },
    { auth: deps.auth, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
  );
  if (workspace === null) {
    throw new CliError("USAGE", `you are in ${identity.tenantIds.length} workspaces on ${target.origin}: name one`, {
      details: { reason: "choose_workspace", workspaces: workspaceNames(identity) },
      help: otherWorkspace,
    });
  }
  if (identity.documentInputBytes !== CURRENT_HOST_DOCUMENT_INPUT_BYTES) {
    plan = await planFor(identity.documentInputBytes);
    if (plan.blockers.length > 0) {
      throw new CliError("USAGE", `${plan.blockers.length} thing(s) in the bundle cannot be published to ${target.origin}: ${plan.blockers[0]!.message}`, {
        details: { reason: "blocked", host: target.origin, blockers: plan.blockers.slice(0, LISTED), blockers_total: plan.blockers.length },
        help: "make the documents smaller, or publish to a host that accepts larger documents",
      });
    }
  }

  const created = await sendCreation(plan, { workspace, bundleId, name, home, canonical, target, client, yesCommand, deps, json: values.json === true });

  if (!converts) {
    deps.stdout(
      render(
        {
          published: "created",
          bundle_id: bundleId,
          name,
          host: target.origin,
          host_from: chosen!.source,
          workspace,
          access: "write (only you, until you share it in the app)",
          sent: {
            documents: created.documents ?? plan.documents.length,
            reserved_files: created.reserved ?? plan.reserved.length,
            other_files: created.blobs ?? plan.blobs.length,
            history: created.history ?? { imported: plan.history.length, verified: false },
          },
          folder: canonical,
          home: facts.home,
          checkout: `not converted: ${uncheckable}`,
          diverges: `this folder${board ? " and its Git board" : ""} and the hosted bundle '${bundleId}' are now separate copies: edits here do not reach the hosted bundle`,
          help: [hostedListCommand(target)],
        },
        mode,
      ),
    );
    return;
  }

  await writePublishedExtras(home, canonical, { host: target.origin, bundle_id: bundleId, extras: plan.extras }).catch(() => {});

  // The bundle exists on the host. From here, a failure leaves the folder adoptable: the marker
  // goes in first, so `checkout --adopt` can finish the conversion.
  // The checkout names the bundle in the workspace it was created in, so another of the person's
  // workspaces holding the same id never makes it ambiguous.
  const slug = identity.workspaces.find((w) => w.tenantId === workspace)?.slug ?? null;
  const markerSource = { origin: target.origin, audience: target.audience, bundle_id: bundleId, workspace, ...(slug !== null ? { workspace_slug: slug } : {}) };
  const adoptHelp = `${cliInvocation()} checkout --adopt ${commandToken(canonical)} --host ${commandToken(bindingHostArgument(target))}`;
  let unbound: Record<string, unknown> | null = null;
  try {
    if (board && gitPlan) {
      await unbindBoard(board, canonical);
      unbound = {
        unbound: true,
        branch: board.branch,
        upstream: board.upstream,
        head: gitPlan.head,
        note: `the board branch stays at ${gitPlan.head ?? "its commit"}, locally and on ${board.upstream ?? "no upstream"}; teammates keep syncing it with Git until you tell them to check out '${bundleId}' instead`,
      };
    }
    await writeCheckoutMarker(canonical, markerSource);
  } catch (error) {
    throw new CliError("RUNTIME", `'${bundleId}' was created on ${target.origin}, but this folder could not be converted: ${(error as Error).message}`, {
      details: { reason: "convert_failed", created, folder: canonical },
      help: board ? `delete ${path.join(canonical, ".git")} and run git worktree prune, then: ${adoptHelp}` : adoptHelp,
    });
  }
  const resume = commandFragment`${cliInvocation()} checkout --adopt ${commandToken(canonical)} --host ${commandToken(bindingHostArgument(target))}`;
  let bound;
  try {
    const connection = await connectHostedBundle({ slug, bundleId }, target, workspace, deps, resume);
    bound = await bindFolderInPlace({ canonical, target, bundleId, connection, deps, resume, extras: plan.extras });
    await clearPublishedExtras(home, canonical);
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError("RUNTIME", (error as Error).message);
    throw new CliError(failure.code, `'${bundleId}' was created on ${target.origin}, but binding this folder to it failed: ${failure.message}`, {
      details: { ...(failure.details ?? {}), reason: "bind_failed", created, folder: canonical, ...(unbound ? { git: unbound } : {}) },
      help: adoptHelp,
    });
  }
  const existing = (await loadCatalog(home).catch(() => ({ entries: [] as { label: string; id: string; locator: { path: string } }[] }))).entries.find(
    (entry) => entry.locator.path === canonical,
  );
  const catalog = existing ? { registered: true, label: existing.label, id: existing.id, home: "hosted" } : await registerInCatalog(home, bound.binding);
  deps.stdout(
    render(
      {
        published: "created",
        bundle_id: bundleId,
        name,
        host: target.origin,
        host_from: chosen!.source,
        workspace,
        access: "write (only you, until you share it in the app)",
        sent: {
          documents: created.documents ?? plan.documents.length,
          reserved_files: created.reserved ?? plan.reserved.length,
          other_files: created.blobs ?? plan.blobs.length,
          history: created.history ?? { imported: plan.history.length, verified: false },
        },
        folder: canonical,
        home: "hosted",
        checkout: {
          matched: bound.matched.length,
          placed: bound.placed.length,
          conflicts: bound.conflicts.length,
          local_only: bound.localOnly.length,
          ...(bound.conflicts.length > 0 ? { conflict_ids: bound.conflicts.slice(0, LISTED) } : {}),
        },
        ...(unbound ? { git: unbound } : {}),
        marker: path.join(canonical, ".superbee", "checkout.json"),
        catalog,
        reverse: `${cliInvocation()} checkout --release ${commandToken(canonical)} leaves a plain local folder; the hosted bundle stays until deleted in the app`,
        help: [`${cliInvocation()} status --dir ${commandToken(canonical)}`, `${cliInvocation()} sync --dir ${commandToken(canonical)}`],
      },
      mode,
    ),
  );
}
