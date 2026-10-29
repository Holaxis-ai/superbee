// `superbee view read <viewId>` and `superbee view update <viewId> --expected-version <v>`: a
// registered View's page (its `entry`, under `views/`) read and replaced whole on a hosted
// checkout's host, through `<sync prefix>/view-content-read` and `<sync prefix>/view-content-update`.
// Sync never sends `views/` (the scan holds it), so this is the one way a checkout changes a page.
//
// Both pin the registration's version as the host serves it now, read through the checkout's
// document reader just before; an update also pins the page's version the author started from
// (`--expected-version`), the same `sha256:` digest a Portal site pins. An update is sent once and
// never resent: an outcome the CLI cannot read is settled by reading the page again. Uploading a page
// never approves its execution; that stays separate (a site's pin, a hosted app slot's approval).
import { lstat, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { readDocVersioned, RemoteError } from "@superbee/core";
import { isAnyRegistryId, parseRegistration } from "@superbee/core/page";
import {
  isViewContentVersion,
  viewContentVersion,
  VIEW_CONTENT_MAX_BYTES,
  type HostedViewContentRefusal,
  type HostedViewContentUpdate,
} from "@superbee/core/hosted-client";

import { parseLeafOrUsage } from "../args.js";
import { openBundle, resolveLocalBundleTarget } from "../bundle.js";
import { bundleHomeAt } from "../bundle-home.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { resolveConceptIdCliArgument } from "../concept-id.js";
import { CliError } from "../errors.js";
import { readExternalFileBytesNoFollowWithin, readLeafNoFollowWithin, type ExternalLeafRead } from "../external-file.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode } from "../output.js";
import { assertPathOutsidePrivateState } from "../private-state-bundle-boundary.js";
import type { HostedAccountDeps } from "../hosted/account.js";
import type { CheckoutBinding } from "../hosted/binding.js";
import { openCheckoutConnection, type CheckoutConnection } from "../hosted/checkout-connection.js";
import { assertSafeNonDocumentOutTarget } from "./egress.js";

export const VIEW_READ_USAGE = `superbee view read — read a registered View's page from a hosted checkout's host

Usage:
  superbee view read <viewId> [--out <path>] [--dir <path>] [--json]

In a hosted checkout, reads the View's page (the registration's entry under views/) as the host
serves it now and prints its key, version, byte count and content type. The version is the
sha256 digest of the page's exact bytes: the --expected-version view update takes, and the digest
a Portal site pins. --out writes the exact bytes to a new file (never over an existing one), as a
backup or a starting point; the page itself is never printed. A local or Git bundle holds its View
pages as plain files: read the file directly.

Options:
  --out <path>   Write the page's exact bytes to this new file
  --dir <path>   Bundle directory (default: discovered from the cwd)
  --json         Emit compact JSON instead of TOON
  -h, --help     Show this help
`;

export const VIEW_UPDATE_USAGE = `superbee view update — replace a registered View's page on a hosted checkout's host

Usage:
  superbee view update <viewId> --expected-version <sha256:...> [--file <path>] [--dir <path>] [--json]

In a hosted checkout, sends the page in --file (default: the registration's entry in the checkout
folder, such as views/<name>.html) as the View's whole new page, at most 512 KiB of UTF-8, byte
for byte (a leading BOM included). --expected-version is the page version you started from (from
view read, or the digest a site pins): if the host's page is any other version, nothing changes
and the command names the host's version. Sync never sends views/, so this is how a checkout
changes a View page.

Uploading never approves execution: a Portal site keeps serving the version its portal.config
pins until you pin the new version, and a hosted app slot needs approving again. If the answer
is lost, the command reads the page again once and reports whether the update applied; it never
resends on its own. A local or Git bundle holds its View pages as plain files: edit the file
directly.

Options:
  --expected-version <v>  The page version this update replaces (sha256:<64 hex>), required
  --file <path>           The page to send (default: the registration's entry in the checkout)
  --dir <path>            Bundle directory (default: discovered from the cwd)
  --json                  Emit compact JSON instead of TOON
  -h, --help              Show this help
`;

/** Said with every update: uploading and approving execution are separate acts. */
export const EXECUTION_NOTE =
  "uploading does not approve execution: a Portal site serves the version its portal.config pins until you pin this one, and a hosted app slot needs approving again";

export interface ViewContentDeps {
  stdout: (text: string) => void;
  /** The checkout's person and the fetch the sync routes are reached with (tests inject both). */
  hosted?: HostedAccountDeps;
  cwd?: string;
}

interface Located {
  readonly binding: CheckoutBinding;
  readonly root: string;
  readonly registryId: string;
}

function homeOf(deps: Partial<ViewContentDeps>): string {
  return deps.hosted?.auth?.home ?? homedir();
}

/** The hosted checkout the command acts in and the View registration id it names; USAGE anywhere else. */
async function locate(sub: "read" | "update", rawId: string, dir: string | undefined, deps: Partial<ViewContentDeps>): Promise<Located> {
  const target = await resolveLocalBundleTarget(dir, deps.cwd ?? process.cwd());
  const facts = await bundleHomeAt(target.canonicalRoot, { home: homeOf(deps) });
  if (facts.home !== "hosted") {
    throw new CliError("USAGE", `view ${sub} reaches a hosted checkout's host; this is a ${facts.home} bundle, whose View pages are plain files: ${sub === "read" ? "read" : "edit"} the file directly`, {
      details: { reason: "not_a_hosted_checkout", home: facts.home },
      help: `${cliInvocation()} view list --dir ${commandToken(target.canonicalRoot)} names each View; its page is the registration's entry file`,
    });
  }
  const bundle = await openBundle(target.canonicalRoot);
  const registryId = await resolveConceptIdCliArgument(bundle, rawId);
  if (!isAnyRegistryId(registryId)) {
    throw new CliError("USAGE", `'${registryId}' is not a View registration id (views-registry/<name>)`, {
      help: `${cliInvocation()} view list --dir ${commandToken(facts.binding.path)}`,
    });
  }
  return { binding: facts.binding, root: target.canonicalRoot, registryId };
}

/** The registration as the host serves it now: its version (the pin) and its entry. */
async function hostRegistration(connection: CheckoutConnection, located: Located): Promise<{ version: string; entry: string }> {
  const { binding, registryId } = located;
  let read;
  try {
    read = await connection.client.reader(binding.bundle_id).read(registryId);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      throw new CliError("NOT_FOUND", `${binding.origin} has no View registration '${registryId}' in ${binding.bundle_id}`, {
        details: { host: binding.origin, bundle_id: binding.bundle_id, registry_id: registryId },
        help: `${cliInvocation()} view list --dir ${commandToken(binding.path)}`,
      });
    }
    throw await hostError(error, connection, binding);
  }
  const registration = parseRegistration(read.doc.id, read.doc.frontmatter);
  if (!registration) {
    throw new CliError("USAGE", `'${registryId}' is not a valid registered View on ${binding.origin}`, {
      details: { host: binding.origin, registry_id: registryId },
      help: `${cliInvocation()} view list --dir ${commandToken(binding.path)}`,
    });
  }
  return { version: read.version, entry: registration.entry };
}

async function hostError(error: unknown, connection: CheckoutConnection, binding: CheckoutBinding): Promise<unknown> {
  if (error instanceof RemoteError && error.code === "bundle_not_found") {
    const { bundleAbsent } = await import("../hosted/refusals.js");
    return bundleAbsent(binding, connection.client);
  }
  const { hostedFailure } = await import("../hosted/client.js");
  return hostedFailure(error, connection.target, connection.resume);
}

/** The host's refusal of a read or an update the outcome of which is known, in the CLI's taxonomy. */
async function refusalError(refusal: HostedViewContentRefusal, connection: CheckoutConnection, located: Located, again: CommandText): Promise<unknown> {
  const { binding, registryId } = located;
  const details = { host: binding.origin, registry_id: registryId, code: refusal.code, write_state: refusal.writeState, message: refusal.message };
  switch (refusal.code) {
    case "version_conflict":
      if (refusal.target === "content") {
        return new CliError("CONFLICT", `the host's page for '${registryId}' is ${refusal.actual ?? "absent"}, not ${refusal.expected ?? "the version given"}: nothing changed`, {
          details: { ...details, reason: "content_version_conflict", expected: refusal.expected ?? null, actual: refusal.actual ?? null },
          help: `inspect the host's page with ${cliInvocation()} view read ${commandToken(registryId)} --out <new-file> --dir ${commandToken(binding.path)}, merge your change into it, then re-run with --expected-version ${refusal.actual ? commandToken(refusal.actual) : "<version>"}`,
        });
      }
      return new CliError("CONFLICT", `the View registration '${registryId}' changed on ${binding.origin} while this command ran: nothing changed`, {
        details: { ...details, reason: "registry_version_conflict", expected: refusal.expected ?? null, actual: refusal.actual ?? null },
        help: `re-run: ${again}`,
      });
    case "concurrent_change":
      return new CliError("CONFLICT", `another change to '${registryId}' landed on ${binding.origin} at the same moment: nothing changed`, {
        details: { ...details, reason: "concurrent_change" },
        help: `re-run: ${again}`,
      });
    case "view_not_found":
      return new CliError("NOT_FOUND", `${binding.origin} has no View '${registryId}' with a page in ${binding.bundle_id}`, {
        details,
        help: `${cliInvocation()} view list --dir ${commandToken(binding.path)}`,
      });
    case "definition_writes_refused":
      return definitionsRefused(binding, registryId, details);
    case "bundle_access_denied":
      return new CliError("FORBIDDEN", `${binding.origin} refused access to ${binding.bundle_id} (${refusal.code})`, {
        details,
        help: "ask whoever manages access to the bundle",
      });
    case "bundle_not_found": {
      const { bundleAbsent } = await import("../hosted/refusals.js");
      return bundleAbsent(binding, connection.client);
    }
    case "invalid_input":
      return new CliError("USAGE", `${binding.origin} refused the request for '${registryId}': ${refusal.message}`, { details });
    default: {
      const { hostedFailure } = await import("../hosted/client.js");
      return hostedFailure(new RemoteError(refusal.message, refusal.code, refusal.status || (refusal.retryable ? 503 : 422)), connection.target, connection.resume);
    }
  }
}

async function definitionsRefused(binding: CheckoutBinding, registryId: string, details: Record<string, unknown>): Promise<CliError> {
  const { DEFINITIONS_REFUSED } = await import("../hosted/sync-scan.js");
  const { why, instead } = DEFINITIONS_REFUSED;
  return new CliError("FORBIDDEN", `'view update' refused: ${why} (bundle ${binding.bundle_id} on ${binding.origin}); ${instead}`, {
    details: { ...details, reason: "definitions_refused", command: "view update", bundle_id: binding.bundle_id, registry_id: registryId },
    help: instead,
  });
}

// ── view read ─────────────────────────────────────────────────────────────────

export async function viewRead(argv: string[], deps: Partial<ViewContentDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const { values, positionals } = parseLeafOrUsage(
    () => parseArgs({ args: argv, options: { out: { type: "string" }, dir: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } }, allowPositionals: true }),
    CLI_LEAVES.viewRead,
  );
  if (values.help) {
    stdout(renderUsage(VIEW_READ_USAGE));
    return;
  }
  const mode = resolveMode(values);
  const cwd = deps.cwd ?? process.cwd();
  let out: string | undefined;
  if (values.out !== undefined) {
    if (values.out.trim() === "") throw new CliError("USAGE", "--out was given an empty value: pass a new file's path", { help: `${cliInvocation()} view read <viewId> --out <new-file>` });
    out = path.resolve(cwd, values.out);
    // A destination inside private state would land over an operational record.
    assertPathOutsidePrivateState(out, homeOf(deps));
  }
  const located = await locate("read", positionals[0]!, values.dir, deps);
  const { binding, registryId } = located;
  if (out !== undefined) {
    await assertSafeNonDocumentOutTarget(await openBundle(located.root), "--out", out, "View HTML", `${cliInvocation()} view read ${commandToken(registryId)} --out <path-outside-bundle>`);
    if (await exists(out)) {
      throw new CliError("ALREADY_EXISTS", `${out} already exists: view read --out writes only a new file`, {
        details: { out },
        help: `${cliInvocation()} view read ${commandToken(registryId)} --out <new-file> --dir ${commandToken(binding.path)}`,
      });
    }
  }
  const resume = commandFragment`${cliInvocation()} view read ${commandToken(registryId)}${out === undefined ? commandFragment`` : commandFragment` --out ${commandToken(out)}`} --dir ${commandToken(binding.path)}${values.json ? commandFragment` --json` : commandFragment``}`;
  const connection = await openCheckoutConnection(binding, deps.hosted, resume, homeOf(deps));
  const registration = await hostRegistration(connection, located);
  const answer = await connection.client.readViewContent(binding.bundle_id, { registryId, expectedRegistryVersion: registration.version });
  if (!answer.ok) throw await refusalError(answer.refusal, connection, located, resume);
  const { content } = answer;
  if (out !== undefined) {
    try {
      // `wx`: a file that appeared since the check is never overwritten.
      await writeFile(out, Buffer.from(content.html, "utf8"), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CliError("ALREADY_EXISTS", `${out} already exists: view read --out writes only a new file`, { details: { out } });
      throw error;
    }
  }
  stdout(render({
    view: "read",
    registry_id: registryId,
    registry_version: content.registryVersion,
    key: content.key,
    version: content.version,
    byte_count: content.byteCount,
    content_type: content.contentType,
    ...(out === undefined ? {} : { out }),
    help: [`${cliInvocation()} view update ${commandToken(registryId)} --expected-version ${commandToken(content.version)} --dir ${commandToken(binding.path)}`],
  }, mode));
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// ── view update ───────────────────────────────────────────────────────────────

export async function viewUpdate(argv: string[], deps: Partial<ViewContentDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: { "expected-version": { type: "string" }, file: { type: "string" }, dir: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
        allowPositionals: true,
      }),
    CLI_LEAVES.viewUpdate,
  );
  if (values.help) {
    stdout(renderUsage(VIEW_UPDATE_USAGE));
    return;
  }
  const mode = resolveMode(values);
  const cwd = deps.cwd ?? process.cwd();
  const expected = values["expected-version"]?.trim();
  if (expected === undefined || !isViewContentVersion(expected)) {
    throw new CliError("USAGE", expected === undefined ? "view update requires --expected-version: the page version you started from" : `--expected-version must be a page version (sha256:<64 lowercase hex>), not '${expected}'`, {
      help: `${cliInvocation()} view read <viewId> prints the host's current version`,
    });
  }
  let given: string | undefined;
  if (values.file !== undefined) {
    if (values.file.trim() === "") throw new CliError("USAGE", "--file was given an empty value: pass the page's path", { help: `${cliInvocation()} view update <viewId> --expected-version <v> --file <path>` });
    given = path.resolve(cwd, values.file);
    // Caller-supplied bytes never come from private state.
    assertPathOutsidePrivateState(given, homeOf(deps));
  }
  const located = await locate("update", positionals[0]!, values.dir, deps);
  const { binding, registryId, root } = located;
  // The host said this person may not change the bundle's model: refused before anything is read or sent.
  if (binding.definition_writes === "refused") throw await definitionsRefused(binding, registryId, { host: binding.origin });

  // The checkout's own copy of the page: the default --file, and the copy reported afterwards.
  const localEntry = await localRegistrationEntry(root, registryId);
  if (given === undefined && localEntry === null) {
    throw new CliError("USAGE", `the checkout holds no registration '${registryId}' to find its page: pass the page with --file`, {
      help: `${cliInvocation()} view update ${commandToken(registryId)} --expected-version ${commandToken(expected)} --file <path> --dir ${commandToken(binding.path)}`,
    });
  }
  const entryFile = localEntry === null ? null : path.join(root, ...localEntry.split("/"));
  const file = given ?? entryFile!;
  const read = given === undefined ? await readLeafNoFollowWithin(file, VIEW_CONTENT_MAX_BYTES) : await readExternalFileBytesNoFollowWithin(file, VIEW_CONTENT_MAX_BYTES, homeOf(deps));
  const bytes = pageBytes(read, file);
  const html = decodePage(bytes, file);
  const sent = viewContentVersion(bytes);

  const again = commandFragment`${cliInvocation()} view update ${commandToken(registryId)} --expected-version ${commandToken(expected)}${given === undefined ? commandFragment`` : commandFragment` --file ${commandToken(given)}`} --dir ${commandToken(binding.path)}${values.json ? commandFragment` --json` : commandFragment``}`;
  const connection = await openCheckoutConnection(binding, deps.hosted, again, homeOf(deps));
  const registration = await hostRegistration(connection, located);
  if (given === undefined && registration.entry !== localEntry) {
    throw new CliError("CONFLICT", `the checkout's registration '${registryId}' names page ${localEntry}, but the host's names ${registration.entry}: nothing was sent`, {
      details: { reason: "stale_registration", registry_id: registryId, checkout_entry: localEntry, host_entry: registration.entry },
      help: `pass the page with --file, or bring the checkout up to date (${cliInvocation()} sync --pull-only --dir ${commandToken(binding.path)}) and re-run`,
    });
  }

  let answer;
  try {
    answer = await connection.client.updateViewContent(binding.bundle_id, { registryId, expectedRegistryVersion: registration.version, expectedContentVersion: expected, html });
  } catch (error) {
    // A RUNTIME is an answer the CLI could not read (too large, or outside the contract): the
    // update may have applied, so it is settled like a lost answer. Anything else was not sent.
    if (!(error instanceof CliError) || error.code !== "RUNTIME") throw error;
  }
  if (answer && !answer.ok && answer.refusal.writeState === "not_applied") throw await refusalError(answer.refusal, connection, located, again);
  const confirmed = !answer?.ok;
  const update = answer?.ok ? answer.update : await settle(connection, located, { sent, expected, again });

  const copy = await checkoutCopy({ binding, home: homeOf(deps), file, sentBytes: bytes, update });
  stdout(render({
    view: "update",
    update: update.changed ? "changed" : "unchanged",
    registry_id: registryId,
    key: update.key,
    previous_version: update.previousVersion,
    version: update.version,
    byte_count: update.byteCount,
    ...(confirmed ? { confirmed_by: "re-read after the update's answer was lost" } : {}),
    checkout_copy: copy.state,
    note: EXECUTION_NOTE,
    ...(copy.note ? { notes: [copy.note] } : {}),
  }, mode));
}

/** The registration's entry as the checkout folder holds it, or null when it holds no valid one. */
async function localRegistrationEntry(root: string, registryId: string): Promise<string | null> {
  try {
    const { doc } = await readDocVersioned(await openBundle(root), registryId);
    return parseRegistration(doc.id, doc.frontmatter)?.entry ?? null;
  } catch {
    return null;
  }
}

function pageBytes(read: ExternalLeafRead, file: string): Buffer {
  if (read.state === "present") return read.bytes;
  if (read.state === "too_large") {
    throw new CliError("USAGE", `${file} is ${read.size} bytes; a View page is at most ${VIEW_CONTENT_MAX_BYTES} bytes (512 KiB): nothing was sent`, {
      details: { reason: "too_large", file, bytes: read.size, maximum: VIEW_CONTENT_MAX_BYTES },
    });
  }
  if (read.state === "missing") throw new CliError("NOT_FOUND", `no page at ${file}: nothing was sent`, { details: { file }, help: "pass the page with --file" });
  throw new CliError("USAGE", `${file} is not a plain file (a symbolic link, a folder, or it changed while being read): nothing was sent`, { details: { reason: "unsafe_file", file } });
}

/** The page's exact text: strict UTF-8, a leading BOM kept as U+FEFF so the bytes sent are the file's. */
function decodePage(bytes: Uint8Array, file: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CliError("USAGE", `${file} is not valid UTF-8: a View page is UTF-8 text; nothing was sent`, { details: { reason: "invalid_utf8", file } });
  }
}

/**
 * An update whose answer was lost (or unreadable): read the registration and the page once more
 * and say what happened, never resending. The host's page at the bytes sent means it applied; at
 * the version expected, it did not (safe to re-run); at any other, someone else's change is there.
 */
async function settle(
  connection: CheckoutConnection,
  located: Located,
  context: { sent: string; expected: string; again: CommandText },
): Promise<HostedViewContentUpdate> {
  const { binding, registryId } = located;
  const unknown = (why: string) =>
    new CliError("RUNTIME", `the update of '${registryId}' may or may not have applied, and ${why}`, {
      details: { reason: "write_outcome_unknown", write_state: "unknown", registry_id: registryId, sent_version: context.sent, expected_version: context.expected },
      help: `check with ${cliInvocation()} view read ${commandToken(registryId)} --dir ${commandToken(binding.path)}: version ${context.sent} means it applied; ${context.expected} means it did not, and the same command is safe to re-run`,
    });
  let current;
  try {
    const registration = await hostRegistration(connection, located);
    const answer = await connection.client.readViewContent(binding.bundle_id, { registryId, expectedRegistryVersion: registration.version });
    if (!answer.ok) throw unknown(`reading the page again was refused (${answer.refusal.code})`);
    current = answer.content;
  } catch (error) {
    if (error instanceof CliError && (error.details as { reason?: unknown } | undefined)?.reason === "write_outcome_unknown") throw error;
    throw unknown(`reading the page again failed (${error instanceof CliError ? error.code : "error"})`);
  }
  if (current.version === context.sent) {
    return {
      bundleId: binding.bundle_id,
      registryId,
      registryVersion: current.registryVersion,
      key: current.key,
      changed: context.sent !== context.expected,
      version: current.version,
      previousVersion: context.expected,
      byteCount: current.byteCount,
      contentType: current.contentType,
      requestId: "",
    };
  }
  if (current.version === context.expected) {
    throw new CliError("TRANSIENT", `the update of '${registryId}' did not apply: the host's page is still ${context.expected}`, {
      details: { reason: "not_applied", write_state: "not_applied", registry_id: registryId, version: current.version, retryable: true },
      help: `re-run the same command: ${context.again}`,
    });
  }
  throw new CliError("CONFLICT", `the host's page for '${registryId}' is ${current.version}: neither the page sent (${context.sent}) nor the version expected (${context.expected})`, {
    details: { reason: "content_version_conflict", write_state: "not_applied", registry_id: registryId, expected: context.expected, actual: current.version, sent: context.sent },
    help: `inspect the host's page with ${cliInvocation()} view read ${commandToken(registryId)} --out <new-file> --dir ${commandToken(binding.path)}, merge your change into it, then re-run with --expected-version ${commandToken(current.version)}`,
  });
}

/**
 * What the checkout's own copy of the page holds now. Sync never places or sends `views/`, so a
 * copy holding the bytes sent is recorded as the host's (the projection's `extras`, as checkout
 * records the files it placed) and sync leaves it be; any other copy is reported, never touched.
 */
async function checkoutCopy(input: {
  binding: CheckoutBinding;
  home: string;
  file: string;
  sentBytes: Uint8Array;
  update: HostedViewContentUpdate;
}): Promise<{ state: "current" | "stale" | "differs" | "absent" | "none"; note?: string }> {
  const { binding, update } = input;
  // The registration's page as the host names it: the checkout path of the page just written.
  const entry = update.key;
  const entryFile = path.join(binding.path, ...entry.split("/"));
  const sameFile = await realpath(input.file).then(async (a) => a === (await realpath(entryFile).catch(() => null)), () => false);
  const read = sameFile ? ({ state: "present", bytes: Buffer.from(input.sentBytes) } as const) : await readLeafNoFollowWithin(entryFile, VIEW_CONTENT_MAX_BYTES);
  if (read.state === "missing") return { state: "absent" };
  if (read.state !== "present") return { state: "differs", note: `the checkout's ${entry} is not a plain file within 512 KiB; it was left as it is` };
  const version = viewContentVersion(read.bytes);
  if (version === update.version) {
    const recorded = await recordCurrent(binding, input.home, entry, entryFile, update.version);
    return recorded ? { state: "current" } : { state: "current", note: `another command holds the checkout, so sync may list ${entry} as held until it is recorded; re-running this command records it` };
  }
  if (version === update.previousVersion) {
    return { state: "stale", note: `the checkout's ${entry} still holds the previous page (${update.previousVersion}); copy the new page there if you keep editing it in the checkout` };
  }
  return { state: "differs", note: `the checkout's ${entry} holds neither the previous page nor the new one; it was left as it is` };
}

/** Record that the checkout's copy holds the host's page, re-reading it under the checkout lock; false when another command holds the checkout. */
async function recordCurrent(binding: CheckoutBinding, home: string, entry: string, entryFile: string, version: string): Promise<boolean> {
  const [{ withIdleCheckoutStore }, { readProjection, writeProjection }, { digestOf }] = await Promise.all([
    import("../hosted/checkout-store.js"),
    import("../hosted/sync-scan.js"),
    import("../hosted/projection.js"),
  ]);
  const done = await withIdleCheckoutStore(binding, home, async (store) => {
    const read = await readLeafNoFollowWithin(entryFile, VIEW_CONTENT_MAX_BYTES);
    if (read.state !== "present" || digestOf(read.bytes) !== version) return true;
    const projection = await readProjection(home, binding.checkout_id, store);
    if (projection.extras?.[entry] === version) return true;
    projection.extras = { ...projection.extras, [entry]: version };
    await writeProjection(home, binding.checkout_id, projection);
    return true;
  });
  return done === true;
}
