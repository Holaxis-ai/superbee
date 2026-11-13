/** Runtime-neutral admission reads. Only the filesystem capability is enabled in this profile. */
import { MalformedDocumentError, parseMarkdown } from "./frontmatter.js";
import {
  QUALIFIED_PROFILE,
  qualifiedDigest,
  qualifiedFailure,
  qualifiedRegistry,
  type QualifiedLock,
} from "./qualified-kinds.js";
import type { KindRegistry } from "./kinds.js";
import type { StorageBackend } from "./types.js";

export async function inspectQualifiedRoot(
  backend: StorageBackend,
): Promise<
  { content: string; version: string; lock: QualifiedLock } | undefined
> {
  const root = await backend.readReserved("", "index.md");
  let fm: Record<string, unknown>;
  try {
    fm = root
      ? parseMarkdown(root.content, "index.md", { okfVersion: "0.2" })
          .frontmatter
      : {};
  } catch (error) {
    if (!(error instanceof MalformedDocumentError)) throw error;
    if (
      root?.content.includes("superbee_profile") ||
      root?.content.includes("superbee_registry") ||
      root?.content.includes("superbee_bundle_origin") ||
      (await backend.readReserved("conventions/qualified", "index.md"))
    )
      throw error;
    // A malformed legacy root remains repairable through its existing raw-write contract.
    return undefined;
  }
  if (fm.superbee_profile === undefined) {
    if (
      Object.keys(fm).some(
        (k) =>
          k.startsWith("superbee_registry") || k === "superbee_bundle_origin",
      ) ||
      (await backend.readReserved("conventions/qualified", "index.md")) !== null
    )
      qualifiedFailure("qualified evidence without profile marker");
    return undefined;
  }
  if (fm.superbee_profile !== QUALIFIED_PROFILE || fm.okf_version !== "0.2")
    qualifiedFailure("unsupported profile or field edition");
  const lock = fm.superbee_registry as QualifiedLock;
  if (
    !lock ||
    fm.superbee_bundle_origin !== lock.origin ||
    fm.superbee_registry_generation !== qualifiedDigest(lock)
  )
    qualifiedFailure("missing or corrupt active registry");
  return { ...root!, lock };
}
export async function loadQualifiedRegistry(
  backend: StorageBackend,
): Promise<KindRegistry> {
  assertQualifiedBackend(backend);
  const root = await inspectQualifiedRoot(backend);
  if (!root) qualifiedFailure("qualified bundle required");
  const registry = qualifiedRegistry(root.lock, root.version);
  for (const entry of root.lock.entries) {
    const found = await backend.read(entry.doc.id);
    if (
      qualifiedDigest(["qualified-definition/v1", found.doc]) !==
      entry.ref.definition_digest
    )
      qualifiedFailure(
        `missing or corrupt admitted definition '${entry.doc.id}'`,
      );
  }
  const after = await backend.readReserved("", "index.md");
  if (after?.version !== root.version)
    qualifiedFailure("registry generation changed; reload");
  return registry;
}

const qualifiedBackends = new WeakMap<object, () => void>();
export function registerQualifiedBackend(
  backend: StorageBackend,
  guard: () => void,
): void {
  qualifiedBackends.set(backend, guard);
}
export function assertQualifiedBackend(backend: StorageBackend): void {
  if (!qualifiedBackends.has(backend))
    qualifiedFailure("unsupported backend or wrapper");
  qualifiedBackends.get(backend)!();
}
