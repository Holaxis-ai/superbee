import { hostedBundleReferenceText, parseHostedBundleReference, type HostedBundleReference } from "./reference.js";

/** One row of the host's bundle list (`<prefix>/bundles`). */
export interface HostedBundleRow {
  readonly bundleId: string;
  readonly name: string;
  /** `active`, or another lifecycle the host names (archived, for example); null when it names none. */
  readonly lifecycle: string | null;
}

/** The host answers at most this many bundle rows (the kernel's list cap, applied across tenants). */
export const BUNDLE_LIST_CAP = 100;

/** One listed row: the reference the host lists it by, and that reference parsed. */
export interface HostedListedBundle {
  readonly row: HostedBundleRow;
  /** Rows the host listed under this same reference: more than one only from a host from before qualified references. */
  readonly workspaces: number;
  /** The listed reference parsed; null for a row that does not read as one. */
  readonly reference: HostedBundleReference | null;
}

/**
 * A bundle list read as a whole: each row under the reference it names (the bare id, or
 * `<slug>/<id>` for an id two of the person's workspaces hold), how many rows name it, and whether
 * the cap cut it.
 */
export interface HostedBundleListing {
  readonly bundles: ReadonlyMap<string, HostedListedBundle>;
  /** False when the host's answer reached {@link BUNDLE_LIST_CAP}, so more bundles may exist. */
  readonly complete: boolean;
  /**
   * What the listing says about a reference: the row it names; `holders`, the rows whose bundle id
   * is the reference's own, however listed (bare or qualified); and those rows' qualified
   * references, sorted. A bare id with two or more holders cannot be told apart.
   */
  lookup(reference: HostedBundleReference): {
    readonly row: HostedBundleRow | null;
    readonly holders: number;
    readonly references: readonly string[];
  };
}

/**
 * One reading of the host's rows, each parsed once. The host answers one row per workspace that
 * serves an id, and names an id two workspaces serve by each one's reference. A host from before
 * qualified references (or a workspace with no slug, or a collision past the list cap) lists such
 * an id bare, more than once.
 */
export function readBundleListing(rows: readonly HostedBundleRow[]): HostedBundleListing {
  const bundles = new Map<string, HostedListedBundle>();
  const holders = new Map<string, number>();
  const qualified = new Map<string, Set<string>>();
  for (const row of rows) {
    const seen = bundles.get(row.bundleId);
    const reference = seen?.reference ?? parseHostedBundleReference(row.bundleId);
    bundles.set(row.bundleId, { row: seen?.row ?? row, workspaces: (seen?.workspaces ?? 0) + 1, reference });
    if (!reference) continue;
    holders.set(reference.bundleId, (holders.get(reference.bundleId) ?? 0) + 1);
    if (reference.slug !== null) qualified.set(reference.bundleId, (qualified.get(reference.bundleId) ?? new Set()).add(row.bundleId));
  }
  return {
    bundles,
    complete: rows.length < BUNDLE_LIST_CAP,
    lookup(reference) {
      return {
        row: bundles.get(hostedBundleReferenceText(reference))?.row ?? null,
        holders: holders.get(reference.bundleId) ?? 0,
        references: [...(qualified.get(reference.bundleId) ?? [])].sort(),
      };
    },
  };
}
