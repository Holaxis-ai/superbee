// `superbee export` — copy a hosted bundle out of hosted Superbee, into a new folder or in place.
//
// The bundle comes from the host's portable export (`POST /sync/v1/export`): every document,
// reserved file and blob at the bundle's latest confirmed revision, as the host stores them, in one
// store-only zip with a digest manifest. The archive is read whole and verified before anything is
// written (`hosted/export-archive.ts`), so a stopped or tampered export never becomes files.
//
// Two ways to land it, each safe to interrupt:
//
// - `--to <folder>`: the files are written into a hidden sibling of the new folder, committed there
//   when `--git` asks, and the sibling is renamed onto the folder in one step. The folder is either
//   absent, or complete. A sibling left by a process that died is removed by the next export to
//   the same folder.
// - `--in-place` on a hosted checkout: the files the checkout lacks (blobs, reserved files, anything
//   newer on the host) are staged in `.superbee-export-partial/` inside the folder, a dot-folder the
//   sync scan and the bundle walk never read. Then the binding is removed, so no later sync can send
//   a half-converted folder, and the staged files are linked into place, never over an existing
//   file. The staging folder holds a journal, so re-running the same command after a crash
//   finishes the conversion without the network.
//
// The hosted bundle is never changed. History is not exported: only the current revision travels.
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { RemoteError } from "@superbee/core";
import { filesystemPushRoleLocks } from "@superbee/core/filesystem-push-role";
import { BOARD_BRANCH, identityFlags, runGit } from "@superbee/board-git";

import { parseLeafOrUsage } from "../args.js";
import { findBundleRoot, resolveProjectBinding } from "../bundle.js";
import { bundleHomeAt } from "../bundle-home.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode, type OutputMode } from "../output.js";
import { assertBundleOutsidePrivateState } from "../private-state-bundle-boundary.js";
import { hostedCheckoutAt } from "../autopull.js";
import { defaultHostedAuthDeps, ensureHostedAccessToken, hostArgument, readDefaultHost, type HostedAuthDeps } from "../hosted-auth/session.js";
import { resolveHostedTarget, type HostedTarget } from "../hosted-auth/discovery.js";
import { bindingForPath, checkoutLockName, releaseCheckout, type CheckoutBinding } from "../hosted/binding.js";
import { createHostedSyncClient, hostedFailure } from "../hosted/client.js";
import { hostedCheckoutFor } from "../hosted/sync.js";
import { hostedStatus } from "../hosted/status.js";
import { readCheckoutMarker, removeCheckoutMarker } from "../hosted/marker.js";
import { classifyEntryPath, ExportArchiveError, MAX_EXPORT_BYTES, verifyExport, type ArchiveEntry, type VerifiedExport } from "../hosted/export-archive.js";

export const EXPORT_USAGE = `superbee export — copy a hosted bundle out of hosted Superbee

Usage:
  superbee export <bundle-id> --to <folder> [--host <url>] [--workspace <id>] [--git] [--json]
  superbee export [--dir <checkout>] --to <folder> [--git] [--json]
  superbee export [--dir <checkout>] --in-place [--git] [--keep-unsent] [--json]

Fetches the hosted bundle's portable export: every document, reserved file (index.md, log.md)
and blob at its latest confirmed revision, byte for byte as the host stores them. The archive is
verified whole (every entry against the host's digest manifest) before any file is written.
Signs in if needed (AUTH_REQUIRED, exit 4, carries the one link to relay and the command to
re-run). The hosted bundle is never changed. History is not exported: the folder holds the
current revision only.

--to <folder> writes a new local bundle there. The folder must be new or empty; it appears
complete or not at all. With a bundle id the host is --host, else your last sign-in; with
--dir (or run inside a checkout) the checkout's own host and bundle are used.

--in-place converts a hosted checkout into a plain local bundle: it adds the files the checkout
lacks (blobs, reserved files, documents added on the host), never overwrites a file, then
forgets the checkout's binding. It refuses a checkout with changes sync has not sent, conflicts
or held files; run 'superbee sync' first, or pass --keep-unsent to keep them in this folder only.
If it is interrupted, re-running the same command finishes it.

--git makes the result a Git board: a repository on branch '${BOARD_BRANCH}' whose first commit is the
export. Share it with 'git remote add origin <url>' and 'superbee sync --establish'.

Options:
  --to <folder>       New or empty folder to export into
  --in-place          Convert the hosted checkout (--dir, else the current folder) into a local bundle
  --dir <checkout>    The hosted checkout to export (default: the current folder)
  --host <url>        Hosted Superbee URL, with a bundle id; default: your last sign-in
  --workspace <id>    Your workspace that holds the bundle, sent with the request
  --git               Initialize a Git repository on branch '${BOARD_BRANCH}' and commit the export
  --keep-unsent       With --in-place: convert even with unsent changes, conflicts or held files
  --json              Emit compact JSON instead of TOON
  -h, --help          Show this help

Examples:
  superbee export team.knowledge --to ~/work/team-knowledge --git
  superbee export --dir ~/work/team --to ~/work/team-copy
  superbee export --dir ~/work/team --in-place
`;

export interface ExportDeps {
  stdout: (text: string) => void;
  auth: HostedAuthDeps;
  cwd: string;
  /** The fetch the sync routes are reached with (the sign-in module keeps its own). */
  fetch?: typeof fetch;
}

function exportDeps(partial: Partial<ExportDeps>): ExportDeps {
  return {
    stdout: partial.stdout ?? ((text) => void process.stdout.write(text)),
    auth: partial.auth ?? defaultHostedAuthDeps(homedir()),
    cwd: partial.cwd ?? process.cwd(),
    ...(partial.fetch ? { fetch: partial.fetch } : {}),
  };
}

/** The export route's own window (60 s); the default 15 s read deadline would cut a large bundle. */
const EXPORT_DEADLINE_MS = 60_000;
const BUNDLE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
/** Paths shown per list in a receipt; the counts are always the totals. */
const SHOWN = 20;
export const IN_PLACE_STAGING = ".superbee-export-partial";
const JOURNAL = "journal.json";
const JOURNAL_SCHEMA = 1;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;

const NO_HISTORY = "not exported: the folder holds the current revision only";
const HOSTED_UNCHANGED = "unchanged: the hosted bundle still exists and was not modified";

interface Source {
  readonly target: HostedTarget;
  readonly bundleId: string;
  readonly workspace: string | null;
  /** Set when the source is a checkout: the principal it was made under. */
  readonly binding: CheckoutBinding | null;
}

async function entryKind(target: string): Promise<"absent" | "empty-dir" | "dir" | "other"> {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (!info.isDirectory()) return "other";
  return (await readdir(target)).length === 0 ? "empty-dir" : "dir";
}

function shown(paths: readonly string[]): string[] {
  return [...paths].sort().slice(0, SHOWN);
}

// ── fetch and verify ─────────────────────────────────────────────────────────────────────────

function refusalCode(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | undefined)?.error;
  if (typeof error === "string") return error;
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The whole archive, bounded, or the CLI error the host's answer means. */
async function fetchArchive(source: Source, deps: ExportDeps, resume: CommandText): Promise<Uint8Array> {
  const { target, bundleId } = source;
  const token = await ensureHostedAccessToken(target, { resume }, deps.auth);
  const client = createHostedSyncClient({
    target,
    accessToken: token.accessToken,
    resume,
    deadlineMs: EXPORT_DEADLINE_MS,
    ...(source.workspace !== null ? { workspace: source.workspace } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  if (source.binding) {
    const identity = await client.whoami();
    if (identity.principalId !== source.binding.principal_id) {
      throw new CliError("FORBIDDEN", `the checkout at ${source.binding.path} was made by another hosted identity than the one signed in`, {
        details: { reason: "other_principal", folder: source.binding.path, checkout_principal: source.binding.principal_id, signed_in_principal: identity.principalId },
        help: `${cliInvocation()} login --host ${commandToken(hostArgument(target))}`,
      });
    }
  }
  let answer;
  try {
    answer = await client.carrier.stream(`${client.prefix}/export`, { bundleId }, client.signal);
  } catch (error) {
    throw hostedFailure(error, target, resume);
  }
  if (!answer.ok) {
    const code = refusalCode(answer.body) ?? "RUNTIME";
    if (code === "bundle_not_found") {
      throw new CliError("NOT_FOUND", `no hosted bundle '${bundleId}' is visible to you on ${target.origin}`, {
        details: { bundle_id: bundleId, host: target.origin },
        help: `${cliInvocation()} whoami --host ${commandToken(hostArgument(target))}`,
      });
    }
    if (code === "result_too_large") {
      throw new CliError("FORBIDDEN", `hosted bundle '${bundleId}' is larger than an export carries`, {
        details: { reason: "bundle_too_large", bundle_id: bundleId, host: target.origin },
        help: "use Export bundle in the Superbee app",
      });
    }
    if (code === "validation_failed") {
      throw new CliError("FORBIDDEN", `hosted bundle '${bundleId}' holds a path an export cannot carry`, {
        details: { reason: "unexportable_path", bundle_id: bundleId, host: target.origin },
        help: "rename the document or file in the Superbee app, then retry the same command",
      });
    }
    throw hostedFailure(new RemoteError(`hosted export answered ${answer.status}`, code, answer.status), target, resume);
  }
  const reader = answer.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_EXPORT_BYTES) {
        throw new CliError("RUNTIME", `${target.origin} answered an export larger than ${MAX_EXPORT_BYTES} bytes`, {
          details: { host: target.origin, bundle_id: bundleId, retryable: false },
        });
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("TRANSIENT", `the export of '${bundleId}' from ${target.origin} stopped part way; nothing was written`, {
      details: { reason: "export_incomplete", bundle_id: bundleId, host: target.origin, retryable: true },
      help: "retry the same command",
    });
  } finally {
    void reader.cancel().catch(() => {});
  }
  const archive = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

function verified(archive: Uint8Array, source: Source): VerifiedExport {
  try {
    return verifyExport(archive, source.bundleId);
  } catch (error) {
    if (!(error instanceof ExportArchiveError)) throw error;
    if (error.problem === "incomplete") {
      // The host ends an export it could not finish (the bundle changed, the deadline passed, the
      // grant was withdrawn) without its central directory; the same request may well succeed.
      throw new CliError("TRANSIENT", `the export of '${source.bundleId}' was not completed by the host; nothing was written`, {
        details: { reason: "export_incomplete", bundle_id: source.bundleId, host: source.target.origin, retryable: true },
        help: "retry the same command",
      });
    }
    throw new CliError("RUNTIME", `${source.target.origin} answered an export this CLI refuses (${error.message}); nothing was written`, {
      details: { reason: `export_${error.problem}`, bundle_id: source.bundleId, host: source.target.origin, retryable: false },
      help: "upgrade Superbee (npm install -g superbee); if it persists, report this bundle and reason",
    });
  }
}

// ── writing ──────────────────────────────────────────────────────────────────────────────────

async function writeNewFile(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(file, "wx", 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Write every entry under a folder this command just created and alone writes to. */
async function writeEntries(root: string, entries: readonly ArchiveEntry[]): Promise<void> {
  for (const entry of entries) {
    const file = path.join(root, ...entry.path.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeNewFile(file, entry.bytes);
  }
}

function gitRun(dir: string, args: string[]): string {
  let result;
  try {
    result = runGit(dir, args);
  } catch (error) {
    throw new CliError("RUNTIME", `git could not run (${error instanceof Error ? error.message : String(error)})`, {
      details: { reason: "git_unavailable" },
      help: "install git, or export without --git",
    });
  }
  if (result.status !== 0) {
    throw new CliError("RUNTIME", `git ${args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? ""} failed: ${result.stderr.trim().split("\n").at(-1) ?? ""}`, {
      details: { reason: "git_failed" },
      help: "fix the git error, then retry the same command",
    });
  }
  return result.stdout.trim();
}

/** Initialize a repository on the board branch in `dir` and commit its files. */
function commitExport(dir: string, message: string, options: { force: boolean }): { branch: string; commit: string } {
  gitRun(dir, ["init", "-q"]);
  gitRun(dir, ["symbolic-ref", "HEAD", `refs/heads/${BOARD_BRANCH}`]);
  gitRun(dir, ["add", "-A", ...(options.force ? ["--force"] : []), "--", ".", `:(exclude)${IN_PLACE_STAGING}`]);
  gitRun(dir, [...identityFlags(dir), "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "--allow-empty", "-m", message]);
  return { branch: BOARD_BRANCH, commit: gitRun(dir, ["rev-parse", "HEAD"]) };
}

function commitMessage(source: Source, exported: VerifiedExport): string {
  return `Export ${source.bundleId} from ${source.target.origin} at revision ${exported.source.revision}\n\nsuperbee export, ${exported.exportedAt}: ${exported.counts.documents} documents, ${exported.counts.reserved} reserved files, ${exported.counts.blobs} blobs. History is not included.\n`;
}

// ── export --to <folder> ─────────────────────────────────────────────────────────────────────

/** The hidden sibling an export to `target` is assembled in. */
function stagingName(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.superbee-export-${process.pid}-${randomBytes(6).toString("hex")}.partial`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove what an earlier export to `target` left when its process died. Returns how many. */
async function removeAbandonedStaging(target: string): Promise<number> {
  const prefix = `.${path.basename(target)}.superbee-export-`;
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(path.dirname(target));
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d+)-[0-9a-f]{12}\.partial$/.exec(name.slice(prefix.length));
    if (!match || processAlive(Number(match[1]))) continue;
    await rm(path.join(path.dirname(target), name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Refuse a folder nested in a bundle, a bound project or a hosted checkout: one authority per folder. */
async function assertStandalone(target: string, home: string): Promise<void> {
  const parent = path.dirname(target);
  const help = "pass --to <folder> outside any bundle, board or checkout";
  const checkout = await hostedCheckoutAt(parent, home);
  if (checkout) {
    throw new CliError("FORBIDDEN", `refusing to export inside the hosted checkout at ${checkout.path}`, { details: { reason: "inside_checkout", enclosing: checkout.path }, help });
  }
  const enclosing = await findBundleRoot(parent).catch(() => null);
  if (enclosing) {
    throw new CliError("FORBIDDEN", `refusing to export inside the local bundle at ${enclosing}`, { details: { reason: "inside_bundle", enclosing }, help });
  }
  const binding = await resolveProjectBinding(parent).catch(() => null);
  if (binding) {
    throw new CliError("FORBIDDEN", `refusing to export inside a project bound to a board (${binding.file})`, { details: { reason: "inside_bound_project", binding: binding.file }, help });
  }
}

async function exportToFolder(source: Source, toArg: string, git: boolean, deps: ExportDeps, mode: OutputMode, resume: CommandText): Promise<void> {
  const requested = path.resolve(deps.cwd, toArg);
  assertBundleOutsidePrivateState(requested, deps.auth.home);
  const found = await entryKind(requested);
  if (found === "other") throw new CliError("ALREADY_EXISTS", `${requested} exists and is not a folder`, { details: { reason: "not_a_folder", folder: requested }, help: "pass --to <new folder>" });
  if (found === "dir") throw new CliError("ALREADY_EXISTS", `${requested} is not empty`, { details: { reason: "not_empty", folder: requested }, help: "pass --to <new or empty folder>" });
  await mkdir(path.dirname(requested), { recursive: true });
  const target = path.join(await realpath(path.dirname(requested)), path.basename(requested));
  assertBundleOutsidePrivateState(target, deps.auth.home);
  await assertStandalone(target, deps.auth.home);

  const exported = verified(await fetchArchive(source, deps, resume), source);

  const abandoned = await removeAbandonedStaging(target);
  const staging = stagingName(target);
  await mkdir(staging);
  let gitResult: { branch: string; commit: string } | null = null;
  try {
    await writeEntries(staging, exported.entries);
    if (git) gitResult = commitExport(staging, commitMessage(source, exported), { force: true });
    // Re-checked last: the folder must still be absent or empty. rename() replaces only an empty
    // folder, so a folder someone filled meanwhile is refused, never overwritten.
    const now = await entryKind(target);
    if (now === "dir" || now === "other") throw new CliError("ALREADY_EXISTS", `${target} is no longer empty`, { details: { reason: "not_empty", folder: target }, help: "pass --to <new or empty folder>" });
    try {
      await rename(staging, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") {
        throw new CliError("ALREADY_EXISTS", `${target} is no longer empty`, { details: { reason: "not_empty", folder: target }, help: "pass --to <new or empty folder>" });
      }
      throw error;
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const home = await bundleHomeAt(target, { home: deps.auth.home });
  deps.stdout(
    render(
      {
        export: "created",
        folder: target,
        home: home.home,
        bundle_id: source.bundleId,
        host: source.target.origin,
        revision: exported.source.revision,
        exported_at: exported.exportedAt,
        okf_edition: exported.source.okfEdition,
        documents: exported.counts.documents,
        reserved: exported.counts.reserved,
        blobs: exported.counts.blobs,
        bytes: exported.bytes,
        root_index: exported.entries.some((entry) => entry.path === "index.md"),
        ...(gitResult ? { git: gitResult } : {}),
        ...(abandoned > 0 ? { removed_abandoned_exports: abandoned } : {}),
        hosted: HOSTED_UNCHANGED,
        history: NO_HISTORY,
        help: nextSteps(target, gitResult !== null),
      },
      mode,
    ),
  );
}

function nextSteps(folder: string, git: boolean): CommandText[] {
  const steps = [commandFragment`${cliInvocation()} status --dir ${commandToken(folder)}`];
  if (git) steps.push(commandFragment`git -C ${commandToken(folder)} remote add origin <url> && ${cliInvocation()} sync --establish --dir ${commandToken(folder)}`);
  return steps;
}

// ── export --in-place ────────────────────────────────────────────────────────────────────────

interface Journal {
  readonly schema: typeof JOURNAL_SCHEMA;
  readonly bundle_id: string;
  readonly host: string;
  /** The binding's token audience: with `host`, what names the checkout's folder marker. */
  readonly audience: string;
  readonly revision: number;
  readonly exported_at: string;
  readonly git: boolean;
  /** Paths staged under `files/`, to be linked into the folder. */
  readonly adds: readonly string[];
  readonly same: number;
  readonly kept_local: readonly string[];
  readonly unsent_kept: number;
}

function isJournal(value: unknown): value is Journal {
  const record = value as Partial<Journal> | null;
  return (
    record !== null &&
    typeof record === "object" &&
    record.schema === JOURNAL_SCHEMA &&
    typeof record.bundle_id === "string" &&
    typeof record.host === "string" &&
    typeof record.audience === "string" &&
    Number.isSafeInteger(record.revision) &&
    typeof record.exported_at === "string" &&
    typeof record.git === "boolean" &&
    Array.isArray(record.adds) &&
    record.adds.every((entry) => typeof entry === "string") &&
    Number.isSafeInteger(record.same) &&
    Array.isArray(record.kept_local) &&
    record.kept_local.every((entry) => typeof entry === "string") &&
    Number.isSafeInteger(record.unsent_kept)
  );
}

async function readJournal(folder: string): Promise<Journal | null> {
  const file = path.join(folder, IN_PLACE_STAGING, JOURNAL);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_JOURNAL_BYTES) return null;
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    return isJournal(value) ? value : null;
  } catch {
    return null;
  }
}

async function sameBytes(file: string, bytes: Uint8Array): Promise<boolean> {
  try {
    return Buffer.compare(await readFile(file), Buffer.from(bytes)) === 0;
  } catch {
    return false;
  }
}

/** The placement of one archive entry against the folder as it is now. */
async function placementOf(folder: string, entry: ArchiveEntry): Promise<"add" | "same" | "kept"> {
  let info;
  try {
    info = await lstat(path.join(folder, ...entry.path.split("/")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "add";
    // A file where a folder of the path must be: the folder's own file is kept.
    if (code === "ENOTDIR") return "kept";
    throw error;
  }
  if (!info.isFile()) return "kept";
  return (await sameBytes(path.join(folder, ...entry.path.split("/")), entry.bytes)) ? "same" : "kept";
}

/** Link one staged file into the folder, never over an existing file and never through a link out of it. */
async function placeStaged(folder: string, staged: string, relative: string): Promise<"added" | "same" | "kept"> {
  const final = path.join(folder, ...relative.split("/"));
  try {
    await mkdir(path.dirname(final), { recursive: true });
    const parent = await realpath(path.dirname(final));
    if (parent !== folder && !parent.startsWith(`${folder}${path.sep}`)) return "kept";
  } catch {
    return "kept";
  }
  let outcome: "added" | "same" | "kept";
  try {
    await link(staged, final);
    outcome = "added";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Already moved by an earlier run of this conversion.
      return (await stat(final).then((info) => info.isFile(), () => false)) ? "same" : "kept";
    }
    if (code !== "EEXIST") throw error;
    outcome = (await sameBytes(final, await readFile(staged))) ? "same" : "kept";
  }
  await unlink(staged).catch(() => {});
  return outcome;
}

async function writeJournal(staging: string, journal: Journal): Promise<void> {
  const temp = path.join(staging, `.${JOURNAL}.${randomBytes(6).toString("hex")}.tmp`);
  await writeNewFile(temp, Buffer.from(`${JSON.stringify(journal)}\n`, "utf8"));
  await rename(temp, path.join(staging, JOURNAL));
}

interface Finished {
  readonly added: string[];
  readonly kept: string[];
  readonly same: number;
  readonly git: { branch: string; commit: string } | null;
  readonly marker: "removed" | "none";
}

/**
 * Finish a conversion whose binding is already gone: link the staged files in, commit when asked,
 * and remove the staging folder last, so a crash anywhere here is finished by re-running.
 */
async function finishInPlace(folder: string, journal: Journal): Promise<Finished> {
  const staging = path.join(folder, IN_PLACE_STAGING);
  const added: string[] = [];
  const kept = [...journal.kept_local];
  let same = journal.same;
  for (const relative of journal.adds) {
    classifyEntryPath(relative);
    const outcome = await placeStaged(folder, path.join(staging, "files", ...relative.split("/")), relative);
    if (outcome === "added") added.push(relative);
    else if (outcome === "same") same += 1;
    else kept.push(relative);
  }
  // The read-only `.superbee/checkout.json` names the host; a local bundle carries none.
  const marker = (await removeCheckoutMarker(folder, { origin: journal.host, audience: journal.audience, bundle_id: journal.bundle_id }).catch(() => false)) ? "removed" : "none";
  let git: Finished["git"] = null;
  if (journal.git) {
    const head = runGit(folder, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const top = runGit(folder, ["rev-parse", "--show-toplevel"]);
    const own = top.status === 0 && (await realpath(top.stdout.trim()).catch(() => "")) === folder;
    git =
      own && head.status === 0
        ? { branch: runGit(folder, ["symbolic-ref", "-q", "--short", "HEAD"]).stdout.trim() || BOARD_BRANCH, commit: head.stdout.trim() }
        : commitExport(folder, `Export ${journal.bundle_id} from ${journal.host} at revision ${journal.revision}\n\nsuperbee export --in-place, ${journal.exported_at}. History is not included.\n`, { force: false });
  }
  await rm(staging, { recursive: true, force: true });
  return { added, kept, same, git, marker };
}

function inPlaceReceipt(folder: string, journal: Journal, finished: Finished, homeName: string, resumed: boolean): Record<string, unknown> {
  return {
    export: "converted",
    folder,
    home: homeName,
    bundle_id: journal.bundle_id,
    host: journal.host,
    revision: journal.revision,
    exported_at: journal.exported_at,
    ...(resumed ? { resumed: true } : {}),
    binding: "removed (the folder is no longer a hosted checkout)",
    marker: finished.marker,
    added: finished.added.length,
    ...(finished.added.length > 0 ? { added_paths: shown(finished.added) } : {}),
    unchanged: finished.same,
    kept_local: finished.kept.length,
    ...(finished.kept.length > 0
      ? { kept_local_paths: shown(finished.kept), kept_local_note: "these files differ from the host's (or block its path); the folder's own were kept" }
      : {}),
    ...(journal.unsent_kept > 0 ? { unsent_kept: journal.unsent_kept, unsent_note: "changes sync had not sent stay in this folder only" } : {}),
    ...(finished.git ? { git: finished.git } : {}),
    hosted: HOSTED_UNCHANGED,
    history: NO_HISTORY,
    help: nextSteps(folder, finished.git !== null),
  };
}

async function assertNoRepository(folder: string): Promise<void> {
  if (await lstat(path.join(folder, ".git")).then(() => true, () => false)) {
    throw new CliError("ALREADY_EXISTS", `${folder} already holds a Git repository`, {
      details: { reason: "already_git", folder },
      help: `${cliInvocation()} export --in-place --dir ${commandToken(folder)}`,
    });
  }
}

async function exportInPlace(dirArg: string | undefined, git: boolean, keepUnsent: boolean, deps: ExportDeps, mode: OutputMode, resume: CommandText): Promise<void> {
  const requested = path.resolve(deps.cwd, dirArg ?? ".");
  assertBundleOutsidePrivateState(requested, deps.auth.home);
  const binding = await hostedCheckoutFor(dirArg === undefined ? [] : ["--dir", dirArg], deps.auth.home, deps.cwd);
  if (!binding) {
    const folder = await realpath(requested).catch(() => requested);
    const journal = await readJournal(folder);
    if (journal) {
      // The binding was removed by an earlier run that stopped before it finished: finish it.
      const finished = await finishInPlace(folder, journal);
      const home = await bundleHomeAt(folder, { home: deps.auth.home });
      deps.stdout(render(inPlaceReceipt(folder, journal, finished, home.home, true), mode));
      return;
    }
    if ((await entryKind(folder)) === "absent") throw new CliError("NOT_FOUND", `${folder} does not exist`, { help: `${cliInvocation()} export --in-place --dir <checkout folder>` });
    const marker = readCheckoutMarker(folder);
    if (marker) {
      // A copy of a checkout that is not bound here (moved, copied or restored): its files are
      // already a local bundle, and only the marker still says hosted. Its host is never trusted
      // on its own, so nothing is fetched: adopt it first to fill what it lacks from the host.
      if (git) await assertNoRepository(folder);
      await removeCheckoutMarker(folder, { origin: marker.host, audience: `${marker.host}/mcp`, bundle_id: marker.bundle_id });
      const committed = git
        ? commitExport(folder, `Export ${marker.bundle_id} (an unbound copy of a hosted checkout)\n\nsuperbee export --in-place. Nothing was fetched from the host; history is not included.\n`, { force: false })
        : null;
      const home = await bundleHomeAt(folder, { home: deps.auth.home });
      deps.stdout(
        render(
          {
            export: "converted",
            folder,
            home: home.home,
            bundle_id: marker.bundle_id,
            from: "an unbound copy of a hosted checkout",
            marker: "removed",
            fetched: false,
            note: `nothing was fetched: the files are kept as they are. To fill in what the copy lacks from the host first, adopt it (${cliInvocation()} checkout --adopt <folder> --host <url>), then export --in-place`,
            ...(committed ? { git: committed } : {}),
            hosted: HOSTED_UNCHANGED,
            history: NO_HISTORY,
            help: nextSteps(folder, committed !== null),
          },
          mode,
        ),
      );
      return;
    }
    const home = await bundleHomeAt(folder, { home: deps.auth.home });
    deps.stdout(render({ export: "unchanged", folder, home: home.home, reason: "not a hosted checkout: nothing to convert" }, mode));
    return;
  }
  const folder = binding.path;
  if (git) await assertNoRepository(folder);

  const status = await hostedStatus(binding, deps.auth.home);
  if (status.sync.state === "busy") {
    throw new CliError("CONFLICT", `another command holds the checkout lock for ${folder}`, { details: { reason: "checkout_busy", folder }, help: "wait for it to finish, then retry the same command" });
  }
  const pending = Number(status.sync.unsent ?? 0) + Number(status.sync.conflicts ?? 0) + Number(status.sync.held_files ?? 0) + Number(status.sync.held_deletions ?? 0);
  if (pending > 0 && !keepUnsent) {
    throw new CliError("CONFLICT", `the checkout of '${binding.bundle_id}' at ${folder} has ${pending} change(s) not on the host`, {
      details: { reason: "unsent_changes", folder, ...status.sync },
      help: commandFragment`${cliInvocation()} sync --dir ${commandToken(folder)} (or, to keep them in this folder only: ${cliInvocation()} export --in-place --dir ${commandToken(folder)} --keep-unsent${git ? commandFragment` --git` : commandFragment``})`,
    });
  }

  const source: Source = { target: resolveHostedTarget(binding.audience), bundleId: binding.bundle_id, workspace: binding.workspace, binding };
  const exported = verified(await fetchArchive(source, deps, resume), source);

  const result = await filesystemPushRoleLocks()
    .request(checkoutLockName(folder), { ifAvailable: true }, async (lock) => {
      if (!lock) {
        throw new CliError("CONFLICT", `another command holds the checkout lock for ${folder}`, { details: { reason: "checkout_busy", folder }, help: "wait for it to finish, then retry the same command" });
      }
      const current = await bindingForPath(deps.auth.home, folder);
      if (!current || current.checkout_id !== binding.checkout_id) {
        throw new CliError("CONFLICT", `the checkout at ${folder} changed while it was exported`, { details: { reason: "checkout_changed", folder }, help: "retry the same command" });
      }
      const staging = path.join(folder, IN_PLACE_STAGING);
      // A staging folder under a live binding is from a run that stopped before unbinding: redo it.
      await rm(staging, { recursive: true, force: true });
      await mkdir(path.join(staging, "files"), { recursive: true });
      const adds: string[] = [];
      const kept: string[] = [];
      let same = 0;
      for (const entry of exported.entries) {
        const placement = await placementOf(folder, entry);
        if (placement === "same") same += 1;
        else if (placement === "kept") kept.push(entry.path);
        else {
          const file = path.join(staging, "files", ...entry.path.split("/"));
          await mkdir(path.dirname(file), { recursive: true });
          await writeNewFile(file, entry.bytes);
          adds.push(entry.path);
        }
      }
      const journal: Journal = {
        schema: JOURNAL_SCHEMA,
        bundle_id: binding.bundle_id,
        host: binding.origin,
        audience: binding.audience,
        revision: exported.source.revision,
        exported_at: exported.exportedAt,
        git,
        adds,
        same,
        kept_local: kept,
        unsent_kept: pending,
      };
      await writeJournal(staging, journal);
      // The binding goes before any file lands, so no sync ever sees a half-converted folder.
      await releaseCheckout(deps.auth.home, binding);
      return { journal, finished: await finishInPlace(folder, journal) };
    });

  const home = await bundleHomeAt(folder, { home: deps.auth.home });
  deps.stdout(render(inPlaceReceipt(folder, result.journal, result.finished, home.home, false), mode));
}

// ── the command ──────────────────────────────────────────────────────────────────────────────

export async function exportCommand(argv: string[], partial: Partial<ExportDeps> = {}): Promise<void> {
  const deps = exportDeps(partial);
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          to: { type: "string" },
          "in-place": { type: "boolean" },
          dir: { type: "string" },
          host: { type: "string" },
          workspace: { type: "string" },
          git: { type: "boolean" },
          "keep-unsent": { type: "boolean" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.export,
  );
  if (values.help) {
    deps.stdout(renderUsage(EXPORT_USAGE));
    return;
  }
  const mode = resolveMode(values);
  const usage = (message: string) => new CliError("USAGE", message, { help: `${cliInvocation()} export --help` });
  const bundleId = positionals[0];
  const inPlace = values["in-place"] === true;
  if (inPlace === (values.to !== undefined)) throw usage("pass exactly one of --to <folder> and --in-place");
  if (bundleId !== undefined && values.dir !== undefined) throw usage("pass a bundle id or --dir <checkout>, not both");
  if (bundleId === undefined && (values.host !== undefined || values.workspace !== undefined)) throw usage("--host and --workspace go with a bundle id; a checkout uses its own");
  if (inPlace && bundleId !== undefined) throw usage("--in-place converts a checkout folder: pass --dir <checkout>, not a bundle id");
  if (!inPlace && values["keep-unsent"]) throw usage("--keep-unsent goes with --in-place");
  if (bundleId !== undefined && (!BUNDLE_ID.test(bundleId) || bundleId.length > 128)) throw usage(`'${bundleId}' is not a hosted bundle id`);
  const git = values.git === true;
  const resume: CommandText = commandFragment`${cliInvocation()} export${bundleId !== undefined ? commandFragment` ${commandToken(bundleId)}` : commandFragment``}${
    values.dir !== undefined ? commandFragment` --dir ${commandToken(path.resolve(deps.cwd, values.dir))}` : commandFragment``
  }${values.to !== undefined ? commandFragment` --to ${commandToken(path.resolve(deps.cwd, values.to))}` : commandFragment``}${inPlace ? commandFragment` --in-place` : commandFragment``}${
    values.host !== undefined ? commandFragment` --host ${commandToken(values.host)}` : commandFragment``
  }${values.workspace !== undefined ? commandFragment` --workspace ${commandToken(values.workspace)}` : commandFragment``}${git ? commandFragment` --git` : commandFragment``}${
    values["keep-unsent"] ? commandFragment` --keep-unsent` : commandFragment``
  }${values.json ? commandFragment` --json` : commandFragment``}`;

  if (values.dir !== undefined) assertBundleOutsidePrivateState(path.resolve(deps.cwd, values.dir), deps.auth.home);
  if (inPlace) {
    await exportInPlace(values.dir, git, values["keep-unsent"] === true, deps, mode, resume);
    return;
  }

  let source: Source;
  if (bundleId !== undefined) {
    const hostChoice = values.host || (await readDefaultHost(deps.auth.home));
    if (!hostChoice) throw new CliError("USAGE", "no hosted Superbee host: sign in first, or pass --host", { help: `${cliInvocation()} login --host <url>` });
    source = { target: resolveHostedTarget(hostChoice), bundleId, workspace: values.workspace ?? null, binding: null };
  } else {
    const binding = await hostedCheckoutFor(values.dir === undefined ? [] : ["--dir", values.dir], deps.auth.home, deps.cwd);
    if (!binding) {
      throw new CliError("NOT_FOUND", `${path.resolve(deps.cwd, values.dir ?? ".")} is not a hosted checkout`, {
        details: { reason: "not_a_checkout" },
        help: `${cliInvocation()} export <bundle-id> --to ${commandToken(values.to!)}`,
      });
    }
    source = { target: resolveHostedTarget(binding.audience), bundleId: binding.bundle_id, workspace: binding.workspace, binding };
  }
  await exportToFolder(source, values.to!, git, deps, mode, resume);
}
