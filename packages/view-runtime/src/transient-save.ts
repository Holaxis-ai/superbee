import {
  VersionConflict,
  SUPERBEE_UPDATED_BY_FIELD,
  loadKinds,
  mutateDocument,
  readBlob,
  readDocVersioned,
  writeBlob,
  type Bundle,
  type Frontmatter,
  type OkfDocument,
  type Version,
} from "@superbee/core";
import {
  isViewEntryKey,
  isViewRegistryId,
  VIEW_ENTRY_PREFIX,
  VIEW_REGISTRY_PREFIX,
  type BridgeCapability,
} from "@superbee/core/page";

export interface SaveTransientViewInput {
  launchId: string;
  viewId: string;
  description?: string;
}

export interface SaveTransientViewResult {
  viewId: string;
  entry: string;
  title: string;
  access: BridgeCapability;
  sourceVersion: Version;
  entryVersion: Version;
  registryVersion: Version;
  entryCreated: boolean;
  registryCreated: boolean;
}

export interface TransientViewSaveSource {
  title: string;
  capability: BridgeCapability;
  contentType: string;
  contentVersion: Version;
  bytes: Uint8Array;
}

/**
 * A transient save may have persisted the immutable entry before a later registry operation
 * failed. The entry is deliberately retained: deleting it could race a concurrent registration.
 * Callers must surface `retainedEntry` rather than reporting the operation as an atomic rollback.
 */
export class TransientViewSaveError extends Error {
  readonly code = "TRANSIENT_VIEW_SAVE_FAILED";
  readonly retainedEntry?: { key: string; version: Version };
  readonly retainedRegistration?: { id: string; version: Version };

  constructor(
    message: string,
    retainedEntry?: { key: string; version: Version },
    retainedRegistration?: { id: string; version: Version },
  ) {
    super(message);
    this.name = "TransientViewSaveError";
    this.retainedEntry = retainedEntry;
    this.retainedRegistration = retainedRegistration;
  }
}

function transientViewEntry(viewId: string): string {
  if (!isViewRegistryId(viewId)) {
    throw new TransientViewSaveError(
      `viewId must be a safe current View registration id under '${VIEW_REGISTRY_PREFIX}'`,
    );
  }
  const entry = `${VIEW_ENTRY_PREFIX}${viewId.slice(VIEW_REGISTRY_PREFIX.length)}.html`;
  if (!isViewEntryKey(entry)) {
    throw new TransientViewSaveError(`viewId '${viewId}' cannot be mapped to a safe View entry`);
  }
  return entry;
}

function withoutMutationMetadata(frontmatter: Frontmatter): Frontmatter {
  const {
    timestamp: _timestamp,
    actor: _actor,
    [SUPERBEE_UPDATED_BY_FIELD]: _updatedBy,
    ...rest
  } = frontmatter;
  return rest as Frontmatter;
}

function sameSavedRegistration(existing: OkfDocument, desired: OkfDocument): boolean {
  const existingFields = withoutMutationMetadata(existing.frontmatter);
  const desiredFields = withoutMutationMetadata(desired.frontmatter);
  const existingKeys = Object.keys(existingFields).sort();
  const desiredKeys = Object.keys(desiredFields).sort();
  return (
    existingKeys.length === desiredKeys.length &&
    existingKeys.every(
      (key, index) => key === desiredKeys[index] && existingFields[key] === desiredFields[key],
    ) &&
    existing.body === desired.body
  );
}

function sameEntry(
  existing: Awaited<ReturnType<typeof readBlob>>,
  source: TransientViewSaveSource,
): existing is NonNullable<Awaited<ReturnType<typeof readBlob>>> {
  return Boolean(
    existing &&
      existing.version === source.contentVersion &&
      existing.contentType === source.contentType &&
      Buffer.from(existing.bytes).equals(Buffer.from(source.bytes)),
  );
}

async function readRegistrationIfPresent(
  bundle: Bundle,
  viewId: string,
): Promise<{ doc: OkfDocument; version: Version } | null> {
  try {
    return await readDocVersioned(bundle, viewId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

/** Persist one already-authorized immutable source as a create-only blob/registration pair. */
export async function persistTransientView(
  bundle: Bundle,
  source: TransientViewSaveSource,
  input: SaveTransientViewInput,
  revalidateSource: () => Promise<boolean>,
  options: { actor?: string; now?: string } = {},
): Promise<SaveTransientViewResult> {
  const viewId = input.viewId.trim();
  const entry = transientViewEntry(viewId);
  const description = input.description?.trim();
  if (input.description !== undefined && (!description || description.length > 500)) {
    throw new TransientViewSaveError("description must be a non-empty string of at most 500 characters");
  }
  const title = source.title.trim();
  if (!title || title.length > 120) {
    throw new TransientViewSaveError("the transient View title is invalid for a durable registration");
  }

  const mutationNow = options.now ?? new Date().toISOString();
  const desiredRegistry: OkfDocument = {
    id: viewId,
    frontmatter: {
      type: "View",
      title,
      ...(description ? { description } : {}),
      entry,
      entry_version: source.contentVersion,
      access: source.capability,
    },
    body: "",
  };

  const [existingEntry, existingRegistry] = await Promise.all([
    readBlob(bundle, entry),
    readRegistrationIfPresent(bundle, viewId),
  ]);
  if (existingEntry !== null && !sameEntry(existingEntry, source)) {
    throw new TransientViewSaveError(
      `Cannot save '${viewId}' because a different View entry already exists at '${entry}'.`,
    );
  }
  if (
    existingRegistry !== null &&
    !sameSavedRegistration(existingRegistry.doc, desiredRegistry)
  ) {
    throw new TransientViewSaveError(
      `Cannot save '${viewId}' because a different View registration already exists.`,
    );
  }

  let entryCreated = false;
  let entryVersion: Version;
  if (existingEntry !== null) {
    entryVersion = existingEntry.version;
  } else {
    try {
      entryVersion = await writeBlob(
        bundle,
        entry,
        source.bytes,
        source.contentType,
        { expectedVersion: null, ...(options.actor ? { actor: options.actor } : {}) },
      );
      entryCreated = true;
    } catch (error) {
      const winner = await readBlob(bundle, entry);
      if (!sameEntry(winner, source)) {
        if (!(error instanceof VersionConflict)) {
          throw new TransientViewSaveError(
            `The View entry write was not acknowledged and no exact retained entry could be verified: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        throw new TransientViewSaveError(
          `Cannot save '${viewId}' because another writer created a different View entry at '${entry}'.`,
        );
      }
      entryVersion = winner.version;
      // A backend may commit and then lose its acknowledgement. The exact retained bytes make a
      // retry safe, but they do not prove this caller created them, so keep the receipt conservative.
      entryCreated = false;
    }
  }

  const retainedEntry = { key: entry, version: entryVersion };
  let sourceIsCurrent = false;
  try {
    sourceIsCurrent = await revalidateSource();
  } catch {
    sourceIsCurrent = false;
  }
  if (!sourceIsCurrent || source.contentVersion !== entryVersion) {
    throw new TransientViewSaveError(
      "The transient View changed or expired after its entry was persisted; no registration was created.",
      retainedEntry,
    );
  }

  try {
    let registryCreated = false;
    const currentRegistry = await readRegistrationIfPresent(bundle, viewId);
    if (currentRegistry !== null) {
      if (!sameSavedRegistration(currentRegistry.doc, desiredRegistry)) {
        throw new TransientViewSaveError(
          `Cannot save '${viewId}' because its registration changed before creation completed.`,
          retainedEntry,
        );
      }
    } else {
      const registry = await loadKinds(bundle);
      if (!(await revalidateSource().catch(() => false))) {
        throw new TransientViewSaveError(
          "The transient View changed or expired before registration creation; the exact entry was retained without a registration.",
          retainedEntry,
        );
      }
      try {
        const written = await mutateDocument({
          bundle,
          id: viewId,
          mode: "create-only",
          registry,
          strict: true,
          actor: options.actor,
          persistActor: true,
          now: () => mutationNow,
          buildCandidate: () => ({
            frontmatter: desiredRegistry.frontmatter,
            body: desiredRegistry.body,
          }),
        });
        registryCreated = true;
      } catch (error) {
        const winner = await readRegistrationIfPresent(bundle, viewId);
        if (winner === null || !sameSavedRegistration(winner.doc, desiredRegistry)) {
          if (!(error instanceof VersionConflict)) throw error;
          throw new TransientViewSaveError(
            `Cannot save '${viewId}' because another writer created a different View registration.`,
            retainedEntry,
          );
        }
        // As with the blob, an exact post-error read proves convergence but not authorship.
        registryCreated = false;
      }
    }

    // The registration's entry_version is the durable cross-resource guard. Reconcile both
    // resources and the process-local approval after creation so success has a truthful final
    // receipt; later blob replacement makes the durable registration unlaunchable rather than
    // silently changing the exact View identity.
    const [finalEntry, finalRegistry, finalSourceIsCurrent] = await Promise.all([
      readBlob(bundle, entry),
      readRegistrationIfPresent(bundle, viewId),
      revalidateSource().catch(() => false),
    ]);
    if (!sameEntry(finalEntry, source) || !finalRegistry || !sameSavedRegistration(finalRegistry.doc, desiredRegistry) || !finalSourceIsCurrent) {
      throw new TransientViewSaveError(
        "The exact View entry, registration, or transient approval changed before save completion; the retained durable state was not reported as a successful save.",
        finalEntry ? { key: entry, version: finalEntry.version } : undefined,
        finalRegistry ? { id: viewId, version: finalRegistry.version } : undefined,
      );
    }

    return {
      viewId,
      entry,
      title,
      access: source.capability,
      sourceVersion: source.contentVersion,
      entryVersion: finalEntry.version,
      registryVersion: finalRegistry.version,
      entryCreated,
      registryCreated,
    };
  } catch (error) {
    const [currentEntry, currentRegistry] = await Promise.all([
      readBlob(bundle, entry).catch(() => null),
      readRegistrationIfPresent(bundle, viewId).catch(() => null),
    ]);
    if (error instanceof TransientViewSaveError) {
      if (!error.retainedEntry && !error.retainedRegistration) throw error;
      throw new TransientViewSaveError(
        error.message,
        currentEntry ? { key: entry, version: currentEntry.version } : undefined,
        currentRegistry ? { id: viewId, version: currentRegistry.version } : undefined,
      );
    }
    const prefix = entryCreated
      ? `The exact View entry was retained at '${entry}', but`
      : `The existing exact View entry at '${entry}' was left untouched, but`;
    throw new TransientViewSaveError(
      `${prefix} its registration could not be created: ${error instanceof Error ? error.message : String(error)}`,
      currentEntry ? { key: entry, version: currentEntry.version } : undefined,
      currentRegistry ? { id: viewId, version: currentRegistry.version } : undefined,
    );
  }
}
