# Superbee AXI contract

This file is the repository authority for Superbee's agent-facing CLI interaction contract. It
owns the meaning of the ten numbered AXI rules used by `packages/superbee`; implementation comments,
command help, and tests are evidence of that contract, not competing definitions.

The contract applies to every public CLI command. Human-only presentation surfaces may choose a
different format when their command help says so, and byte-channel commands deliberately reserve
stdout for raw data. Those are explicit exceptions, not permission for an ordinary command to
return unstructured prose.

## Numbered rules

1. **Structured by default.** Ordinary success output is a stable record: TOON by default, with
   compact JSON when `--json` is offered. Plain-text help and explicitly selected raw byte/value
   channels are the exceptions. Output keys and ordering are part of the observable interface.
2. **Make the common scan small and uniform.** List-like commands project a bounded, uniform row
   schema that covers the common case in one call. They report total result counts and provide an
   explicit projection escape hatch rather than dumping bodies or arbitrary fields. `link show`
   reports both `outbound_count` and the derived `backlink_count`; its backlink rows stay inline
   with the concept detail rather than requiring a second client-side count.
3. **Make detail complete without flooding context.** A detail read exposes all relevant metadata,
   but previews large bodies only up to a documented bound and points to a byte channel for the
   complete value. A byte channel must keep receipts and errors off its stdout payload.
4. **Aggregate before making the agent assemble.** Orientation and health commands compute the
   useful whole-bundle summary themselves: totals, grouped counts, recent rows, and actionable next
   steps. Do not require an agent to issue and join a series of low-level reads for routine context.
5. **Represent empty, partial, and unavailable states honestly.** An empty result is successful and
   explicit. Skipped, truncated, stale, unreadable, offline, and unavailable data must be named;
   they must not masquerade as an empty result or as fresh complete truth.
6. **Translate failures into a small stable taxonomy.** Ordinary CLI failures render a structured
   TOON error envelope on stdout, even when `--json` was requested, and use tool-native codes with
   the stable `0/1/2/4/5/6` exit taxonomy. Dependency wording, stacks, and noisy transport text do
   not become the interface. For `doc read --out -`, stdout remains raw bytes and every error
   envelope goes to stderr. For `mcp`, stdout remains the JSON-RPC transport and every CLI startup
   or runtime error envelope goes to stderr.
7. **Minimize ambient instruction and emit runnable, correctly scoped next steps.** Keep one live
   command/help authority; prefer defaults that cover supported hosts; name the selected bundle or
   remote when it matters; and emit commands that can actually run from the installed artifact.
   Persistent SessionStart installation covers Claude Code, Codex, and OpenCode. It uses a verified
   global executable (a direct absolute launcher when no managed bin is on `PATH`), never an `npx`
   network launch. Install/uninstall ownership is exact generated or recognized historical content,
   never a marker substring or filename alone.
8. **No arguments means live orientation, not a manual.** The bare command identifies the tool and
   leads with cheap live project/bundle context when available. The command index follows that live
   content. `--help` remains the deliberate manual route.
9. **Bound repeated rows and teach at the point of use.** Repeated output has a default cap, exposes
   total versus shown counts, and names the all-results escape. Put the smallest useful next command
   next to the result that motivates it rather than front-loading a general tutorial.
10. **Identify the tool and focus help on the selected verb.** The home view identifies the exact
    running Superbee artifact before live data. Top-level help is an index; each leaf's `--help`
    describes that leaf and does not dump unrelated family commands.

## Standing mutation invariant

All public mutations are idempotent at their advertised semantic boundary. Repeating a request that
has already reached its intended state succeeds without duplication or a new revision; an absent
delete is a successful `deleted:false`. This does not weaken compare-and-swap: a caller that supplies
an expected version still receives a conflict when that premise is stale, even if the requested
content would otherwise be a no-op.

`doc field <action> <document-id> <field-name>` makes collection scope explicit: `add` and
`remove` change one tag or source, `edit` patches one selected source, and `replace-all`
replaces the complete supported list. `edit` and `replace-all` require an observed version.
`set` and ordinary `doc update` refuse implicit list replacement, including nested lists;
`doc update` accepts one value per dynamic field flag. Collection actions currently support
only `tags` and `sources`; source selectors refuse ambiguous matches. Receipts report the
field/action scope, and errors identify the corrective action. See `test/doc-field.test.ts`
and `test/kind-arity.test.ts` for membership, stale-version, selector, and arity evidence.

## Cross-bundle links are additive

Cross-bundle (`okf://<alias>/<path>.md`) output never changes the report of a bundle that has no
`docs/dependencies` and no `okf:` href. `status` adds `cross_bundle_links`,
`cross_bundle_unresolved` and `cross_bundle_unchecked` only for a bundle that has one or the
other, and its `dependencies`, `dependency_problems`, `cross_bundle_unresolved_rows` and
`cross_bundle_link_type_violations_rows` tables are each omitted when empty and capped like every
other row list (rule 9). `unresolved_links` and `link_type_violations` stay local-only.
`link show` lists qualified links in a separate `qualified_outbound` table with its own
`qualified_outbound_count`; `outbound_count` keeps counting local links. No command reads another
bundle unless `--with` or `--with-deps` names it (rule 5: an unbound alias is reported as
`unchecked`, not as resolved or broken). Exit codes are unchanged. Evidence:
`packages/cli/test/cross-bundle-cli.test.ts`.

## The sync gate covers both homes

A sync gate declared with `git config superbee.syncGate '<command>'` judges what `sync` would
send in a Git board clone and in a hosted checkout alike. A hosted checkout reads the key from Git
configuration as seen from its folder, never from the bundle's documents or the host. It runs
after the pull and before anything is sent, only when the run has something to send. A failure
sends nothing: no document and no front page. The edits stay in the checkout, and sync exits 5
with code `GATE_FAILED` and the gate's facts in `details.gate`. A Git configuration that cannot be
read fails closed the same way (`reason: gate_config_unreadable`). Only the bytes the gate judged
are sent: a front page edited after it ran waits as a `paused` row (`changed_since_gate`) for the
next sync's gate. A receipt names a gate that passed
(`gate: passed: ...`). With no gate declared, the receipt has no `gate` key and is otherwise
unchanged. Evidence: `packages/cli/test/hosted-sync-gate.test.ts` and
`packages/cli/test/sync-gate-retry.test.ts`.

## Kind field types are additive

A Kind that declares no `fields.types` renders byte-identical output: `status`, `kinds`,
`new "<Kind>" --help`, `doc update`, `doc write` and `doc field set` are unchanged for it,
including when the Kind carries `x_*` keys such as `x_field_types`, which core ignores. A Kind
that declares types adds a `types` map to its `kinds` row and `; type: <t>` to each typed field
line of `new "<Kind>" --help`. A wrong value, or `null`, on a typed field is `KIND_FIELD_TYPE`,
counted in the existing `kind_warnings` and `conformance_debt`; `status` gains no key. The write
policy is the enum policy: `new` and strict writes refuse, `doc write` warns, and the overwrite
ratchet refuses a new violation. Exit codes are unchanged. `recipe evolve` is excluded from this
guarantee; see the next section. Evidence: `packages/cli/test/kind-field-types-golden.test.ts` and
`packages/cli/test/kind-field-types.test.ts`.

## Recipe evolve may add field types and enums

This is an intentional behavior change for every bundle, typed or not. `recipe evolve` may add a
`fields.types` entry, or a `fields.values` entry on a field the installed Kind already declares,
when every existing instance conforms. Before, an enum added to an installed field was refused as
`RECIPE_EVOLUTION_NON_MONOTONIC`; now it is planned, and its plan, `added_paths` and plan token
change accordingly. When existing documents would violate an added entry, the plan has one
`RECIPE_EVOLUTION_RESTRICTION_VIOLATED` blocker per entry: `id` is the Convention, `field` is
`fields.types.<f>` or `fields.values.<f>`, and the message names up to ten violating documents and
counts the rest. Changing or removing a type or an enum stays refused by the additive merge
(`RECIPE_EVOLUTION_REPLACEMENT_UNSUPPORTED`, `RECIPE_EVOLUTION_REMOVAL_UNSUPPORTED`), and an enum
on an undeclared field stays `RECIPE_EVOLUTION_NON_MONOTONIC`; its message now says to declare the
field in `fields.required` or `fields.optional` first, so that plan's text and token change too. Apply recomputes the plan and
refuses a stale token, but it does not bind instance versions into the convention write, so a
document written after that recomputation becomes conformance debt that `status` reports. Plans
for recipes that add neither entry were byte-identical, tokens included, until the recipe install
stamps below changed every plan. Evidence: `packages/cli/test/recipe-evolve-golden.test.ts` and
the `recipe evolve` tests in `packages/cli/test/recipes.test.ts`.

## Recipe install stamps

This is an intentional contract change for every recipe. Every convention `recipe add` creates or
`recipe evolve` writes carries an `x_recipe` stamp, written in the same compare-and-swap write as
the convention: the recipe `id` and `version`, `of` (how many conventions the recipe declares),
`source_digest`, `definition` (a digest of the convention as written) and `digest_rules`. It
records no actor, time or plan token. The recipe lifecycle's comparisons ignore the key; every
other reader treats it as an unknown `x_` key, so `kinds` output is unchanged.

`recipe evolve` plans gain a top-level `writes` after `changed`, each definition row gains `stamp`
(`current`, `stale`, `foreign` or `missing`), and `counts` gains `stamp_writes`. `action` and
`changed` keep their content-only meaning; the write set is every content update plus every
convention whose stamp is `stale` or `missing`, and a `foreign` stamp alone is never rewritten. A
current stamp whose `definition` no longer matches content that equals what the recipe writes
plans as `stale`, so the next apply re-stamps it. A
ready plan with `changed: false` and `writes` above zero has an apply command: it records stamps
only, which is how a bundle from before stamps gets them. Plan tokens change for every recipe,
because each definition's `stamp` and the recipe's source digest enter the token input. The apply
reports `recipe: evolved | stamped | already current`, `changed: true` whenever anything was
written, `definitions[]` rows of `id`, `changed` (a content update), `stamped` (this apply wrote
the row) and `version`, and `counts` of `updated`, `stamped` and `unchanged`; interrupted and
postcondition errors carry the same rows. A repeated apply after success writes nothing.

Evolve puts back a locally removed declaration only when restoring it widens the Kind (an optional
field, an enum value, a description, a link type, or a type that passes the instance scan). A
locally removed required field, section, terminal value or inbound expectation blocks the plan
(`RECIPE_EVOLUTION_NON_MONOTONIC`, `RECIPE_EVOLUTION_TERMINAL_CHANGE` or
`RECIPE_EVOLUTION_RELATIONSHIP_CHANGE`) until restored by hand, and a locally added declaration
blocks it (`RECIPE_EVOLUTION_REMOVAL_UNSUPPORTED`) until the recipe adopts it or it is removed by
hand.

`recipe add` gains a top-level `stamp` after `changed`: the worst of its conventions' stamps, and
`commands.plan_evolution` whenever it is not `current`. With a bundle, `recipes` adds
`installed_count`, `installed` (one row per stamped recipe: `state` of `installed`, `partial`,
`diverged` or `unknown`, `version`, `source_digest`, `conventions`, `of`, and `records`,
`missing`, `missing_ids`, `diverged` or `unknown_rules` when they apply), `unstamped_count`, a
capped `unstamped` list with `unstamped_help` (plus `unstamped_shown` and `conventions_all`, a
command listing every convention, when the list is capped), and a descriptive
`stamp_help` when any row is not `installed`; the built-in rows and every existing key are
unchanged. Exit codes are unchanged. The definition digest reads CRLF as LF, while evolve still
compares convention bodies byte for byte, so on a CRLF checkout `recipes` can read a state that a
plan cannot converge (blocked at `/body`); normalizing that comparison is a follow-up. Evidence:
`packages/core/test/recipe-lifecycle.test.ts`,
`packages/cli/test/recipe-evolve-golden.test.ts`, the stamp tests in
`packages/cli/test/recipes.test.ts` and `packages/cli/test/hosted-definition-writes.test.ts`.

## Evidence map

Every numbered row has one help/source anchor and one behavioral test anchor. The repository test
`project-contract-docs.test.ts` reads this table, requires exactly ten correctly cased rows, and
fails when an anchor or its identifying text disappears.

| ID | Required behavior | Help/source evidence | Behavioral proof |
| --- | --- | --- | --- |
| AXI-01 | Ordinary output is structured TOON with an explicit JSON hatch; raw/help channels are declared exceptions. | `packages/cli/src/commands/setup.ts::Emit compact JSON instead of TOON` | `packages/cli/test/setup.test.ts::setup defaults to TOON rather than JSON` |
| AXI-02 | Lists use a uniform minimal schema, count matches, and explicit field projection; `link show` includes outbound and derived backlink totals inline. | `packages/cli/src/commands/list.ts::default schema is` `packages/cli/src/commands/link.ts::outbound_count/backlink_count always report the true` | `packages/cli/test/list.test.ts::list (unscoped): stays the minimal` `packages/cli/test/link.test.ts::link show --limit caps the outbound/backlink lists; counts stay the true totals (A5)` `packages/cli/test/link.test.ts::link show: backlink rows carry the citing link's text` |
| AXI-03 | Detail shows all fields, bounds body preview, and points to a stdout-safe byte channel. | `packages/cli/src/commands/doc/common.ts::truncates a large body (pointing at --out)` | `packages/cli/test/doc.test.ts::body truncation + --out byte-channel pointer` |
| AXI-04 | Home computes whole-bundle orientation rather than requiring client-side joins. | `packages/cli/src/commands/home.ts::render the local orientation view` | `packages/cli/test/home.test.ts::A1.1 dashboard: bundle present, docs>0` |
| AXI-05 | Empty/unreadable/offline states are explicit and distinct, and a truncated body preview identifies itself instead of passing as the complete body. | `packages/cli/src/commands/list.ts::result reports` `packages/cli/src/body-replace-guards.ts::The token every TRUNCATED body preview carries INSIDE its own value` | `packages/cli/test/list.test.ts::definitive empty state` `packages/cli/test/doc.test.ts::a truncated body is named body_preview` |
| AXI-06 | Ordinary errors are structured TOON on stdout with the capped exit taxonomy; raw `doc read --out -` and MCP JSON-RPC reserve stdout and route errors to stderr. | `packages/cli/src/output.ts::Errors are ALWAYS TOON regardless of --json` `packages/cli/src/errors.ts::The 0/1/2/4/5/6 exit taxonomy is PRESERVED` `packages/cli/src/commands/doc/read.ts::makes the channel invariant unconditional` `packages/cli/src/commands/mcp.ts::must be routed once to stderr` | `packages/cli/test/arity-built.test.ts::must keep its reserved non-error channel byte-clean` `packages/cli/test/error-boundary.test.ts::error matrix: a CliError instance passes through` `packages/cli/test/doc-cli-integration.test.ts::built CLI: raw doc-read channels route early missing-id and unknown-option envelopes only to stderr` `packages/cli/test/mcp.test.ts::mcp routes every pre-initialize failure to stderr and marks it handled` `packages/cli/test/mcp-stdio.test.ts::built npm CLI keeps MCP stdout byte-empty for usage and bundle startup failures` |
| AXI-07 | Next steps are small, scoped, runnable; hooks cover all hosts with exact ownership. | `packages/cli/src/commands/hook.ts::Claude Code, Codex, AND OpenCode` | `packages/cli/test/session-start.test.ts::into all three runtimes; status/uninstall agree` |
| AXI-08 | Bare invocation renders live orientation before the manual. | `packages/cli/src/commands/home.ts::superbee home — render the local orientation view` | `packages/cli/test/home.test.ts::identity -> bundle -> commands` |
| AXI-09 | Repeated rows expose caps, counts, and a complete-result escape. | `packages/cli/src/commands/list.ts::0 = unlimited` | `packages/cli/test/list.test.ts::count=total, shown=cap` |
| AXI-10 | The artifact identifies itself and leaf help stays focused. | `packages/cli/src/reference.ts::for a specific command's full reference.` | `packages/cli/test/doc.test.ts::each doc verb's --help is focused` |

The mutation invariant is pinned independently because existing code uses both numbered-section
citations and the older `P6` shorthand; merging those labels would silently reinterpret the ten
rows above.

| ID | Required behavior | Help/source evidence | Behavioral proof |
| --- | --- | --- | --- |
| MUTATION | Repeating an already-satisfied mutation is a successful no-op without weakening an explicit CAS premise. | `packages/cli/src/commands/doc/common.ts::Idempotent: re-writing a doc` | `packages/cli/test/doc.test.ts::doc update: idempotent` |

## Related boundaries

- The HTTP storage seam is owned by the [wire protocol](../../docs/WIRE-PROTOCOL.md).
- Private vulnerability routing is owned by the repository [security policy](../../SECURITY.md).
- Command syntax remains owned by live `superbee <verb> --help`; this file defines interaction
  invariants, not a second command manual.
