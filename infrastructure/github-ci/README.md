# Superbee merge queue

This Terraform root owns one additive branch ruleset in `Holaxis-ai/superbee`.
It requires `CI required lanes` from GitHub Actions and enables an ALLGREEN,
squash merge queue with at most two builds and one PR per merge. Existing legacy
branch protection, immutable release tags, hosted settings, and all Windows
settings retain their current owners. No actor receives a bypass.

The default ruleset enforcement is **disabled**. Committed workflow capability
does not mean the live queue is enabled. Activation requires the reviewed CI and
CodeQL workflows on `main`, current successful main-push evidence, and a protected
remote state backend. Do not activate a queue while its required workflows exist
only on a feature branch.

## Local validation

Use Terraform 1.16.x with the committed provider lockfile:

```sh
terraform -chdir=infrastructure/github-ci fmt -check
terraform -chdir=infrastructure/github-ci init -backend=false -input=false
terraform -chdir=infrastructure/github-ci validate
terraform -chdir=infrastructure/github-ci test
node --test infrastructure/github-ci/preflight.test.mjs
```

The provider is mocked in tests. These checks do not contact GitHub or prove live
enforcement. The engine scripts lane runs both the JavaScript and Terraform tests.

## State and credentials

Select an existing approved private remote backend, copy `backend.hcl.example`
to an owner-only operator directory, and fill its nonsecret coordinates. Keep the
distinct key `superbee/github-ci/terraform.tfstate`; never reuse a different root's
key. Supply backend credentials through the provider's environment authentication
and `GITHUB_TOKEN` for Terraform's GitHub provider. Do not put secret values in
configuration, arguments, Git, logs, or Superbee. Use a separately scoped provider
identity with the repository administration access needed for rulesets.

Before the first apply, prove locking with competing clients and recovery from an
interrupted operation against the chosen backend using disposable test state.
An S3-compatible endpoint alone is not locking evidence. Keep protected state
backups and confirm a second authorized operator can recover them. If no suitable
backend or credential is available, stop before apply; local backendless validation
remains usable. No default account, bucket, or credential is inferred.

If a `Superbee merge queue` rule already exists, inspect its ownership and import
it into this root's state before planning; do not create a duplicate or import
someone else's managed resource. The pinned provider's import ID is
`superbee:<ruleset-id>`. Existing legacy protection and the release-tag ruleset
must not be imported into this root. Windows has no resource here.

## Activation after the human merge

1. Check out the exact reviewed engine implementation commit with a clean tree.
   The human must have merged its PR into `main`. Squash/rebase merges are supported:
   retain the reviewed feature SHA and let GitHub's merged-PR metadata bind it to
   the integration commit. Wait for the latest main-push
   `CI tests` and `CodeQL security` runs to finish successfully.
2. Run the read-only preflight from the repository root:

   ```sh
   node infrastructure/github-ci/preflight.mjs
   ```

   It checks either the reviewed commit's ancestry or a merged PR with that exact
   head, this repository's `main` base, and an integration commit still on main.
   It also checks source agreement for both workflows, shared gate, CodeQL scope,
   lane adapter/contract and Terraform configuration/preflight, the latest
   main-push run attempts and named jobs, the existing Actions-owned legacy checks,
   release-tag update/deletion restrictions with unchanged scope and no bypass, and the
   absence of a Windows queue. Missing access or incomplete observations fail
   closed. A successful preflight is evidence for review, not permission to apply.
3. With a reviewed backend file and private `TF_DATA_DIR`, initialize and save an
   activation plan in the private operator directory:

   ```sh
   terraform -chdir=infrastructure/github-ci init -input=false -backend-config=/secure/operator/backend.hcl
   terraform -chdir=infrastructure/github-ci plan -input=false -var=activate_merge_queue=true -out=/secure/operator/queue.tfplan
   terraform -chdir=infrastructure/github-ci show /secure/operator/queue.tfplan
   ```

4. Inspect that exact plan: only creation or enforcement of this one engine rule
   is allowed. Stop on destruction, replacement, changed protections, wrong
   repository, extra resources, or unknown ownership. Record the source SHA,
   backend identity, plan digest and sanitized actions. Rerun preflight immediately
   before apply; if source, state, or settings changed, refresh and review a new
   plan. Keep normal backend locking on.
5. Apply only the reviewed saved plan under the user's activation authorization:

   ```sh
   terraform -chdir=infrastructure/github-ci apply /secure/operator/queue.tfplan
   terraform -chdir=infrastructure/github-ci plan -input=false -var=activate_merge_queue=true
   ```

6. Verify GitHub reports the rule Active and a follow-up plan has no changes.
   Re-read engine legacy/tag protection and Windows settings. Observe an actual
   `merge_group` CI run when a human-approved PR enters the queue; all required
   checks must report on that queue SHA. Activation alone is not queue execution
   evidence, and workflow dispatch cannot substitute for a real queue event.

Enqueuing a PR may cause GitHub to merge it automatically once checks pass. The
human owns that merge decision; this runbook does not delegate enqueuing arbitrary
PRs. The shared CI change does not merge PRs, publish npm packages, or deploy apps.

## Recovery and updates

If the queue blocks unexpectedly, inspect required-check names, event coverage,
current run attempts and credential access first. Under the appropriate operator
authority, plan `activate_merge_queue=false` to disable only this additive rule;
existing branch protection remains in force. Do not delete resource blocks or
force-unlock another active operation. `prevent_destroy` is a tripwire, not a
substitute for reviewing destructive plans, especially after a block is removed.

The preflight deliberately pins the legacy check names and release-tag ruleset
identity observed during adoption. A separately reviewed protection migration must
update these assertions and their tests together. Readiness is time-bound; do not
reuse an old receipt after a code, state, or repository-setting change.
