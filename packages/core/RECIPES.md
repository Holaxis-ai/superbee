# Recipe validation without the CLI

`@superbee/core/recipes` parses caller-supplied recipe files. It uses the same implementation
as the CLI's built-in and filesystem recipe sources. It performs no file discovery, network
access, installation, View execution, or bundle mutation. To install or evolve a parsed recipe on a
bundle, use `@superbee/core/recipe-lifecycle` (see "Recipe lifecycle" in the README).

```ts
import { parseRecipeFiles, type RecipeFile } from "@superbee/core/recipes";
import { buildKindRegistry, validateAgainstKind } from "@superbee/core/kinds";
import { MalformedDocumentError, type OkfDocument } from "@superbee/core/document-codec";

function checkExample(files: RecipeFile[], example: OkfDocument) {
  const result = parseRecipeFiles(files, "editor:draft");
  if (!result.ok) return { error: result.error };

  const registry = buildKindRegistry(result.recipe.docs);
  const kind = registry.kinds.get(String(example.frontmatter.type));
  return {
    recipeWarnings: result.recipe.warnings,
    registryWarnings: registry.warnings,
    kindFound: Boolean(kind),
    recordWarnings: kind ? validateAgainstKind(example, kind) : [],
  };
}

// Malformed frontmatter throws the shared codec error; structural recipe errors
// instead return { ok: false, error: { code, message } }.
try {
  checkExample([], { id: "terms/example", frontmatter: { type: "Term" }, body: "" });
} catch (error) {
  if (!(error instanceof MalformedDocumentError)) throw error;
  // Present the malformed-frontmatter diagnostic to the author.
}
```

Each `RecipeFile` contains a recipe-relative POSIX `path` and a UTF-8 text `bytes` string.
The `source` argument is an opaque caller-provided provenance label. The parser never resolves it.
A recipe needs `recipe.md` and at least one valid Convention under `conventions/`. Definitions-only
recipes reject undeclared files and malformed definitions; legacy recipes retain their existing
skip-with-warning behavior. Declared View and Reference assets are returned as data. A
definitions-only recipe may also list `type: Connector` declarations in its manifest's
`connectors:` (paths under `connectors/`); each is parsed by `parseConnectorDoc` and returned in
`connectors`, which is absent when the manifest declares none. A malformed one is
`RECIPE_CONNECTOR_INVALID`, whose `connector` names the first refusal and counts them all, and a
convention governing `Connector` is `RECIPE_MALFORMED`.

The result retains the existing `LoadedRecipe`, `RecipeError` and `LoadResult` shapes. Parsing
preserves input order, warnings and messages. `RECIPE_NOT_FOUND` remains in the shared error
vocabulary for acquisition adapters; the parser itself reports a missing manifest as
`RECIPE_MALFORMED`.

## Consumer responsibilities

- Acquire files and enforce any resource limits appropriate to the source. This API accepts typed
  file records, not an arbitrary untrusted JSON request or an archive.
- Inspect recipe and registry warnings. A missing Kind is distinct from a record passing its
  declared checks. Consumers choose whether warnings block their workflow.
- Kind validation checks declared fields, enum values, declared value types (`fields.types`, one
  of eleven core types; `null` on a typed field fails), and sections. It does not prove linked targets exist,
  relationship cardinalities, authorization, or compatibility with an installed bundle.
- Keep example records separate from distributable definitions-only recipes.
- Use `@superbee/core/recipe-lifecycle` for installation and evolution, or the CLI adapter.
  Built-in content and Kind authoring are opt-in subpaths documented in the core README. Parsing
  does not grant permission to install or execute a View.

The package proof installs core alone, typechecks the public subpaths, runs parsing and record
checks in Node, and executes a browser-target bundle without Node globals. This is not a live
browser or Worker integration guarantee. No CLI runtime dependency or new package is required.

## Deprecating declarations

A convention can keep a declaration readable while preventing new admitted usage:

```yaml
deprecated:
  fields: [legacy_category]
  values:
    category: [old]
  links: [legacy_relation]
```

Names must remain declared. Whole fields must be optional domain fields, excluding standard,
reserved and claim coordinates. Deprecated values must be declared vocabulary members; required
fields retain an active member, and terminal/claim values require a separate migration. A link
label still required by an inbound expectation in the admitted registry cannot be deprecated.
Malformed or ineligible recognized policy keeps the Kind visible but refuses admitted authoring.

`kindDeprecationTransition(existing, candidate, registry)` and
`inspectKindDeprecatedUsage(document, kind)` are pure exports from `@superbee/core/kinds`.
The first returns authoring refusals; the second reports informational stored occurrences, including
unknown malformed qualified references. Ordinary `validateAgainstKind` keeps its read-conformance
meaning. `mutateDocument` applies the transition policy for its explicitly supplied registry on
create, replacement, patch and each fresh retry, even when `strict:false`.

An unchanged deprecated field or scalar value can survive unrelated edits or be removed; a whole
deprecated field cannot change its value. A deprecated list member or body edge cannot gain an
occurrence. Edge identity distinguishes local targets from qualified alias plus target ID; changing
an alias cannot inherit an existing allowance. A byte-identical malformed qualified reference can
survive an unrelated edit, but new/changed deprecated-label usage refuses. Copying, recreating or
retyping a document does not inherit another Kind's legacy allowance. Existing typed-list, body
replacement, standard-field and other Kind guards still apply.

CLI `kinds` exposes metadata; `status` reports `deprecated_usage` separately from conformance debt.
Recipe evolution can add lifecycle metadata only with an unchanged readable same-recipe ownership
baseline. It preserves instances and blocks silent policy removal/reactivation. Ordinary additive evolution does not remove declarations: per-definition CAS and a postcondition
are not atomic instance-scan closure or evidence of ecosystem-wide non-use. Explicit guarded
retirement is a separate one-definition-stage operation, described below.

Admission is bounded to the supplied registry. Raw storage/wire imports and intentionally empty
registry recipe install/evolve asset writes keep their existing import-like behavior. Recipe assets
can themselves be governed OKF documents, so successful asset import is not a deprecation-policy
admission certificate. An empty/stale registry does not prove current bundle policy enforcement.
No automatic record migration, foreign lookup or permission change occurs.

## Inspecting declaration retirement

`planRecipeDeclarationRetirement(bundle, source, { consumerEvidence? })` from
`@superbee/core/recipe-lifecycle` inspects omissions of previously deprecated optional fields,
vocabulary members and outbound labels. The installed definition must retain its readable,
unchanged same-recipe stamp. Other omissions and schema migrations remain refused. The scanner
reuses Kind usage semantics: own-key null/empty fields count, list occurrences count, qualified
edges retain their alias identity, and malformed references remain unknown.

CLI `recipe evolve <source> --retirement-scan` performs this read-only inspection. Optional
`--retirement-evidence <json>` supplies an actual recipe-set preflight input; it is not fetched
implicitly and cannot be combined with `--apply`. Evidence must describe this exact source,
proposed definitions and full observed local concept inventory. A valid unrelated preflight or
stale observation cannot certify this retirement. Evidence describes the final selected-source
hypothesis, not an intermediate multi-definition apply stage.

The report separates local usage, supplied known-consumer structural assessment and unknown
external consumers. It includes exact observed backend versions and repeat-read completeness
checks, which are not an atomic snapshot or an authenticated storage capability. Unreadable,
changing or ambiguous inventory remains unknown. Without supplied descriptors, external use is
unassessed; enum/type/write-intent compatibility and arbitrary code remain outside preflight.
`can_apply` is always false: lifecycle retirement apply is not implemented by this inspection API.
Its observation digest is evidence identity, never an apply token. No records or definitions change.

## Applying one retirement stage

`recipe evolve <source> --remove-deprecated --retirement-scope cooperating-local-writers-v1`
plans a single definition stage. Optional `--retirement-definition <id>` selects the stage;
otherwise the planner selects the first eligible definition in storage-key order. Only a ready
stage emits an exact apply command. Repeat that command with its `--apply <token>` to commit that
one definition, then inspect a fresh plan for any remaining definitions. An old token never
advances another stage. No ordinary records, source files or unrelated recipe assets are migrated.

The CLI admits only a known plain local filesystem route. It uses the existing home, binding,
marker, Git and root-index owners with strict evidence: malformed/unreadable evidence refuses.
Known ancestor/descendant edition-declaring roots, independently targeted project bindings,
hosted authorities/copies and Git-board routes refuse. Descendant symlinks, custom filesystem
hosts/wrappers, unknown Git classification and bounded-walk exhaustion also refuse. The walk
covers at most 128 ancestors and 4096 descendant directories with depth at most 32; a normal
navigation index without an edition does not establish a separate root. Nested Git routes whose
existing committed selector cannot distinguish failed probes from absence remain unsupported.
These checks run during planning and again before apply.

The guard covers participating writers in this exact physical-root/domain only. Raw editors,
old binaries, other hosts and unregistered overlapping roots remain outside it; nondetection
never proves exclusive root ownership or prevents a new external authority appearing later.
Core independently replans and binds actual source, target, inventory and candidate before one
shared guarded mutation. Conflicts require fresh inspection, without ordinary-CAS fallback.

Omitted consumer evidence explicitly selects consumer-unassessed local-only retirement; external,
offline and arbitrary-code use stays unknown. Supplied failing/partial evidence cannot be dropped
implicitly. A final-source structural preflight cannot certify a different mixed intermediate
stage. Successful stage receipts retain actual completed versions and pending IDs; ambiguous
outcomes remain outcome-unknown and require a fresh scan, never blind replay or rollback.
