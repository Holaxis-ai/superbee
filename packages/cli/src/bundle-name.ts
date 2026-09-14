// The ONE bundle display-name derivation (tasks/bundle-display-name).
//
// PROBLEM: the conventional-folder convention makes every project's bundle root basename the
// SAME conventional string (`.superbee`, or legacy `.agentstate-lite`), so any surface labeling a bundle by its root basename shows
// the folder convention instead of the project — two projects' UIs become indistinguishable.
//
// CHAIN (first hit wins; every failure degrades silently to the next rung — this function NEVER
// throws and performs NO network I/O for the local bundles its consumers pass):
//   (a) EXPLICIT — the well-known doc {@link BUNDLE_NAME_DOC_ID} (`docs/bundle`), consumed ONLY
//       when its `type` is the dedicated marker {@link BUNDLE_NAME_DOC_TYPE}: the type gate is
//       the explicit opt-in that prevents silently appropriating an ordinary pre-existing
//       `docs/bundle` doc's title as the project name. Under the marker type, frontmatter
//       `name` wins, else the doc's `title` — settable today via plain fixed flags, no new verb:
//           doc write docs/bundle --type "Bundle Name" --title "<display name>"
//           doc update docs/bundle --title "<display name>"
//       A `docs/bundle` doc with any OTHER type is IGNORED and the chain continues. A committed
//       doc, so the name syncs to teammates.
//   (b) CONVENTIONAL — a root named `.superbee` or legacy `.agentstate-lite` displays as its PARENT directory's
//       basename (the project folder): offline, zero-config, per-project distinct.
//   (c) FALLBACK — the root basename (the pre-existing behavior for standalone bundles).
//
// One known-id read, absent-tolerant: rung (a) costs a single `readDoc` against the bundle's own
// backend (filesystem for every current consumer); a missing/malformed/unmarked doc is the common
// case and simply falls through. Consumers: the `ui` command's `/__ui/config` (shell header +
// bridge `hello.bundle.name`) and home/session-start's bundle block — and the workspace catalog
// is expected to consume THIS function too (the pairing note on
// tasks/workspace-catalog-dogfood-checkpoint); do not fork a second derivation.
import path from "node:path";
import { readDoc, type Bundle } from "@superbee/core";
import {
  CONVENTIONAL_BUNDLE_DIR_NAME,
  LEGACY_CONVENTIONAL_BUNDLE_DIR_NAME,
} from "./bundle.js";

/**
 * The well-known concept id carrying a bundle's explicit display name. NOT the bundle-root
 * `index.md` — OKF §3.1 reserves that file's frontmatter solely for `okf_version`, so the name
 * needs its own small doc.
 */
export const BUNDLE_NAME_DOC_ID = "docs/bundle";

/**
 * The ownership marker: `docs/bundle` names the bundle ONLY when it carries exactly this `type`.
 * Chosen over a bare `Bundle`: the two-word form is self-describing ("this doc carries the
 * bundle's name"), follows the built-in `Context Note` multi-word-type precedent, and a generic
 * noun like `Bundle` is far likelier to collide with an ordinary doc's type or a future kind
 * convention's `governs`. Plain type matching suffices — no kind convention is required (a
 * future recipe MAY declare one for field linting, but the derivation must keep working
 * conventions-free).
 */
export const BUNDLE_NAME_DOC_TYPE = "Bundle Name";

/**
 * Which rung of the chain produced the name — lets a consumer hint at the explicit override only
 * when the name was merely derived (home's `name_help`), and gives the catalog the same signal.
 */
export type BundleNameSource = "explicit" | "conventional-parent" | "root-basename";

/** A derived display name plus the chain rung that produced it. */
export interface BundleDisplayName {
  name: string;
  source: BundleNameSource;
}

/** Ultimate fallback when even the root basename is empty (a bundle rooted at `/`). */
const FALLBACK_NAME = "bundle";

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Derive the human display name for a LOCAL bundle (see the module header's chain). Total: never
 * throws — an absent, unreadable, malformed, or non-marker-typed well-known doc (and a backend
 * `read` that throws for any reason) degrades silently down the chain to a purely path-derived
 * name.
 */
export async function deriveBundleDisplayName(bundle: Bundle): Promise<BundleDisplayName> {
  try {
    const doc = await readDoc(bundle, BUNDLE_NAME_DOC_ID);
    // The type gate IS the opt-in: only a doc that declares itself the bundle's name-carrier may
    // name the bundle — an ordinary docs/bundle doc of any other type is ignored entirely.
    if (nonEmptyString(doc.frontmatter.type) === BUNDLE_NAME_DOC_TYPE) {
      const explicit = nonEmptyString(doc.frontmatter.name) ?? nonEmptyString(doc.frontmatter.title);
      if (explicit) return { name: explicit, source: "explicit" };
    }
  } catch {
    // Absent or unreadable doc — the common case; fall through to the path-derived rungs.
  }
  const base = path.basename(bundle.root);
  if (base === CONVENTIONAL_BUNDLE_DIR_NAME || base === LEGACY_CONVENTIONAL_BUNDLE_DIR_NAME) {
    const parent = path.basename(path.dirname(bundle.root));
    if (parent) return { name: parent, source: "conventional-parent" };
  }
  return { name: base || FALLBACK_NAME, source: "root-basename" };
}
