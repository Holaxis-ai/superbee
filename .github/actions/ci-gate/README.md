# Required CI gate

A dependency-free composite action that evaluates the caller's complete job results against an
explicit policy. Set up Node 22 or newer before calling it. External repositories pin
`Holaxis-ai/superbee/.github/actions/ci-gate` to a reviewed full commit SHA; this repository uses
`./.github/actions/ci-gate` after checkout to test the candidate's own implementation.

```yaml
required:
  name: CI required lanes
  needs: [scope, check, browser]
  if: ${{ always() }}
  runs-on: ubuntu-latest
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: 22
    # Replace REVIEWED_FULL_COMMIT_SHA with the reviewed 40-character source SHA.
    - uses: Holaxis-ai/superbee/.github/actions/ci-gate@REVIEWED_FULL_COMMIT_SHA
      with:
        needs-json: ${{ toJSON(needs) }}
        policy-json: >-
          [{"job":"scope","required":true},
           {"job":"check","required":true},
           {"job":"browser","required":"${{ needs.scope.outputs.browser }}"}]
```

`needs-json` must be a non-array object with exactly the jobs named in `policy-json`. The policy
must be a nonempty array of unique `{job, required}` rows with no additional keys. Job IDs use
GitHub's identifier shape (letter or underscore, followed by letters, digits, underscores or
hyphens). `required` accepts JSON booleans or the exact strings `"true"` and `"false"`.
A required job must succeed. An explicitly unselected job may succeed or skip. Failure,
cancellation, absent/malformed results, unknown states and malformed selections always fail.
Extra result-object fields such as GitHub's `outputs` are allowed and ignored.

The caller owns its job set and selection provenance. Its wiring tests must independently pin
all dependencies and policy rows, require the scope/check jobs unconditionally, and bind each
conditional row to the correct successful scope job output. Never derive a policy from the actual
result keys or default a missing scope output to false. The action cannot infer where a boolean
came from. Required job and action steps must not use `continue-on-error`; the aggregate job uses
`always()` so a failed dependency cannot hide its verdict.

The action performs no checkout, install, network calls or credential operations. It accepts no
commands or hooks. Input JSON passes through environment variables and is never interpolated into
shell source. The runner invokes the evaluator bundled at `github.action_path`, independent of
the caller checkout and working directory. A successful gate proves this policy was met; repository
settings own merge enforcement and are separate from workflow capability.

Run the behavior and bundled-action tests with `node --test .github/actions/ci-gate/evaluate.test.mjs`.
