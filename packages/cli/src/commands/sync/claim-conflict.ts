// Sync converge's OWNERSHIP half: which frontmatter coordinates a conflicted doc's kind DECLARES
// as claim fields, and the one arbiter a lost claim may be attributed to. Split from
// `converge.ts` (which owns the conflict strings and row projection) so the workflow vocabulary
// stays where it belongs — declared by the bundle's kind convention, never spelled into the CLI.
//
// The reported outcome of a claim race is an ownership FACT, not a content divergence: the
// diagnostics name the recorded actor string verbatim and a git REF — never a hostname, a person,
// a "teammate", or a machine.
import {
  BOARD_BRANCH,
  BOARD_REMOTE,
  resolveOriginRef,
  runGit,
} from "@superbee/board-git";
import {
  SUPERBEE_UPDATED_BY_FIELD,
  claimCoordinates,
  loadKinds,
  parseMarkdown,
  readBundleOkfVersion,
  type KindClaimCoordinates,
} from "@superbee/core";

/** The pinned row/message key an agent branches on when its claim did not win. */
export const CLAIM_LOST_KEY = "claim_lost";

/** The pinned closing clause of every ownership statement. */
export const CLAIM_NOT_ARBITRATED = "your claim was not arbitrated";

/** Rendered when the arbitrated version records no owner at all (a release, not a rival claim). */
export const CLAIM_NO_OWNER_RECORDED = "no owner is recorded";

/** The upstream ref the converging mechanic keeps content from — the claim's actual arbiter. */
export const BOARD_UPSTREAM_REF = `${BOARD_REMOTE}/${BOARD_BRANCH}`;

/**
 * Frontmatter keys the ENGINE rewrites on EVERY write (attribution + clocks). Two concurrent
 * versions of one doc always disagree on them and no caller can meaningfully re-apply them, so
 * they never turn an otherwise claim-only conflict into a mixed one. This set decides ONLY that
 * question — the reported `frontmatter_differs` list is untouched for every conflict that carries
 * no claim divergence.
 */
export const ENGINE_STAMPED_FIELDS: ReadonlySet<string> = new Set([
  "timestamp",
  "generated",
  SUPERBEE_UPDATED_BY_FIELD,
]);

/** The claim vocabulary a converging conflict run may report against. */
export interface ClaimPolicy {
  /**
   * Resolved claim coordinates for a doc whose kept `type` is `type`, or undefined when the
   * bundle declares none for it — the whole ownership report is then skipped for that doc.
   *
   * This probe drives SUPPRESSION, which is independent of {@link ClaimPolicy.upstreamFrontmatter}
   * and {@link ClaimPolicy.provenance}: withdrawing the steal instruction needs only a declared
   * claim field, never a nameable arbiter.
   */
  forType(type: unknown): KindClaimCoordinates | undefined;
  /**
   * The doc's frontmatter as recorded on `origin/board` — the ARBITER ITSELF — or undefined when
   * that ref carries no readable copy of it. Reading the owner here rather than from the local
   * HEAD keeps the `origin/board@<sha>` provenance true by construction, including on a
   * multi-stop rebase where a later local commit replayed on top of the kept version.
   */
  upstreamFrontmatter(relPath: string): Record<string, unknown> | undefined;
  /** `origin/board@<sha>`, or undefined when the ref does not resolve (nothing to attribute to). */
  readonly provenance: string | undefined;
}

/** The inert policy: every probe answers "no claim declared", so converge reports as it always did. */
const INACTIVE_POLICY: ClaimPolicy = {
  forType: () => undefined,
  upstreamFrontmatter: () => undefined,
  provenance: undefined,
};

/**
 * Build the claim policy for one converging conflict run, from the board worktree's OWN
 * conventions through the ONE kind registry. Degrades to {@link INACTIVE_POLICY} whenever
 * ownership cannot be spoken honestly — no upstream ref to name, no declared kinds, or any
 * failure reading the bundle: a CONFLICT terminal must still report its conflicts, so this
 * enrichment can never become the reason the report is lost.
 */
export async function loadClaimPolicy(boardPath: string): Promise<ClaimPolicy> {
  try {
    const originSha = resolveOriginRef(boardPath);
    if (originSha === null) return INACTIVE_POLICY;
    const bundle = { root: boardPath };
    const [registry, okfVersion] = await Promise.all([loadKinds(bundle), readBundleOkfVersion(bundle)]);
    if (registry.kinds.size === 0) return INACTIVE_POLICY;

    const resolved = new Map<string, KindClaimCoordinates | undefined>();
    return {
      provenance: `${BOARD_UPSTREAM_REF}@${originSha}`,
      forType(type: unknown): KindClaimCoordinates | undefined {
        const name = typeof type === "string" ? type.trim() : "";
        if (name === "") return undefined;
        if (!resolved.has(name)) {
          const kind = registry.kinds.get(name);
          resolved.set(name, kind ? claimCoordinates(okfVersion, kind) : undefined);
        }
        return resolved.get(name);
      },
      upstreamFrontmatter(relPath: string): Record<string, unknown> | undefined {
        const shown = runGit(boardPath, ["show", `${BOARD_UPSTREAM_REF}:${relPath}`]);
        if (shown.status !== 0) return undefined;
        try {
          return parseMarkdown(shown.stdout, relPath).frontmatter as Record<string, unknown>;
        } catch {
          return undefined;
        }
      },
    };
  } catch {
    return INACTIVE_POLICY;
  }
}

/**
 * The recorded owner as the stored scalar VERBATIM, or undefined when the arbitrated version
 * records none. A non-scalar (a list, a map) is not an actor string and reads as no owner.
 */
export function recordedOwner(
  frontmatter: Record<string, unknown>,
  ownerField: string | undefined,
): string | undefined {
  if (ownerField === undefined) return undefined;
  const value = frontmatter[ownerField];
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * The ONE ownership statement (test-pinned): who owns the arbitrated version, the ref and sha it
 * was observed at, and the plain fact that this side's claim never reached the arbiter. It offers
 * no re-apply route by construction — reversing the arbitration is not a remedy the product may
 * suggest.
 */
export function claimLostStatement(owner: string | undefined, provenance: string): string {
  const who = owner === undefined ? CLAIM_NO_OWNER_RECORDED : `owner is ${owner}`;
  return `${who} as of ${provenance}; ${CLAIM_NOT_ARBITRATED}`;
}
