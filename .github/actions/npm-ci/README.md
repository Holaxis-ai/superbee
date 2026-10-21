# Authenticated npm installation

A dependency-free action for installing a locked npm graph with private registry reads on Linux
or macOS runners. Set up Node 22 or newer first. Pin this action to a reviewed full commit SHA. It runs an optional
dependency-free npm preflight script, then `npm ci`, and removes its temporary user configuration
on success or failure. It never changes the repository's npm configuration or exports credentials
to later workflow steps. Build and test commands remain owned by the caller.

```yaml
- uses: Holaxis-ai/superbee/.github/actions/npm-ci@REVIEWED_FULL_COMMIT_SHA
  with:
    npm-token: ${{ secrets.NPM_READ_TOKEN }}
    # Optional: a dependency-free package.json script which checks package metadata.
    preflight-script: ci:dependencies
```

The default `working-directory: '.'` installs from the workspace root. If checkout uses a
subdirectory, select that same path; the runner applies it to both preflight and installation:

```yaml
- uses: actions/checkout@REVIEWED_CHECKOUT_SHA
  with:
    path: code
- uses: Holaxis-ai/superbee/.github/actions/npm-ci@REVIEWED_FULL_COMMIT_SHA
  with:
    npm-token: ${{ secrets.NPM_READ_TOKEN }}
    working-directory: code
```

The directory must already exist. The runner refuses a missing directory or a file path before
starting the install step. Paths are passed as native step configuration, never interpolated into
a shell command. Node setup and cache paths remain the caller's responsibility.

For a second private scope on GitHub Packages, add `github-scope: '@example-org'` and
`github-token: ${{ github.token }}`. The caller must declare `packages: read`, and each package
must grant that repository access. GitHub's token does not grant access to private npmjs packages. Bearer values remain opaque: the
action accepts JWT-format GitHub installation tokens without assuming a fixed token length.
Existing project `.npmrc` files still participate in npm's normal precedence; legacy references to
`NPM_READ_TOKEN` and `NODE_AUTH_TOKEN` receive the npm reader and GitHub reader respectively when
the second registry is enabled. With npmjs only, both receive the npm reader.

Install lifecycle scripts default to disabled. Set `ignore-scripts: 'false'` explicitly for a
consumer that needs its existing install lifecycle. The preflight runs only its named npm script,
without automatic pre/post hooks, and a failure prevents installation. Both phases receive registry
read access. Subsequent build/test steps do not receive credentials from this action.

The organization owns the read-only package token and grants the secret to selected repositories.
The action does not mint, discover, share, or widen credentials. The token's actual package access
and read-only permissions must be configured at its provider. Keep secret values out of command
arguments and source. Npm output is redacted against the supplied token values; GitHub also masks
them. Temporary configuration contains environment references rather than token values and is
removed in `finally`; cancellation may leave a placeholder-only file in the disposable runner.

Run the real npm fixture checks with `node --test .github/actions/npm-ci/install.test.mjs`.
