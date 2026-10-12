# Superbee merge-queue readiness

Terraform configuration, mocked-provider tests, state-backend setup instructions,
and the activation runbook live in the private
[holaxis-infrastructure repository](https://github.com/Holaxis-ai/holaxis-infrastructure/tree/main/github/superbee).

This directory owns the read-only engine readiness check. From a clean checkout
of the exact reviewed Superbee implementation commit, after its human merge:

```sh
node infrastructure/github-ci/preflight.mjs
```

The preflight compares main source bytes with the owning files' immutable Git
blobs at the reviewed checkout SHA. It separately verifies checkout bytes, regular
file and parent-directory types, executable modes, and visible index entries;
`assume-unchanged` and `skip-worktree` entries refuse readiness even when Git status
is clean. The receipt identifies each reviewed blob. The exact reviewed SHA and
checkout root recorded in the private activation runbook remain authoritative.
It also verifies successful current
main-push CI and CodeQL evidence (every runtime shard, maintained proof lane,
both security analyses, and their stable aggregate statuses), existing protection
invariants, and the absence
of a Windows queue.

The legacy smoke requirement uses the maintained engines-floor lane's display
name from `scripts/ci-lanes.json`, with GitHub Actions ownership preserved.
Engine queues are inventoried by `merge_queue` rule type and main-branch scope,
independent of display name. Multiple relevant queues, including disabled or
evaluate candidates, require reconciliation. Literal branch refs and GitHub's
all/default-branch selectors are supported; other patterns or incomplete queue
identity/scope refuse readiness until reconciled. An inventory with no queue is
valid for initial setup; this check does not require or authorize activation.

Its tests run in the engine scripts lane:

```sh
node --test infrastructure/github-ci/preflight.test.mjs
```

The private runbook separately binds Terraform source and the saved activation
plan to the reviewed infrastructure commit. A passing preflight is time-bound
readiness evidence, not permission to apply. Queue activation still requires a
selected and verified private state backend and the user's activation authority.
