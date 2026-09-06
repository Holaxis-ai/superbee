# Recipe validation without the CLI

`@superbee/core/recipes` parses caller-supplied recipe files. It uses the same implementation
as the CLI's built-in and filesystem recipe sources. It performs no file discovery, network
access, installation, View execution, or bundle mutation.

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
skip-with-warning behavior. Declared View and Reference assets are returned as data.

The result retains the existing `LoadedRecipe`, `RecipeError` and `LoadResult` shapes. Parsing
preserves input order, warnings and messages. `RECIPE_NOT_FOUND` remains in the shared error
vocabulary for acquisition adapters; the parser itself reports a missing manifest as
`RECIPE_MALFORMED`.

## Consumer responsibilities

- Acquire files and enforce any resource limits appropriate to the source. This API accepts typed
  file records, not an arbitrary untrusted JSON request or an archive.
- Inspect recipe and registry warnings. A missing Kind is distinct from a record passing its
  declared checks. Consumers choose whether warnings block their workflow.
- Kind validation checks declared fields and sections. It does not prove linked targets exist,
  relationship cardinalities, authorization, or compatibility with an installed bundle.
- Keep example records separate from distributable definitions-only recipes.
- Use the CLI for existing recipe installation and evolution workflows. Parsing does not grant
  permission to install or execute a View.

The package proof installs core alone, typechecks the public subpaths, runs parsing and record
checks in Node, and executes a browser-target bundle without Node globals. This is not a live
browser or Worker integration guarantee. No CLI runtime dependency or new package is required.
