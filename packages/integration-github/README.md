# @superbee/integration-github

Independently versioned GitHub repository issue adapter for Superbee, with the generic
`source-feeds` foundation and `work-items` recipes. The recipes are generated from the repository's
canonical `examples/recipes` inputs; the generic Work Item convention also supports other trackers.

```js
import {restJsonProfile, nextLinkTarget} from '@superbee/core/source-profiles';
import {unsupportedContent} from '@superbee/core/source-engine';
import {createSourceProfile} from '@superbee/integration-github/profile';
const profile = createSourceProfile(Object.freeze({restJsonProfile, nextLinkTarget, unsupportedContent}));
```

The root and `./profile` exports expose the same standalone factory, normalization and coverage
utilities. `normalizeGithubIssue(issue, parameters, helpers)` accepts the host's
`unsupportedContent` helper. `./recipes` exports `recipeFiles(id)`, which returns detached
`RecipeFile[]` for `source-feeds` or `work-items`; parse and install both through Core's public
recipe APIs. The manifest also lists inert on-disk recipe directories for CLI installation.
Install `source-feeds` before `work-items`. Installing recipes does not register executable code,
bind a feed, grant a credential or contact GitHub.

The `superbeeIntegration` contract-1 metadata identifies the single `dist/profile.mjs` module
and exact compatible Core version. It has no runtime imports, executable sidecars, install hook
or required runtime dependencies. Core is an optional exact peer for public types and a build
dependency; programmatic callers explicitly install that version of Core. See [PROFILE.md](PROFILE.md)
for normalization, paging and completeness behavior.

For the single Superbee CLI, install an exact released package using npm's ordinary installation
controls, then run `superbee source plugin register <installed-package-directory>` and accept its
concrete proposal digest. `superbee source plugin list` reports active metadata and recipe paths.
Install those recipe directories with `superbee recipe add`, then explicitly bind and run the feed.
A plugin upgrade requires registration and feed rebinding; rebinding to a changed implementation
resets prior observation and accepted overlay state, so the next run reacquires it.

Registration is an explicit trust decision about the selected local bytes. A package name and
local digest do not authenticate npm or Holaxis origin. Approved code runs in the CLI process
with ambient process access; the injected helpers and guarded transport are not a sandbox.
Registration snapshots and pins selected bytes; a later npm update does not update that snapshot.
Untrusted community extensions require the separate isolation boundary.

Package identity: `@superbee/integration-github`, source `Holaxis-ai/superbee`, directory
`packages/integration-github`; proposed independent release identity `integration-github/v<version>`.
Direct publication is blocked by a `prepublishOnly` tripwire. Public package creation, trusted
publisher setup and a retained-artifact release workflow remain human-gated release preparation.
This package does not configure publication or promise registry availability.

`fixtures/author/fixture.json` is an honest recorded subset for `source test`. Its six scenarios
cover auth/server/rate-limit failures, incomplete paging, resume and a hostile cursor. The report
still lists eight missing required scenarios: malformed content, disappearance, owned conflicts,
unmapped/null fields, missing identity, redirects and undeclared hosts. The strict provider
normalizer rejects malformed identity before generic mapping, so this subset is not full author
qualification. Separate focused tests exercise normalization, overlay ownership and foreign paging.
