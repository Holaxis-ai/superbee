---
type: Recipe
id: example
title: Example
version: "1"
summary: A trivial throwaway recipe proving the external-folder load arm (Recipes Unit B).
---
# Example Recipe

A throwaway, non-domain recipe used only to prove `recipe add <path>` loads and applies an
EXTERNAL recipe folder through the same `parseRecipeFiles` pipeline the built-in `context-notes`
recipe uses. Declares one convention: `Term` (a trivial glossary-entry kind). Not a product
recipe — do not ship this content.
