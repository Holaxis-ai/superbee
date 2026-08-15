// Built-in recipes are an acquisition adapter: they materialize the same RecipeFile[] shape an
// external source supplies, then delegate all interpretation to parseRecipeFiles.
import { kindConventionDoc, stringifyDoc } from "@superbee/core";
import { parseRecipeFiles, type LoadedRecipe, type RecipeFile, type RecipeSource } from "./recipe-parser.js";
import { looksLikeRecipePath } from "./recipe-ref.js";
import {
  CONTEXT_NOTE_KIND,
  CONTEXT_NOTE_SEED_BODY,
  CONTEXT_NOTES_SUMMARY,
  RECIPE_DESC_BODY,
  TASK_KIND,
  TASK_SEED_BODY,
  WORK_TRACKING_SUMMARY,
  WORK_TRACKING_DESC_BODY,
  ROADMAP_KIND,
  ROADMAP_SEED_BODY,
  ROADMAP_ITEM_KIND,
  ROADMAP_ITEM_SEED_BODY,
  ROADMAP_SUMMARY,
  ROADMAP_DESC_BODY,
} from "./recipes.js";

/** Used only to call the shared serializer; built-in source bytes discard it before parsing. */
const PLACEHOLDER_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function unstampedConvention(kind: Parameters<typeof kindConventionDoc>[0], body: string) {
  const doc = kindConventionDoc(kind, body, PLACEHOLDER_TIMESTAMP);
  const { timestamp: _timestamp, ...frontmatter } = doc.frontmatter;
  return { ...doc, frontmatter };
}

function buildContextNotesFiles(): RecipeFile[] {
  const conv = unstampedConvention(CONTEXT_NOTE_KIND, CONTEXT_NOTE_SEED_BODY);
  return [
    {
      path: "recipe.md",
      bytes: stringifyDoc(
        { type: "Recipe", id: "context-notes", title: "Context Notes", version: "1", summary: CONTEXT_NOTES_SUMMARY },
        RECIPE_DESC_BODY,
      ),
    },
    { path: "conventions/context-note.md", bytes: stringifyDoc(conv.frontmatter, conv.body) },
  ];
}

function buildWorkTrackingFiles(): RecipeFile[] {
  const conv = unstampedConvention(TASK_KIND, TASK_SEED_BODY);
  return [
    {
      path: "recipe.md",
      bytes: stringifyDoc(
        { type: "Recipe", id: "work-tracking", title: "Work Tracking", version: "1", summary: WORK_TRACKING_SUMMARY },
        WORK_TRACKING_DESC_BODY,
      ),
    },
    { path: "conventions/task.md", bytes: stringifyDoc(conv.frontmatter, conv.body) },
  ];
}

function buildRoadmapFiles(): RecipeFile[] {
  const roadmap = unstampedConvention(ROADMAP_KIND, ROADMAP_SEED_BODY);
  const item = unstampedConvention(ROADMAP_ITEM_KIND, ROADMAP_ITEM_SEED_BODY);
  return [
    {
      path: "recipe.md",
      bytes: stringifyDoc(
        { type: "Recipe", id: "roadmap", title: "Roadmap", version: "1", summary: ROADMAP_SUMMARY },
        ROADMAP_DESC_BODY,
      ),
    },
    { path: "conventions/roadmap.md", bytes: stringifyDoc(roadmap.frontmatter, roadmap.body) },
    { path: "conventions/roadmap-item.md", bytes: stringifyDoc(item.frontmatter, item.body) },
  ];
}

const BUILTIN_FILES: Record<string, RecipeFile[]> = {
  "context-notes": buildContextNotesFiles(),
  "work-tracking": buildWorkTrackingFiles(),
  roadmap: buildRoadmapFiles(),
};

export function builtinNames(): string[] {
  return Object.keys(BUILTIN_FILES);
}

export function builtinRecipeSource(): RecipeSource {
  return {
    kind: "builtin",
    async resolve(ref) {
      if (looksLikeRecipePath(ref)) return null;
      const files = BUILTIN_FILES[ref];
      if (!files) return null;
      return parseRecipeFiles(files, `builtin:${ref}`);
    },
  };
}

function resolveBuiltinSync(name: string): LoadedRecipe {
  const files = BUILTIN_FILES[name];
  if (!files) throw new Error(`resolveBuiltinSync: no built-in recipe named '${name}'`);
  const result = parseRecipeFiles(files, `builtin:${name}`);
  if (!result.ok) throw new Error(`resolveBuiltinSync: built-in '${name}' failed to parse: ${result.error.message}`);
  return result.recipe;
}

/** Test convenience, pre-resolved through the same parser every source uses. */
export const CONTEXT_NOTES_RECIPE: LoadedRecipe = resolveBuiltinSync("context-notes");
