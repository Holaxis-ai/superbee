import type { CommandSpecGroup } from "../../src/command-spec.js";

/** Test-only relational projection for synthetic change-budget probes. */
export function projectCommandSpec(groups: readonly CommandSpecGroup[]): {
  readonly paths: readonly string[];
  readonly commandNames: readonly string[];
  readonly leaves: readonly { readonly id: string; readonly path: string; readonly count: number }[];
  readonly rows: readonly { readonly id: string; readonly paths: readonly string[] }[];
} {
  const rows = groups.flatMap((group) => group.commands.map((row) => ({
    id: row.id,
    paths: row.leaves.map((candidate) => candidate.path),
  })));
  const paths = rows.flatMap((row) => row.paths);
  const leaves = groups.flatMap((group) => group.commands.flatMap((row) =>
    row.leaves.map((candidate) => Object.freeze({
      id: candidate.id,
      path: candidate.path,
      count: candidate.arity.count,
    }))));
  return Object.freeze({
    paths: Object.freeze(paths),
    commandNames: Object.freeze([...new Set(paths.map((path) => path.split(" ", 1)[0] ?? path))]),
    leaves: Object.freeze(leaves),
    rows: Object.freeze(rows.map((row) => Object.freeze({ ...row, paths: Object.freeze(row.paths) }))),
  });
}
