# Superbee agent entrypoint

Superbee is an OKF-native, CLI-first, local-first knowledge environment. This file is the
mandatory project entrypoint; it routes agents to the smallest authority needed for the work.

## 1. Authority and orientation

Use these sources for different kinds of truth:

- Bundle `docs/core` owns product purpose and frozen or coupled scope.
- Bundle `docs/vision` owns durable architecture intent and component boundaries.
- Bundle `docs/north-star` owns long-term remote and versioning direction.
- Bundle `roadmaps/superbee-platform`, Tasks, Plans, and Reviews own current state and evidence.
- Repository source, manifests, tests, and CI own current executable behavior.
- [CONTRIBUTING.md](CONTRIBUTING.md) owns repository workflow policy.

When intent and implementation disagree, do not silently choose one. Treat the disagreement as a
defect, record it, and reconcile the two authorities.

### Select the project bundle safely

An orchestrating or solo session may establish freshness only after confirming that Superbee has
selected this project's existing bundle. The expected bundle document IDs above must resolve.
A catalog entry is available for explicit selection; it is not ambient project context.

A dispatched agent receives the exact bundle root and actor in its packet. It may perform the
packet's necessary reads, but it must never:

- run `superbee sync`;
- initialize or publish a bundle;
- guess a bundle from a catalog entry; or
- pass the repository root to `--dir` as though it were a bundle.

If selection is missing or cannot be verified, do not initialize a replacement. Continue only
with committed repository authorities and stop any work that depends on current project state.
If a previously verified bundle is merely stale because sync or the network is unavailable, label
the information as last-known and stop only where freshness is required. Missing authority and
stale authority are different states.

For Superbee command syntax and recovery, use the installed Superbee Skill when present and the
current `superbee <command> --help` or `superbee setup` output as the cross-host fallback. Never
copy a command manual into this file.

### Begin from purpose

Before substantive work:

1. Read `docs/core` or the workspace's highest-level goal.
2. State and record one proximate goal and how it serves that ultimate goal.
3. Inspect relevant current tasks and context notes before creating new work.
4. Claim implementation work with one guarded write: `doc update <task> --progress_status
   in_progress --assignee <actor> --actor <actor> --expected-version <head_version>`. The
   compare-and-swap is the claim; without `--expected-version` there is no compare-and-swap.
   Exit 5 means someone else owns it — pick other work; do not re-read and retry. A claim is
   provisional until `sync` confirms it.

Bundle records and code commits are separate. The orchestrator owns synchronization of bundle
writes. A bundle document belongs in a code commit only when that document is the reviewed
deliverable itself.

## 2. Roles, verbs, and evidence

Your role is defined by the verbs you own, not by what a packet happens to request.

| Role | Owns | Must not do |
| --- | --- | --- |
| Builder | One coherent change, scoped smoke, commit, SHA report | Push, PR, CI dispatch, sync, publish, release assets |
| Reviewer or QA | Exact-SHA evaluation and named probes | Modify the reviewed SHA, push, sync, publish, release assets |
| Researcher | Read-only evidence and a durable finding | Repository or external mutations not explicitly authorized |
| Orchestrator or solo agent | Claim, integrate, bundle sync, one branch push, CI dispatch | Open the PR, merge, or expand human-gated scope without permission |
| CI | Authoritative shipping verdict on the pushed SHA | Substitute a result from another SHA |
| Human | PR and merge gate; product, disclosure, and release decisions | None delegated by implication |

A dispatched builder produces one claim's worth of change, runs:

```sh
npm run build
npm run typecheck
npm test -w <touched-package>
```

It commits and reports the SHA plus the exit codes it observed. This is a pre-commit smoke, not the
shipping gate. Reviews and research run only the evidence their packet names; they do not perform a
ritual full gate.

The orchestrator verifies commit scope and provenance, integrates builders, pushes the feature
branch once, and ensures CI is running on that exact SHA. If no PR exists, dispatch the `CI tests`
workflow for the branch. Do not rerun valid builder evidence merely to duplicate it. If evidence is
missing, stale, or from a changed tree, rerun the smallest relevant smoke.

CI on the pushed SHA is the shipping verdict. A local lane or `npm run check` is never reported as
that verdict. The human opens and merges the PR unless that authority is explicitly delegated.

Detailed branch, commit, lane, generated-artifact, mutation-testing, integration, and review policy
lives in [CONTRIBUTING.md](CONTRIBUTING.md).

### Review ordering

Review is a dependency, not a label applied after testing:

- Trivial documentation or test-only work follows the proportional tier in `CONTRIBUTING.md`.
- Routine code receives independent review of the exact SHA.
- Security, concurrency, destructive writes, migrations, deployments, remote selection,
  reconnect/replay, releases, and other high-risk mechanics require Builder -> independent
  exact-SHA Review -> adversarial QA.
- QA cannot be scheduled before its required Review, and neither precedes the builder commit.
- Reviewers audit existing evidence, reproduce only load-bearing proof, and add one meaningful red
  probe for the named risk. Current exact-SHA CI evidence is reused.

Every PR remains one coherent behavioral or policy claim. Review or QA fixes made after a PR opens
are appended as clearly labeled commits; do not amend or force-push review history except for a
base rebase, which must be reported with old and new SHAs.

## 3. Engineering contracts

The repository's detailed contribution contracts are intentionally one hop away:

- [Contributor workflow](CONTRIBUTING.md)
- [OKF compatibility](CONTRIBUTING.md#okf-compatibility)
- [Findings and commitments](CONTRIBUTING.md#findings-and-commitments)
- [Assurance evolution](CONTRIBUTING.md#assurance-evolution)
- [CLI AXI contract](packages/cli/AXI-CONTRACT.md)
- [Wire protocol](docs/WIRE-PROTOCOL.md)

Do not recreate package or shipped-feature inventories here. Read workspace manifests, package
source, import-boundary tests, and bundle records for current facts.

Apply these cross-cutting rules:

- One parser, resolver, registry, mutation policy, or action authority owns each semantic concern;
  adapters do not fork it.
- Storage stays behind the core backend seam; backends persist and retrieve while the engine owns
  OKF semantics.
- Public behavior with multiple surfaces uses one owning primitive or a per-row agreement table.
- A risky mechanic and its deterministic adversarial test ship in the same reviewed unit.
- Recurring bug classes move into an owning primitive or shared row table, not one-off reminders.
- Terms such as `canonical`, `parity`, `gate`, `verified`, and `proven` require executable or
  traceable evidence.
- Build from the repository root. Fresh worktrees install their own dependencies before test
  results are trusted.
- Verify a command by its own exit code. Do not infer success from a piped `tail` or `grep`.
- Keep full verification output in temporary logs; inspect bounded failures and summaries.

`examples/sample-bundle` is the external OKF interop fixture. Existing bundles retain their
declared OKF edition; genuinely new bundles default to v0.2 unless v0.1 is explicitly requested.
The complete edition and reserved-file rules live at the OKF compatibility link above.

Source comments explain stable, non-obvious reasons. Review history, adjudication narrative,
timings, and shipped-pass narration belong in the project bundle or PR, not beside the code.

## 4. Security, releases, and human gates

### Security

Never place secrets, exploit mechanisms, reachability conditions, or working reproductions in a
public channel or any synchronized bundle by default, regardless of its observed visibility.
An externally exploitable defect present on `main` goes through a private GitHub Security Advisory:
fix privately, merge, then disclose. Stop before writing sensitive detail and follow
[SECURITY.md](SECURITY.md).

Bundle privacy is not advisory isolation. A bundle may carry sanitized coordination metadata such
as severity, evidence class, ownership, status, acceptance gates, and an opaque advisory link.
Exploit mechanics, reproductions, affected-code detail, and private patch coordination remain
advisory-only. Parent-visible handoffs report only that a private finding exists plus its severity,
evidence class, and advisory receipt; detailed evidence moves directly into the advisory.

Pre-merge non-sensitive review findings may use the normal review route. Unknown, changed, or
mismatched visibility never weakens the conservative rule.

### Releases

Releases use GitHub and npm's native controls; the repository adds no release state, ledger,
receipt, or approval transport of its own. The mechanism is `.github/workflows/release.yml`
(build once, stage the exact tarball on npm through OIDC trusted publishing) and
`.github/workflows/release-finalize.yml` (after the human's `npm stage approve`, verify the
registry against the build attestation and create the GitHub release, immutable once the
repository setting is on). Read those two files; do not reconstruct a
procedure from memory. The package's `prepublishOnly` refusal is an ergonomics tripwire, not a
boundary; npm's require-2FA/disallow-tokens setting is the boundary.

Agents may prepare a version-bump PR and, when explicitly asked, push the `v<version>` tag that
starts a release. Agents never run `npm publish`, `npm stage approve`, `npm dist-tag`, or any
other authenticated npm mutation unless specifically authorized by Mike, Brian, or another human
user with release authority; the human's interactive 2FA approval of the staged bytes is the one
release gate. Prereleases stage on `next`, stable versions on `latest`, chosen at stage time.

Record each release as one `Release` document in the project bundle (`releases/superbee-<version>`)
with pointers to the workflow run, stage id, tarball digest, GitHub release, current `status`, and
`next_action`. The bundle is memory, never release authority; the registry and the GitHub release
are the facts.

### Frozen scope

The frozen and coupled decisions in bundle `docs/core` require an explicit human decision to
reopen. Code adjacency is not authorization. In particular, do not introduce hosted deployment,
authentication, administration/collaboration UI, or multi-bundle authorization piecemeal.

## 5. Delivery and records

Branch from current `origin/main` on a descriptively named feature branch. Do not push to `main`.
Do not add AI attribution or `Co-Authored-By` lines to commits.

Agents do not open pull requests. After pushing the feature branch, provide a plain-ASCII,
paste-ready PR title and description. The human owns the PR and merge gate.

When a unit closes:

1. Update its bundle Task with the delivered SHA, evidence, and honest caveats.
2. Update the platform roadmap only when the shipped order or commitment changed.
3. Record review and QA against the exact artifact they evaluated.
4. Synchronize the bundle through the orchestrating session, never a dispatched agent.

The project bundle is the current-state record. Do not grow a changelog, roadmap, package tour,
historical failure narrative, or copied task list in this entrypoint.
