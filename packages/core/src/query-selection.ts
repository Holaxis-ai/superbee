/**
 * Browser-safe post-filtering shared by human-facing query surfaces.
 *
 * Storage-facing `type`/`prefix` filtering stays in `queryHeads`; this helper owns the
 * field-set, declared-terminal, honest-count, and limit projection used after those rows arrive.
 */
import {
  PROGRESS_STATUS_FIELD,
  isTerminal,
  readKindField,
  type KindConvention,
} from "./kinds.js";
import { matchesFilter } from "./query-filter.js";
import type { Frontmatter } from "./types.js";

export interface QuerySelectionParams {
  type?: string;
  prefix?: string;
  field?: string;
  open?: boolean;
  limit?: number;
  /** Bundle-root OKF edition, used only for declaration-driven logical field aliases. */
  okfVersion?: string;
}

export function applyQuerySelectionFilters<
  T extends { id: string; frontmatter: Frontmatter },
>(
  rows: T[],
  params: QuerySelectionParams,
  kinds: KindConvention[] = [],
): { rows: T[]; count: number } {
  let out = rows;
  const byGoverns = new Map(kinds.map((kind) => [kind.governs, kind]));
  if (params.field) {
    const eq = params.field.indexOf("=");
    if (eq > 0) {
      const key = params.field.slice(0, eq).trim();
      const values = params.field
        .slice(eq + 1)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      out = out.filter((row) => {
        if (key !== PROGRESS_STATUS_FIELD) {
          return values.some((value) => matchesFilter(row, { fields: { [key]: value } }));
        }
        const kind = byGoverns.get(String(row.frontmatter.type ?? ""));
        if (!kind) return false;
        const raw = readKindField(params.okfVersion, kind, row.frontmatter, key);
        const actual = raw === undefined || raw === null
          ? []
          : (Array.isArray(raw) ? raw : [raw]).map((value) => String(value));
        return values.some((value) => actual.includes(value));
      });
    }
  }
  if (params.open) {
    out = out.filter((row) => {
      const kind = byGoverns.get(String(row.frontmatter.type ?? ""));
      return !kind || !isTerminal(kind, row.frontmatter);
    });
  }
  const count = out.length;
  if (typeof params.limit === "number" && params.limit > 0) {
    out = out.slice(0, params.limit);
  }
  return { rows: out, count };
}
