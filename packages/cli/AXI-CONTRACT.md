# Superbee AXI contract

This file is the repository authority for Superbee's agent-facing CLI interaction contract. It
owns the meaning of the ten numbered AXI rules used by `packages/cli`; implementation comments,
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
| AXI-05 | Empty/unreadable/offline states are explicit and distinct, and a truncated body preview identifies itself instead of passing as the complete body. | `packages/cli/src/commands/list.ts::result reports` `packages/cli/src/commands/doc/common.ts::The token every TRUNCATED body preview carries INSIDE its own value` | `packages/cli/test/list.test.ts::definitive empty state` `packages/cli/test/doc.test.ts::a truncated body is named body_preview` |
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
