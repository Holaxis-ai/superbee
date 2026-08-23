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
import type { Frontmatter, QueryFilter } from "./types.js";

export interface QuerySelectionParams {
  type?: string;
  prefix?: string;
  field?: string;
  /** Repeatable CLI field expressions. This is additive; `field` remains the View wire shape. */
  fields?: string[];
  open?: boolean;
  limit?: number;
  /** Bundle-root OKF edition, used only for declaration-driven logical field aliases. */
  okfVersion?: string;
}

interface FieldSelection {
  key: string;
  values: string[];
}

function fieldExpressions(params: QuerySelectionParams): string[] {
  return params.fields ?? (params.field ? [params.field] : []);
}

function parseFieldSelection(expression: string): FieldSelection {
  const eq = expression.indexOf("=");
  const key = eq >= 0 ? expression.slice(0, eq).trim() : "";
  if (eq < 0 || !key) throw new Error(`field expects key=value (got '${expression}')`);
  const raw = expression.slice(eq + 1);
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => !value)) throw new Error(`field ${key} has an empty value or set member`);
  return { key, values };
}

/**
 * Compile the public query shape once. Hosts use the pushdown as an optimization only; callers
 * must still pass returned rows through `applyQuerySelectionFilters` for canonical semantics.
 */
export function normalizeQuerySelection(params: QuerySelectionParams): {
  params: QuerySelectionParams;
  pushdown: QueryFilter;
} {
  const selections = new Map<string, FieldSelection>();
  for (const expression of fieldExpressions(params)) {
    const selection = parseFieldSelection(expression);
    selections.set(selection.key, selection);
  }
  const fields = [...selections.values()].map(({ key, values }) => `${key}=${values.join(",")}`);
  const pushdown: QueryFilter = {
    ...(params.type ? { type: params.type } : {}),
    ...(params.prefix ? { prefix: params.prefix } : {}),
  };
  const singleFields = Object.fromEntries(
    [...selections.values()]
      .filter(({ key, values }) => key !== PROGRESS_STATUS_FIELD && values.length === 1)
      .map(({ key, values }) => [key, values[0]!]),
  );
  if (Object.keys(singleFields).length > 0) pushdown.fields = singleFields;
  return { params: { ...params, ...(fields.length > 0 ? { fields } : {}) }, pushdown };
}

export function applyQuerySelectionFilters<
  T extends { id: string; frontmatter: Frontmatter },
>(
  rows: T[],
  params: QuerySelectionParams,
  kinds: KindConvention[] = [],
): { rows: T[]; count: number } {
  const normalized = normalizeQuerySelection(params).params;
  let out = rows.filter((row) => matchesFilter(row, {
    ...(normalized.type ? { type: normalized.type } : {}),
    ...(normalized.prefix ? { prefix: normalized.prefix } : {}),
  }));
  const byGoverns = new Map(kinds.map((kind) => [kind.governs, kind]));
  for (const { key, values } of normalized.fields?.map(parseFieldSelection) ?? []) {
    out = out.filter((row) => {
      if (key !== PROGRESS_STATUS_FIELD) {
        return values.some((value) => matchesFilter(row, { fields: { [key]: value } }));
      }
        const kind = byGoverns.get(String(row.frontmatter.type ?? ""));
        if (!kind) return false;
        const raw = readKindField(normalized.okfVersion, kind, row.frontmatter, key);
        const actual = raw === undefined || raw === null
          ? []
          : (Array.isArray(raw) ? raw : [raw]).map((value) => String(value));
        return values.some((value) => actual.includes(value));
    });
  }
  if (normalized.open) {
    out = out.filter((row) => {
      const kind = byGoverns.get(String(row.frontmatter.type ?? ""));
      return !kind || !isTerminal(kind, row.frontmatter);
    });
  }
  const count = out.length;
  if (typeof normalized.limit === "number" && normalized.limit > 0) {
    out = out.slice(0, normalized.limit);
  }
  return { rows: out, count };
}
