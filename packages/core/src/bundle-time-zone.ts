import { parseReservedMarkdown, stringifyReservedMarkdown } from "./frontmatter.js";
import { DEFAULT_BUNDLE_TIME_ZONE, validateBundleTimeZone } from "./time-zone.js";
import { VersionConflict } from "./version-transport.js";
import { OkfActorError } from "./errors.js";
import { isOkfActor } from "./okf-actor.js";
import type { StorageBackend, Version, WriteOptions } from "./types.js";

const FIELD = "superbee_base_time_zone";

export interface BundleTimeZone {
  timeZone: string;
  source: "default" | "configured";
  /** Version of the complete root index, or null when it is absent. */
  version: Version | null;
}

export interface BundleTimeZoneWrite extends BundleTimeZone {
  changed: boolean;
}

function resolved(frontmatter: Record<string, unknown>, version: Version | null): BundleTimeZone {
  if (!Object.hasOwn(frontmatter, FIELD)) {
    return { timeZone: DEFAULT_BUNDLE_TIME_ZONE, source: "default", version };
  }
  return { timeZone: validateBundleTimeZone(frontmatter[FIELD]), source: "configured", version };
}

/** Resolve bundle policy without treating malformed configuration as an absent setting. */
export async function readBundleTimeZone(backend: StorageBackend, options: { signal?: AbortSignal } = {}): Promise<BundleTimeZone> {
  options.signal?.throwIfAborted();
  const current = await backend.readReserved("", "index.md", options);
  options.signal?.throwIfAborted();
  return resolved(current ? parseReservedMarkdown(current.content, "index.md").frontmatter : {}, current?.version ?? null);
}

/** Change only bundle policy, with one guarded reserved-file write and no document migration. */
export async function setBundleTimeZone(
  backend: StorageBackend,
  timeZone: string | null,
  options: WriteOptions = {},
): Promise<BundleTimeZoneWrite> {
  const selected = timeZone === null ? null : validateBundleTimeZone(timeZone);
  const current = await backend.readReserved("", "index.md");
  const version = current?.version ?? null;
  if (options.expectedVersion !== undefined && options.expectedVersion !== version) {
    throw new VersionConflict("index.md", options.expectedVersion, version);
  }
  const { frontmatter, body } = parseReservedMarkdown(current?.content ?? "", "index.md");
  if (frontmatter.okf_version === "0.2" && options.actor !== undefined && !isOkfActor(options.actor)) {
    throw new OkfActorError(options.actor, `OKF v0.2 mutation actor '${options.actor}' must be human:<id>, process:<id>, or <producer>/<version>`);
  }
  const exists = Object.hasOwn(frontmatter, FIELD);
  if ((selected === null && !exists) || (exists && frontmatter[FIELD] === selected)) {
    return { ...resolved(frontmatter, version), changed: false };
  }
  if (selected === null) delete frontmatter[FIELD];
  else frontmatter[FIELD] = selected;
  const next = await backend.writeReserved("", "index.md", stringifyReservedMarkdown(frontmatter, body), {
    ...options,
    expectedVersion: version,
  });
  return { ...resolved(frontmatter, next), changed: true };
}
