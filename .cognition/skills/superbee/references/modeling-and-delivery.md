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
7. Remove temporary authoring or staging directories, summarize the value, and identify the
   authoritative result by title and document reference. Follow the eager Skill's "Make the value
   visible" guidance for explicit display requests.

Use `--body-file` for multiline Markdown. Use `superbee new "<Kind>" --help` for the exact fields
of an installed Kind. Prefer semantic no-ops, actor attribution, and version-aware updates when the
CLI exposes them.

Put write-time guidance in a Kind's field or value descriptions, never its body: a write that
sets a described value returns that description as `guidance`.

## Copy documents from another bundle

Use `superbee doc import` when documents should exist here under their own ids instead of being
linked with `okf:` links. Declare the source with `superbee deps add <alias> --bundle-id <id>`. The
copy you bind with `--with` must declare the same bundle id.

```sh
superbee doc import --from <alias> --with <alias>=<path> --select type=<T> --prefix <p>
superbee doc import --from <alias> --with <alias>=<path> --select type=<T> --prefix <p> --apply <plan-token>
superbee doc import --from <alias> --with <alias>=<path> --refresh <record-id>
```

Without `--apply` the command only prints the plan. Show the person the plan, then apply its exact
token. An import writes new documents plus one Promotion record and never overwrites. A refresh
treats a copy edited since the import as a `target_edited` conflict: ask the person whether to name
it with `--overwrite <id>` (discards the edit) or `--skip <id>`. On `TRANSFER_PLAN_CHANGED`, read
the new plan before applying again. On `TRANSFER_INTERRUPTED`, run `--resume <record-id>`. Hosted
checkouts and `--remote` are refused.

## When a document cannot be read

Frontmatter parsing is bounded, so a write over a limit is refused with `USAGE` and nothing is
stored. A stored document over a limit, or with invalid YAML, fails `doc read` with `RUNTIME` and
`details.frontmatter.code` (`FRONTMATTER_TOO_LARGE`, `FRONTMATTER_TOO_DEEP`,
`FRONTMATTER_ALIAS_LIMIT`, `FRONTMATTER_CYCLE` or `FRONTMATTER_MALFORMED`).

`superbee status` and `superbee list` name affected documents. Until one is fixed, `search`,
`index generate`, `link list` and `link show` fail for the whole bundle; `list`, `query`, `status`
and `view list` skip it. `doc update` and `doc field` cannot change it. Editing the frontmatter in
the file or running `superbee doc delete <id>` restores those commands. Removing or rewriting
someone's document is the person's call, so ask first.

## Evolve from use

Refine fields or relationships only after actual instances expose a recurring need. Package a
recipe only after the definitions stabilize. Add a View only when repeated human interpretation
cost is visible. Periodically consolidate or retire structure that no longer earns its cognitive
cost.
