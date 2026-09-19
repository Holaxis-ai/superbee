# Superbee merge-queue readiness

Terraform configuration, mocked-provider tests, state-backend setup instructions,
and the activation runbook live in the private
[holaxis-infrastructure repository](https://github.com/Holaxis-ai/holaxis-infrastructure/tree/main/github/superbee).

This directory owns the read-only engine readiness check. From a clean checkout
of the exact reviewed Superbee implementation commit, after its human merge:

```sh
node infrastructure/github-ci/preflight.mjs
```

The preflight verifies the reviewed engine source against main, successful current
main-push CI and CodeQL evidence, existing protection invariants, and the absence
of a Windows queue. Its tests run in the engine scripts lane:

```sh
node --test infrastructure/github-ci/preflight.test.mjs
```

The private runbook separately binds Terraform source and the saved activation
plan to the reviewed infrastructure commit. A passing preflight is time-bound
readiness evidence, not permission to apply. Queue activation still requires a
selected and verified private state backend and the user's activation authority.
