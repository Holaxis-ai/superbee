# Explicit recipe-set structural preflight

`@superbee/core/recipe-set-preflight` provides `preflightRecipeSet(input)` and
`recipePreflightDigest(value)`. It is an opt-in, browser-safe, asynchronous read-only
checker over caller-supplied JSON evidence. It does not fetch, install, evolve or
select recipes, resolve dependencies, read bundles, or grant permissions.

A `valid` result means only that the declared structural checks passed on the
supplied snapshots. It is not general compatibility, runtime usability, publisher
authentication, an atomic installation grant, safe declaration retirement, actual
record endpoint validation, or proof of deployment or adoption. External consumers
remain `unknown-out-of-scope` for every verdict.

## Input and identity

Use the exported `RecipePreflightInput` type, tagged `recipe-set-preflight/v1`.
`preflightRecipeSet` accepts `unknown` so runtime callers receive `INPUT_SHAPE`
refusals for malformed finite JSON, rather than trusting TypeScript assertions.
Unknown schema versions refuse. Unknown requirement operators or constraints make
the result partial; they are never silently treated as satisfied.

- `selected`: exact local keys, asserted publisher/recipe/release tuples, `base` or
  `extension` role, artifact pins and artifacts. An artifact contains an identity
  and files `{path, bytes, digest}`. `bytes` is UTF-8 text. A null or omitted artifact
  means unavailable evidence. Publisher names are assertions, not authentication.
- `consumers`: independent `{id, owner, descriptorDigest, requirements}` records.
  An owner refers to a selected key. Requirements name a selected provider, Kind,
  required/optional availability, and optionally declared field names or exact
  link labels and logical target provider/Kind. `requirements: null` means unknown.
  A selected extension requires a descriptor with nonempty requirements; absence
  or an empty list stays partial. Standalone bases do not require a descriptor.
- `endpoints`: one `{id, consumer, requirement, placement, alias?}` mapping for
  each checked requirement. Placement is `local` or `qualified`; qualified aliases
  obey Core's existing alias grammar. A local mapping must not carry an alias.
- `observations`: per-selected-provider `{id, provider, scope, availability,
  complete, observedVersion?, definitions}` evidence. Each definition is `{id,
  bytes}` with real Core-written ownership stamps. `scope` is `local` or an alias.
  Qualified observations also supply matching `bundleId` and `expectedBundleId`.
  Incomplete or unavailable evidence cannot establish absence.
- `placementInventories`: full collision evidence, separate from per-provider
  observations. See the exact shape below.

```ts
placementInventories?: Array<{
  id: string;
  scope: string;
  bundleId?: string;
  expectedBundleId?: string;
  availability: 'available' | 'unavailable' | 'unknown';
  complete: boolean;
  observedVersion?: string;
  files: Array<{ path: string; bytes: string }>;
}>;
```

Supply one consistent, available, complete inventory with an observed version for
each checked scope. Include all relevant local definition Markdown and selected
View entry HTML, including definitions not owned by selected recipes. Only
`conventions/` contains active Kind declarations; an ordinary record or Convention
outside that namespace does not become a model declaration.

Missing or incomplete placement evidence makes the result partial, even if every
provider observation says complete. Duplicate placement inventories, conflicting
owned observation bytes, conflicting IDs and duplicate active Kinds refuse. This
field refines the unpublished normalized design sketch: old sketch inputs without
it now receive `PLACEMENT_INVENTORY_UNKNOWN`, rather than a false valid verdict.
The result's `inputs.placementInventories` echoes inventory IDs and versions.
Completeness, versions and bundle identities are caller assertions, not authenticated
snapshots or access grants. Matching bytes are checked explicitly; the checker does
not union disagreeing snapshots or choose a newer one.

## Digest and parser contracts

`recipePreflightDigest` labels its scheme
`fixture-envelope-v1/utf16-code-unit-sorted-keys-and-file-paths/sha256`. It is separate
from Core recipe-source and definition digests, and from private Studio artifacts.
It hashes strings as raw UTF-8 with Core's SHA256 implementation. Objects use
recursively key-sorted JSON; arrays of path-bearing objects are sorted by path,
while other arrays retain order. Comparisons use UTF-16 code units, without locale
collation, Unicode normalization or case folding.

Pin each file's bytes. Pin an artifact over exactly `{identity, files}`, including
its file digests. Pin a descriptor over exactly `{id, owner, requirements}`. The
global input schema versions this descriptor grammar; there is no extra descriptor
tag, asserted byte length or file-role field. UTF-8 encoding belongs to Core's
hashing primitive; accepted file roles and materialized assets derive from Core's
recipe parser, not caller metadata. That parser currently imposes no byte-size
limit. Existing parser path, definition-only and asset declaration rules still
apply. This API introduces no new packaging format accepted by the installer.

The checker reuses Core's recipe parser, Kind registry, prepared-install identity,
definition digests and installed-stamp inspection. It checks all selected asset
collision paths: Conventions, References, Connectors, View registries and HTML.
Current same-owner stamped definitions are idempotent. Foreign/stale stamps and
local declaration/body divergence refuse; unknown/missing stamp rules stay partial.
Core definition-digest exclusions, including local order and managed clocks, remain
excluded. Noncolliding local Kinds are allowed without acquiring recipe ownership.

Parser warnings remain visible in `parserWarnings`. Malformed/duplicate active
models refuse. Other unclassified diagnostics make the result partial, including
reserved `requires`/`composes` declarations. Those keys retain their current parser
behavior and do not satisfy dependencies.

## Results and use

```ts
import {
  preflightRecipeSet,
  explainRecipePreflightIssue,
  type RecipePreflightInput,
} from '@superbee/core/recipe-set-preflight';

const result = await preflightRecipeSet(evidence as RecipePreflightInput);
for (const issue of result.issues) {
  const guidance = explainRecipePreflightIssue(issue.code);
  console.log(issue.at, guidance.message, guidance.action);
}
```

Results use `recipe-set-preflight-result/v1`, fixed
`scope: 'declared-structural-input-only'`, exact selected pins and observed versions.
Any refusal yields `refused`; otherwise any unknown yields `partial`; otherwise
`valid`. All diagnostics survive reduction, sorted by code-unit ordering of their
canonical `{level,code,at}` JSON. `structuralComplete` is exactly `verdict === 'valid'`.
No timestamps, random IDs, input mutation, storage or network operations occur.
Changed relevant evidence requires a fresh run.

`explainRecipePreflightIssue` supplies plain-language explanation and action for
an adapter. The diagnostic location names the artifact, placement or requirement.
Missing scope is evidence to collect, not permission to enable a required feature.
Optional unavailable providers stay partial; known contradictions still refuse.

Field checks establish declaration membership only, not required values, types,
vocabulary, workflow semantics or coercion. Link checks compare source labels and
logical targets after explicit placement mapping, not cardinality, actual record
Kinds or existence. Conflicting mappings for the same logical target refuse.
Topology-specific local/qualified recipe variants retain separate exact artifact
identities; this checker never relocates or rewrites definitions.

The synthetic fixture table in `packages/core/test/recipe-set-preflight-fixtures.mjs`
contains the local/two-bundle author example and shared expectation rows. The packed
Core external proof constructs its own complete base example using only supported
public exports, then runs it in Node and a browser bundle without Node globals.
Neither example requires private Studio source or credentials.
