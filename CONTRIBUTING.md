# Contributing to Superbee

This is the repository-local authority for contribution workflow. Product intent and work records
live in the selected project bundle; executable behavior lives in source, package scripts, and CI.
When those surfaces disagree, stop and repair the disagreement instead of choosing the convenient
answer.

## Start here

1. Fork or branch from the current `origin/main`, then run `npm ci` from the repository root. A
   fresh worktree has no trustworthy dependency installation until that succeeds.
2. Read `CLAUDE.md` for the mandatory cold-start and safety rules. Use this document for the
   contribution procedure.
3. Keep the change to one coherent behavioral or policy claim. If correctness needs another
   decision, make it explicit and order it first.
4. Build from the repository root. Use the root `./superbee` shim when exercising the freshly built
   CLI.
5. Develop with Node.js 20 or newer on macOS, Linux, or Windows. Windows private state lives under
   `%LOCALAPPDATA%` and relies on that per-user known folder's ACL boundary; POSIX hosts additionally
   verify private file modes. The manually dispatched `windows-latest` proof runs every workspace
   test natively and installs the packed CLI on Node 20 for a release candidate or targeted check.

A fresh clone does not need an installed Agent Skill or a project bundle to build, test, or submit
code. It does need the maintainer-supplied bundle or an exact scoped handoff to claim project
work, change product intent, or write durable Task and Review records. Do not initialize a
replacement bundle or guess missing project state. Ask the maintainer for the selected bundle or a
bounded packet, and continue only with work that does not depend on that state.

## Roles and verbs

Ownership follows the verb, not the runtime or the task packet.

| Role | Owns | Does not own |
| --- | --- | --- |
| Builder | Implement one claim, run its pre-commit evidence, commit the coherent unit | Push, sync the project bundle, dispatch CI, publish, release, or merge |
| Orchestrator | Verify commit identity and scope, integrate commits, push once, dispatch CI for the integrated SHA | Re-run valid builder evidence as ceremony or rewrite a builder's commit |
| Reviewer / QA | Inspect the exact target, attack the named risk, and record the result | Move the target while reviewing it or substitute broad reruns for a focused probe |
| CI | Decide whether the pushed SHA passes the full repository gate | Author policy or repair a failing change |
| Human maintainer | Open and merge the PR and authorize external or destructive operations | Delegate accountability for the merge gate |

A sub-agent commit is the handoff. The orchestrator checks its parent, diff, message, and evidence;
it does not amend the commit. A void result - missing exit code, a changed tree after the run, or a
test that did not exercise the claimed bytes - is rerun at the same pre-commit scope. Integration of
several green commits is new evidence and belongs to CI on the integrated SHA.

## Engineering principles

- Treat `canonical`, `parity`, and `gate` as executable claims. Back each with one owning primitive
  or a direct agreement check.
- When a contract has multiple public surfaces, use one per-row agreement table. Collapse behavior
  into one primitive where possible; test only projections that must remain separate.
- Put deterministic adversarial tests beside risky boundary changes, especially security,
  concurrency, destructive writes, migrations, remote selection, and replay or recovery.
- A consolidation removes the superseded implementation, tests, and commentary in the same unit.
- Keep source comments to stable, non-obvious reasons. Review history belongs in the PR or project
  bundle.

## Branches, commits, and integration

Start from current `origin/main`, not another PR tip. Commit one reviewed unit with a descriptive
message and no AI-attribution or tool-generated authorship trailers. Do not force-push an open PR
except for an explicitly coordinated rebase; preserve review deltas as appended commits. The human
maintainer opens the PR and owns merge.

After merging another branch into a working branch, re-read generated prose near the change and the
front-door README. A generator can prove byte agreement; it cannot prove that retained prose is
still true.

### Dispatch and agent work

Dispatch one independent claim per packet. Name no broad gate by default: builders run the
pre-commit smoke and touched target, while CI gates the integrated SHA. Preserve the empirical probe
that the risk requires, even when it is slow. Do not dispatch an agent for a read that a bounded
search answers.

Every packet that depends on project state names the selected bundle, an actor, exact authorities,
the phase-boundary Context Note requirement, and prohibited external verbs. A packet cannot grant a
builder push, sync, CI-dispatch, publish, release, or merge authority.

## Checks and CI

CI on the pushed SHA is the authoritative gate. During implementation, run the smallest lane that
owns the affected behavior. `npm run check` is the fullest local stand-in only when CI is
unavailable; the pre-commit smoke is not the full gate.

Two validations exist, and each needs exactly one run. PR validation (`pull_request`) proves the
proposed change against its base before merge. Release-source validation is the newest recorded
`CI required lanes` verdict on the exact tagged commit — ordinarily the `push` run on the merged
`main` commit; `release.yml` consumes that verdict fail-closed instead of rerunning CI. The
maintainer opens the PR immediately after the branch push so its run starts the pre-merge
verdict; dispatch `CI tests` on a branch only when no PR will exist promptly, and never
treat a branch dispatch as a serial prerequisite for opening or progressing the PR — a dispatch and
a PR run on the same SHA are the same coverage paid twice. One run can satisfy both validations
only when the merged SHA equals the validated SHA (fast-forward or a merge queue; the current
merge-queue posture is recorded in `scripts/ci-lanes.json`).

The finite lane projection below is checked against `scripts/ci-lanes.json`, root package scripts,
and `.github/workflows/ci-tests.yml`. Change the executable topology first, then update this table in
the same unit.

<!-- contributing-ci-lanes:start -->
| Lane | Local command | CI job | Node |
| --- | --- | --- | --- |
| runtime | `npm run ci:runtime` | `runtime` | 22, 26 |
| aliasing-host | `npm run ci:aliasing-host` | `aliasing-host` | 26 |
| windows | workflow_dispatch only | `windows` | 22, 20 |
| distribution | `npm run ci:distribution` | `distribution` | 26 |
| browser | `npm run ci:browser` | `browser` | 26 |
| scripts | `npm run ci:scripts` | `scripts` | 26 |
| smoke-node-20 | workflow only | `smoke-node-20` | 20 |
<!-- contributing-ci-lanes:end -->

Minimum iteration lanes by reach:

| Touched surface | Run at minimum |
| --- | --- |
| Package source or tests | `npm run ci:runtime` (native Windows behavior is gated in CI) |
| `package.json`, `scripts/`, or packaging code | `npm run ci:distribution` and `npm run ci:scripts` |
| `packages/ui`, `packages/mcp-app`, or embedded browser code | `npm run ci:browser` |
| Workflow topology or `scripts/ci-lanes.json` | `npm run ci:scripts` |
| Host-class-dependent tests (case or normalization fixtures, the identity lock) | `npm run ci:aliasing-host` |
| `.github/workflows/release*.yml` | `npm run ci:scripts` (workflow invariant test), then one rehearsal against a disposable package before first live use |

A CI topology change must update `scripts/ci-lanes.json` and this table in the same unit; never
add path skipping without a separately reviewed fail-closed classifier. Automatic CI runs on Linux
plus the `aliasing-host` lane, which runs `npm run ci:aliasing-host` on macOS with
`SUPERBEE_TEST_EXPECT_ALIASING_HOST=1` (the Linux runtime jobs set `0`) so tests whose native
branch needs a case-aliasing filesystem execute and fail closed on a mismatched host. The lane's
scope is a constraint, not a list: `scripts/aliasing-host-coverage.test.mjs` fails when a
host-sensitive workspace test is not executed by the lane's script chain. The manually dispatched
`.github/workflows/windows-installed-package.yml` runs the Windows contract on Node 22 and then
installs and drives the exact packed npm artifact on Node 20. Run it against a release candidate or
when Windows behavior changes; a Linux-only green result cannot substitute for that explicit proof.

### Running checks

Before each commit, run `npm run build && npm run typecheck` from the repository root plus the
touched test target. For the exact lanes and their components, use the table above and
`scripts/ci-lanes.json` rather than reconstructing commands from prose.

Redirect potentially large output to a temporary log and read the command's own exit code. A pipe
to `tail` or `grep` reports the last process's status and can turn a failing check into a false
green. On success, inspect nothing further; on failure, inspect matching failures and a bounded
tail. Report the command, exact tested commit or tree state, and observed exit code.

`examples/sample-bundle` is the externally shaped interop fixture. Its unquoted timestamps,
relative links, and wrapped lists must round-trip without being reformatted into a Superbee-only
shape.

## Build and package

`npm run build` produces sibling package outputs and bundles the CLI at
`packages/cli/dist/superbee.mjs`; a package-scoped build can leave imported sibling outputs stale.
Use `./superbee` for in-repository CLI journeys. At minimum, exercise `init`, `doc write` and
`doc read`, `list`, `link add` and `link show`, and `status` against a scratch bundle when CLI
behavior changes.

`npm run verify:npm-package` proves the installed tarball, its allowlist, command identity,
zero-runtime-dependency boundary, and offline create/query journey. `npm run check:skill -w
superbee` proves that the generated npm Agent Skill bytes match their source. Release publication
has a separate action-time contract; passing either check does not authorize publishing.

## OKF compatibility

Superbee preserves the edition declared by an existing bundle. New bundles default to OKF v0.2;
use `init --okf-version 0.1` only when deliberately authoring a v0.1 bundle. If edition discovery is
missing on an older existing bundle, the compatibility fallback is v0.1. Never silently upgrade an
existing root during an ordinary document write.

<!-- contributing-okf-matrix:start -->
| Edition | New bundle | Existing writes | Meaningful-change clock | Offline authority |
| --- | --- | --- | --- | --- |
| 0.1 | `--okf-version 0.1` | retain 0.1 | top-level `timestamp` | this section plus core edition tests |
| 0.2 | default | retain 0.2 | `generated.at` when present, with legacy `timestamp` fallback for reads | this section plus core edition tests |
<!-- contributing-okf-matrix:end -->

Across both editions:

- `index.md` and `log.md` are reserved; only a directory's `index.md` may carry reserved-file
  frontmatter. Concept documents require a non-empty `type`, and unknown frontmatter keys survive
  round trips.
- Writes normalize only the selected edition's document shape. v0.1 retains or creates its legacy
  `timestamp`; raw v0.2 transport does not invent optional `generated`, legacy clocks, or legacy
  actor fields. Substantive product mutations advance the edition-appropriate clock.
- Generated internal links use relative bundle-relative Markdown hrefs. External URLs pass through;
  concept IDs remain canonical and bundle-relative.
- YAML timestamp scalars are normalized to ISO-8601 strings without converting unrelated nested or
  date-only values. Storage revision time and meaningful-change time are different clocks.

The external specification is supporting evidence, not the only discovery route. The committed
section and core edition tests are the offline fallback. The fixture at
`examples/sample-bundle/references/okf-spec.md` is explicitly a v0.1 interop reference; it is not a
cross-edition or current-product authority.

### Kind conventions

Kind conventions are bundle-authored, opt-in schemas consumed through the one core registry. A
convention document must have `type: Convention` and live under `conventions/`; a Convention
document outside that prefix is deliberately not discovered. This keeps a conventions-free bundle
behaviorally unchanged and makes an empty registry load a cheap prefix query.

Malformed convention documents are skipped with collected warnings rather than aborting the whole
load. When multiple documents declare the same `governs` value, the first document by ID wins. The
command layer builds the registry at most once per invocation and passes it to kind-aware commands;
engine reads and writes never load it implicitly. Validation reuses core's heading and freshness
primitives rather than defining parallel parsers or clocks. Convention seeding belongs to generic
CLI recipes, never to `initBundle` or another engine special case.

## Findings and commitments

A discovery must land in the shared row table for its defect class. The project bundle document
`docs/boundary-finding-routing` names those homes; when no row can represent a finding, repair the
table instead of adding a one-off test that will be rediscovered later.

A specification statement is not a work commitment. A `VIOLATED` statement describes a defect and
an `UNKNOWN` statement describes missing evidence; neither commits anyone to resolve or accept it.
Before a release proceeds, every release-relevant `VIOLATED` or `UNKNOWN` statement must link to
either:

- a Task that commits the work and carries its release disposition; or
- a recorded acceptance decision that identifies the exact statement/version, owner, rationale,
  residual risk, and release scope.

Use the selected bundle's `conventions/task` and `conventions/review` for record shape; do not copy
their field definitions here. Record acceptance as a `subject_kind: process` Review that targets the
exact statement version; its Verdict states the accepted release scope and residual risk. The
person tagging a release performs this one-hop check before pushing the tag.
Missing, stale, unavailable, or unqueryable evidence is not an approval.

Recurring defect classes are API-design feedback. Move the invariant into one owning primitive so
callers cannot recreate the mistake; add the new case to the shared agreement table.

## Assurance

Assurance tracks residual risk after standing checks:

- Trivial documentation, metadata, dependency, or test-only corrections with no consequential
  mechanism change need author validation and relevant automated checks.
- Behavior-preserving changes with a mechanical parity contract need Builder -> one independent
  provenance-centered review. The reviewer samples the contract and proves it red once; add QA only
  if the contract cannot cover reachable state or the review finds drift.
- Ordinary code changes need independent exact-SHA review and the repository gate. Add dedicated QA
  when the remaining risk or review findings warrant it.
- New or changed high-risk mechanics - security, concurrency, destructive writes, migrations,
  deployment, remote selection, or replay/recovery - require Builder -> independent review ->
  adversarial QA -> merge decision.

Review always precedes QA when both are required, and both precede merge. Reviewers may escalate or
recommend de-escalation, with the reasoning recorded; splitting or relabeling work does not lower
its actual tier.

The selected bundle's `conventions/review` is the sole schema authority for Review records. Follow
it for exact-target identity, evidence, findings, survived attacks, and verdicts rather than
repeating those fields here.

### Review process

- Review code in an isolated checkout at the exact commit. Review immutable document versions at
  their exact version.
- A risky mechanic and its adversarial test ship in the same reviewed unit.
- Reuse current exact-SHA CI evidence. Audit builder evidence, sample the load-bearing part, and run
  one meaningful red probe; reproduce the full gate only when provenance or drift is in doubt.
- Separate empirical findings from reasoned ones and report survived attacks so approval is
  calibrated. A documented command was executed only when the emitted characters were run without
  substitution.

## Assurance evolution

Review and QA stages change through evidence, never silent habit:

1. Select the five most recent completed units of the same change type and assurance stage within
   the previous 180 days. Fewer than three comparable Review records is insufficient evidence.
2. Query those Review records and persist the exact selection at
   `research/assurance-<change-type>-<stage>-<YYYY-MM-DD>`, with a report of verdicts, blocking and
   non-blocking findings, survived attacks, unresolved risks, and defects first found by the stage.
   Keep zero-finding records in the denominator.
3. Review that report as a `subject_kind: process` Review. Its Verdict records exactly one decision:
   keep, thin, expand, or retire the named stage for the named change type, with rationale, owner,
   effective date, and reversal trigger.
4. Link the process Review to the report and supersede the prior decision when one exists. Apply the
   change only after both records exist at exact immutable versions.

No records, an unavailable query, an unpublished report, a missing decision, mixed change types, or
an incomparable stage leaves the current assurance stage unchanged. "Verified" and "proven" remain
testable claims regardless of stage history.

## Generated artifacts

Generated bytes have one source. Change the source, run its generator, and commit both in the same
unit. Use the owning drift check (including `npm run check:skill -w superbee` for the npm Agent
Skill). After a merge or policy change, also inspect the generated prose semantically: byte parity
cannot detect a source sentence that became false.

Never hand-edit a generated target to make a drift check pass.

## Mutation testing

Mutation testing measures suite sensitivity on demand; it is not a merge gate. From a clean tree,
build at the repository root, then run `npm run mutation:core` or `npm run mutation:cli`. Stryker
runs in place; if interrupted, inspect `.stryker-tmp` before recovery. Use `npm run
mutation:survivors` to extract named surviving gaps from existing reports.

The scheduled and manually dispatched mutation workflow publishes survivor summaries. Route a
recurring survivor through the finding and commitment process above rather than chasing an
undocumented score.

## Project records

The project bundle owns Tasks, Plans, Research, Reviews, roadmap state, and durable context. Use the
Superbee CLI and the bundle's own Conventions when that bundle is available. Claim work with the
Task convention's compare-and-swap transition before building it; record the exact commit and
evidence when the unit closes. Move byte content between repository and bundle with product
`promote`/`pull` operations, not model retyping.

Bundle writes and code commits are separate delivery channels. Builders write phase-boundary
context notes but do not sync. The orchestrator reviews and syncs bundle changes; code goes through
branch, human-owned PR, CI, review, and merge.
