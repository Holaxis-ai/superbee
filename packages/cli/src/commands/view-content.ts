// `superbee view read <viewId>` and `superbee view update <viewId> --expected-version <v>`: a
// registered View's page (its `entry`, under `views/`) read and replaced whole on a hosted
// checkout's host, through `<sync prefix>/view-content-read` and `<sync prefix>/view-content-update`.
// Sync never sends `views/` (the scan holds it), so this is the one way a checkout changes a page.
// `superbee view create <name>` adds a View (`<sync prefix>/view-create`): the host writes its
// record and page together, and an outcome the CLI cannot read is resent once, which the host
// answers as already created when the first attempt landed.
//
// Both pin the registration's version as the host serves it now, read through the checkout's
// document reader just before; an update also pins the page's version the author started from
// (`--expected-version`), the same `sha256:` digest a Portal site pins. An update is sent once and
// never resent: an outcome the CLI cannot read is settled by reading the page again. Uploading a page
// never approves its execution; that stays separate (a site's pin, a hosted app slot's approval).
import { lstat, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { readDocVersioned, RemoteError } from "@superbee/core";
import { isAnyRegistryId, parseRegistration } from "@superbee/core/page";
import {
  isViewContentVersion,
  viewContentVersion,
  viewCreateTarget,
  viewCreateTextProblem,
  VIEW_CONTENT_MAX_BYTES,
  VIEW_CREATE_ACCESS,
  type HostedViewContentRefusal,
  type HostedViewContentUpdate,
  type HostedViewCreate,
  type HostedViewCreateAccess,
} from "@superbee/core/hosted-client";

import { parseLeafOrUsage } from "../args.js";
import { openBundle, resolveLocalBundleTarget } from "../bundle.js";
import { bundleHomeAt } from "../bundle-home.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandLiteral, commandToken, type CommandText } from "../command-text.js";
import { resolveConceptIdCliArgument } from "../concept-id.js";
import { CliError } from "../errors.js";
import { readExternalFileBytesNoFollowWithin, readLeafNoFollowWithin, type ExternalLeafRead } from "../external-file.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode } from "../output.js";
import { assertPathOutsidePrivateState } from "../private-state-bundle-boundary.js";
import type { HostedAccountDeps } from "../hosted/account.js";
import type { CheckoutBinding } from "../hosted/binding.js";
import { openCheckoutConnection, type CheckoutConnection } from "../hosted/checkout-connection.js";
import { parentUnsafe } from "../hosted/projection.js";
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

export const VIEW_CREATE_USAGE = `superbee view create — add a View to a hosted checkout's bundle on the host

Usage:
  superbee view create <name> --title <text> [--description <text>] [--access bundle-read|none] [--file <path>] [--dir <path>] [--json]

In a hosted checkout, adds the View <name> on the host: its record views-registry/<name> and its
page views/<name>.html, sent from --file (default: views/<name>.html in the checkout folder), at
most 512 KiB of UTF-8, byte for byte. <name> is a lowercase letter then up to 54 lowercase
letters, digits or hyphens; the title is 1 to 120 characters and the description at most 320.
--access is bundle-read (the default) or none. Adding a View changes the bundle's model, so the
host needs you to hold the permission for that; without it nothing is saved.

If a View or a page with that name already exists, nothing is saved and the command names it:
change an existing View's page with view update. If the answer is lost, the command sends the same
create once more on its own (safe: a create that already landed answers that it did); a refusal
of that resend says the first attempt's outcome is unknown. A views-registry/<name>.md written in
the checkout and never sent is refused: remove it and pass its fields as flags. The View is
listed in the workspace at once; run sync to pull its record into the checkout. A local or Git
bundle holds its Views as plain files: add the page and its views-registry/ record directly.

Options:
  --title <text>           The View's title, required
  --description <text>     A short description
  --access <value>         bundle-read (default) or none
  --file <path>            The page to send (default: views/<name>.html in the checkout)
  --dir <path>             Bundle directory (default: discovered from the cwd)
  --json                   Emit compact JSON instead of TOON
  -h, --help               Show this help
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

/** The hosted checkout the command acts in; USAGE anywhere else. */
async function hostedCheckout(sub: "read" | "update" | "create", dir: string | undefined, deps: Partial<ViewContentDeps>): Promise<{ binding: CheckoutBinding; root: string }> {
  const target = await resolveLocalBundleTarget(dir, deps.cwd ?? process.cwd());
  const facts = await bundleHomeAt(target.canonicalRoot, { home: homeOf(deps) });
  if (facts.home !== "hosted") {
    const act = sub === "read" ? "read the file directly" : sub === "update" ? "edit the file directly" : "add the page and its views-registry/ record as plain files";
    throw new CliError("USAGE", `view ${sub} reaches a hosted checkout's host; this is a ${facts.home} bundle, whose View pages are plain files: ${act}`, {
      details: { reason: "not_a_hosted_checkout", home: facts.home },
      help: `${cliInvocation()} view list --dir ${commandToken(target.canonicalRoot)} names each View; its page is the registration's entry file`,
    });
  }
  return { binding: facts.binding, root: target.canonicalRoot };
}

/** The hosted checkout the command acts in and the View registration id it names; USAGE anywhere else. */
async function locate(sub: "read" | "update", rawId: string, dir: string | undefined, deps: Partial<ViewContentDeps>): Promise<Located> {
  const { binding, root } = await hostedCheckout(sub, dir, deps);
  const bundle = await openBundle(root);
  const registryId = await resolveConceptIdCliArgument(bundle, rawId);
  if (!isAnyRegistryId(registryId)) {
    throw new CliError("USAGE", `'${registryId}' is not a View registration id (views-registry/<name>)`, {
      help: `${cliInvocation()} view list --dir ${commandToken(binding.path)}`,
    });
  }
  return { binding, root, registryId };
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
          help: `inspect the host's page with ${cliInvocation()} view read ${commandToken(registryId)} --out <new-file> --dir ${commandToken(binding.path)}, merge your change into it, then re-run with --expected-version ${refusal.actual ? commandToken(refusal.actual) : commandLiteral("<version>")}`,
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

async function definitionsRefused(binding: CheckoutBinding, registryId: string, details: Record<string, unknown>, command: "view update" | "view create" = "view update", outcome = ""): Promise<CliError> {
  const { DEFINITIONS_REFUSED } = await import("../hosted/sync-scan.js");
  const { why, instead } = DEFINITIONS_REFUSED;
  return new CliError("FORBIDDEN", `'${command}' refused: ${why} (bundle ${binding.bundle_id} on ${binding.origin})${outcome}; ${instead}`, {
    details: { ...details, reason: "definitions_refused", command, bundle_id: binding.bundle_id, registry_id: registryId },
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
  // The checkout's entry is read only through plain folders: a symbolic link on the way could reach outside the checkout.
  if (given === undefined && (await parentUnsafe(root, file))) pageBytes({ state: "unsafe" }, file);
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
  // The host's page already holds exactly these bytes (a re-run after a lost answer, say): nothing to change.
  const alreadyApplied = answer !== undefined && !answer.ok && answer.refusal.code === "version_conflict" && answer.refusal.target === "content" && answer.refusal.actual === sent;
  if (answer && !answer.ok && answer.refusal.writeState === "not_applied" && !alreadyApplied) throw await refusalError(answer.refusal, connection, located, again);
  const confirmed = !alreadyApplied && !answer?.ok;
  const update: HostedViewContentUpdate = alreadyApplied
    ? { bundleId: binding.bundle_id, registryId, registryVersion: registration.version, key: registration.entry, changed: false, version: sent, previousVersion: sent, byteCount: bytes.byteLength, contentType: "", requestId: "" }
    : answer?.ok ? answer.update : await settle(connection, located, { sent, expected, again });

  const copy = await checkoutCopy({ binding, home: homeOf(deps), file, sentBytes: bytes, update });
  stdout(render({
    view: "update",
    update: update.changed ? "changed" : "unchanged",
    registry_id: registryId,
    key: update.key,
    previous_version: update.previousVersion,
    version: update.version,
    byte_count: update.byteCount,
    ...(alreadyApplied ? { already_applied: true } : {}),
    ...(confirmed ? { confirmed_by: "re-read after the update's answer was lost" } : {}),
    checkout_copy: copy.state,
    notes: [
      ...(alreadyApplied ? [`the host's page already held exactly these bytes (${sent}), so nothing changed; --expected-version ${commandToken(expected)} was not its version`] : []),
      EXECUTION_NOTE,
      ...(copy.note ? [copy.note] : []),
    ],
  }, mode));
}

// ── view create ───────────────────────────────────────────────────────────────

/** Said with every create: where the View shows, and how the checkout gets its record. */
const LISTED_NOTE = "listed now in this workspace's Views; run sync to pull the record into the checkout";

export async function viewCreate(argv: string[], deps: Partial<ViewContentDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          title: { type: "string" },
          description: { type: "string" },
          access: { type: "string" },
          file: { type: "string" },
          dir: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.viewCreate,
  );
  if (values.help) {
    stdout(renderUsage(VIEW_CREATE_USAGE));
    return;
  }
  const mode = resolveMode(values);
  const cwd = deps.cwd ?? process.cwd();
  const name = positionals[0]!;
  const usage = `${cliInvocation()} view create <name> --title <text> [--description <text>] [--access bundle-read|none] [--file <path>]`;
  const target = viewCreateTarget(name);
  if (!target) {
    throw new CliError("USAGE", `'${name}' is not a View name: a lowercase letter then up to 54 lowercase letters, digits or hyphens (the record is views-registry/<name>, the page views/<name>.html): nothing was sent`, {
      details: { reason: "invalid_name", name },
      help: usage,
    });
  }
  if (values.title === undefined) throw new CliError("USAGE", "view create requires --title: the View's title, 1 to 120 characters", { help: usage });
  for (const [field, value] of [["title", values.title], ["description", values.description]] as const) {
    const problem = value === undefined ? null : viewCreateTextProblem(field, value);
    if (problem) throw new CliError("USAGE", `--${field}: ${problem}: nothing was sent`, { details: { reason: `invalid_${field}` }, help: usage });
  }
  const access = values.access ?? "bundle-read";
  if (!(VIEW_CREATE_ACCESS as readonly string[]).includes(access)) {
    throw new CliError("USAGE", `--access must be ${VIEW_CREATE_ACCESS.join(" or ")}, not '${access}': nothing was sent`, { details: { reason: "invalid_access", access }, help: usage });
  }
  let given: string | undefined;
  if (values.file !== undefined) {
    if (values.file.trim() === "") throw new CliError("USAGE", "--file was given an empty value: pass the page's path", { help: usage });
    given = path.resolve(cwd, values.file);
    // Caller-supplied bytes never come from private state.
    assertPathOutsidePrivateState(given, homeOf(deps));
  }
  const { binding, root } = await hostedCheckout("create", values.dir, deps);
  const { registryId, key } = target;
  const located: Located = { binding, root, registryId };
  // An unsent local record of that name would meet the host's on the next sync: the host builds the record from the flags.
  // A record the host already sent is left to the host's answer (a View of that name exists).
  const localRecord = await localRegistryFile(root, name);
  if (localRecord !== null && !(await (await import("../hosted/sync-scan.js")).projectionTracks(homeOf(deps), binding.checkout_id, localRecord.replace(/\.md$/i, "")))) {
    throw new CliError("USAGE", `the checkout already holds ${localRecord}, which sync never sends: nothing was sent. Remove that file and pass its fields as flags (--title, --description, --access); the host creates the record and sync brings it back`, {
      details: { reason: "local_registry_file", file: localRecord },
      help: usage,
    });
  }
  // The host said this person may not change the bundle's model: refused before anything is read or sent.
  if (binding.definition_writes === "refused") throw await definitionsRefused(binding, registryId, { host: binding.origin }, "view create", ": nothing was sent");

  const file = given ?? path.join(root, ...key.split("/"));
  // The checkout's own page is read only through plain folders: a symbolic link on the way could reach outside the checkout.
  if (given === undefined && (await parentUnsafe(root, file))) pageBytes({ state: "unsafe" }, file);
  const read = given === undefined ? await readLeafNoFollowWithin(file, VIEW_CONTENT_MAX_BYTES) : await readExternalFileBytesNoFollowWithin(file, VIEW_CONTENT_MAX_BYTES, homeOf(deps));
  const bytes = pageBytes(read, file);
  const html = decodePage(bytes, file);

  const again = commandFragment`${cliInvocation()} view create ${commandToken(name)} --title ${commandToken(values.title)}${values.description === undefined ? commandFragment`` : commandFragment` --description ${commandToken(values.description)}`}${values.access === undefined ? commandFragment`` : commandFragment` --access ${commandToken(access)}`}${given === undefined ? commandFragment`` : commandFragment` --file ${commandToken(given)}`} --dir ${commandToken(binding.path)}${values.json ? commandFragment` --json` : commandFragment``}`;
  const connection = await openCheckoutConnection(binding, deps.hosted, again, homeOf(deps));
  const request = { name, title: values.title, ...(values.description === undefined ? {} : { description: values.description }), access: access as HostedViewCreateAccess, html };

  // Sent at most twice: a create whose outcome is unknown is resent once, which is safe because
  // both writes expect absence and the host answers an equal resend `created: false`.
  let created: HostedViewCreate | undefined;
  let resent = false;
  let lastUnread: CliError | HostedViewContentRefusal | undefined;
  for (let attempt = 0; attempt < 2 && created === undefined; attempt += 1) {
    resent = attempt > 0;
    let answer;
    try {
      answer = await connection.client.createView(binding.bundle_id, request);
    } catch (error) {
      // A RUNTIME without an HTTP status is an answer the CLI could not read (too large, or
      // outside the contract): the create may have landed, so it is resent like a lost answer. A
      // definite answer (a 429, a plain 4xx, another operation's envelope) is reported as itself,
      // and anything else was not sent.
      if (!(error instanceof CliError) || error.code !== "RUNTIME" || typeof (error.details as { status?: unknown } | undefined)?.status === "number") throw error;
      lastUnread = error;
    }
    if (answer?.ok) created = answer.create;
    else if (answer && answer.refusal.writeState === "not_applied") throw await createRefusalError(answer.refusal, connection, located, { name, file, again, resent });
    else if (answer) lastUnread = answer.refusal;
  }
  if (created === undefined) {
    const last = lastUnread instanceof CliError ? { last_error: { code: lastUnread.code, message: lastUnread.message, ...(lastUnread.details ?? {}) } } : lastUnread ? { last_error: { code: lastUnread.code, status: lastUnread.status, message: lastUnread.message } } : {};
    throw new CliError("RUNTIME", `the create of '${registryId}' was sent twice and neither answer could be read: it may or may not have been saved`, {
      details: { reason: "write_outcome_unknown", write_state: "unknown", registry_id: registryId, sent_version: viewContentVersion(bytes), ...last },
      help: `check with ${cliInvocation()} view read ${commandToken(registryId)} --dir ${commandToken(binding.path)}: version ${commandToken(viewContentVersion(bytes))} means it was saved; a View not found means it was not, and the same command is safe to re-run`,
    });
  }

  const copy = await checkoutCopy({ binding, home: homeOf(deps), file, sentBytes: bytes, update: created });
  stdout(render({
    view: "create",
    create: created.created ? "created" : "already_created",
    registry_id: created.registryId,
    registry_version: created.registryVersion,
    key: created.key,
    version: created.version,
    byte_count: created.byteCount,
    access,
    ...(resent ? { resent: true } : {}),
    checkout_copy: copy.state,
    notes: [
      ...(created.created ? [] : ["already created: your earlier attempt was saved"]),
      LISTED_NOTE,
      ...(copy.note ? [copy.note] : []),
    ],
    help: [`${cliInvocation()} sync --dir ${commandToken(binding.path)}`],
  }, mode));
}

/** The host's refusal of a create, in the CLI's taxonomy: nothing was saved, or, on the resend, the first attempt's outcome is unknown. */
async function createRefusalError(refusal: HostedViewContentRefusal, connection: CheckoutConnection, located: Located, context: { name: string; file: string; again: CommandText; resent: boolean }): Promise<unknown> {
  const { binding, registryId } = located;
  // On the resend, the first attempt's answer was lost: this refusal says nothing about it.
  const outcome = context.resent
    ? `: the first attempt's outcome is unknown; check with ${cliInvocation()} view read ${commandToken(registryId)} --dir ${commandToken(binding.path)}`
    : ": nothing was saved";
  const details = { host: binding.origin, registry_id: registryId, code: refusal.code, write_state: refusal.writeState, message: refusal.message };
  switch (refusal.code) {
    case "version_conflict": {
      const target = refusal.target ?? "registry";
      const what = target === "content" ? `page views/${context.name}.html` : `record ${registryId}`;
      const update = target === "content" && refusal.actual
        ? `${cliInvocation()} view update ${commandToken(registryId)} --expected-version ${commandToken(refusal.actual)} --file ${commandToken(context.file)} --dir ${commandToken(binding.path)}`
        : `${cliInvocation()} view read ${commandToken(registryId)} --dir ${commandToken(binding.path)} prints the page version, then ${cliInvocation()} view update ${commandToken(registryId)} --expected-version <version> --file ${commandToken(context.file)}`;
      return new CliError("CONFLICT", `a View or file named ${context.name} already exists on ${binding.origin} (${target === "content" ? "content" : "registry"}: the ${what}${refusal.actual ? `, version ${refusal.actual}` : ""})${outcome}`, {
        details: { ...details, reason: "already_exists", target, actual: refusal.actual ?? null },
        help: `to change an existing View's page: ${update}`,
      });
    }
    case "concurrent_change":
      return new CliError("CONFLICT", `another change landed on ${binding.bundle_id} at the same moment${outcome}`, {
        details: { ...details, reason: "concurrent_change" },
        help: `re-run: ${context.again}`,
      });
    case "definition_writes_refused":
      return definitionsRefused(binding, registryId, details, "view create", outcome);
    case "bundle_access_denied":
    case "insufficient_scope":
      return new CliError("FORBIDDEN", `${binding.origin} refused writing to ${binding.bundle_id} (${refusal.code})${outcome}`, {
        details,
        help: "ask whoever manages access to the bundle",
      });
    case "bundle_not_found": {
      const { bundleAbsent } = await import("../hosted/refusals.js");
      return bundleAbsent(binding, connection.client);
    }
    case "invalid_input":
      return new CliError("USAGE", `${binding.origin} refused the create of '${registryId}' as invalid input${outcome}`, { details });
    default: {
      const { hostedFailure } = await import("../hosted/client.js");
      return hostedFailure(new RemoteError(refusal.message, refusal.code, refusal.status || (refusal.retryable ? 503 : 422)), connection.target, connection.resume);
    }
  }
}

/** The checkout's own `views-registry/<name>.md`, compared folded, as a folder-relative path; null when it holds none. */
async function localRegistryFile(root: string, name: string): Promise<string | null> {
  const list = async (dir: string) => readdir(dir).catch(() => [] as string[]);
  for (const folder of (await list(root)).filter((entry) => entry.toLowerCase() === "views-registry")) {
    const file = (await list(path.join(root, folder))).find((entry) => entry.toLowerCase() === `${name}.md`);
    if (file !== undefined) return `${folder}/${file}`;
  }
  return null;
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

function pageBytes(read: ExternalLeafRead | { readonly state: "unsafe" }, file: string): Buffer {
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
      help: `check with ${cliInvocation()} view read ${commandToken(registryId)} --dir ${commandToken(binding.path)}: version ${commandToken(context.sent)} means it applied; ${commandToken(context.expected)} means it did not, and the same command is safe to re-run`,
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
    throw new CliError("TRANSIENT", `the update of '${registryId}' had not applied when the page was read again just now: the host's page was still ${context.expected}`, {
      details: { reason: "not_applied_as_observed", write_state: "not_applied_as_observed", registry_id: registryId, version: current.version, retryable: true },
      help: `re-running is safe because it is pinned to --expected-version ${commandToken(context.expected)} (if the lost update lands first, the re-run reports it as already applied): ${context.again}`,
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
  /** The page the host now holds; `previousVersion` is the one it replaced, absent for a create. */
  update: { readonly registryId: string; readonly key: string; readonly version: string; readonly previousVersion?: string };
}): Promise<{ state: "current" | "stale" | "differs" | "absent" | "none"; note?: string }> {
  const { binding, update } = input;
  // The registration's page as the host names it: the checkout path of the page just written.
  const entry = update.key;
  const entryFile = path.join(binding.path, ...entry.split("/"));
  const sameFile = await realpath(input.file).then(async (a) => a === (await realpath(entryFile).catch(() => null)), () => false);
  if (await parentUnsafe(binding.path, entryFile)) return { state: "differs", note: `the checkout's ${entry} is reached through a symbolic link or a file; it was left as it is` };
  const read = sameFile ? ({ state: "present", bytes: Buffer.from(input.sentBytes) } as const) : await readLeafNoFollowWithin(entryFile, VIEW_CONTENT_MAX_BYTES);
  if (read.state === "missing") return { state: "absent" };
  if (read.state !== "present") return { state: "differs", note: `the checkout's ${entry} is not a plain file within 512 KiB; it was left as it is` };
  const version = viewContentVersion(read.bytes);
  if (version === update.version) {
    const recorded = await recordCurrent(binding, input.home, entry, entryFile, update.version);
    return recorded
      ? { state: "current" }
      : { state: "current", note: `another command holds the checkout, so sync may list ${entry} as held until it is recorded; record it with ${cliInvocation()} view update ${commandToken(update.registryId)} --expected-version ${commandToken(update.version)} --dir ${commandToken(binding.path)} (a no-op update of the same bytes)` };
  }
  if (update.previousVersion !== undefined && version === update.previousVersion) {
    return { state: "stale", note: `the checkout's ${entry} still holds the previous page (${update.previousVersion}); copy the new page there if you keep editing it in the checkout` };
  }
  return { state: "differs", note: `the checkout's ${entry} holds ${update.previousVersion === undefined ? "other bytes than the page sent" : "neither the previous page nor the new one"}; it was left as it is` };
}

/** Record that the checkout's copy holds the host's page, re-reading it under the checkout lock; false when another command holds the checkout. */
async function recordCurrent(binding: CheckoutBinding, home: string, entry: string, entryFile: string, version: string): Promise<boolean> {
  const [{ withIdleCheckoutStore }, { readProjection, writeProjection }, { digestOf }] = await Promise.all([
    import("../hosted/checkout-store.js"),
    import("../hosted/sync-scan.js"),
    import("../hosted/projection.js"),
  ]);
  const done = await withIdleCheckoutStore(binding, home, async (store) => {
    if (await parentUnsafe(binding.path, entryFile)) return true;
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
