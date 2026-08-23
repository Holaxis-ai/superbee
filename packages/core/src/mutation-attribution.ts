import type { Frontmatter } from "./types.js";

/** Producer-qualified portable projection of the actor behind the latest Superbee mutation. */
export const SUPERBEE_UPDATED_BY_FIELD = "superbee_updated_by";

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Resolve advisory mutation attribution from document bytes.
 *
 * The producer-qualified v0.2 extension wins. The remaining spellings preserve permissive
 * consumption of documents written before the extension existed.
 */
export function mutationActorFromFrontmatter(
  frontmatter: Readonly<Record<string, unknown>>,
): string | undefined {
  return nonEmptyString(frontmatter[SUPERBEE_UPDATED_BY_FIELD])
    ?? nonEmptyString(frontmatter.updated_by)
    ?? nonEmptyString(frontmatter.actor);
}

export interface PersistMutationActorOptions {
  actor: string | undefined;
  okfVersion: "0.1" | "0.2";
  /** A v0.2 Kind may independently require the legacy-named `actor` field. */
  kindRequiresActor: boolean;
}

/** Apply the edition-appropriate portable mutation-attribution coordinate. */
export function persistMutationActor(
  frontmatter: Frontmatter,
  options: PersistMutationActorOptions,
): Frontmatter {
  if (options.actor === undefined) return frontmatter;
  if (options.okfVersion === "0.1") return { ...frontmatter, actor: options.actor };
  return {
    ...frontmatter,
    [SUPERBEE_UPDATED_BY_FIELD]: options.actor,
    ...(options.kindRequiresActor ? { actor: options.actor } : {}),
  };
}
