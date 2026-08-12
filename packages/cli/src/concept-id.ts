import {
  assertSafeConceptId,
  conceptIdFromPath,
  existsDoc,
  InvalidInputError,
  isReservedFile,
  pathFromConceptId,
  type Bundle,
  type ConceptId,
} from "@superbee/core";
import { CliError } from "./errors.js";

/**
 * Normalize a CLI positional that may be spelled like an id (`tasks/a`) or its markdown path
 * (`./tasks/a.md`) into the ONE canonical ConceptId admitted by the engine/storage seam.
 */
export function conceptIdFromCliArgument(raw: string): ConceptId {
  const id = conceptIdFromPath(raw.trim());
  try {
    assertSafeConceptId(id);
  } catch (error) {
    if (error instanceof InvalidInputError) throw new CliError("USAGE", error.message);
    throw error;
  }
  return id;
}

/** Apply a kind-declared namespace to one already-canonical candidate. */
function withPrefix(id: ConceptId, rawPrefix: string | undefined): ConceptId {
  if (rawPrefix === undefined) return id;
  const prefix = conceptIdFromPath(rawPrefix.trim().replace(/\/+$/, ""));
  assertSafeConceptId(prefix);
  const prefixed = id === prefix || id.startsWith(`${prefix}/`) ? id : `${prefix}/${id}`;
  assertSafeConceptId(prefixed);
  return prefixed;
}

/**
 * Resolve the CLI's historical `.md` convenience without making it part of storage identity.
 * A real canonical id wins when it exists (`x.md` addresses physical `x.md.md`); otherwise the
 * spelling is treated as the familiar path alias (`x.md` addresses canonical `x`). Prefixing a
 * physical spelling with `./` bypasses that existence-based disambiguation, so every level remains
 * reachable even when a deeper `.md`-suffixed id exists (`./x.md.md` always addresses `x.md`).
 */
export async function resolveConceptIdCliArgument(
  bundle: Bundle,
  raw: string,
  options: { prefix?: string } = {},
): Promise<ConceptId> {
  const alias = withPrefix(conceptIdFromCliArgument(raw), options.prefix);
  const trimmed = raw.trim();

  // A leading `./` (or Windows `.\\`) is the CLI's unambiguous physical-path spelling. Without
  // this escape, an existing `x.md.md.md` would make bare `x.md.md` select canonical `x.md.md`,
  // leaving canonical `x.md` impossible to address or create by name.
  if (/^\.[\\/]/.test(trimmed)) return alias;

  // Reserved path spellings are never ambiguous CLI aliases. `index.md` means the reserved
  // `index.md`; the distinct canonical concept id `index.md` is addressed explicitly through
  // its physical spelling `index.md.md`, just like every other canonical id ending in `.md`.
  if (isReservedFile(pathFromConceptId(alias))) return alias;
  if (!trimmed.endsWith(".md")) return alias;

  // Appending a suffix before path->id conversion preserves the user's existing suffix as part
  // of the literal canonical candidate while still applying the path normalizer once.
  const literal = withPrefix(conceptIdFromPath(`${trimmed}.md`), options.prefix);
  return literal !== alias && await existsDoc(bundle, literal) ? literal : alias;
}
