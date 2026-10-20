/** Admission for the narrowly scoped exact-root retirement CLI. This does not prove exclusive
 * ownership: raw editors, old binaries and unregistered overlapping roots remain outside it. */
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { FilesystemBackend, type Bundle } from "@superbee/core";
import { inspectBundleHomeAt } from "./bundle-home.js";
import { assertResolvedLocalRouteIdentity, inspectBundleRootIndex, resolveLocalBundleRoute, resolveProjectBinding } from "./bundle.js";
import { currentFilesystemHost } from "./runtime-context.js";
import { CliError } from "./errors.js";

const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
function refusal(reason: string, root?: string): never {
  throw new CliError("CONFLICT", "declaration retirement requires a known plain local filesystem route", {
    details: { reason, ...(root ? { root } : {}), scope: "cooperating-local-writers-v1", external_writers: "unregistered-overlap-and-raw-editors-outside-domain" },
  });
}

/** Reuse the existing root recognizer after establishing that its evidence is readable. */
function independentIndex(dir: string): boolean {
  const index = inspectBundleRootIndex(dir);
  if (index.state === "unknown") refusal("root-index-evidence-unknown", dir);
  return index.independent;
}

export async function admitRecipeRetirementRoute(dir: string | undefined, options: { home?: string } = {}): Promise<Bundle> {
  if (currentFilesystemHost()) refusal("custom-filesystem-host-unsupported");
  const route = await resolveLocalBundleRoute(dir);
  if (route.kind === "bound-board") refusal("bound-board-unsupported", route.bundle.root);
  await assertResolvedLocalRouteIdentity(route);
  const bundle = route.bundle, root = route.target.canonicalRoot;
  if (!(bundle.backend instanceof FilesystemBackend) || Object.getPrototypeOf(bundle.backend) !== FilesystemBackend.prototype) refusal("backend-wrapper-unsupported", root);
  try {
    const before = await stat(root);
    const inspect = async (folder: string): Promise<void> => {
      const home = await inspectBundleHomeAt(folder, options);
      if (home.state === "unknown") refusal("home-evidence-unknown", folder);
      if (home.facts.home !== "local" || home.facts.copy) refusal("nonlocal-authority", folder);
      const binding = await resolveProjectBinding(folder);
      if (binding) {
        const target = await realpath(binding.target);
        if (target !== root && overlaps(target, root)) refusal("overlapping-project-binding", folder);
        // A descendant's explicit pointer selects another root, even outside this tree.
        if (folder !== root && folder.startsWith(root + path.sep) && target !== root) refusal("independent-descendant-binding", folder);
      }
    };
    independentIndex(root); // Unknown root metadata must not project to absence.
    await inspect(root);
    // Ancestors can be independently selected stores. A normal index without an edition is
    // reserved navigation only and does not establish a second root.
    let ancestor = path.dirname(root);
    for (let depth = 0; ; depth++) {
      if (depth > 128) refusal("ancestor-inspection-limit", ancestor);
      if (independentIndex(ancestor)) refusal("independent-ancestor-root", ancestor);
      await inspect(ancestor);
      const next = path.dirname(ancestor); if (next === ancestor) break; ancestor = next;
    }
    const pending = [{ folder: root, depth: 0 }]; let count = 0;
    while (pending.length) {
      const item = pending.pop()!;
      if (++count > 4096 || item.depth > 32) refusal("descendant-inspection-limit", item.folder);
      for (const entry of await readdir(item.folder, { withFileTypes: true })) {
        const child = path.join(item.folder, entry.name);
        if (entry.isSymbolicLink()) refusal("descendant-link-evidence-unknown", child);
        if (!entry.isDirectory()) continue;
        if (entry.name === ".git") refusal("independent-descendant-git", child);
        if (independentIndex(child)) refusal("independent-descendant-root", child);
        await inspect(child);
        pending.push({ folder: child, depth: item.depth + 1 });
      }
    }
    const after = await lstat(root);
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || await realpath(bundle.root) !== root) refusal("route-identity-changed", root);
    return bundle;
  } catch (error) {
    if (error instanceof CliError && error.code === "CONFLICT") throw error;
    refusal("authority-evidence-unknown", root);
  }
}
