# Modeling and delivery

Read this only after the user accepts a durable domain-modeling change.

## Inspect before choosing a representation

Use the current CLI as the syntax authority:

```sh
superbee bundle locate
superbee list --limit 50
superbee kinds
superbee recipes
superbee link list --limit 100
```

Run the relevant command's `--help` before writing. Preserve source documents and existing domain
definitions.

## Choose the least structure that removes the recurring cost

- **Generic document:** one important record or a representative example while the shape is still
  uncertain. OKF documents do not need a governing Kind.
- **Kind:** repeated instances need shared vocabulary, fields, lifecycle, sections, freshness, or
  relationship rules. Create a Kind only when the repeated shape is already supported by evidence.
- **Recipe:** multiple stable definitions should be reusable in other bundles. Recipes contain
  definitions and guidance, never the user's instance data.
- **View:** humans repeatedly need the same comparison, timeline, graph, board, dashboard, or
  interactive decision surface. The underlying documents and relationships remain authoritative.
- **Task/Roadmap:** accountable, sequenced coordination benefits from execution state and a governing
  overview. Do not use them merely because their recipes are available.

For a newly recognized domain, create one clearly labeled representative generic document first.
Do not introduce a new Kind until the user has used that record or at least two existing records
already demonstrate the same stable fields or relationships. When the current bundle already
contains several examples that establish a stable repeated shape, creating the Kind and one valid
instance together is appropriate.

## Delivery loop

1. State the recurring problem and the future outcome in the user's terms.
2. Inspect existing vocabulary and avoid a competing source of truth.
3. Keep unknown facts explicitly unknown; do not infer operational state from silence.
4. Create the smallest model and one representative instance. Use a temporary recipe directory
   plus `superbee recipe add <path>` when installing new Kind definitions, so normal validation and
   expect-absent behavior apply.
5. Relate the new record to its actual evidence, policies, decisions, or dependencies.
6. Run `superbee status`, read the new record, and inspect its links. Repair only defects caused by
   this change.
7. Remove temporary authoring or staging directories, present the authoritative result, and give a
   brief value receipt.

Use `--body-file` for multiline Markdown. Use `superbee new "<Kind>" --help` for the exact fields
of an installed Kind. Prefer semantic no-ops, actor attribution, and version-aware updates when the
CLI exposes them.

## Evolve from use

Refine fields or relationships only after actual instances expose a recurring need. Package a
recipe only after the definitions stabilize. Add a View only when repeated human interpretation
cost is visible. Periodically consolidate or retire structure that no longer earns its cognitive
cost.
