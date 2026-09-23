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
import { defaultHostedAuthDeps, ensureHostedAccessToken, hostArgument, readDefaultHost, type HostedAuthDeps } from "../hosted-auth/session.js";
import { readDefaultWorkspace } from "../hosted/defaults.js";
import { recordPulled } from "../hosted/freshness.js";
import { resolveHostedTarget, type HostedTarget } from "../hosted-auth/discovery.js";
import {
  bindingForPath,
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
import { createHostedSyncClient, hostedFailure, syncRoutePrefix, WORKSPACE_HEADER } from "../hosted/client.js";
import { HOSTED_CHECKOUT_REFUSALS } from "../hosted/refusals.js";
import { digestOf, exportFresh, findPathCollision, ROOT_INDEX } from "../hosted/projection.js";
import { writeProjection } from "../hosted/sync-scan.js";

/**
 * Checkout refuses a bundle over this many documents until paged heads and snapshot land: the
 * host's working copy routes answer one unpaged listing, bounded at this size.
 */
export const CHECKOUT_DOCUMENT_LIMIT = 1000;
const BUNDLE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
/** The bundle list the host answers is capped at this many rows. */
const BUNDLE_LIST_CAP = 100;

export const CHECKOUT_USAGE = `superbee checkout — mirror a hosted bundle into a local folder

Usage:
  superbee checkout <bundle-id> [--host <url>] [--dir <folder>] [--workspace <id>] [--json]
  superbee checkout --release <folder> [--json]

Signs in if needed (AUTH_REQUIRED, exit 4, carries the one link to relay and the command to
re-run), then copies the hosted bundle into --dir (default: ./<bundle-id>), which must be new or
empty. The host is --host, else the host of your last sign-in (never SUPERBEE_HOST alone); the
receipt names the host it bound. The folder holds plain bundle files, so every command runs on it
with --dir <folder>. The link to the host is kept in private state, keyed by the folder's path,
never in the folder. Re-running for the same folder and bundle is a no-op. A checkout whose folder
was deleted, or replaced by a new empty folder, is replaced, unless it holds changes sync has not
sent yet; a checkout emptied in place is refused, because removing every file is a pending edit.

--release <folder> forgets the checkout at that folder: its private binding and store are removed
and the folder's files are left as they are. Releasing a folder that is not a checkout is a no-op.

'superbee sync --dir <folder>' sends your edits and brings in the host's. Commands whose effect
sync cannot send (doc delete, delete, doc verify, kind, recipe add/evolve, artifact, promote to a
non-.md key, serve, ui, mcp) are refused in it with "do this in the app". Bundles over ${CHECKOUT_DOCUMENT_LIMIT} documents, bundles the host does not
serve to a checkout (such as one with a Git source), and ids in two of your workspaces are refused.

Options:
  --host <url>        Hosted Superbee URL (an origin, or an agent connection URL); default: your last sign-in
  --dir <folder>      Checkout folder (default: ./<bundle-id>)
  --workspace <id>    Your workspace that holds the bundle: checked against your memberships,
                      recorded in the binding and sent as ${WORKSPACE_HEADER}
  --release           Treat the argument as a checkout folder and forget its binding
  --json              Emit compact JSON instead of TOON
  -h, --help          Show this help

Examples:
  superbee checkout team.knowledge
  superbee checkout team.knowledge --host https://mcp.getsuperbee.com --dir ~/work/team
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

async function entryKind(target: string): Promise<"absent" | "empty-dir" | "dir" | "other"> {
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

function sameBundle(binding: CheckoutBinding, target: HostedTarget, bundleId: string): boolean {
  return binding.origin === target.origin && binding.audience === target.audience && binding.bundle_id === bundleId;
}

function bindingView(binding: CheckoutBinding): Record<string, unknown> {
  return {
    bundle_id: binding.bundle_id,
    host: binding.origin,
    audience: binding.audience,
    workspace: binding.workspace,
    principal: binding.principal_id,
    folder: binding.path,
  };
}

function nextSteps(folder: string): string[] {
  return [`${cliInvocation()} list --dir ${commandToken(folder)}`, `${cliInvocation()} status --dir ${commandToken(folder)}`];
}

/** Refuse a folder nested in a local bundle or a bound project: one authority per folder. */
async function assertStandaloneFolder(folder: string): Promise<void> {
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

function capabilityRefusal(error: unknown, bundleId: string, target: HostedTarget, listed: boolean, resume: string): unknown {
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

function tooLarge(bundleId: string, target: HostedTarget, count: number | null): CliError {
  return new CliError("FORBIDDEN", `hosted bundle '${bundleId}' is too large to check out (over ${CHECKOUT_DOCUMENT_LIMIT} documents)`, {
    details: { reason: "bundle_too_large", bundle_id: bundleId, host: target.origin, limit: CHECKOUT_DOCUMENT_LIMIT, ...(count === null ? {} : { documents: count }) },
    help: "use the Superbee app for this bundle; paged checkout is not available yet",
  });
}

/** The lock errors a checkout can meet, as the CLI taxonomy names them. */
function lockFailure(error: unknown, folder: string): unknown {
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
async function canonicalFolder(folder: string): Promise<string> {
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
async function removePlaced(folder: string, placed: ReadonlyMap<string, string>, createdFolder: boolean): Promise<boolean> {
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
  await filesystemPushRoleLocks()
    .request(checkoutLockName(canonical), { ifAvailable: true }, async (lock) => {
      if (!lock) {
        throw new CliError("CONFLICT", `another command holds the checkout lock for ${canonical}`, {
          details: { reason: "checkout_busy", folder: canonical },
          help: "wait for it to finish, then retry the same command",
        });
      }
      await releaseCheckout(deps.auth.home, binding);
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
  // The host is the flag, else the last sign-in's host. SUPERBEE_HOST alone never selects it, and
  // the chosen host is fixed in the binding and echoed in the receipt.
  const hostChoice = values.host || (await readDefaultHost(deps.auth.home));
  if (!hostChoice) {
    throw new CliError("USAGE", "no hosted Superbee host: sign in first, or pass --host", {
      help: `${cliInvocation()} login --host <url>`,
    });
  }
  const target = resolveHostedTarget(hostChoice);
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
    if (existing && sameBundle(existing, target, bundleId)) {
      deps.stdout(render({ checkout: "unchanged", ...bindingView(existing), help: nextSteps(existing.path) }, mode));
      return;
    }
    throw new CliError("ALREADY_EXISTS", existing
      ? `${folder} is already a checkout of '${existing.bundle_id}' on ${existing.origin}`
      : `${folder} is not empty`, {
      details: existing ? { reason: "other_checkout", ...bindingView(existing) } : { reason: "not_empty", folder },
      help: existing ? `${cliInvocation()} checkout --release ${commandToken(existing.path)}` : "pass --dir <new or empty folder>",
    });
  }
  await assertStandaloneFolder(folder);

  // Sign-in first: AUTH_REQUIRED passes through unchanged with its one link, before any request.
  const token = await ensureHostedAccessToken(target, { resume }, deps.auth);
  const client = createHostedSyncClient({
    target,
    accessToken: token.accessToken,
    resume,
    ...(values.workspace !== undefined ? { workspace: values.workspace } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  const identity = await client.whoami();
  if (values.workspace !== undefined && !identity.tenantIds.includes(values.workspace)) {
    throw new CliError("NOT_FOUND", `you are not a member of workspace '${values.workspace}' on ${target.origin}`, {
      details: { workspace: values.workspace, workspaces: identity.tenantIds },
      help: `${cliInvocation()} checkout ${commandToken(bundleId)} --host ${commandToken(hostArgument(target))} --workspace <id>`,
    });
  }
  const bundles = await client.bundles();
  const matches = bundles.filter((row) => row.bundleId === bundleId).length;
  if (matches > 1) {
    // The host selects the tenant from the bundle id and refuses an id two tenants serve; it does
    // not select by workspace yet, so naming one cannot settle it.
    throw new CliError("CONFLICT", `hosted bundle id '${bundleId}' is in ${matches} of your workspaces on ${target.origin}, so the host cannot tell which one you mean`, {
      details: { reason: "ambiguous_bundle", bundle_id: bundleId, host: target.origin, workspaces: identity.tenantIds, ...(values.workspace ? { requested_workspace: values.workspace } : {}) },
      help: "rename the bundle in all but one workspace in the Superbee app, or use the app for it",
    });
  }
  const listed = matches === 1;
  if (!listed && bundles.length < BUNDLE_LIST_CAP) {
    throw new CliError("NOT_FOUND", `no hosted bundle '${bundleId}' is visible to you on ${target.origin}`, {
      details: { bundle_id: bundleId, host: target.origin, visible: bundles.slice(0, 20).map((row) => row.bundleId), visible_total: bundles.length },
      help: `${cliInvocation()} checkout <bundle-id> --host ${commandToken(hostArgument(target))}`,
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

  // Named, else the only one, else the default `setup hosted` recorded for this host (if still yours).
  const remembered = identity.tenantIds.length > 1 ? await readDefaultWorkspace(deps.auth.home, target.origin) : null;
  const workspace =
    values.workspace ??
    (identity.tenantIds.length === 1 ? identity.tenantIds[0]! : remembered !== null && identity.tenantIds.includes(remembered) ? remembered : null);
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
  deps.stdout(
    render(
      {
        checkout: "created",
        ...bindingView(result.binding),
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

/** The refused command families, as the receipt lists them. */
const REFUSED_SUMMARY: readonly string[] = Object.freeze(
  HOSTED_CHECKOUT_REFUSALS.filter((row) => row.reason !== "checkout_target").map((row) => {
    const words = row.words.join(" ");
    return row.words[0] === "promote" ? "promote (non-.md key)" : words;
  }),
);

/** Refuse, before any file is written, ids the folder cannot hold as distinct files. */
function assertProjectable(ids: readonly string[], bundleId: string, target: HostedTarget): void {
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
