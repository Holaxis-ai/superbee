// `sync --inspect` and `sync --resolve keep|take|revise` on a Git board: the hosted checkout's
// conflict verbs, as aliases over the Git board's own conflict flow. A plain `sync` still
// converges exactly as before (the teammate's version is kept, yours is saved to an export file);
// these verbs only read that saved copy and finish the reconcile chain the conflict row names:
//
//   --inspect          your saved version and the teammate's kept one (origin/board, last fetch)
//   --resolve take     the teammate's version stays; your saved copy is discarded
//   --resolve keep     your saved body is written over the teammate's with `doc update`
//   --resolve revise   the document as it is now (edited to the result first) is the resolution
//
// Nothing here fetches, commits or pushes: the next plain `sync` shares keep and revise.
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeConceptId, conceptIdFromPath, isReservedFile, parseMarkdown, pathFromConceptId, versionOfBytes } from "@superbee/core";
import { BOARD_REF, bundleDirNameForProject, readDocBytesAtRef, repoTopLevel, resolveBundleKey, retargetBoardInterior, runGit } from "@superbee/board-git";
import { resolveLocalBundleRoute } from "../../bundle.js";
import { commandFragment, commandToken, type CommandText } from "../../command-text.js";
import { defaultSyncStore } from "../../cursor.js";
import { CliError } from "../../errors.js";
import { cliInvocation } from "../../invocation.js";
import { render, resolveMode } from "../../output.js";
import { assertPathOutsidePrivateState } from "../../private-state-bundle-boundary.js";
import type { SyncCliDeps } from "../../sync-cli.js";
import { docUpdate } from "../doc/update.js";
import { docWrite } from "../doc/write.js";
import { CLAIM_LOST_KEY, claimLostStatement, ENGINE_STAMPED_FIELDS, loadClaimPolicy, recordedOwner } from "./claim-conflict.js";
import { parseSyncArgs } from "./orchestrate.js";

/** The raw flags that ask for a conflict verb (as opposed to a hosted-only deletion verb). */
const CONFLICT_FLAGS = ["--inspect", "--resolve", "--doc"] as const;
/** Hosted-only verbs: a Git board has no held or refused deletions. */
const HOSTED_ONLY_FLAGS = ["--accept-deletes", "--restore-deletes", "--take-host-deletions"] as const;
/** Flags of the Git sync run that have no meaning for a conflict verb. */
const RUN_ONLY_FLAGS = ["establish", "pull-only", "show-incoming", "yes", "body-out", "migrate", "limit"] as const;
/** Content shown per side by --inspect; --out writes the teammate's version whole. */
const INSPECT_PREVIEW_CHARS = 4000;

function hasFlag(argv: readonly string[], flags: readonly string[]): boolean {
  for (const token of argv) {
    if (token === "--") return false;
    if (flags.some((flag) => token === flag || token.startsWith(`${flag}=`))) return true;
  }
  return false;
}

/** True when raw argv asks for `--inspect`, `--resolve` or `--doc`. */
export function requestsConflictVerb(argv: readonly string[]): boolean {
  return hasFlag(argv, CONFLICT_FLAGS);
}

/** True when raw argv asks for a verb only a hosted checkout has. */
export function requestsHostedOnlyVerb(argv: readonly string[]): boolean {
  return hasFlag(argv, HOSTED_ONLY_FLAGS);
}

/** The refusal for a hosted-only verb on any other target. */
export function hostedOnlyVerbError(): CliError {
  return new CliError("USAGE", "--accept-deletes, --restore-deletes and --take-host-deletions apply to a hosted checkout; this folder is not one", {
    help: `${cliInvocation()} sync --help`,
  });
}

type Choice = "keep" | "take" | "revise";

/** The sync CLI's deps plus the run directory a hosted checkout resolves from. */
export type GitConflictDeps = Partial<SyncCliDeps> & { cwd?: string };

interface ConflictArgs {
  id: string;
  inspect: boolean;
  resolve?: Choice;
  out?: string;
  dir?: string;
  json?: boolean;
}

function parseConflictArgs(argv: string[]): ConflictArgs {
  const { values } = parseSyncArgs(argv);
  const inv = cliInvocation();
  for (const flag of RUN_ONLY_FLAGS) {
    if ((values as Record<string, unknown>)[flag] !== undefined) {
      throw new CliError("USAGE", `--${flag} is not part of --inspect or --resolve; each is a step of its own`, { help: `${inv} sync --help` });
    }
  }
  if (values["accept-deletes"] !== undefined || values["restore-deletes"] !== undefined || values["take-host-deletions"] !== undefined) {
    throw hostedOnlyVerbError();
  }
  if (values.inspect !== undefined && values.resolve !== undefined) {
    throw new CliError("USAGE", "--inspect and --resolve are separate steps", { help: `${inv} sync --inspect --doc <id>` });
  }
  let target: string | undefined;
  if (values.inspect !== undefined) {
    // `--inspect --doc <id>` is the spelling; `--inspect <id>` is its alias, as in a hosted checkout.
    if (values.inspect === "" && values.doc === undefined) throw new CliError("USAGE", "--inspect needs --doc <id>", { help: `${inv} sync --inspect --doc <id>` });
    if (values.inspect !== "" && values.doc !== undefined && values.inspect !== values.doc) {
      throw new CliError("USAGE", `--inspect names '${values.inspect}' and --doc names '${values.doc}'; name one document`, { help: `${inv} sync --inspect --doc ${commandToken(values.doc)}` });
    }
    target = values.inspect === "" ? values.doc : values.inspect;
  } else if (values.resolve !== undefined) {
    if (values.doc === undefined) throw new CliError("USAGE", "--resolve needs --doc <id>", { help: `${inv} sync --resolve ${commandToken(values.resolve)} --doc <id>` });
    if (!["keep", "take", "revise"].includes(values.resolve)) {
      throw new CliError("USAGE", `--resolve takes keep, take or revise, not '${values.resolve}'`, { help: `${inv} sync --resolve keep|take|revise --doc <id>` });
    }
    target = values.doc;
  } else {
    throw new CliError("USAGE", "--doc names the document for --inspect or --resolve", { help: `${inv} sync --inspect --doc ${commandToken(values.doc ?? "<id>")}` });
  }
  if (values.out !== undefined && values.inspect === undefined) {
    throw new CliError("USAGE", "--out writes the teammate's version for --inspect", { help: `${inv} sync --inspect --doc <id> --out <file>` });
  }
  const raw = (target ?? "").trim();
  const id = conceptIdFromPath(raw);
  try {
    assertSafeConceptId(id);
  } catch (error) {
    throw new CliError("USAGE", `'${raw}' is not a document id (${(error as Error).message})`, { help: `${inv} sync --inspect --doc <id>` });
  }
  if (isReservedFile(pathFromConceptId(id))) {
    throw new CliError("USAGE", `'${raw}' is a reserved file, not a document; view its incoming version with --show-incoming`, { help: `${inv} sync --show-incoming ${commandToken(raw)}` });
  }
  return {
    id,
    inspect: values.inspect !== undefined,
    ...(values.resolve !== undefined ? { resolve: values.resolve as Choice } : {}),
    ...(values.out !== undefined ? { out: values.out } : {}),
    ...(values.dir !== undefined ? { dir: values.dir } : {}),
    ...(values.json !== undefined ? { json: values.json } : {}),
  };
}

/** The board a conflict verb reads: its folder, the state key its exports live under, and the id's saved copy. */
interface Board {
  root: string;
  relPath: string;
  file: string;
  exportPath: string;
  bodyExportPath: string;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch {
    return false;
  }
}

async function readIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function dirSuffix(args: ConflictArgs): CommandText {
  return args.dir !== undefined ? commandFragment` --dir ${commandToken(args.dir)}` : commandFragment``;
}

/**
 * The bundle folder `--dir` names. `sync --dir` takes any folder of the project to run from, so a
 * folder inside a repository selects that project's board checkout, as a plain sync would, and a
 * board checkout or standalone board clone is its own repository's root. A folder outside any
 * repository is taken as the bundle itself (the resolver then reports that it is not a board).
 */
export function conflictBundleDir(dir: string | undefined, cwd: string): string | undefined {
  if (dir === undefined) return undefined;
  const requested = retargetBoardInterior(path.resolve(cwd, dir));
  const top = repoTopLevel(requested);
  if (top === null) return requested;
  const board = path.join(top, bundleDirNameForProject(top));
  return existsSync(board) ? board : top;
}

async function locateBoard(args: ConflictArgs, cwd: string): Promise<Board> {
  const inv = cliInvocation();
  const route = await resolveLocalBundleRoute(conflictBundleDir(args.dir, cwd), cwd);
  if (route.kind === "bound-board" && route.readiness !== "ready") {
    throw new CliError("CONFLICT", "the selected private board has a board-origin rebase pending; run sync first to recover it", { help: `${inv} sync${dirSuffix(args)}` });
  }
  const root = route.kind === "bound-board" ? route.owner.bundleRoot : route.bundle.root;
  if (repoTopLevel(root) === null || runGit(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/${BOARD_REF}`]).status !== 0) {
    throw new CliError("USAGE", "--inspect and --resolve apply to a shared Git board or a hosted checkout; this bundle is neither, so sync has no conflicts to show", {
      details: { bundle: root },
      help: `${inv} sync --help`,
    });
  }
  const key = route.kind === "bound-board" ? route.owner.stateKey : resolveBundleKey(root);
  const relPath = pathFromConceptId(args.id);
  const exportPath = path.join(defaultSyncStore.exportsDir(key), relPath);
  const board: Board = {
    root,
    relPath,
    file: path.join(root, relPath),
    exportPath,
    bodyExportPath: exportPath.replace(/\.md$/, ".body.md"),
  };
  if (!(await isFile(exportPath))) {
    throw new CliError("NOT_FOUND", `'${args.id}' has no saved conflict on this board: sync saves your version only when a teammate changed the same document`, {
      details: { id: args.id, board: root },
      help: `${inv} sync${dirSuffix(args)}`,
    });
  }
  return board;
}

function preview(content: string | null): { content: string | null; truncated: boolean; chars: number } {
  if (content === null) return { content: null, truncated: false, chars: 0 };
  return { content: content.length > INSPECT_PREVIEW_CHARS ? content.slice(0, INSPECT_PREVIEW_CHARS) : content, truncated: content.length > INSPECT_PREVIEW_CHARS, chars: content.length };
}

function parsed(bytes: Buffer | null, relPath: string): { frontmatter: Record<string, unknown>; body: string } | null {
  if (bytes === null) return null;
  try {
    const doc = parseMarkdown(bytes.toString("utf8"), relPath);
    return { frontmatter: doc.frontmatter as Record<string, unknown>, body: doc.body };
  } catch {
    return null;
  }
}

function frontmatterOf(bytes: Buffer | null, relPath: string): Record<string, unknown> | null {
  return parsed(bytes, relPath)?.frontmatter ?? null;
}

/** Top-level frontmatter keys whose values differ between the two sides; the engine's own stamps excluded. */
function frontmatterDiffers(local: Record<string, unknown> | null, remote: Record<string, unknown> | null): string[] {
  if (local === null || remote === null) return [];
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  keys.delete("timestamp");
  for (const stamped of ENGINE_STAMPED_FIELDS) keys.delete(stamped);
  return [...keys].filter((key) => JSON.stringify(local[key]) !== JSON.stringify(remote[key])).sort();
}

/**
 * How the two sides' frontmatter differs, with the converge's own claim rule: when a declared
 * owner field diverged, every claim coordinate leaves the list (re-applying it would take the
 * document back from the arbitrated owner) and the ownership statement is reported instead.
 */
interface Divergence {
  differs: string[];
  /** Present when a declared claim diverged; `statement` only when an owner can be named honestly. */
  claim?: { statement?: string; only: boolean };
}

async function divergenceOf(board: Board, local: Buffer, remote: Buffer | null): Promise<Divergence> {
  const localDoc = parsed(local, board.relPath);
  const remoteDoc = parsed(remote, board.relPath);
  if (localDoc === null || remoteDoc === null) return { differs: [] };
  const differs = frontmatterDiffers(localDoc.frontmatter, remoteDoc.frontmatter);
  const policy = await loadClaimPolicy(board.root);
  const coordinates = policy.forType(remoteDoc.frontmatter.type);
  const ownerField = coordinates?.ownerField;
  if (coordinates === undefined || ownerField === undefined || !differs.includes(ownerField)) return { differs };
  const rest = differs.filter((key) => !coordinates.fields.includes(key));
  const upstream = policy.upstreamFrontmatter(board.relPath);
  const statement =
    recordedOwner(localDoc.frontmatter, ownerField) !== undefined && upstream !== undefined && policy.provenance !== undefined
      ? claimLostStatement(recordedOwner(upstream, ownerField), policy.provenance)
      : undefined;
  return { differs: rest, claim: { ...(statement !== undefined ? { statement } : {}), only: rest.length === 0 && localDoc.body === remoteDoc.body } };
}

function claimFields(divergence: Divergence): Record<string, unknown> {
  return divergence.claim?.statement !== undefined ? { [CLAIM_LOST_KEY]: divergence.claim.statement } : {};
}

function commandFor(args: ConflictArgs, choice: Choice): string {
  return `${cliInvocation()} sync --resolve ${choice} --doc ${commandToken(args.id)}${dirSuffix(args)}`;
}

async function runInspect(args: ConflictArgs, board: Board, cwd: string): Promise<Record<string, unknown>> {
  const local = await fs.readFile(board.exportPath);
  const remote = readDocBytesAtRef(board.root, `refs/remotes/${BOARD_REF}`, board.relPath);
  if (args.out !== undefined) {
    if (remote === null) throw new CliError("NOT_FOUND", `the teammate's side has no version of '${args.id}' to write: it was deleted there`, { details: { id: args.id } });
    const outHelp = `${cliInvocation()} sync --inspect --doc ${commandToken(args.id)} --out <file outside the bundle>`;
    if (args.out.trim() === "" || args.out.trim() === "-") {
      throw new CliError("USAGE", "--out takes a file path; the teammate's version is not streamed to stdout here", { help: outHelp });
    }
    const out = path.resolve(cwd, args.out);
    // A link at the target itself would carry the write wherever it points, so it is refused.
    const existing = await fs.lstat(out).catch(() => null);
    if (existing?.isSymbolicLink()) throw new CliError("USAGE", "--out must not be a symbolic link", { help: outHelp });
    let landing = out;
    try {
      landing = path.join(await fs.realpath(path.dirname(out)), path.basename(out));
    } catch {
      // The parent does not exist yet; the write below fails on its own.
    }
    assertPathOutsidePrivateState(out);
    assertPathOutsidePrivateState(landing);
    const root = await fs.realpath(board.root);
    if (landing === root || landing.startsWith(`${root}${path.sep}`)) {
      throw new CliError("USAGE", "--out must be outside the bundle, or the file would be synced as a document", { help: outHelp });
    }
    await fs.writeFile(out, remote);
  }
  const localText = local.toString("utf8");
  const remoteText = remote === null ? null : remote.toString("utf8");
  const divergence = await divergenceOf(board, local, remote);
  const differs = divergence.differs;
  const deleted = remote === null;
  // A lost claim with nothing else to carry offers no keep: keeping would only retake ownership.
  const claimOnly = divergence.claim?.only === true;
  return {
    conflict: args.id,
    file: board.file,
    reason: deleted ? "deleted_remotely" : "changed_remotely",
    local: { version: versionOfBytes(localText), saved_at: board.exportPath, ...preview(localText) },
    remote: { version: remoteText === null ? null : versionOfBytes(remoteText), ref: `${BOARD_REF} (as of the last fetch)`, ...(deleted ? { deleted: true } : {}), ...preview(remoteText) },
    ...claimFields(divergence),
    ...(differs.length > 0 ? { frontmatter_differs: differs } : {}),
    ...(args.out !== undefined ? { remote_written_to: path.resolve(cwd, args.out) } : {}),
    choices: deleted
      ? {
          take: "accept the deletion: the file is removed and your saved copy is discarded",
          keep: "re-create the document from your saved version with doc write",
          revise: "re-create the document as you want it first, then record it",
        }
      : claimOnly
        ? {
            take: "keep the teammate's version: your saved copy is discarded",
            revise: "edit the document to the result you want first, then record it",
          }
        : {
            keep: "write your saved body over the teammate's with doc update",
            take: "restore the teammate's version: your saved copy is discarded",
            revise: "edit the document to the result you want first, then record it",
          },
    help: deleted
      ? [commandFor(args, "take"), commandFor(args, "keep"), commandFor(args, "revise")]
      : claimOnly
        ? [commandFor(args, "take"), commandFor(args, "revise")]
        : [commandFor(args, "keep"), commandFor(args, "take"), commandFor(args, "revise")],
  };
}

/** Run one `doc` verb in-process and return its JSON receipt. */
async function runDocVerb(verb: typeof docUpdate, argv: string[]): Promise<Record<string, unknown>> {
  const out: string[] = [];
  await verb([...argv, "--json"], { stdout: (text: string) => void out.push(text) });
  try {
    return JSON.parse(out.join("")) as Record<string, unknown>;
  } catch {
    throw new CliError("RUNTIME", "the document write gave no readable receipt; your saved copy was kept", { help: `${cliInvocation()} sync --help` });
  }
}

async function discardSavedCopy(board: Board): Promise<void> {
  await fs.rm(board.exportPath, { force: true });
  await fs.rm(board.bodyExportPath, { force: true });
}

async function runResolve(args: ConflictArgs, choice: Choice, board: Board, cwd: string): Promise<Record<string, unknown>> {
  const inv = cliInvocation();
  const remote = readDocBytesAtRef(board.root, `refs/remotes/${BOARD_REF}`, board.relPath);
  const bundleDir = conflictBundleDir(args.dir, cwd);
  const dirArgs = bundleDir !== undefined ? ["--dir", bundleDir] : [];
  const local = await fs.readFile(board.exportPath);
  const divergence = await divergenceOf(board, local, remote);
  const present = await readIfPresent(board.file);
  let fileState: string;
  let notCarried: string[] = [];
  if (choice === "keep") {
    if (divergence.claim?.only === true) {
      throw new CliError("CONFLICT", `'${args.id}' differs only by a claim the teammate's version won, so there is nothing of yours to keep`, {
        details: { id: args.id, claim_only: true, ...claimFields(divergence) },
        help: commandFor(args, "take"),
      });
    }
    if (!(await isFile(board.bodyExportPath))) {
      throw new CliError("CONFLICT", `your saved version of '${args.id}' is not a readable document, so keep cannot write it; merge it by hand from ${board.exportPath}, then use revise`, {
        details: { id: args.id, saved_at: board.exportPath },
        help: commandFor(args, "revise"),
      });
    }
    const localFrontmatter = frontmatterOf(local, board.relPath);
    if (present === null) {
      const type = localFrontmatter?.type;
      if (typeof type !== "string" || type.trim() === "") {
        throw new CliError("CONFLICT", `your saved version of '${args.id}' has no type, so keep cannot re-create it; re-create it with doc write, then use revise`, {
          details: { id: args.id, saved_at: board.exportPath },
          help: `${inv} doc write ${commandToken(args.id)} --type <Type> --body-file ${commandToken(board.bodyExportPath)}`,
        });
      }
      const title = localFrontmatter?.title;
      await runDocVerb(docWrite, [args.id, "--type", type, ...(typeof title === "string" && title !== "" ? ["--title", title] : []), "--body-file", board.bodyExportPath, ...dirArgs]);
      fileState = "re-created";
      notCarried = Object.keys(localFrontmatter ?? {}).filter((key) => !["type", "title", "timestamp", ...ENGINE_STAMPED_FIELDS].includes(key)).sort();
    } else {
      // Yours replaces theirs deliberately, so a link only the teammate's body carried is not a reason to stop.
      const receipt = await runDocVerb(docUpdate, [args.id, "--body-file", board.bodyExportPath, "--replace-links", ...dirArgs]);
      fileState = receipt.changed === false ? "unchanged" : "written";
      notCarried = divergence.differs;
    }
  } else if (choice === "take") {
    // take means the teammate's version, so any edit made since the converge is put back to it.
    if (remote === null) {
      if (present !== null) await fs.rm(board.file, { force: true });
      fileState = present === null ? "absent" : "removed";
    } else if (present !== null && present.equals(remote)) {
      fileState = "unchanged";
    } else {
      const restored = runGit(board.root, ["restore", `--source=refs/remotes/${BOARD_REF}`, "--worktree", "--", board.relPath]);
      if (restored.status !== 0) {
        throw new CliError("RUNTIME", `could not restore the teammate's version of '${args.id}'; your saved copy was kept`, {
          details: { id: args.id, git: restored.stderr.trim() },
          help: commandFor(args, "take"),
        });
      }
      fileState = "restored";
    }
  } else {
    if (present === null) {
      throw new CliError("CONFLICT", `'${args.id}' is not in the bundle: re-create it as you want it first, or use keep to re-create it from your saved version, or take to accept the deletion`, {
        details: { id: args.id, saved_at: board.exportPath },
        help: commandFor(args, "keep"),
      });
    }
    fileState = "unchanged";
  }
  // The resolution is recorded by removing the saved copy, after any write it needed.
  await discardSavedCopy(board);
  const now = await readIfPresent(board.file);
  const sends = now === null ? remote !== null : remote === null || !now.equals(remote);
  const sync = `${inv} sync${dirSuffix(args)}`;
  return {
    resolved: args.id,
    choice,
    file: board.file,
    file_state: fileState,
    discarded: board.exportPath,
    sent: false,
    ...claimFields(divergence),
    ...(notCarried.length > 0 ? { frontmatter_not_carried: notCarried } : {}),
    next: sends
      ? `resolved, not pushed yet: run ${sync} to share the document as it is now`
      : "resolved: the document matches the teammate's version, so there is nothing to push for it",
    help: sends ? [sync] : [],
  };
}

/**
 * `sync --inspect` / `sync --resolve` on anything that is not a hosted checkout. A Git board with a
 * saved conflict answers; any other bundle is refused with the reason.
 */
export async function gitConflictVerb(argv: string[], deps: GitConflictDeps = {}): Promise<void> {
  const args = parseConflictArgs(argv);
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const cwd = deps.cwd ?? process.cwd();
  const mode = resolveMode({ json: args.json });
  const board = await locateBoard(args, cwd);
  const record = args.inspect ? await runInspect(args, board, cwd) : await runResolve(args, args.resolve!, board, cwd);
  stdout(render(record, mode));
}
