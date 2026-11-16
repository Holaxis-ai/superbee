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

## Recipe sources and published indexes

`@superbee/core/recipe-sources` owns the source contract every host composes. A `RecipeSource`
has a `kind` (`builtin`, `files` or `index`) and `resolve(ref)`, which returns `null` when the
source does not address the reference. `resolveRecipe(ref, sources)` asks each source in order and
returns the first answer, or `RECIPE_NOT_FOUND`. `builtinRecipeSource()` lives in
`@superbee/core/builtin-recipes`; sources that need a filesystem or a network stay in their host.

A published index is one JSON document, `recipe-index/v1`:

```json
{
  "format": "recipe-index/v1",
  "source": "example",
  "title": "Example recipes",
  "recipes": [
    { "id": "context-notes", "version": "1", "designation": "supported", "maintainer": "Holaxis-ai",
      "source_digest": "sha256:<64 hex>", "files_digest": "sha256:<64 hex>", "root": "recipes/context-notes",
      "files": ["recipe.md", "conventions/context-note.md"] }
  ],
  "cookbooks": [
    { "id": "starter", "title": "Starter", "summary": "Notes for agents.", "designation": "supported",
      "maintainer": "Holaxis-ai", "recipes": ["context-notes"] }
  ]
}
```

A cookbook is a named, ordered group of recipes the index lists. `root` is relative to the index
location and optional. `files` are relative to `root`, and a
reader fetches exactly those files. `parseRecipeIndex` refuses unknown keys (except `discovery`, below)
and formats, absolute
paths, `..`, backslashes, dot entries, duplicates (file paths compare case-insensitively), and
cookbooks that name a recipe the index does not list or, for a `supported` cookbook, a `community`
recipe. Its codes are `RECIPE_INDEX_MALFORMED`,
`RECIPE_INDEX_FORMAT_UNSUPPORTED`, `RECIPE_INDEX_PATH_INVALID`, `RECIPE_INDEX_DUPLICATE` and
`RECIPE_INDEX_COOKBOOK_INVALID`.

Every recipe and cookbook carries a required `designation`, `supported` (maintained by Holaxis) or
`community`, and a required nonempty `maintainer`, for example a GitHub org or handle. Any other
designation is refused. A `supported` cookbook may hold only `supported` recipes; a `community`
cookbook may hold either. The designation is set by whoever controls the published index; for
superbee-plugins, that is Holaxis maintainers through review. Core does not verify it, it is not a
security property, and it promises no service level. It exists for discovery. The digests below are
the only integrity guarantee, and verified results carry the designation and maintainer only so a
host can display them.

Each recipe carries two pins. `files_digest` is `recipeFilesDigest` of the exact listed files as
raw bytes. Each file becomes a row `{"digest": "sha256:<hex of its bytes>", "path": <recipe-relative
path>}`, the row shape the CLI reports for source plugin files. The rows are sorted by path in
code-unit order, and `files_digest` is `sha256:` and the hex SHA-256 of the UTF-8 JSON array of rows,
keys in that order. Every file is hashed to a fixed length and JSON quoting delimits every path, so
concatenation cannot collide, and listing order does not matter. `source_digest` is
`recipeSourceDigest` of the parsed recipe, the value install stamps record.

`resolveIndexRecipe(index, id, read)` and `createIndexRecipeSource(index, read)` take a
host-supplied async reader that returns raw bytes (`Uint8Array`) and never decodes. Core checks
`files_digest` on those bytes, then decodes each file once as strict UTF-8 (one leading BOM is
dropped), parses, and checks `source_digest`. A difference in either pin is
`RECIPE_INDEX_DIGEST_MISMATCH`, with `digest` naming the pin that failed, and no recipe is returned.
Bytes that are not UTF-8 are `RECIPE_INDEX_ENCODING_INVALID`. Frontmatter that the bounded loader refuses, on
read or in the bytes a write would store, is `RECIPE_INDEX_FRONTMATTER_REFUSED`, with `frontmatter`
carrying the code and document, because nothing was tampered with. Every prepared document, for both
editions, goes through the real serializer before a recipe counts as verified, so a recipe whose
aliases expand past the limits fails here and not between two cookbook members. A recipe preparation
or authoring admission refuses is `RECIPE_MALFORMED`. A reader that throws is
`RECIPE_INDEX_READ_FAILED`. `parseRecipeIndex` also accepts the index as raw bytes and decodes it
the same way. `resolveCookbook(index, id, read)` verifies every member in order and returns either
all of them or a refusal naming the failed member, never a partial set. It then refuses with
`RECIPE_INDEX_COOKBOOK_CONFLICT` when two members would install the same target, whether or not
their bytes agree, because create-only installs keep the first and never converge on the second.
Targets are the ids `prepareRecipeInstall` produces, and a View's legacy `pages-registry/` and
`pages/` spellings count as the same target as `views-registry/` and `views/`, as they do at
install. `conflict` names both members and the shared ids in each member's spelling.

`files_digest` covers every listed byte, including the manifest's title, summary, offer and prose
and any listed README. `source_digest` covers what install writes. Neither authenticates a
publisher. Bound the reader's sizes and times in the host, and keep local reads inside the index
directory. Path segments may not start or end with `.`.

### Discovery, display text and the format rule

The format rule for `recipe-index/v1`: keys that change what a reader fetches, verifies or installs
are strict, and changing them is a new format version. Everything for finding and grouping entries
sits in one optional `discovery` object at index, recipe and cookbook level, and readers tolerate it:

```json
{ "id": "my-home", "title": "My Home", "summary": "...", "designation": "supported", "maintainer": "Holaxis-ai",
  "recipes": ["my-home", "my-home-maintenance", "my-home-costs"],
  "discovery": {
    "offer": "Keep track of your home: rooms, appliances, repairs, warranties and what you spent.",
    "keywords": ["house", "appliance", "repair", "warranty"],
    "categories": ["home", "money"],
    "audience": "personal" } }
```

- Known keys: `keywords` (at most 12, each matching `^[a-z0-9][a-z0-9 -]{0,39}$`, for search),
  `categories` (one or two ids from `RECIPE_CATEGORIES`, the first is the primary) and `audience`
  (`personal`, `work` or `both`) on recipes and cookbooks; `offer` (display text of at most 140
  characters) on cookbooks only. A recipe's `offer` is the manifest's `offer` in `recipe.md`. The
  index level has no known key yet.
- `readRecipeDiscovery(value, level)` reads one object. It drops unknown keys and invalid values (one
  item at a time inside a list), keeps the first 12 keywords and the first two categories, and
  never refuses. A `discovery` that is not an object is dropped whole. Dropped data is not kept in
  the parse result, so nothing Core does not understand reaches an agent or a page. Parsed entries
  carry `discovery` only when something survives, and `resolveIndexRecipe` and `resolveCookbook`
  pass it through. When an older reader drops an
  unknown first category, the next one becomes the primary.
- Readers never refuse an index because of `discovery`, so a later, wider rule (a new category, a
  third audience) leaves older readers working; they simply do not show the new value until they run
  a Core that knows it. `readRecipeDiscovery` also returns `problems`, one sentence per drop, so a
  generator refuses what readers tolerate and authors see their mistakes.
- `RECIPE_CATEGORIES` is the one category table: `home` (Home and family), `money`, `learning`
  (Learning and hobbies), `productivity`, `research`, `business` (Business operations) and `software`
  (Software and engineering). Ids are permanent and never reused; display names may change. A host
  shows only categories that hold at least one entry. There is no health category.

The display text rule is `recipeDisplayText(value, max)`: a nonempty string with no control
character (Unicode category Cc, C0 and C1, newline and tab included), no format character (category
Cf: bidirectional marks and overrides, the zero-width space U+200B, U+FEFF and the U+E0000 tag
block) except the zero-width non-joiner and joiner (U+200C, U+200D), which Persian, Indic scripts
and emoji need, and no line or paragraph separator (U+2028, U+2029), cut to `max` UTF-16 code units without splitting a surrogate
pair, or null. `parseRecipeIndex` refuses the index (`RECIPE_INDEX_MALFORMED`) when its `title`, a
cookbook's `title` or `summary`, a `maintainer` or a `version` breaks it, and `discovery.offer`
follows the drop rule. Whatever builds listing rows from verified recipes uses
`recipeDisplayFields(recipe)`, which clamps the file-derived `title` to 200, `summary` to 1000 and
`offer` to 140 characters (`RECIPE_DISPLAY_LIMITS`), leaves out a value with a refused character, and
falls back from `offer` to the title and from the title to the id. No character rule catches an
instruction-shaped sentence, so this text stays data.

What Core verifies, and what is only the publisher's statement:

- Verified: a recipe's id, version, `files_digest`, `source_digest` and storability, after every
  listed file is fetched. So a verified recipe's `title`, `summary`, `offer` and Kinds are pinned: fixed to digests the same
  publisher wrote, so still the publisher's words, only unchangeable once pinned.
- Not verified: everything in `discovery`, every cookbook field (`title`, `summary`, `offer`,
  `recipes`), `designation`, `maintainer` and the index `source` and `title`. The index document has
  no pin of its own and its digests come from the same publisher, so they prove consistency, not who
  published. A reader holding only the index has only unpinned text. Tool and page output built from
  an index says which of its text is the publisher's statement.

A recipe manifest's `offer`, `title` and `summary` are covered by `files_digest` and not by
`source_digest`, so rewording them keeps install stamps current. After an index lists a recipe
version, its bytes are immutable, so a rewording needs a new recipe version.

**Qualified recipe identity, later.** A qualified recipe identity (authority, repository and
recipe-local id) will come with a new format version. A key that older readers ignore is not enough:
they would still resolve by the bare `id`, and two entries with the same `id` are refused as
duplicates. Any new key outside `discovery` is a new format version.

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
