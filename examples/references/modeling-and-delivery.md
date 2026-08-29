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

For a newly recognized domain with no prior-use evidence, create one clearly labeled representative
generic document first. Do not introduce a new Kind until the user has used that record, at least
two existing records demonstrate the same stable fields or relationships, or an accepted interview
has surfaced concrete prior examples that demonstrate the same stable fields, lifecycle, and
relationships. A stated intention that a concept will recur is not enough. When the current bundle
already contains several examples that establish a stable repeated shape, creating the Kind and one
valid instance together is appropriate.

## Interview-designed workspaces

When an interview is meant to design a purpose-built workspace, the proposal is the delivery
manifest, not merely an overview. Before asking for approval, separate:

- **Recurring concepts:** the things the user expects to handle repeatedly and the concrete examples
  that support that expectation.
- **Relationships and provenance:** how records relate and which sources support which conclusions.
- **Records to create now:** the named representative records that will make the accepted workflow
  usable; these may remain generic documents while their shape is uncertain.
- **Candidate Kinds:** proposed shared structure, separated from the records that do not need it yet.
- **Workflow:** the states, handoffs, or recurring actions the workspace should support.
- **Unstructured material:** notes or source material that should remain flexible rather than be
  forced into a schema.
- **Privacy and sharing boundary:** who may access the workspace and whether it stays local or joins
  an existing shared board.

After approval, use that manifest as the acceptance boundary. Every approved record under
**Records to create now:** must be created unless the user explicitly changes the proposal. An
overview may orient the workspace, but it cannot substitute for those records.

Do not install a Kind merely because the user expects a concept to recur. An interview supports
immediate installation only when concrete prior examples or prior use already demonstrate the
same stable fields, lifecycle, and relationships. In the delivery receipt, label each candidate
Kind either **installed** with the prior examples that establish its stable fields, lifecycle, and
relationships, or **deferred** with the evidence or use that would make it stable. Deferral is a
valid completed decision; unexplained omission is not.

Do not call an interview-designed workspace complete until its records and relationships match the
approved manifest, every candidate Kind has an explicit disposition, `superbee status` passes
without findings caused by the delivery, the created records and links read back, and a fresh task
or session resolves the workspace and reads the representative records. If the host cannot start
that independent session, report delivery as finished with fresh-session verification pending
instead of claiming completion.

## Delivery loop

1. State the recurring problem and the future outcome in the user's terms.
2. Inspect existing vocabulary and avoid a competing source of truth.
3. Keep unknown facts explicitly unknown; do not infer operational state from silence.
4. Create the smallest model and the representative records approved for creation now. For an
   ordinary modeling change this is normally one representative instance. Use a temporary recipe
   directory plus `superbee recipe add <path>` when installing new Kind definitions, so normal
   validation and expect-absent behavior apply.
5. Relate each new record to its actual evidence, policies, decisions, or dependencies.
6. Run `superbee status`, read the new records, and inspect their links. Repair only defects caused
   by this change.
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
