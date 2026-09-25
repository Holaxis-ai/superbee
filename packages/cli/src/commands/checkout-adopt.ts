// `superbee checkout --adopt <folder>` — bind a moved, copied or restored checkout folder again.
//
// A checkout is bound by private state keyed by the folder's path and identity, so a folder that
// moves, or is copied or restored, arrives unbound: it carries the read-only marker
// (`hosted/marker.ts`) and behaves as a plain local bundle. Adopt binds it again, two ways:
//
// - **Moved.** A binding in private state records this exact folder (same device and inode, which
//   a rename keeps) at a path that no longer holds it. The binding is moved to the new path. No
//   request is made, and the store, the projection and any unsent edits or conflicts carry over.
// - **Copied or restored.** Nothing local knows the folder. The person names the host (`--host`;
//   the marker's host is only ever shown, never used alone), adopt signs in, fetches the hosted
//   bundle into a new private store, and reconciles the folder without overwriting anything:
//   * a document the folder lacks is placed;
//   * a file that says what the host says is recorded as in sync;
//   * a file that differs is left as it is with no record, which sync reports as a conflict
//     (`sync --inspect/--resolve`), because the version it was edited against is unknown;
//   * a document only in the folder has no record either, so the next sync sends it as new.
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";

import { bootstrap, openLocalBundle } from "@superbee/browser-local";
import { conceptIdFromPath, isReservedFile, pathFromConceptId } from "@superbee/core";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { filesystemPushRoleLocks } from "@superbee/core/filesystem-push-role";

import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { resolveHostedTarget } from "../hosted-auth/discovery.js";
import { cliInvocation } from "../invocation.js";
import { readRegularFileNoFollowSync } from "../nofollow-read.js";
import { render, type resolveMode } from "../output.js";
import {
  bindingForPath,
  checkoutLockName,
  checkoutStoreDir,
  discardCheckoutState,
  folderIdentity,
  indexCheckoutPath,
  movedBindingFor,
  readBinding,
  sameFolder,
  newCheckoutId,
  rebindCheckout,
  writeBinding,
  type CheckoutBinding,
} from "../hosted/binding.js";
import { relocateCatalogEntry } from "../catalog.js";
import { syncRoutePrefix } from "../hosted/client.js";
import { recordPulled } from "../hosted/freshness.js";
import { bindingHostArgument, readCheckoutMarker, writeCheckoutMarker } from "../hosted/marker.js";
import { digestOf, ensureParentInside, parentUnsafe, placeNew, ROOT_INDEX } from "../hosted/projection.js";
import { sameAsStored, walk, writeProjection, type ProjectionEntry } from "../hosted/sync-scan.js";
import { storeOkfVersion } from "../hosted/sync.js";
import {
  assertProjectable,
  assertStandaloneFolder,
  bindingView,
  capabilityRefusal,
  connectHostedBundle,
  lockFailure,
  nextSteps,
  registerInCatalog,
  removePlaced,
  type CheckoutDeps,
} from "./checkout.js";

/** How many ids a receipt lists per group before it only counts. */
const LISTED = 20;

interface AdoptOptions {
  readonly host: string | undefined;
  readonly workspace: string | undefined;
  readonly json: boolean;
}

/** The file's bytes, `unsafe` for a link or anything but a regular file, or null when absent. */
function readLeaf(file: string): Buffer | "unsafe" | null {
  const read = readRegularFileNoFollowSync(file);
  if (read.state === "missing") return null;
  return read.state === "present" ? read.bytes : "unsafe";
}

function listed(ids: readonly string[]): { ids: string[]; total: number } {
  return { ids: ids.slice(0, LISTED), total: ids.length };
}

async function withCheckoutLock<T>(folder: string, body: () => Promise<T>): Promise<T> {
  return filesystemPushRoleLocks()
    .request(checkoutLockName(folder), { ifAvailable: true }, async (lock) => {
      if (!lock) {
        throw new CliError("CONFLICT", `another command holds the checkout lock for ${folder}`, {
          details: { reason: "checkout_busy", folder },
          help: "wait for it to finish, then retry the same command",
        });
      }
      return body();
    })
    .catch((error: unknown) => {
      throw lockFailure(error, folder);
    });
}

export async function adopt(folderArg: string, options: AdoptOptions, deps: CheckoutDeps, mode: ReturnType<typeof resolveMode>): Promise<void> {
  const folder = path.resolve(deps.cwd, folderArg);
  let canonical: string;
  try {
    canonical = await realpath(folder);
    if (!(await lstat(canonical)).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new CliError("NOT_FOUND", `${folder} is not a folder`, { help: `${cliInvocation()} checkout --adopt <folder> --host <url>` });
  }
  const home = deps.auth.home;

  const bound = await bindingForPath(home, canonical);
  if (bound) {
    if (options.host !== undefined && resolveHostedTarget(options.host).audience !== bound.audience) {
      throw new CliError("CONFLICT", `${canonical} is already a checkout of '${bound.bundle_id}' on ${bound.origin}`, {
        details: { reason: "other_checkout", ...bindingView(bound) },
        help: `${cliInvocation()} checkout --release ${commandToken(canonical)}`,
      });
    }
    // An older checkout has no marker yet; adopting it is the way to add one.
    const marker = await writeCheckoutMarker(canonical, bound).catch(() => null);
    deps.stdout(render({ adopted: "unchanged", ...bindingView(bound), marker: marker ? "written" : "present", help: nextSteps(canonical) }, mode));
    return;
  }

  // Moved on the same disk: private state already knows this folder under its old path, and the
  // folder's own marker names that same checkout. Anything less is treated as a copy.
  const folderMarker = readCheckoutMarker(canonical);
  const candidate = await movedBindingFor(home, canonical);
  const moved =
    candidate && folderMarker && folderMarker.bundle_id === candidate.bundle_id && folderMarker.host === bindingHostArgument(candidate) ? candidate : null;
  if (moved) {
    if (options.host !== undefined && resolveHostedTarget(options.host).audience !== moved.audience) {
      throw new CliError("CONFLICT", `${canonical} was moved from the checkout of '${moved.bundle_id}' on ${moved.origin}, not ${options.host}`, {
        details: { reason: "moved_checkout_other_host", from: moved.path, ...bindingView(moved) },
        help: `${cliInvocation()} checkout --adopt ${commandToken(canonical)}`,
      });
    }
    const rebound = await withCheckoutLock(moved.path, () =>
      withCheckoutLock(canonical, async () => {
        // Re-checked under both locks: another adopt, checkout or release may have run meanwhile.
        const current = await readBinding(home, moved.checkout_id);
        const identityNow = await folderIdentity(canonical);
        const stillThere = await folderIdentity(moved.path);
        if (
          !current ||
          current.state !== "ready" ||
          current.path !== moved.path ||
          !identityNow ||
          !sameFolder(identityNow, current.folder_identity) ||
          (stillThere && sameFolder(stillThere, current.folder_identity)) ||
          (await bindingForPath(home, canonical))
        ) {
          throw new CliError("CONFLICT", `the checkout moved to ${canonical} changed while adopting it`, {
            details: { reason: "checkout_busy", folder: canonical, from: moved.path },
            help: `${cliInvocation()} checkout --adopt ${commandToken(canonical)}`,
          });
        }
        return rebindCheckout(home, current, canonical);
      }),
    );
    const marker = await writeCheckoutMarker(canonical, rebound).catch(() => null);
    const relocated = await relocateCatalogEntry(moved.path, canonical, { home }).catch(() => null);
    deps.stdout(
      render(
        {
          adopted: "moved",
          from: moved.path,
          ...bindingView(rebound),
          network: "none (the folder's own checkout, found in private state)",
          ...(marker ? { marker: "written" } : {}),
          catalog: relocated ? { relocated: true, label: relocated.label, id: relocated.id } : { relocated: false, note: "no catalog entry named the old folder" },
          ...(options.workspace !== undefined ? { workspace_flag: "ignored: a moved checkout keeps the workspace it was bound with" } : {}),
          help: [...nextSteps(canonical), `${cliInvocation()} sync --dir ${commandToken(canonical)}`],
        },
        mode,
      ),
    );
    return;
  }

  const marker = folderMarker;
  if (!marker) {
    throw new CliError("NOT_FOUND", `${canonical} has no hosted checkout marker (.superbee/checkout.json) and no checkout in private state was moved here`, {
      details: { reason: "not_a_checkout_copy", folder: canonical },
      help: `to mirror a hosted bundle into a new folder: ${cliInvocation()} checkout <bundle-id> --dir <new folder>`,
    });
  }
  if (options.host === undefined) {
    // The marker is folder content: its host is shown, never contacted until the person names it.
    deps.stdout(
      render(
        {
          adopted: "preview",
          folder: canonical,
          marker: { host: marker.host, bundle_id: marker.bundle_id, ...(marker.workspace ? { workspace: marker.workspace } : {}) },
          plan: [
            "sign in to the host you name, and fetch the hosted bundle",
            "add the documents the folder lacks; never overwrite a file",
            "a file that differs from the host becomes a conflict for sync --inspect/--resolve",
            "a document only in the folder is sent as new by the next sync",
          ],
          help: [`${cliInvocation()} checkout --adopt ${commandToken(canonical)} --host ${commandToken(marker.host)}`],
        },
        mode,
      ),
    );
    return;
  }
  const target = resolveHostedTarget(options.host);
  const markerTarget = (() => {
    try {
      return resolveHostedTarget(marker.host);
    } catch {
      return null;
    }
  })();
  if (!markerTarget || markerTarget.audience !== target.audience) {
    throw new CliError("USAGE", `the folder's marker names ${marker.host}, not ${options.host}`, {
      details: { reason: "marker_host_mismatch", folder: canonical, marker_host: marker.host, host: options.host },
      help: `to put this folder's documents in another host's bundle, check that bundle out into a new folder and copy the files you want`,
    });
  }
  const bundleId = marker.bundle_id;
  await assertStandaloneFolder(canonical);
  const resume: CommandText = commandFragment`${cliInvocation()} checkout --adopt ${commandToken(canonical)} --host ${commandToken(bindingHostArgument(target))}${
    options.workspace !== undefined ? commandFragment` --workspace ${commandToken(options.workspace)}` : commandFragment``
  }${options.json ? commandFragment` --json` : commandFragment``}`;
  const { identity, reader, listed: isListed, workspace } = await connectHostedBundle(bundleId, target, options.workspace ?? marker.workspace ?? undefined, deps, resume);

  const placedFiles = new Map<string, string>();
  const result = await withCheckoutLock(canonical, async () => {
    if (await bindingForPath(home, canonical)) {
      throw new CliError("CONFLICT", `${canonical} was bound by another command meanwhile`, { details: { reason: "checkout_busy", folder: canonical }, help: "retry the same command" });
    }
    const identityNow = await folderIdentity(canonical);
    if (!identityNow) throw new CliError("RUNTIME", `${canonical} disappeared during adopt`, { help: "retry the same command" });
    const binding: CheckoutBinding = {
      schema: 1,
      checkout_id: newCheckoutId(),
      path: canonical,
      origin: target.origin,
      audience: target.audience,
      routes: syncRoutePrefix(target),
      workspace,
      workspaces: identity.tenantIds,
      bundle_id: bundleId,
      principal_id: identity.principalId,
      created_at: new Date(deps.auth.now()).toISOString(),
      state: "hydrating",
      folder_identity: identityNow,
    };
    await writeBinding(home, binding);
    let store: FileJournaledBackend | undefined;
    try {
      store = await FileJournaledBackend.open({ directory: checkoutStoreDir(home, binding.checkout_id) });
      const local = openLocalBundle(binding.checkout_id, { backend: store });
      try {
        await bootstrap(reader, local);
      } catch (error) {
        throw capabilityRefusal(error, bundleId, target, isListed, resume);
      }
      const heads = await store.readHeads({ project: (head) => ({ id: head.id, raw: head.raw, version: head.version }) });
      assertProjectable(
        heads.map((head) => head.id),
        bundleId,
        target,
      );
      const okfVersion = await storeOkfVersion(store);
      const files: Record<string, ProjectionEntry> = {};
      const placed: string[] = [];
      const matched: string[] = [];
      const conflicts: string[] = [];
      const hostIds = new Set<string>();
      for (const head of heads) {
        hostIds.add(head.id);
        const file = path.join(canonical, pathFromConceptId(head.id));
        if (await parentUnsafe(canonical, file)) {
          conflicts.push(head.id);
          continue;
        }
        const bytes = readLeaf(file);
        if (bytes === "unsafe") {
          // A symbolic link or a folder in the document's place: left alone, reported.
          conflicts.push(head.id);
          continue;
        }
        if (bytes === null) {
          const hostBytes = Buffer.from(head.raw, "utf8");
          await ensureParentInside(canonical, file);
          const outcome = await placeNew(file, hostBytes);
          if (outcome.placed) {
            placedFiles.set(file, digestOf(hostBytes));
            files[head.id] = { digest: digestOf(hostBytes), version: head.version };
            placed.push(head.id);
          } else conflicts.push(head.id);
          continue;
        }
        const stored = await store.readWithJournal(head.id);
        if (sameAsStored(bytes, head.id, stored.document?.doc, okfVersion)) {
          files[head.id] = { digest: digestOf(bytes), version: head.version };
          matched.push(head.id);
        } else conflicts.push(head.id);
      }
      // The root index: placed when absent; a differing one stays and is held, as in any checkout.
      let root: string | null = null;
      let rootIndex: string = "none on the host";
      const index = await store.readReserved("", "index.md");
      if (index) {
        const hostRoot = Buffer.from(index.content, "utf8");
        root = digestOf(hostRoot);
        const current = readLeaf(path.join(canonical, ROOT_INDEX));
        if (current === "unsafe") rootIndex = "kept (not a plain file; sync holds it)";
        else if (current === null) {
          const placedRoot = (await placeNew(path.join(canonical, ROOT_INDEX), hostRoot)).placed;
          if (placedRoot) placedFiles.set(path.join(canonical, ROOT_INDEX), root);
          rootIndex = placedRoot ? "placed" : "kept";
        } else rootIndex = digestOf(current) === root ? "matches" : "kept (differs from the host's; sync holds it)";
      }
      const localOnly: string[] = [];
      for (const { rel, symlink } of await walk(canonical)) {
        if (symlink || !rel.endsWith(".md") || rel === ROOT_INDEX || isReservedFile(rel)) continue;
        const id = conceptIdFromPath(rel);
        if (!hostIds.has(id)) localOnly.push(id);
      }
      await writeProjection(home, binding.checkout_id, { files, root });
      const ready: CheckoutBinding = { ...binding, state: "ready" };
      await writeBinding(home, ready);
      await recordPulled(home, ready.checkout_id);
      await indexCheckoutPath(home, ready);
      const markerWritten = await writeCheckoutMarker(canonical, ready).catch(() => null);
      return { binding: ready, placed, matched, conflicts, localOnly, rootIndex, markerWritten };
    } catch (error) {
      await store?.close().catch(() => {});
      store = undefined;
      await discardCheckoutState(home, binding.checkout_id).catch(() => {});
      // Never leave the host's documents behind in a folder that did not become a checkout.
      await removePlaced(canonical, placedFiles, false).catch(() => false);
      throw error;
    } finally {
      await store?.close();
    }
  });

  const cataloged = await registerInCatalog(home, result.binding);
  const syncHelp = `${cliInvocation()} sync --dir ${commandToken(canonical)}`;
  deps.stdout(
    render(
      {
        adopted: "copy",
        ...bindingView(result.binding),
        catalog: cataloged,
        documents: { placed: result.placed.length, matched: result.matched.length, conflicts: result.conflicts.length, local_only: result.localOnly.length },
        ...(result.conflicts.length > 0 ? { conflicts: listed(result.conflicts) } : {}),
        ...(result.localOnly.length > 0 ? { local_only: listed(result.localOnly), local_only_note: "the next sync sends these as new documents, which re-creates any the host deleted since the copy was made; delete any you do not want first" } : {}),
        root_index: result.rootIndex,
        ...(result.markerWritten ? { marker: "written" } : {}),
        help:
          result.conflicts.length > 0
            ? [`${cliInvocation()} sync --dir ${commandToken(canonical)} --inspect --doc ${commandToken(result.conflicts[0]!)}`, syncHelp]
            : [syncHelp, ...nextSteps(canonical)],
      },
      mode,
    ),
  );
}
