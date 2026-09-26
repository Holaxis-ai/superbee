// `superbee checkout <bundle-id> --host <url>` — mirror one hosted bundle into a local folder.
//
// The folder is a projection of a private working copy: the shared engine
// (`@superbee/browser-local`) hydrates core's Node log store from the host's streamed snapshot
// under the signed-in person's bearer token, and the projection places the store's exact bytes in
// the folder without overwriting anything. A private binding keyed by the folder's path records
// the host, audience, workspace, bundle and principal; the folder itself carries no URL. Every
// existing command then runs unchanged on the folder, and the commands sync cannot send are
// refused there up front (`hosted/refusals.ts`).
//
// `superbee sync` in the folder sends local edits and brings in the host's (`hosted/sync.ts`).
import { homedir } from "node:os";
import { lstat, mkdir, readFile, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { bootstrap, openLocalBundle, UNSETTLED_STATES } from "@superbee/browser-local";
import { FilesystemMutationLockError, RemoteError } from "@superbee/core";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { filesystemPushRoleLocks, PushRoleStaleOwnerError } from "@superbee/core/filesystem-push-role";
import type { HostedCapabilities } from "@superbee/core/hosted-transport";

import { parseLeafOrUsage } from "../args.js";
import { findBundleRoot, resolveProjectBinding } from "../bundle.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode } from "../output.js";
import { assertBundleOutsidePrivateState } from "../private-state-bundle-boundary.js";
import { defaultHostedAuthDeps, hostArgument, requireHostedBundleHost, type HostedAuthDeps } from "../hosted-auth/session.js";
import { connectHostedAccount, hostedListCommand } from "../hosted/account.js";
import { recordPulled } from "../hosted/freshness.js";
import type { HostedTarget } from "../hosted-auth/discovery.js";
import {
  bindingForPath,
  bindsBundle,
  checkoutLockName,
  checkoutStoreDir,
  discardCheckoutState,
  folderIdentity,
  sameFolder,
  indexCheckoutPath,
  indexedBindingForPath,
  newCheckoutId,
  releaseCheckout,
  writeBinding,
  type CheckoutBinding,
} from "../hosted/binding.js";
import { createHostedSyncClient, hostedFailure, readBundleListing, syncRoutePrefix, WORKSPACE_HEADER } from "../hosted/client.js";
import { HOSTED_CHECKOUT_REFUSALS } from "../hosted/refusals.js";
import { digestOf, exportFresh, findPathCollision, ROOT_INDEX } from "../hosted/projection.js";
import { writeProjection } from "../hosted/sync-scan.js";
import { addCatalogEntry, assertCatalogLabel, loadCatalog } from "../catalog.js";
import { checkoutMarkerBytes, readCheckoutMarker, removeCheckoutMarker, writeCheckoutMarker } from "../hosted/marker.js";
import { adopt } from "./checkout-adopt.js";

/**
 * Checkout refuses a bundle over this many documents until paged heads and snapshot land: the
 * host's working copy routes answer one unpaged listing, bounded at this size.
 */
export const CHECKOUT_DOCUMENT_LIMIT = 1000;
export const BUNDLE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export const CHECKOUT_USAGE = `superbee checkout — mirror a hosted bundle into a local folder

Usage:
  superbee checkout <bundle-id> [--host <url>] [--dir <folder>] [--workspace <id>] [--json]
  superbee checkout --adopt <folder> [--host <url>] [--workspace <id>] [--json]
  superbee checkout --release <folder> [--json]

'superbee catalog list --hosted' lists the bundle ids you can check out. Signs in if needed
(AUTH_REQUIRED, exit 4, carries the one link to relay and the command to re-run), then copies the hosted bundle into --dir (default: ./<bundle-id>), which must be new or
empty. The host is --host, else the host of your last sign-in (never SUPERBEE_HOST alone); the
receipt names the host it bound. The folder holds plain bundle files, so every command runs on it
with --dir <folder>. The link to the host is kept in private state, keyed by the folder's path,
never in the folder. Re-running for the same folder and bundle is a no-op. A checkout whose folder
was deleted, or replaced by a new empty folder, is replaced, unless it holds changes sync has not
sent yet; a checkout emptied in place is refused, because removing every file is a pending edit.

A new checkout is added to your workspace catalog under its bundle id (or the id with -2 to -9
when that label is taken), so other sessions and the local MCP app can find it; 'catalog list'
shows it with home: hosted. The local MCP app serves it read-only.

The folder carries a read-only marker, .superbee/checkout.json, naming the host and bundle. It is
informational: it never selects a host or routes a command. A folder that has the marker but no
binding here (it was moved, copied or restored) works as a plain local bundle, and status, home,
bundle locate and session-start report it as copy_of_checkout.

--adopt <folder> binds such a folder again. A folder moved on the same disk is bound back to its
own checkout with no network (unsent edits and conflicts carry over). Any other copy needs --host,
which you name yourself (the marker's host is never used alone): without it, --adopt only
previews. With it, adopt signs in, fetches the hosted bundle, adds the documents the folder lacks,
and never overwrites a file. A file that differs from the host's version becomes a conflict for
'sync --inspect/--resolve'; a document only in the folder is sent as new by the next sync.

--release <folder> forgets the checkout at that folder: its private binding and store are removed,
its marker is removed, and the folder's other files are left as they are. Releasing a folder that
is not a checkout is a no-op.

'superbee sync --dir <folder>' sends your edits and brings in the host's. Commands whose effect
sync cannot send (doc verify, kind, recipe add/evolve, artifact, promote or delete of a non-.md
key, index generate, serve, ui, mcp) are refused in it with "do this in the app". Deleting a
document file, by hand or with doc delete or delete --doc-key <id>.md, syncs as a delete. Bundles over ${CHECKOUT_DOCUMENT_LIMIT} documents, bundles the host does not
serve to a checkout (such as one with a Git source), and ids in two of your workspaces are refused.

Options:
  --host <url>        Hosted Superbee URL (an origin, or an agent connection URL); default: your last sign-in
  --dir <folder>      Checkout folder (default: ./<bundle-id>)
  --workspace <id>    Your workspace that holds the bundle: checked against your memberships,
                      recorded in the binding and sent as ${WORKSPACE_HEADER}
  --adopt             Treat the argument as a moved, copied or restored checkout folder and bind it
  --release           Treat the argument as a checkout folder and forget its binding
  --json              Emit compact JSON instead of TOON
  -h, --help          Show this help

Examples:
  superbee checkout team.knowledge
  superbee checkout team.knowledge --host https://mcp.getsuperbee.com --dir ~/work/team
  superbee checkout --adopt ~/restored/team --host https://mcp.getsuperbee.com
  superbee checkout --release ~/work/team
`;

export interface CheckoutDeps {
  stdout: (text: string) => void;
  auth: HostedAuthDeps;
  cwd: string;
  /** The fetch the sync routes are reached with (the sign-in module keeps its own). */
  fetch?: typeof fetch;
}

function checkoutDeps(partial: Partial<CheckoutDeps>): CheckoutDeps {
  return {
    stdout: partial.stdout ?? ((text) => void process.stdout.write(text)),
    auth: partial.auth ?? defaultHostedAuthDeps(homedir()),
    cwd: partial.cwd ?? process.cwd(),
    ...(partial.fetch ? { fetch: partial.fetch } : {}),
  };
}

export async function entryKind(target: string): Promise<"absent" | "empty-dir" | "dir" | "other"> {
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (!info.isDirectory()) return "other";
  return (await readdir(target)).length === 0 ? "empty-dir" : "dir";
}

export function bindingView(binding: CheckoutBinding): Record<string, unknown> {
  return {
    bundle_id: binding.bundle_id,
    host: binding.origin,
    audience: binding.audience,
    workspace: binding.workspace,
    principal: binding.principal_id,
    folder: binding.path,
  };
}

export function nextSteps(folder: string): string[] {
  return [`${cliInvocation()} list --dir ${commandToken(folder)}`, `${cliInvocation()} status --dir ${commandToken(folder)}`];
}

/** Refuse a folder nested in a local bundle or a bound project: one authority per folder. */
export async function assertStandaloneFolder(folder: string): Promise<void> {
  const parent = path.dirname(folder);
  const enclosing = await findBundleRoot(parent).catch(() => null);
  if (enclosing) {
    throw new CliError("FORBIDDEN", `refusing to check out inside the local bundle at ${enclosing}`, {
      details: { reason: "inside_bundle", enclosing },
      help: "pass --dir <folder> outside any bundle or board",
    });
  }
  const binding = await resolveProjectBinding(parent).catch(() => null);
  if (binding) {
    throw new CliError("FORBIDDEN", `refusing to check out inside a project bound to a board (${binding.file})`, {
      details: { reason: "inside_bound_project", binding: binding.file },
      help: "pass --dir <folder> outside any bundle or board",
    });
  }
}

export function capabilityRefusal(error: unknown, bundleId: string, target: HostedTarget, listed: boolean, resume: string): unknown {
  if (error instanceof RemoteError && error.code === "bundle_not_found" && listed) {
    // Visible to this identity, but the working copy routes do not serve it. The host does not say
    // why: a bundle backed by a Git source answers this, and so does any bundle the working copy
    // surface cannot serve. The reason stays neutral until the host names it.
    return new CliError("FORBIDDEN", `hosted bundle '${bundleId}' is not served to a checkout on ${target.origin}; a hosted bundle with a Git source is edited through its Git board`, {
      details: { reason: "not_served", bundle_id: bundleId, host: target.origin },
      help: "if the bundle has a Git source, clone that repository and run superbee sync there; otherwise use the Superbee app",
    });
  }
  if (error instanceof RemoteError && error.code === "bundle_not_found") {
    return new CliError("NOT_FOUND", `no hosted bundle '${bundleId}' is visible to you on ${target.origin}`, {
      details: { bundle_id: bundleId, host: target.origin },
      help: `${cliInvocation()} whoami --host ${commandToken(hostArgument(target))}`,
    });
  }
  if (error instanceof RemoteError && error.code === "result_too_large") return tooLarge(bundleId, target, null);
  return hostedFailure(error, target, resume);
}

export function tooLarge(bundleId: string, target: HostedTarget, count: number | null): CliError {
  return new CliError("FORBIDDEN", `hosted bundle '${bundleId}' is too large to check out (over ${CHECKOUT_DOCUMENT_LIMIT} documents)`, {
    details: { reason: "bundle_too_large", bundle_id: bundleId, host: target.origin, limit: CHECKOUT_DOCUMENT_LIMIT, ...(count === null ? {} : { documents: count }) },
    help: "use the Superbee app for this bundle; paged checkout is not available yet",
  });
}

/** The lock errors a checkout can meet, as the CLI taxonomy names them. */
export function lockFailure(error: unknown, folder: string): unknown {
  if (error instanceof PushRoleStaleOwnerError) {
    return new CliError("CONFLICT", `the checkout lock for ${folder} names a process that is gone`, {
      details: { reason: "stale_lock", folder, lock: error.lockPath },
      help: `confirm no superbee command is using ${folder}, remove ${error.lockPath}, then retry the same command`,
    });
  }
  if (error instanceof FilesystemMutationLockError) {
    return new CliError("CONFLICT", `the checkout lock for ${folder} is not usable`, {
      details: { reason: "lock_unavailable", folder, lock: error.lockPath },
      help: `confirm no superbee command is using ${folder}, remove ${error.lockPath}, then retry the same command`,
    });
  }
  return error;
}

/**
 * The canonical path a folder has, or will have once created: its parent's real path plus its
 * name, or, when the folder is a symbolic link, the real path of the folder it names. A link to
 * nothing is refused.
 */
export async function canonicalFolder(folder: string): Promise<string> {
  const parent = path.dirname(folder);
  await mkdir(parent, { recursive: true });
  let link = false;
  try {
    link = (await lstat(folder)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!link) return path.join(await realpath(parent), path.basename(folder));
  try {
    return await realpath(folder);
  } catch {
    throw new CliError("USAGE", `the --dir folder ${folder} is a symbolic link to a folder that does not exist`, { help: "pass --dir <the real folder>" });
  }
}

/**
 * Refuse to reclaim a checkout indexed at this path while it may hold a person's work: a folder
 * that is still the checkout's own (same identity) but empty had every file removed, which is a
 * pending deletion, and a store with changes sync has not sent would lose them.
 */
async function assertReclaimable(home: string, binding: CheckoutBinding, canonical: string): Promise<void> {
  const identity = await folderIdentity(canonical);
  if (identity && sameFolder(identity, binding.folder_identity)) {
    throw new CliError("ALREADY_EXISTS", `${canonical} is the checkout of '${binding.bundle_id}' with every file removed; that is a pending change, not a stale checkout`, {
      details: { reason: "emptied_checkout", ...bindingView(binding) },
      help: `restore the files, or forget the checkout first: ${cliInvocation()} checkout --release ${commandToken(canonical)}`,
    });
  }
  const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(home, binding.checkout_id) });
  let unsent: number;
  try {
    unsent = (await store.listIntents(UNSETTLED_STATES)).length;
  } finally {
    await store.close();
  }
  if (unsent > 0) {
    throw new CliError("CONFLICT", `the checkout of '${binding.bundle_id}' at ${canonical} holds ${unsent} change(s) sync has not sent`, {
      details: { reason: "unsent_changes", unsent, ...bindingView(binding) },
      help: `to discard them and check out again: ${cliInvocation()} checkout --release ${commandToken(canonical)}`,
    });
  }
}

/**
 * Remove exactly the files this checkout placed (each only while it still holds the bytes placed),
 * then the directories that left empty, then the folder when this command created it. A file
 * someone else wrote, or changed, is kept, and so is every directory holding one.
 */
export async function removePlaced(folder: string, placed: ReadonlyMap<string, string>, createdFolder: boolean): Promise<boolean> {
  const dirs = new Set<string>();
  for (const [file, digest] of placed) {
    try {
      if (digestOf(await readFile(file)) === digest) await unlink(file);
    } catch {
      // Already gone or unreadable: nothing of ours to remove.
    }
    for (let dir = path.dirname(file); dir !== folder && dir.startsWith(`${folder}${path.sep}`); dir = path.dirname(dir)) dirs.add(dir);
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) await rmdir(dir).catch(() => {});
  if (createdFolder) await rmdir(folder).catch(() => {});
  return (await entryKind(folder)) !== "dir";
}

async function release(folderArg: string, deps: CheckoutDeps, mode: ReturnType<typeof resolveMode>): Promise<void> {
  const folder = path.resolve(deps.cwd, folderArg);
  let canonical: string;
  try {
    canonical = (await lstat(folder)).isSymbolicLink() ? await realpath(folder) : path.join(await realpath(path.dirname(folder)), path.basename(folder));
  } catch {
    try {
      canonical = path.join(await realpath(path.dirname(folder)), path.basename(folder));
    } catch {
      canonical = folder;
    }
  }
  const binding = await indexedBindingForPath(deps.auth.home, canonical);
  if (!binding) {
    deps.stdout(render({ released: false, folder: canonical, reason: "not a hosted checkout" }, mode));
    return;
  }
  const markerRemoved = await filesystemPushRoleLocks()
    .request(checkoutLockName(canonical), { ifAvailable: true }, async (lock) => {
      if (!lock) {
        throw new CliError("CONFLICT", `another command holds the checkout lock for ${canonical}`, {
          details: { reason: "checkout_busy", folder: canonical },
          help: "wait for it to finish, then retry the same command",
        });
      }
      await releaseCheckout(deps.auth.home, binding);
      return removeCheckoutMarker(canonical, binding).catch(() => false);
    })
    .catch((error: unknown) => {
      throw lockFailure(error, canonical);
    });
  deps.stdout(
    render(
      {
        released: true,
        ...bindingView(binding),
        files: "kept (the folder is now an ordinary local folder)",
        marker: markerRemoved ? "removed" : "none",
        help: [`${cliInvocation()} checkout ${commandToken(binding.bundle_id)} --host ${commandToken(binding.origin)} --dir <new folder>`],
      },
      mode,
    ),
  );
}

export async function checkout(argv: string[], partial: Partial<CheckoutDeps> = {}): Promise<void> {
  const deps = checkoutDeps(partial);
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          host: { type: "string" },
          dir: { type: "string" },
          workspace: { type: "string" },
          release: { type: "boolean" },
          adopt: { type: "boolean" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.checkout,
  );
  if (values.help) {
    deps.stdout(renderUsage(CHECKOUT_USAGE));
    return;
  }
  const mode = resolveMode(values);
  if (values.release && values.adopt) {
    throw new CliError("USAGE", "--release and --adopt cannot be combined", { help: `${cliInvocation()} checkout --help` });
  }
  if (values.adopt) {
    if (values.dir !== undefined) {
      throw new CliError("USAGE", "--adopt takes the folder as its argument, not --dir", { help: `${cliInvocation()} checkout --adopt <folder> --host <url>` });
    }
    await adopt(positionals[0]!, { host: values.host, workspace: values.workspace, json: values.json === true }, deps, mode);
    return;
  }
  if (values.release) {
    if (values.host !== undefined || values.dir !== undefined || values.workspace !== undefined) {
      throw new CliError("USAGE", "--release takes only the checkout folder", { help: `${cliInvocation()} checkout --release <folder>` });
    }
    await release(positionals[0]!, deps, mode);
    return;
  }
  const bundleId = positionals[0]!;
  if (!BUNDLE_ID.test(bundleId) || bundleId.length > 128) {
    throw new CliError("USAGE", `'${bundleId}' is not a hosted bundle id`, { help: `${cliInvocation()} checkout --help` });
  }
  // The chosen host is fixed in the binding and echoed in the receipt.
  const target = await requireHostedBundleHost(values.host, deps.auth.home);
  const prefix = syncRoutePrefix(target);
  const folder = path.resolve(deps.cwd, values.dir ?? bundleId);
  assertBundleOutsidePrivateState(folder, deps.auth.home);
  const resume: CommandText = commandFragment`${cliInvocation()} checkout ${commandToken(bundleId)} --host ${commandToken(hostArgument(target))} --dir ${commandToken(folder)}${
    values.workspace !== undefined ? commandFragment` --workspace ${commandToken(values.workspace)}` : commandFragment``
  }${values.json ? commandFragment` --json` : commandFragment``}`;

  const found = await entryKind(folder);
  if (found === "other") {
    throw new CliError("ALREADY_EXISTS", `${folder} exists and is not a folder`, { help: "pass --dir <new folder>" });
  }
  if (found === "dir") {
    const existing = await bindingForPath(deps.auth.home, await realpath(folder));
    if (existing && bindsBundle(existing, target, bundleId)) {
      deps.stdout(render({ checkout: "unchanged", ...bindingView(existing), help: nextSteps(existing.path) }, mode));
      return;
    }
    const marker = existing ? null : readCheckoutMarker(folder);
    throw new CliError("ALREADY_EXISTS", existing
      ? `${folder} is already a checkout of '${existing.bundle_id}' on ${existing.origin}`
      : marker
        ? `${folder} is a copy of a hosted checkout of '${marker.bundle_id}', not bound here`
        : `${folder} is not empty`, {
      details: existing
        ? { reason: "other_checkout", ...bindingView(existing) }
        : marker
          ? { reason: "unbound_copy", folder, marker_host: marker.host, marker_bundle_id: marker.bundle_id }
          : { reason: "not_empty", folder },
      help: existing
        ? `${cliInvocation()} checkout --release ${commandToken(existing.path)}`
        : marker
          ? `${cliInvocation()} checkout --adopt ${commandToken(folder)} --host ${commandToken(marker.host)}`
          : "pass --dir <new or empty folder>",
    });
  }
  await assertStandaloneFolder(folder);

  const { identity, reader, listed, workspace } = await connectHostedBundle(bundleId, target, values.workspace, deps, resume);
  const canonical = await canonicalFolder(folder);
  let createdFolder = false;
  const placed = new Map<string, string>();
  let replaced: CheckoutBinding | null = null;
  const result = await filesystemPushRoleLocks()
    .request(checkoutLockName(canonical), { ifAvailable: true }, async (lock) => {
      if (!lock) {
        throw new CliError("CONFLICT", `another command holds the checkout lock for ${canonical}`, {
          details: { reason: "checkout_busy", folder: canonical },
          help: "wait for it to finish, then retry the same command",
        });
      }
      // Re-checked under the lock, where the folder is also created: a concurrent checkout of the
      // same path sees either nothing or this one's folder, never a half-claimed one.
      const kind = await entryKind(canonical);
      if (kind === "dir" || kind === "other") {
        throw new CliError("ALREADY_EXISTS", `${canonical} is no longer empty`, { details: { reason: "not_empty", folder: canonical }, help: "pass --dir <new or empty folder>" });
      }
      // A ready binding whose folder is gone, or is now another (empty) folder, is stale: the
      // person removed the checkout. It is discarded only when nothing of theirs is in it.
      replaced = await indexedBindingForPath(deps.auth.home, canonical);
      if (replaced) {
        await assertReclaimable(deps.auth.home, replaced, canonical);
        await releaseCheckout(deps.auth.home, replaced);
      }
      if (kind === "absent") {
        await mkdir(canonical);
        createdFolder = true;
      }
      const identityNow = await folderIdentity(canonical);
      if (!identityNow) throw new CliError("RUNTIME", `${canonical} disappeared during checkout`, { help: "retry the same command" });
      const binding: CheckoutBinding = {
        schema: 1,
        checkout_id: newCheckoutId(),
        path: canonical,
        origin: target.origin,
        audience: target.audience,
        routes: prefix,
        workspace,
        workspaces: identity.tenantIds,
        bundle_id: bundleId,
        principal_id: identity.principalId,
        created_at: new Date(deps.auth.now()).toISOString(),
        state: "hydrating",
        folder_identity: identityNow,
      };
      await writeBinding(deps.auth.home, binding);
      let store: FileJournaledBackend | undefined;
      try {
        store = await FileJournaledBackend.open({ directory: checkoutStoreDir(deps.auth.home, binding.checkout_id) });
        const local = openLocalBundle(binding.checkout_id, { backend: store });
        let marker;
        try {
          marker = await bootstrap(reader, local);
        } catch (error) {
          throw capabilityRefusal(error, bundleId, target, listed, resume);
        }
        // The snapshot may list documents the heads did not: check what will actually be placed.
        const stored = await store.readHeads({ project: (head) => head.id });
        assertProjectable(stored, bundleId, target);
        const exported = await exportFresh(store, canonical, (file, digest) => placed.set(file, digest));
        if (exported.kept.length > 0) {
          throw new CliError("CONFLICT", `files appeared in ${canonical} during checkout`, {
            details: { reason: "folder_changed", kept: exported.kept.slice(0, 20), kept_total: exported.kept.length },
            help: "retry the same command once nothing else writes to the folder",
          });
        }
        // The folder's baseline: each file's digest and the store version it holds, so a sync that
        // stops part way never mistakes a stale file for a current one.
        const versions = new Map(await store.readHeads({ project: (head) => [head.id, head.version] as const }));
        const files: Record<string, { digest: string; version: string }> = {};
        for (const [id, digest] of Object.entries(exported.exported)) {
          const version = versions.get(id);
          if (id !== ROOT_INDEX && version) files[id] = { digest, version };
        }
        await writeProjection(deps.auth.home, binding.checkout_id, { files, root: exported.exported[ROOT_INDEX] ?? null });
        // The folder's read-only marker: informational, never routing (`hosted/marker.ts`).
        const markerFile = await writeCheckoutMarker(canonical, binding);
        if (markerFile) placed.set(markerFile, digestOf(checkoutMarkerBytes(binding)));
        const ready: CheckoutBinding = { ...binding, state: "ready" };
        await writeBinding(deps.auth.home, ready);
        // The checkout is a complete pull: reads start fresh instead of pulling or warning at once.
        await recordPulled(deps.auth.home, ready.checkout_id);
        await indexCheckoutPath(deps.auth.home, ready);
        return { binding: ready, documents: exported.documents, root: exported.root, digest: marker.headsDigest ?? null };
      } catch (error) {
        await store?.close().catch(() => {});
        store = undefined;
        await discardCheckoutState(deps.auth.home, binding.checkout_id).catch(() => {});
        throw error;
      } finally {
        await store?.close();
      }
    })
    .catch(async (error: unknown) => {
      // Never leave a partial folder: remove what this run placed. Only a file someone else wrote
      // or changed meanwhile can remain, and then the error says where.
      const clean = await removePlaced(canonical, placed, createdFolder);
      const failure = lockFailure(error, canonical);
      if (!clean && failure instanceof CliError) {
        throw new CliError(failure.code, failure.message, {
          details: { ...(failure.details ?? {}), partial_folder: canonical },
          ...(failure.help ? { help: failure.help } : {}),
        });
      }
      throw failure;
    });

  const replacedBinding = replaced as CheckoutBinding | null;
  const cataloged = await registerInCatalog(deps.auth.home, result.binding);
  deps.stdout(
    render(
      {
        checkout: "created",
        ...bindingView(result.binding),
        catalog: cataloged,
        documents: result.documents,
        root_index: result.root,
        heads_digest: result.digest,
        ...(replacedBinding ? { replaced_stale_checkout: { bundle_id: replacedBinding.bundle_id, host: replacedBinding.origin } } : {}),
        mode: "sync",
        refused: REFUSED_SUMMARY,
        help: nextSteps(result.binding.path),
      },
      mode,
    ),
  );
}

/** What `connectHostedBundle` found: who signed in, a reader for the bundle, and its workspace. */
export interface HostedBundleConnection {
  readonly identity: { readonly principalId: string; readonly tenantIds: readonly string[] };
  readonly reader: ReturnType<ReturnType<typeof createHostedSyncClient>["reader"]>;
  /** True when the host's bundle list named it. */
  readonly listed: boolean;
  /** Named, else the only one, else the default `setup hosted` recorded for this host (if still yours). */
  readonly workspace: string | null;
}

/**
 * Sign in, confirm the bundle is visible and servable as a working copy, and check its documents
 * fit a folder. Every refusal comes before anything is written.
 */
export async function connectHostedBundle(
  bundleId: string,
  target: HostedTarget,
  workspaceFlag: string | undefined,
  deps: CheckoutDeps,
  resume: CommandText,
): Promise<HostedBundleConnection> {
  const { client, identity, workspace } = await connectHostedAccount(
    target,
    {
      workspace: workspaceFlag,
      resume,
      otherWorkspace: `${cliInvocation()} checkout ${commandToken(bundleId)} --host ${commandToken(hostArgument(target))} --workspace <id>`,
    },
    deps,
  );
  const bundles = await client.bundles();
  const listing = readBundleListing(bundles);
  const matches = listing.bundles.get(bundleId)?.workspaces ?? 0;
  if (matches > 1) {
    // The host selects the tenant from the bundle id and refuses an id two tenants serve; it does
    // not select by workspace yet, so naming one cannot settle it.
    throw new CliError("CONFLICT", `hosted bundle id '${bundleId}' is in ${matches} of your workspaces on ${target.origin}, so the host cannot tell which one you mean`, {
      details: { reason: "ambiguous_bundle", bundle_id: bundleId, host: target.origin, workspaces: identity.tenantIds, ...(workspaceFlag ? { requested_workspace: workspaceFlag } : {}) },
      help: "rename the bundle in all but one workspace in the Superbee app, or use the app for it",
    });
  }
  const listed = matches === 1;
  if (!listed && listing.complete) {
    throw new CliError("NOT_FOUND", `no hosted bundle '${bundleId}' is visible to you on ${target.origin}`, {
      details: { bundle_id: bundleId, host: target.origin, visible: bundles.slice(0, 20).map((row) => row.bundleId), visible_total: bundles.length },
      help: hostedListCommand(target),
    });
  }

  const reader = client.reader(bundleId);
  let capabilities: HostedCapabilities;
  try {
    capabilities = await reader.hostedCapabilities();
  } catch (error) {
    throw capabilityRefusal(error, bundleId, target, listed, resume);
  }
  if (!capabilities.heads || !capabilities.snapshot) {
    throw new CliError("RUNTIME", `${target.origin} does not serve a working copy of '${bundleId}'`, { details: { bundle_id: bundleId, host: target.origin } });
  }
  let ids: string[];
  try {
    const heads = await reader.heads();
    ids = heads?.heads.map((head) => head.id) ?? [];
  } catch (error) {
    throw capabilityRefusal(error, bundleId, target, listed, resume);
  }
  if (ids.length > Math.min(CHECKOUT_DOCUMENT_LIMIT, capabilities.bound.documents)) throw tooLarge(bundleId, target, ids.length);
  assertProjectable(ids, bundleId, target);

  return { identity, reader, listed, workspace };
}

/** Catalog labels tried for a checkout: the bundle id, then `-2` to `-9` when another entry holds it. */
function catalogLabels(bundleId: string): string[] {
  const base = bundleId.slice(0, 60).replace(/[._-]+$/, "");
  return [base, ...Array.from({ length: 8 }, (_, index) => `${base}-${index + 2}`)].filter((label) => {
    try {
      assertCatalogLabel(label);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Register a new checkout in the person's workspace catalog, so other sessions and the local MCP
 * app can find it; the catalog derives its home (hosted) from the binding. Registration never
 * fails the checkout: the receipt says what happened and how to do it by hand.
 */
export async function registerInCatalog(home: string, binding: CheckoutBinding): Promise<Record<string, unknown>> {
  const byHand = `${cliInvocation()} catalog add <label> --dir ${commandToken(binding.path)}`;
  try {
    const taken = new Set((await loadCatalog(home)).entries.map((entry) => entry.label));
    const label = catalogLabels(binding.bundle_id).find((candidate) => !taken.has(candidate));
    if (label === undefined) return { registered: false, note: "every catalog label for this bundle id is taken", help: byHand };
    const { entry } = await addCatalogEntry(label, binding.path, { home });
    return { registered: true, label: entry.label, id: entry.id, home: "hosted" };
  } catch (error) {
    return { registered: false, note: error instanceof Error ? error.message : String(error), help: byHand };
  }
}

/** The refused command families, as the receipt lists them. */
export const REFUSED_SUMMARY: readonly string[] = Object.freeze(
  HOSTED_CHECKOUT_REFUSALS.filter((row) => row.reason !== "checkout_target").map((row) => {
    const words = row.words.join(" ");
    return row.words[0] === "promote" || row.words[0] === "delete" ? `${words} (non-.md key)` : words;
  }),
);

/** Refuse, before any file is written, ids the folder cannot hold as distinct files. */
export function assertProjectable(ids: readonly string[], bundleId: string, target: HostedTarget): void {
  let collision;
  try {
    collision = findPathCollision(ids);
  } catch (error) {
    throw new CliError("FORBIDDEN", `hosted bundle '${bundleId}' has a document id that cannot be a file path (${(error as Error).message})`, {
      details: { reason: "unsafe_id", bundle_id: bundleId, host: target.origin },
      help: "rename the document in the Superbee app, then retry the same command",
    });
  }
  if (collision) {
    throw new CliError("FORBIDDEN", `hosted bundle '${bundleId}' has paths that differ only in letter case: '${collision.first}' and '${collision.second}'`, {
      details: { reason: "path_collision", bundle_id: bundleId, host: target.origin, first: collision.first, second: collision.second },
      help: "rename one of them in the Superbee app, then retry the same command",
    });
  }
}
