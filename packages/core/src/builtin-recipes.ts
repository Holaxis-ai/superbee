// Built-in recipes are an acquisition adapter: they materialize the same RecipeFile[] shape an
// external source supplies, then delegate all interpretation to parseRecipeFiles.
import { kindConventionDoc } from "./kinds.js";
import { stringifyDoc } from "./frontmatter.js";
import { parseRecipeFiles, type LoadedRecipe, type RecipeFile } from "./recipes.js";
import {
  CONTEXT_NOTE_KIND,
  CONTEXT_NOTE_SEED_BODY_LOGICAL,
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
} from "./builtin-recipes/content.js";

/** Used only to call the shared serializer; built-in source bytes discard it before parsing. */
const PLACEHOLDER_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function unstampedConvention(kind: Parameters<typeof kindConventionDoc>[0], body: string) {
  const doc = kindConventionDoc(kind, body, PLACEHOLDER_TIMESTAMP);
  const { timestamp: _timestamp, ...frontmatter } = doc.frontmatter;
  return { ...doc, frontmatter };
}

function buildContextNotesFiles(): RecipeFile[] {
  const conv = unstampedConvention(CONTEXT_NOTE_KIND, CONTEXT_NOTE_SEED_BODY_LOGICAL);
  return [
    {
      path: "recipe.md",
      bytes: stringifyDoc(
        {
          type: "Recipe",
          id: "context-notes",
          title: "Context Notes",
          version: "1",
          summary: CONTEXT_NOTES_SUMMARY,
          offer: "give agents persistent memory between sessions",
        },
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
        {
          type: "Recipe",
          id: "work-tracking",
          title: "Work Tracking",
          version: "1",
          summary: WORK_TRACKING_SUMMARY,
          offer: "set up a shared task list for this project",
        },
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
        {
          type: "Recipe",
          id: "roadmap",
          title: "Roadmap",
          version: "1",
          summary: ROADMAP_SUMMARY,
          offer: "map out where the project is going",
        },
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

/** Resolve a built-in name only. Acquisition and filesystem routing belong to the caller. */
export function loadBuiltinRecipe(name: string): ReturnType<typeof parseRecipeFiles> | null {
  const files = BUILTIN_FILES[name];
  return files && Object.hasOwn(BUILTIN_FILES, name)
    ? parseRecipeFiles(files, `builtin:${name}`, { okfVersion: "0.2" })
    : null;
}

/** Detached source bytes, for consumers that need a recipe package rather than its parsed form. */
export function builtinRecipeFiles(name: string): RecipeFile[] | undefined {
  return Object.hasOwn(BUILTIN_FILES, name) ? structuredClone(BUILTIN_FILES[name]) : undefined;
}

/** Synchronous builtin resolution for render-path consumers (offers) that must stay pure. */
export function resolveBuiltinSync(name: string): LoadedRecipe {
  const files = builtinRecipeFiles(name);
  if (!files) throw new Error(`resolveBuiltinSync: no built-in recipe named '${name}'`);
  const result = parseRecipeFiles(files, `builtin:${name}`, { okfVersion: "0.2" });
  if (!result.ok) throw new Error(`resolveBuiltinSync: built-in '${name}' failed to parse: ${result.error.message}`);
  return result.recipe;
}

export {
  CONTEXT_NOTE_KIND,
  CONTEXT_NOTE_SEED_BODY_LOGICAL,
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
  ROADMAP_DESC_BODY
} from "./builtin-recipes/content.js";
