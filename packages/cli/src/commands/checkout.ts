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
// This slice is read-only: hosted sync, which sends local edits, is its own command slice.
import { homedir } from "node:os";
import { mkdir, readdir, realpath, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { bootstrap, openLocalBundle } from "@superbee/browser-local";
import { RemoteError } from "@superbee/core";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { filesystemPushRoleLocks } from "@superbee/core/filesystem-push-role";
import type { HostedCapabilities } from "@superbee/core/hosted-transport";

import { parseLeafOrUsage } from "../args.js";
import { findBundleRoot, resolveProjectBinding } from "../bundle.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode } from "../output.js";
import { assertBundleOutsidePrivateState } from "../private-state-bundle-boundary.js";
import { writeUserStateFileAtomic0600 } from "../user-state.js";
import { defaultHostedAuthDeps, ensureHostedAccessToken, hostArgument, type HostedAuthDeps } from "../hosted-auth/session.js";
import { resolveHostedTarget, type HostedTarget } from "../hosted-auth/discovery.js";
import {
  bindingForPath,
  checkoutDir,
  checkoutLockName,
  checkoutStoreDir,
  discardCheckoutState,
  indexCheckoutPath,
  newCheckoutId,
  writeBinding,
  type CheckoutBinding,
} from "../hosted/binding.js";
import { createHostedSyncClient, hostedFailure, syncRoutePrefix } from "../hosted/client.js";
import { exportFresh } from "../hosted/projection.js";

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
  superbee checkout <bundle-id> --host <url> [--dir <folder>] [--workspace <id>] [--json]

Signs in if needed (AUTH_REQUIRED, exit 4, carries the one link to relay), then copies the hosted
bundle into --dir (default: ./<bundle-id>), which must be new or empty. The folder holds plain
bundle files, so every command runs on it with --dir <folder>. The link to the host is kept in
private state, keyed by the folder's path, never in the folder. Re-running for the same folder and
bundle is a no-op.

A checkout is a read copy for now: commands whose effect sync cannot send (doc delete, delete,
doc verify, kind, recipe add/evolve, artifact, sync) are refused in it with "do this in the app".
Bundles over ${CHECKOUT_DOCUMENT_LIMIT} documents, and hosted bundles with a Git source, are refused.

Options:
  --host <url>        Hosted Superbee URL (an origin, or an agent connection URL); required
  --dir <folder>      Checkout folder (default: ./<bundle-id>)
  --workspace <id>    The workspace the bundle belongs to, when you are in several
  --json              Emit compact JSON instead of TOON
  -h, --help          Show this help

Examples:
  superbee checkout team.knowledge --host https://mcp.getsuperbee.com
  superbee checkout team.knowledge --host https://mcp.getsuperbee.com --dir ~/work/team
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

function capabilityRefusal(error: unknown, bundleId: string, target: HostedTarget, listed: boolean): unknown {
  if (error instanceof RemoteError && error.code === "bundle_not_found" && listed) {
    // The bundle is visible to this identity but its content is not served to a working copy:
    // the working copy surface serves only bundles whose content the host stores, so a bundle
    // backed by a Git source answers exactly this.
    return new CliError("FORBIDDEN", `hosted bundle '${bundleId}' is not served to a checkout: a hosted bundle with a Git source is edited through its Git board`, {
      details: { reason: "git_source", bundle_id: bundleId, host: target.origin },
      help: "clone the bundle's source repository and run superbee sync there",
    });
  }
  if (error instanceof RemoteError && error.code === "bundle_not_found") {
    return new CliError("NOT_FOUND", `no hosted bundle '${bundleId}' is visible to you on ${target.origin}`, {
      details: { bundle_id: bundleId, host: target.origin },
      help: `${cliInvocation()} whoami --host ${commandToken(hostArgument(target))}`,
    });
  }
  if (error instanceof RemoteError && error.code === "result_too_large") return tooLarge(bundleId, target, null);
  return hostedFailure(error, target);
}

function tooLarge(bundleId: string, target: HostedTarget, count: number | null): CliError {
  return new CliError("FORBIDDEN", `hosted bundle '${bundleId}' is too large to check out (over ${CHECKOUT_DOCUMENT_LIMIT} documents)`, {
    details: { reason: "bundle_too_large", bundle_id: bundleId, host: target.origin, limit: CHECKOUT_DOCUMENT_LIMIT, ...(count === null ? {} : { documents: count }) },
    help: "use the Superbee app for this bundle; paged checkout is not available yet",
  });
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
  const bundleId = positionals[0]!;
  if (!BUNDLE_ID.test(bundleId) || bundleId.length > 128) {
    throw new CliError("USAGE", `'${bundleId}' is not a hosted bundle id`, { help: `${cliInvocation()} checkout --help` });
  }
  // No ambient default: the host is named on the command, never taken from the environment or
  // the last sign-in, so a checkout cannot silently bind to another host.
  if (values.host === undefined || values.host === "") {
    throw new CliError("USAGE", "checkout needs --host: a checkout never picks a host by default", {
      help: `${cliInvocation()} checkout ${commandToken(bundleId)} --host <url>`,
    });
  }
  const target = resolveHostedTarget(values.host);
  const prefix = syncRoutePrefix(target);
  const folder = path.resolve(deps.cwd, values.dir ?? bundleId);
  assertBundleOutsidePrivateState(folder, deps.auth.home);

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
      help: "pass --dir <new or empty folder>",
    });
  }
  await assertStandaloneFolder(folder);

  const resume: CommandText = commandFragment`${cliInvocation()} checkout ${commandToken(bundleId)} --host ${commandToken(hostArgument(target))}${
    values.dir !== undefined ? commandFragment` --dir ${commandToken(values.dir)}` : commandFragment``
  }`;
  // Sign-in first: AUTH_REQUIRED passes through unchanged with its one link, before any request.
  const token = await ensureHostedAccessToken(target, { resume }, deps.auth);
  const client = createHostedSyncClient({ target, accessToken: token.accessToken, ...(deps.fetch ? { fetch: deps.fetch } : {}) });

  const identity = await client.whoami();
  if (values.workspace !== undefined && !identity.tenantIds.includes(values.workspace)) {
    throw new CliError("NOT_FOUND", `you are not a member of workspace '${values.workspace}' on ${target.origin}`, {
      details: { workspace: values.workspace, workspaces: identity.tenantIds },
      help: `${cliInvocation()} checkout ${commandToken(bundleId)} --host ${commandToken(hostArgument(target))}`,
    });
  }
  const bundles = await client.bundles();
  const listed = bundles.some((row) => row.bundleId === bundleId);
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
    throw capabilityRefusal(error, bundleId, target, listed);
  }
  if (!capabilities.heads || !capabilities.snapshot) {
    throw new CliError("RUNTIME", `${target.origin} does not serve a working copy of '${bundleId}'`, { details: { bundle_id: bundleId, host: target.origin } });
  }
  let count: number;
  try {
    const heads = await reader.heads();
    count = heads?.heads.length ?? 0;
  } catch (error) {
    throw capabilityRefusal(error, bundleId, target, listed);
  }
  if (count > Math.min(CHECKOUT_DOCUMENT_LIMIT, capabilities.bound.documents)) throw tooLarge(bundleId, target, count);

  const workspace = values.workspace ?? (identity.tenantIds.length === 1 ? identity.tenantIds[0]! : null);
  let createdFolder = false;
  if (found === "absent") {
    await mkdir(folder, { recursive: true });
    createdFolder = true;
  }
  const canonical = await realpath(folder);
  const locks = filesystemPushRoleLocks();
  let placed = 0;
  const result = await locks.request(checkoutLockName(canonical), { ifAvailable: true }, async (lock) => {
    if (!lock) {
      throw new CliError("CONFLICT", `another command holds the checkout lock for ${canonical}`, {
        details: { reason: "checkout_busy", folder: canonical },
        help: "wait for it to finish, then retry the same command",
      });
    }
    // Re-checked under the lock: another checkout may have claimed the folder since.
    if ((await entryKind(canonical)) !== "empty-dir" || (await bindingForPath(deps.auth.home, canonical))) {
      throw new CliError("ALREADY_EXISTS", `${canonical} is no longer empty`, { details: { reason: "not_empty", folder: canonical }, help: "pass --dir <new or empty folder>" });
    }
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
        throw capabilityRefusal(error, bundleId, target, listed);
      }
      const exported = await exportFresh(store, canonical);
      placed = Object.keys(exported.exported).length;
      if (exported.kept.length > 0) {
        throw new CliError("CONFLICT", `files appeared in ${canonical} during checkout and were kept`, {
          details: { reason: "folder_changed", kept: exported.kept.slice(0, 20), kept_total: exported.kept.length },
          help: "remove the folder, then retry the same command",
        });
      }
      await writeUserStateFileAtomic0600(
        deps.auth.home,
        checkoutDir(deps.auth.home, binding.checkout_id),
        "projection.json",
        `${JSON.stringify({ schema: 1, exported: exported.exported })}\n`,
      );
      const ready: CheckoutBinding = { ...binding, state: "ready" };
      await writeBinding(deps.auth.home, ready);
      await indexCheckoutPath(deps.auth.home, ready);
      return { binding: ready, documents: exported.documents, root: exported.root, digest: marker.headsDigest ?? null };
    } catch (error) {
      await store?.close().catch(() => {});
      store = undefined;
      await discardCheckoutState(deps.auth.home, binding.checkout_id).catch(() => {});
      if (placed > 0 && error instanceof CliError) {
        throw new CliError(error.code, error.message, {
          details: { ...(error.details ?? {}), partial_folder: canonical, files_written: placed },
          help: `remove ${canonical}, then retry the same command`,
        });
      }
      throw error;
    } finally {
      await store?.close();
    }
  }).catch(async (error: unknown) => {
    // A folder this command created and left empty is removed; one holding files is reported.
    if (placed === 0 && createdFolder) await rmdir(canonical).catch(() => {});
    throw error;
  });

  deps.stdout(
    render(
      {
        checkout: "created",
        ...bindingView(result.binding),
        documents: result.documents,
        root_index: result.root,
        heads_digest: result.digest,
        sync: "read copy: hosted sync is not available yet; doc delete, delete, doc verify, kind, recipe add/evolve, artifact and sync are refused in this folder",
        help: nextSteps(result.binding.path),
      },
      mode,
    ),
  );
}
