// `superbee publish --to hosted` — move a local bundle or a Git board to hosted Superbee.
//
// Without --yes it only previews, from the folder and local Git: what travels (documents,
// reserved files, other files, and with --with-history the Git history of a board), what stays,
// every bound the host enforces, and what will happen. No request is made.
//
// With --yes it signs in, creates the bundle in the person's own workspace in one
// `bundles.create.v1` request (hosted `docs/person-bundle-create.md`; no create limit unless the
// workspace sets one, D1), and converts the folder in place into a hosted checkout: the read-only
// marker, a private binding, and the files left exactly as they are. A Git board is unbound first:
// the folder stops being a worktree of the `board` branch, and the branch itself, local and on
// origin, is left where it was (the receipt names its commit). Git history travels only with
// --with-history, as labeled, unverified rows (D2).
//
// A retry after an unknown outcome reuses the same request id, recorded in private state, so the
// host finishes or confirms the one creation instead of starting another.
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { runGit } from "@superbee/board-git";
import { parseMarkdown, RemoteError } from "@superbee/core";
import { HostedCarrierError } from "@superbee/core/hosted-transport";

import { parseLeafOrUsage } from "../args.js";
import { findBundleRoot, openBundle, resolveLocalBundleTarget, resolveProjectBinding } from "../bundle.js";
import { bundleHomeAt, gitBoardSyncBlock, type BundleHomeFacts, type GitBoardFacts } from "../bundle-home.js";
import { deriveBundleDisplayName } from "../bundle-name.js";
import { loadCatalog } from "../catalog.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { resolveHostedTarget, type HostedTarget } from "../hosted-auth/discovery.js";
import { defaultHostedAuthDeps, ensureHostedAccessToken, hostedBundleHost } from "../hosted-auth/session.js";
import { createHostedSyncClient, hostedFailure } from "../hosted/client.js";
import { readDefaultWorkspace } from "../hosted/defaults.js";
import { bindingHostArgument, writeCheckoutMarker } from "../hosted/marker.js";
import { createBody, planDigest, planPublish, type PublishPlan } from "../hosted/publish-plan.js";
import { clearPendingCreate, clearPublishedExtras, readPendingCreate, writePendingCreate, writePublishedExtras } from "../hosted/publish-state.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode } from "../output.js";
import { assertBundleOutsidePrivateState } from "../private-state-bundle-boundary.js";
import { bindFolderInPlace } from "./checkout-adopt.js";
import { BUNDLE_ID, connectHostedBundle, registerInCatalog, type CheckoutDeps } from "./checkout.js";

export const PUBLISH_USAGE = `superbee publish — move a local bundle or Git board to hosted Superbee

Usage:
  superbee publish --to hosted [--dir <bundle>] [--host <url>] [--workspace <id>]
                   [--bundle-id <id>] [--name <name>] [--with-history] [--yes] [--json]

Without --yes, previews only, with no network: what travels (documents, reserved files, other
files), what stays (dot-files, links), every bound the host enforces (at most 1,000 documents,
100 other files, 1,500 objects in all, 3 MiB in one request; 64 KiB per document, 16 KiB of
frontmatter), the history plan, and what will happen to the folder.

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
finishes or confirms the one creation.

Options:
  --to hosted         Required: the only destination
  --dir <bundle>      The bundle to publish (default: the one found from here)
  --host <url>        Hosted Superbee URL (default: your last sign-in)
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

export type PublishDeps = CheckoutDeps;

function publishDeps(partial: Partial<PublishDeps>): PublishDeps {
  return {
    stdout: partial.stdout ?? ((text) => void process.stdout.write(text)),
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
  return BUNDLE_ID.test(id) ? id : "bundle";
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
  return name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 128);
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
    throw new CliError("FORBIDDEN", `${canonical} is a copy of a hosted checkout of '${facts.copy.marker.bundle_id}'; adopt it instead of publishing a second bundle`, {
      details: { reason: "unbound_copy", folder: canonical, marker_host: facts.copy.marker.host, marker_bundle_id: facts.copy.marker.bundle_id },
      help: `${cliInvocation()} checkout --adopt ${commandToken(canonical)} --host ${commandToken(facts.copy.marker.host)}`,
    });
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
    history: { mode: plan.historyPlan.mode, versions: plan.historyPlan.versions, ...(plan.historyPlan.skipped > 0 ? { skipped: plan.historyPlan.skipped } : {}), note: plan.historyPlan.note },
  };
}

/** One refusal answer of `bundles.create.v1`, as the CLI taxonomy names it. */
function createRefusal(code: string, message: string, context: { bundleId: string; workspace: string; target: HostedTarget; resume: CommandText; folder: string }): CliError {
  const details = { reason: code, bundle_id: context.bundleId, workspace: context.workspace, host: context.target.origin, host_message: message };
  switch (code) {
    case "bundle_exists":
      return new CliError("ALREADY_EXISTS", `the hosted bundle id '${context.bundleId}' is taken in ${context.workspace}`, { details, help: `${cliInvocation()} publish --to hosted --bundle-id <another id>` });
    case "workspace_not_found":
      return new CliError("NOT_FOUND", `'${context.workspace}' is not one of your workspaces on ${context.target.origin}`, { details, help: `${cliInvocation()} whoami --host ${commandToken(bindingHostArgument(context.target))}` });
    case "bundle_create_unavailable":
    case "bundle_create_limit":
      return new CliError("FORBIDDEN", code === "bundle_create_limit" ? `your bundle creation limit in ${context.workspace} is used up` : `${context.workspace} does not offer bundle creation to this client`, {
        details,
        help: "ask a workspace admin in the Superbee app",
      });
    case "request_conflict":
      return new CliError("CONFLICT", `an unfinished publish of '${context.bundleId}' from this folder carried other contents, and the host holds the id for it`, {
        details,
        help: `put the files back as they were and re-run the same command to finish it; if the creation already finished, bind this folder to it (your edits become sync conflicts): ${cliInvocation()} checkout --adopt ${commandToken(context.folder)} --host ${commandToken(bindingHostArgument(context.target))}`,
      });
    default:
      return new CliError("USAGE", `${context.target.origin} refused the bundle (${code}): ${message}`, { details, help: "fix the files it names, then preview again" });
  }
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
  if (!BUNDLE_ID.test(bundleId) || bundleId.length > 128) {
    throw new CliError("USAGE", `'${bundleId}' is not a hosted bundle id (lower-case letters and digits, joined by . _ or -, starting with a letter)`, {
      help: `${cliInvocation()} publish --to hosted --bundle-id <id>`,
    });
  }
  const hostChoice = await hostedBundleHost(values.host, home);
  const target = hostChoice ? resolveHostedTarget(hostChoice) : null;
  const withHistory = values["with-history"] === true;
  const plan = await planPublish(canonical, withHistory ? { history: true, ...(board ? { board } : {}), now: deps.auth.now() } : { history: false });

  const yesCommand = commandFragment`${cliInvocation()} publish --to hosted${values.dir !== undefined ? commandFragment` --dir ${commandToken(canonical)}` : commandFragment``}${
    target ? commandFragment` --host ${commandToken(bindingHostArgument(target))}` : commandFragment``
  }${values.workspace !== undefined ? commandFragment` --workspace ${commandToken(values.workspace)}` : commandFragment``} --bundle-id ${commandToken(bundleId)}${
    values.name !== undefined ? commandFragment` --name ${commandToken(name)}` : commandFragment``
  }${withHistory ? commandFragment` --with-history` : commandFragment``} --yes${values.json ? commandFragment` --json` : commandFragment``}`;
  const gitPlan = board
    ? {
        branch: board.branch,
        upstream: board.upstream,
        head: boardHead(board),
        sync: boardState?.block.state,
        ...(boardState && ((boardState.block.ahead as number | null) ?? 0) + ((boardState.block.uncommitted as number | null) ?? 0) > 0
          ? { not_on_branch: { ahead: boardState.block.ahead, uncommitted: boardState.block.uncommitted, note: "these travel to hosted but not to the board branch teammates still sync" } }
          : {}),
        will: "unbind this folder from the board branch; the branch and its commits stay, locally and on origin",
      }
    : null;

  if (!values.yes) {
    const blockers = [...plan.blockers.map((b) => ({ path: b.path, reason: b.reason, message: b.message })), ...(boardState?.blocker ? [boardState.blocker] : [])];
    if (!target) blockers.push({ path: "", reason: "no_host", message: "no hosted Superbee host: sign in first, or pass --host" });
    deps.stdout(
      render(
        {
          publish: "preview",
          ready: blockers.length === 0,
          folder: canonical,
          home: facts.home,
          to: {
            host: target?.origin ?? null,
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
            "convert this folder in place into a hosted checkout: no file rewritten, a read-only .superbee/checkout.json added",
            ...(board ? ["unbind the Git board first; teammates keep the board branch until you tell them"] : []),
          ],
          network: "none (preview)",
          help: blockers.length === 0 ? [String(yesCommand)] : !target ? [`${cliInvocation()} login --host <url>`] : ["fix the blocking files, then preview again"],
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

  // Sign-in first: AUTH_REQUIRED passes through unchanged with its one link, before any request.
  const token = await ensureHostedAccessToken(target, { resume: yesCommand }, deps.auth);
  const client = createHostedSyncClient({
    target,
    accessToken: token.accessToken,
    resume: yesCommand,
    deadlineMs: CREATE_DEADLINE_MS,
    ...(values.workspace !== undefined ? { workspace: values.workspace } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const identity = await client.whoami();
  const remembered = identity.tenantIds.length > 1 ? await readDefaultWorkspace(home, target.origin) : null;
  const workspace =
    values.workspace ??
    (identity.tenantIds.length === 1 ? identity.tenantIds[0]! : remembered !== null && identity.tenantIds.includes(remembered) ? remembered : null);
  if (workspace === null || !identity.tenantIds.includes(workspace)) {
    throw new CliError(workspace === null ? "USAGE" : "NOT_FOUND", workspace === null ? `you are in ${identity.tenantIds.length} workspaces on ${target.origin}: name one` : `you are not a member of workspace '${workspace}' on ${target.origin}`, {
      details: { reason: workspace === null ? "choose_workspace" : "not_a_member", workspaces: identity.tenantIds },
      help: `${cliInvocation()} publish --to hosted --workspace <id> --bundle-id ${commandToken(bundleId)} --yes`,
    });
  }

  const body = createBody(plan, { workspace, bundleId, name });
  const digest = planDigest(body);
  // An unfinished creation of the same bundle keeps its request id whatever changed since: the
  // host then finishes or confirms it, or answers request_conflict, and never holds the id for a
  // request nobody can finish.
  const earlier = await readPendingCreate(home, canonical, bundleId);
  const resumes = earlier !== null && earlier.host === target.origin && earlier.workspace === workspace;
  const requestId = resumes ? earlier.request_id : randomUUID();
  if (!resumes) await writePendingCreate(home, canonical, { request_id: requestId, host: target.origin, workspace, bundle_id: bundleId, digest });

  const context = { bundleId, workspace, target, resume: yesCommand, folder: canonical };
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
  if (answer.status === 429 && code === "bundle_create_limit") {
    await clearPendingCreate(home, canonical, bundleId);
    throw createRefusal(code, hostMessage, context);
  }
  if (answer.status === 200 && envelope.ok === false && code !== null) {
    if (code !== "request_conflict") await clearPendingCreate(home, canonical, bundleId);
    throw createRefusal(code, hostMessage, context);
  }
  if (answer.status !== 200 || envelope.ok !== true || typeof envelope.data !== "object" || envelope.data === null) {
    if (answer.status === 400) await clearPendingCreate(home, canonical, bundleId);
    throw hostedFailure(new RemoteError(`hosted bundle-create answered ${answer.status}`, code ?? "RUNTIME", answer.status), target, yesCommand);
  }
  await clearPendingCreate(home, canonical, bundleId);
  const created = envelope.data;
  await writePublishedExtras(home, canonical, { host: target.origin, bundle_id: bundleId, extras: plan.extras }).catch(() => {});

  // The bundle exists on the host. From here, a failure leaves the folder adoptable: the marker
  // goes in first, so `checkout --adopt` can finish the conversion.
  const markerSource = { origin: target.origin, audience: target.audience, bundle_id: bundleId, workspace };
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
    const connection = await connectHostedBundle(bundleId, target, workspace, deps, resume);
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
