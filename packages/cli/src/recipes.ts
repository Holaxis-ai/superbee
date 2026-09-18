// The CLI's recipe APPLY machinery + `context-notes`'s CONTENT ("recipe zero").
//
// This is where Context Note SEEDING lives (moved out of `packages/core`: "the
// engine special-cases NOTHING about conventions"). Core keeps only the generic apply primitive
// (`writeDocVersioned` expect-absent CAS) and the generic `kindConventionDoc` serializer; this
// module supplies the SPECIFIC content (the `Context Note` kind's convention + seed prose body,
// plus the built-in recipe's manifest text) and the generic loop that applies ANY recipe's
// convention docs idempotently, whether it came from the built-in source or an external folder
// (`recipe-source.ts`'s `parseRecipeFiles` — the ONE parse+validate path both flow through).
//
// `context-notes` (recipe zero) is the spec-test that a recipe must model a convention doc WITH A
// BODY, not just bare frontmatter — `CONTEXT_NOTE_SEED_BODY` is the in-bundle authoring reference
// for kind conventions (see its own doc comment below).
//
// Recipes Unit B (pluggable recipes): the registry is no longer an in-code array of `Recipe`
// objects keyed by name — that shape could only ever hold built-ins. `applyRecipe`'s input widened
// to `recipe-source.ts`'s `LoadedRecipe` (a folder-shaped `OkfDocument[]`, produced identically
// whether the folder was a built-in in-code constant or bytes read off disk), so a built-in and an
// external recipe apply through byte-for-byte the SAME function.
import {
  PROGRESS_STATUS_FIELD,
  progressStatusStorageField,
  readBlob,
  readBundleOkfVersion,
  readDoc,
  resolveContentType,
  writeBlob,
  mutateDocument,
  query,
  CONVENTIONS_PREFIX,
  VersionConflict,
  type Bundle,
  type ConceptId,
  type KindConvention,
  type KindRegistry,
  type OkfDocument,
  type ValidationWarning,
} from "@superbee/core";
import {
  PAGE_ENTRY_PREFIX,
  PAGE_REGISTRY_PREFIX,
  PAGE_TYPE_NAMES,
  parseRegistration,
  VIEW_ENTRY_PREFIX,
  VIEW_REGISTRY_PREFIX,
} from "@superbee/core/page";
import { isDeepStrictEqual } from "node:util";
import { CliError } from "./errors.js";
import { LEGACY_PAGE_TYPE_NAME } from "./legacy-page.js";
import type { LoadedRecipe } from "./recipe-source.js";

/** The `type` value the context-notes recipe governs; formerly a core export, localized when the
 * bespoke `note` command (and core's `noteToDoc`) was deleted — the recipe is exactly the thing
 * that DEFINES the type it governs, so the identifier belongs here now. */
const CONTEXT_NOTE_TYPE = "Context Note";

/**
 * The `Context Note` kind convention (moved VERBATIM from core's `CONTEXT_NOTE_KIND`, Recipes Unit
 * A). `governs`/`title` are stamped from the locally-defined `CONTEXT_NOTE_TYPE` above — the type
 * this recipe governs, authored via the GENERIC path (`new "Context Note" <id>` + `doc read`/`doc
 * update`/`doc write`; there is no bespoke note command or codec anymore). `description` is
 * declared OPTIONAL (not required) because a `new "Context Note"` instance can legitimately carry
 * an empty one, and a kind must not fail its own convention's producer. `sections` declares ONLY
 * `Summary` — the one heading the recipe SCAFFOLDS on every `new "Context Note"` create — for the
 * same producer-must-pass reason: a summary-only note is the most common legitimate shape, and
 * declaring additional headings would make `status` flag every minimal note with
 * KIND_SECTION_MISSING noise — alert fatigue on the primary path. The seed's BODY carries a worked
 * multi-section/`fields.values` example for authors of OTHER kinds to copy.
 */
export const CONTEXT_NOTE_KIND: KindConvention = {
  id: "conventions/context-note",
  title: CONTEXT_NOTE_TYPE,
  governs: CONTEXT_NOTE_TYPE,
  path: "context-notes/",
  fields: {
    required: ["title", "timestamp"],
    optional: ["description", "tags"],
    values: {},
    valueDescriptions: {},
    terminal: {},
    descriptions: {},
  },
  sections: ["Summary"],
  freshnessHorizon: "24h",
  // Context Notes are transient cross-session scratch — collapse them by default in browse listings
  // so they never swamp durable knowledge (designs/document-discovery Decision 1). Per-bundle
  // overridable by dropping the key; every other kind stays expanded.
  browseCollapsed: true,
};

/**
 * The seed's prose body (`conventions/context-note.md`) is deliberately doubled up as the
 * IN-BUNDLE authoring reference for kind conventions: every produced bundle that applies this
 * recipe (via `init`'s default, or an explicit `recipe add context-notes`) ships one worked
 * example of the ONE correct shape, right where an agent discovering `conventions/` will find it —
 * not just in a doc an agent may never read. Bodies are prose (the registry only parses
 * frontmatter, per `parseConventionDoc`), so a fenced YAML example here is inert to the parser
 * and purely illustrative. The source uses one explicit logical-field token so the recipe
 * materializer can teach the physical workflow coordinate appropriate to the target OKF edition.
 */
const RECIPE_PROGRESS_STATUS_TOKEN = "{{superbee:progress_status}}";

export const CONTEXT_NOTE_SEED_BODY_LOGICAL =
  "# Context Note\n\n" +
  "An agent's cross-session orientation note: what happened, what was decided, and what's " +
  "still open. Create one with `new \"Context Note\" <id>` (scaffolds the `# Summary` section " +
  "under `context-notes/`), read it with `doc read`, and edit it with `doc update` / `doc " +
  "write`. This recipe retains `timestamp` as an explicit compatibility field and uses the " +
  "Superbee-specific `freshness_horizon` Kind extension so `superbee status` can surface notes " +
  "older than 24h. In an OKF v0.2 bundle, `generated.at` remains the standard meaningful-change " +
  "clock when provenance is present.\n\n" +
  "## Declaring a kind convention\n\n" +
  "A kind convention is a plain OKF doc (`type: Convention`) living under `conventions/`. Its " +
  "FRONTMATTER is the only part core parses (this prose is not). Supported frontmatter keys:\n\n" +
  "- `governs` (required, non-empty) — the `type` value this convention governs.\n" +
  "- `title` (optional) — display title; defaults to `governs`.\n" +
  "- `description` (optional) — the kind's purpose and intended use.\n" +
  "- `path` (optional) — canonical bundle-relative path prefix instances are scaffolded under " +
  "(e.g. `roadmap/`).\n" +
  "- `fields.required` — list of field names an instance MUST carry (non-empty).\n" +
  "- `fields.optional` — list of field names an instance MAY carry.\n" +
  "- `fields.descriptions` — a MAP of `field name -> human guidance` for declared fields.\n" +
  "- `fields.values` — a MAP of `field name -> list of allowed values`. This is the ONLY place " +
  "an enum constraint goes — never a top-level `enum:`/`enums:`/`values:`/`constraints:` key, " +
  "and never a field named directly at the top level either.\n" +
  "- `sections` — list of expected level-1 (`# Heading`) body-section names. Declare only the " +
  "headings EVERY instance must carry (this Context Note kind declares just `Summary`, the one " +
  "section `new \"Context Note\"` scaffolds and every instance carries).\n" +
  "- `freshness_horizon` — a Superbee Kind extension using `<n>(m|h|d)`, e.g. `24h`, `30d`, `15m`.\n\n" +
  "Worked example (a `Roadmap Item` kind, with an enum-restricted field and expected sections):\n\n" +
  "```yaml\n" +
  "---\n" +
  "type: Convention\n" +
  "title: Roadmap Item\n" +
  "governs: Roadmap Item\n" +
  "description: A durable line of work that groups related tasks.\n" +
  "path: roadmap/\n" +
  "fields:\n" +
  `  required: [title, ${RECIPE_PROGRESS_STATUS_TOKEN}]\n` +
  "  optional: [horizon]\n" +
  "  values:\n" +
  `    ${RECIPE_PROGRESS_STATUS_TOKEN}: [planned, active, done]\n` +
  "  descriptions:\n" +
  "    title: A concise summary of the outcome.\n" +
  `    ${RECIPE_PROGRESS_STATUS_TOKEN}: The roadmap item's current workflow progress.\n` +
  "    horizon: The expected delivery window.\n" +
  "sections: [Why, \"Done when\"]\n" +
  "freshness_horizon: 30d\n" +
  "---\n" +
  "```\n";

function materializeRecipeBody(body: string, storageField: string): string {
  return body.replaceAll(RECIPE_PROGRESS_STATUS_TOKEN, storageField);
}

/** V0.1 materialization retained for tests and direct recipe-content consumers. */
export const CONTEXT_NOTE_SEED_BODY = materializeRecipeBody(
  CONTEXT_NOTE_SEED_BODY_LOGICAL,
  "status",
);

/** One-line description, shown by `recipes` and the command reference — the built-in `context-notes`
 * recipe's `recipe.md` manifest `summary:`. */
export const CONTEXT_NOTES_SUMMARY =
  "Declares the built-in Context Note kind convention (title/timestamp required, 24h freshness horizon)";

/** The prose body of the built-in `context-notes` recipe's `recipe.md` manifest doc — NOT parsed by
 * `parseRecipeFiles` (only the manifest's frontmatter is read), purely descriptive for a human or
 * agent who reads the recipe folder directly (built-in or, via a future `eject`, on disk). */
export const RECIPE_DESC_BODY =
  "# Context Notes\n\n" +
  "Installs the `Context Note` kind convention: a lightweight cross-session orientation note — " +
  "what happened, what was decided, what's still open. Declares the `Context Note` type's " +
  "required fields, the `# Summary` scaffold section, and a 24h freshness horizon.\n\n" +
  "Applied by default on `init` (opt out with `init --recipe none`), or on demand with " +
  "`recipe add context-notes`.\n";

/** The `type` value the work-tracking recipe governs — mirrors `CONTEXT_NOTE_TYPE`'s pattern (a
 * recipe is exactly the thing that DEFINES the type it governs). */
const TASK_TYPE = "Task";

/**
 * The `Task` kind convention — the first DOMAIN recipe on the pluggable-recipe foundation
 * (Recipes Unit B was the plumbing; this is the first thing built on it). The built-in now carries
 * agent-readable purpose and field guidance; recipe application remains expect-absent, so an
 * existing hand-authored Task convention is preserved rather than upgraded in place. No `sections`
 * — unlike Context Note, a Task instance is not scaffolded around a fixed body shape; its body is
 * free-form task description, and declaring expected headings here would just be lint noise on
 * the common one-line task.
 */
export const TASK_KIND: KindConvention = {
  id: "conventions/task",
  title: TASK_TYPE,
  governs: TASK_TYPE,
  description: "A concrete unit of work that can be claimed, prioritized, assigned, and completed.",
  path: "tasks/",
  // The typed-edge vocabulary (decisions/typed-links-carrier): a task's dependency edge is a
  // link whose display text is exactly "depends on", targeting another Task. Declared here so
  // `kinds` teaches the vocabulary to any agent that orients — discovery shipped; validation
  // is a future consumer.
  links: { "depends on": TASK_TYPE },
  // The claim coordinates (research/atomic-shared-task-claim-design): declaring them is what
  // lets sync's converge report a lost claim as ownership and withdraw the re-apply route,
  // instead of presenting the race as an ordinary content conflict. Logical names; the
  // edition's coordinate policy resolves them onto storage keys.
  claim: { ownerField: "assignee", stateField: "progress_status" },
  fields: {
    required: ["title", PROGRESS_STATUS_FIELD],
    optional: ["priority", "assignee", "description"],
    values: { [PROGRESS_STATUS_FIELD]: ["todo", "in_progress", "blocked", "done", "canceled"] },
    valueDescriptions: {},
    // The terminal declaration (tasks/status-terminal-declaration.md): done/canceled are the
    // states past which a Task is no longer open — machinery (list --open, the status sweep's
    // exclusion + sort) ships together with the declaration for every new bundle.
    terminal: { [PROGRESS_STATUS_FIELD]: ["done", "canceled"] },
    descriptions: {
      title: "A concise human-readable summary of the work.",
      [PROGRESS_STATUS_FIELD]: "The task's current workflow state.",
      priority: "Relative urgency used to order the work; follow the bundle's adopted priority scale.",
      assignee: "The person or agent currently responsible for the task.",
      description: "The task's scope, context, acceptance criteria, and other working details.",
    },
  },
  freshnessHorizon: "30d",
};

/**
 * The seed's prose body (`conventions/task.md`) explains how the generic primitives compose into
 * task tracking. Composed entirely from EXISTING lite primitives (link graph as DAG, CAS write as claim,
 * `list --type`/`status` as query/lint) — no bespoke task engine, no new verb. The CLI's task-aware
 * columns, claim, and runnable/blocked projections are a separate concern, not part of this recipe.
 */
export const TASK_SEED_BODY =
  "# Task\n\n" +
  "A unit of work, composed entirely from lite primitives — no bespoke task engine.\n" +
  "A task is a `type: Task` doc; its logical `progress_status` is a validated enum; its DEPENDENCIES are\n" +
  "typed `depends on` cross-links to prerequisite task docs (the declared link type —\n" +
  "the link graph IS the DAG, and `link show <id> --text \"depends on\"` shows both\n" +
  "directions); an atomic CLAIM is a compare-and-swap write flipping `progress_status` to\n" +
  "`in_progress` (a second claimer gets a VersionConflict). Query with `list --type Task`;\n" +
  "lint/orphans/staleness via `status`.\n";

/** One-line description, shown by `recipes` and the command reference — the built-in
 * `work-tracking` recipe's `recipe.md` manifest `summary:`. */
export const WORK_TRACKING_SUMMARY =
  "Declares the built-in Task kind convention (title/progress_status required, workflow enum, 'depends on' link type, 30d freshness horizon)";

/** The prose body of the built-in `work-tracking` recipe's `recipe.md` manifest doc — NOT parsed
 * by `parseRecipeFiles` (only the manifest's frontmatter is read), purely descriptive. */
export const WORK_TRACKING_DESC_BODY =
  "# Work Tracking\n\n" +
  "Installs the `Task` kind convention: a unit of work with a validated logical `progress_status` enum " +
  "(todo/in_progress/blocked/done/canceled), scaffolded under `tasks/`. Status/priority/assignee " +
  "are FIELDS of Task, not separate conventions or a bespoke task verb — dependencies, claiming, " +
  "and querying all compose from existing generic primitives (`link add`, CAS `doc update`, " +
  "`list --type Task`, `status`).\n\n" +
  "Applied on demand with `recipe add work-tracking` (not part of `init`'s default — that stays " +
  "`context-notes`).\n";

/** The `type` values the roadmap recipe governs — extracted from the project's own board (the
 * hand-authored `conventions/roadmap` + `conventions/roadmap-item` docs), the same
 * dogfood-then-package path work-tracking took. */
const ROADMAP_TYPE = "Roadmap";
const ROADMAP_ITEM_TYPE = "Roadmap Item";

/**
 * The `Roadmap` kind convention — the SPINE: a single top-level roadmap doc that `contains` the
 * bundle's Roadmap Items via typed links. Frontmatter faithful to the board's hand-authored
 * `conventions/roadmap` (no `path` — the spine is one doc, conventionally the bundle-root
 * `roadmap`, not a scaffolded family; no freshness horizon; `title` is the only required field).
 */
export const ROADMAP_KIND: KindConvention = {
  id: "conventions/roadmap",
  title: ROADMAP_TYPE,
  governs: ROADMAP_TYPE,
  // The typed-edge vocabulary: the spine's ownership edge is a link whose display text is exactly
  // "contains", targeting a Roadmap Item — declared so `kinds` teaches it and `link add`'s graph
  // lint validates it.
  links: { contains: ROADMAP_ITEM_TYPE },
  // No status field on the spine, so nothing to declare terminal (Brian's ruling on the
  // task board's `tasks/status-terminal-declaration.md`).
  fields: { required: ["title"], optional: [], values: {}, valueDescriptions: {}, terminal: {}, descriptions: {} },
};

/** The `conventions/roadmap.md` prose body. */
export const ROADMAP_SEED_BODY =
  "# Roadmap\n\n" +
  "The spine document: a single top-level roadmap doc that CONTAINS the bundle's Roadmap\n" +
  "Items via typed links carrying the text `contains` (`link add <roadmap> <item> --text\n" +
  "contains`), making the whole roadmap → item → task chain one filtered query per hop\n" +
  "(`link show <id> --text contains`). Progress is DERIVED, never stored: list the\n" +
  "contained items and read their statuses.\n";

/**
 * The `Roadmap Item` kind convention — a durable line of work spanning multiple tasks.
 * Frontmatter faithful to the board's hand-authored `conventions/roadmap-item`: scaffolded under
 * `roadmap-items/`, `contains` its Tasks, `status` is the three-state item lifecycle (coarser than
 * Task's five-state enum on purpose — an item's granular progress is the derived task rollup, not
 * a stored field).
 */
export const ROADMAP_ITEM_KIND: KindConvention = {
  id: "conventions/roadmap-item",
  title: ROADMAP_ITEM_TYPE,
  governs: ROADMAP_ITEM_TYPE,
  path: "roadmap-items/",
  links: { contains: "Task" },
  linkDescriptions: { contains: "Tasks whose delivery is governed by this roadmap commitment." },
  fields: {
    required: ["title", PROGRESS_STATUS_FIELD],
    optional: ["description", "sequence"],
    values: { [PROGRESS_STATUS_FIELD]: ["queued", "active", "done"] },
    valueDescriptions: {},
    // Brian's ruling (task board `tasks/status-terminal-declaration.md`): a done Roadmap Item
    // hides from `list --open`, consistent with Task's done/canceled.
    terminal: { [PROGRESS_STATUS_FIELD]: ["done"] },
    descriptions: {},
  },
};

/** The `conventions/roadmap-item.md` prose body. */
export const ROADMAP_ITEM_SEED_BODY =
  "# Roadmap Item\n\n" +
  "A durable line of work spanning multiple tasks — the granular form of the single\n" +
  "roadmap spine doc. An item CONTAINS its tasks via links carrying the text `contains`;\n" +
  "backlinks from a task answer \"which item owns this\". An item's progress is DERIVED,\n" +
  "never stored: list its contained tasks and read their workflow states (the rollup). `progress_status`\n" +
  "tracks the item itself: `queued` (not started) → `active` (any contained task moving)\n" +
  "→ `done` (all contained tasks done or canceled).\n";

/** One-line description, shown by `recipes` and the command reference — the built-in `roadmap`
 * recipe's `recipe.md` manifest `summary:`. */
export const ROADMAP_SUMMARY =
  "Declares the Roadmap + Roadmap Item kind conventions (typed 'contains' links, roadmap → item → task; item progress_status enum queued/active/done) — work-tracking's companion";

/** The prose body of the built-in `roadmap` recipe's `recipe.md` manifest doc — NOT parsed by
 * `parseRecipeFiles` (only the manifest's frontmatter is read), purely descriptive. Its "Pairing
 * the Task kind" section is the RECORDED resolution of this unit's expects_inbound design
 * question: recipes apply via expect-absent CAS and can never patch an EXISTING `conventions/task`
 * doc, and `kind field` edits only `fields.{required,optional,values}` — so the Task-side
 * `expects_inbound` pairing is a documented one-step opt-in (pull → edit → promote, the
 * CLI's one sanctioned convention-schema edit route), not a silent recipe patch. The chain below
 * is pinned by a test that literally executes it (recipes.test.ts). */
export const ROADMAP_DESC_BODY =
  "# Roadmap\n\n" +
  "Installs the `Roadmap` and `Roadmap Item` kind conventions: roadmap-items-as-docs. A single\n" +
  "`Roadmap` spine doc CONTAINS `Roadmap Item` docs; each item CONTAINS its `Task` docs — all\n" +
  "via typed links carrying the text `contains`, so the whole roadmap → item → task chain is\n" +
  "one filtered query per hop (`link show <id> --text contains`). An item's progress is derived\n" +
  "from its contained tasks' statuses, never stored.\n\n" +
  "Applied on demand with `recipe add roadmap` (not part of `init`'s default — that stays\n" +
  "`context-notes`). Composes with the `work-tracking` recipe (the `Task` kind this recipe's\n" +
  "`contains` vocabulary points at) — apply both for the full chain.\n\n" +
  "## Pairing the Task kind (opt-in, one documented step)\n\n" +
  "The graph lint that answers \"which tasks have no owning Roadmap Item\" reads\n" +
  "`expects_inbound` on the TASK kind's convention (`status` then reports\n" +
  "`missing_expected_links`). A recipe applies via expect-absent CAS and never touches a doc\n" +
  "that already exists, so this recipe cannot patch your bundle's `conventions/task` — the\n" +
  "pairing is a deliberate one-step opt-in on the adopting bundle:\n\n" +
  "```\n" +
  "superbee pull --doc-key conventions/task.md --out task.md\n" +
  "# edit task.md — add to the frontmatter:\n" +
  "#   expects_inbound:\n" +
  "#     contains: Roadmap Item\n" +
  "superbee promote task.md --doc-key conventions/task.md --expected-version <version from the pull receipt>\n" +
  "```\n\n" +
  "Without this step everything else still works (the `contains` vocabulary and its link-type\n" +
  "validation come from THIS recipe's conventions); only the \"task lacks an owning item\" lint\n" +
  "stays off.\n";

/** Per-doc apply outcome: `changed: false` means the doc already existed (idempotent no-op), or —
 * when `legacy_present`/`migration_required` names a doc — that a legacy-LOCATED counterpart
 * already occupies the artifact's slot (working, or awaiting migration, respectively). */
export interface RecipeDocResult {
  id: ConceptId;
  changed: boolean;
  /** The existing doc was preserved, but its definition differs from this recipe's source. */
  source_differs?: true;
  /** Set when creation was skipped because this existing legacy-located doc satisfies the artifact. */
  legacy_present?: ConceptId;
  /** NON-SUCCESS skip: the counterpart still carries the RETIRED legacy names, so it
   * no longer works at runtime — the bundle needs the migration script before this artifact is
   * genuinely satisfied. Named alongside a receipt-level warning carrying the remedy. */
  migration_required?: ConceptId;
}

export interface RecipePageResult {
  registry_id: ConceptId;
  entry: string;
  registry_changed: boolean;
  entry_changed: boolean;
  changed: boolean;
  /** Set when creation was skipped because a COMPLETE, still-REGISTERING legacy-located pair satisfies the artifact. */
  legacy_present?: { registry: ConceptId; entry: string };
  /** See {@link RecipeDocResult.migration_required} — the page-pair variant. */
  migration_required?: { registry: ConceptId; entry: string };
}

export interface RecipeReferenceResult {
  id: ConceptId;
  changed: boolean;
}

/** The receipt `applyRecipe` returns: identity, per-doc outcomes, an overall `changed` (any doc
 * changed), and any non-fatal warnings collected at LOAD time (recipe.md reserved keys, skipped
 * malformed convention docs). Duplicate-`governs` against the TARGET bundle is a separate, POST-
 * apply check (`loadKinds(bundle)`) — the command layer's job, not this function's. */
/** Per-artifact tally (docs + pages + references; a page's registry/entry pair is ONE artifact). */
export interface ApplyRecipeCounts {
  created: number;
  existing: number;
  legacy_present: number;
  /** Existing convention docs whose definitions do not match the recipe source. */
  source_differs?: number;
  /** Artifacts whose slot is held by RETIRED-name content (see `migration_required` fields). */
  migration_required: number;
}

export interface ApplyRecipeResult {
  id: string;
  version: string;
  source: string;
  docs: RecipeDocResult[];
  pages: RecipePageResult[];
  references: RecipeReferenceResult[];
  counts: ApplyRecipeCounts;
  changed: boolean;
  warnings: ValidationWarning[];
}

// ── Legacy-alias awareness (plans/rename-page-kind-to-view, Option C+) ────────────────────────
// A renamed recipe keeps its id/version but renames its artifact ids (views-registry//views/ over
// the legacy pages-registry//pages/). Idempotency here is per-artifact expect-absent CAS, so
// REAPPLYING the renamed recipe onto a bundle that installed the legacy edition would otherwise
// create a complete SECOND set — two identical launcher cards once that bundle is migrated in
// place (migration keeps legacy LOCATIONS; only names change). The legacy install SATISFIES the
// requirement: before creating an artifact, probe its legacy-alias counterpart — the location
// half derived from CORE's legacy prefix constants, the retired kind name from legacy-page.ts's
// frozen literal (post-removal it is deliberately absent from the live grammar) — and skip
// creation when the counterpart exists, reporting `legacy_present` in the receipt. An UNMIGRATED
// legacy install also satisfies the probe: its docs no longer register, but the remedy is the
// migration script (which fixes them in place, flagged loudly by `status`), never a duplicate
// install. General by construction: any recipe whose artifacts ride the renamed prefixes or
// govern the View kind benefits; for every other recipe each probe derives null and nothing
// changes.

/** Core's one accepted kind name (`View`); the retired legacy name comes from legacy-page.ts. */
const [VIEW_KIND_NAME] = PAGE_TYPE_NAMES;
const LEGACY_VIEW_KIND_NAME = LEGACY_PAGE_TYPE_NAME;

function legacyRegistryAlias(id: ConceptId): ConceptId | null {
  return id.startsWith(VIEW_REGISTRY_PREFIX)
    ? `${PAGE_REGISTRY_PREFIX}${id.slice(VIEW_REGISTRY_PREFIX.length)}`
    : null;
}

function legacyEntryAlias(key: string): string | null {
  return key.startsWith(VIEW_ENTRY_PREFIX)
    ? `${PAGE_ENTRY_PREFIX}${key.slice(VIEW_ENTRY_PREFIX.length)}`
    : null;
}

function governsKind(doc: OkfDocument, kindName: string): boolean {
  const governs = doc.frontmatter["governs"];
  return typeof governs === "string" && governs.trim() === kindName;
}

const RECIPE_WRITE_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function renameLogicalFieldMap(
  value: unknown,
  storageField: string,
  recipeId: string,
  docId: ConceptId,
): unknown {
  const record = plainRecord(value);
  if (!record || !Object.prototype.hasOwnProperty.call(record, PROGRESS_STATUS_FIELD)) return value;
  if (
    storageField !== PROGRESS_STATUS_FIELD
    && Object.prototype.hasOwnProperty.call(record, storageField)
  ) {
    throw new CliError(
      "USAGE",
      `recipe '${recipeId}' convention '${docId}' declares both logical '${PROGRESS_STATUS_FIELD}' and storage field '${storageField}'`,
    );
  }
  return Object.fromEntries(
    Object.entries(record).map(([field, fieldValue]) => [
      field === PROGRESS_STATUS_FIELD ? storageField : field,
      fieldValue,
    ]),
  );
}

/** Materialize explicit logical recipe fields into the target edition's physical convention keys. */
export function materializeRecipeForEdition(
  recipe: LoadedRecipe,
  okfVersion: string,
): LoadedRecipe {
  const storageField = progressStatusStorageField(okfVersion);
  if (!storageField) {
    throw new CliError(
      "USAGE",
      `recipe '${recipe.id}' cannot target unsupported OKF mutation version '${okfVersion}'`,
    );
  }
  const docs = recipe.docs.map((doc) => {
    const fields = plainRecord(doc.frontmatter.fields);
    if (!fields) return doc;
    const listField = (value: unknown): unknown => {
      if (!Array.isArray(value) || !value.includes(PROGRESS_STATUS_FIELD)) return value;
      if (value.includes(storageField)) {
        throw new CliError(
          "USAGE",
          `recipe '${recipe.id}' convention '${doc.id}' declares both logical '${PROGRESS_STATUS_FIELD}' and storage field '${storageField}'`,
        );
      }
      return value.map((field) => field === PROGRESS_STATUS_FIELD ? storageField : field);
    };
    const materializedFields: Record<string, unknown> = { ...fields };
    for (const key of ["required", "optional"]) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        materializedFields[key] = listField(fields[key]);
      }
    }
    for (const key of ["values", "value_descriptions", "terminal", "descriptions"]) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        materializedFields[key] = renameLogicalFieldMap(fields[key], storageField, recipe.id, doc.id);
      }
    }
    return {
      ...doc,
      frontmatter: { ...doc.frontmatter, fields: materializedFields },
      body: materializeRecipeBody(doc.body, storageField),
    };
  });
  return { ...recipe, docs };
}

export function recipeDocumentForApply(
  doc: OkfDocument,
  okfVersion: string,
  now: string,
): OkfDocument {
  return okfVersion === "0.1"
    ? { ...doc, frontmatter: { ...doc.frontmatter, timestamp: now } }
    : { ...doc, frontmatter: { ...doc.frontmatter } };
}

async function createRecipeDocument(
  bundle: Bundle,
  doc: OkfDocument,
  okfVersion: string,
  now: string,
): Promise<OkfDocument> {
  const result = await mutateDocument({
    bundle,
    id: doc.id,
    mode: "create-only",
    registry: RECIPE_WRITE_REGISTRY,
    strict: false,
    // Installed definitions must stay byte-comparable to their recipe source (sameInstalledDoc
    // strips generated.at but not an engine-seeded generated.by), so never seed a clock here.
    seedGenerationClock: false,
    now: () => now,
    buildCandidate: (_existing, context) => {
      if (context.okfVersion !== okfVersion) {
        throw new CliError(
          "CONFLICT",
          `bundle OKF version changed from '${okfVersion}' to '${context.okfVersion}' during recipe installation; retry`,
        );
      }
      return { frontmatter: { ...doc.frontmatter }, body: doc.body };
    },
  });
  return result.doc;
}

/** The id of an existing convention doc governing the LEGACY kind name, or null. Called at most
 * once per apply, and only when the recipe carries a convention governing the current name. */
async function findLegacyViewConvention(bundle: Bundle): Promise<ConceptId | null> {
  const conventions = await query(bundle, { prefix: CONVENTIONS_PREFIX, type: "Convention" });
  for (const doc of conventions) {
    if (governsKind(doc, LEGACY_VIEW_KIND_NAME)) return doc.id;
  }
  return null;
}

/**
 * Apply `recipe` through the shared document-mutation boundary using expect-absent CAS. Recipe
 * conventions may declare Superbee's logical `progress_status`; this installer materializes the
 * concrete field for the bundle edition before any write. V0.1 retains the historical install-time
 * `timestamp`; v0.2 preserves explicitly supplied legacy fields but does not invent them. A
 * `VersionConflict` remains an idempotent existing-doc result, never a clobber.
 */
export async function applyRecipe(
  bundle: Bundle,
  recipe: LoadedRecipe,
  now: string = new Date().toISOString(),
): Promise<ApplyRecipeResult> {
  const okfVersion = await readBundleOkfVersion(bundle) ?? "0.1";
  recipe = materializeRecipeForEdition(recipe, okfVersion);
  await assertPortableTargetsCompatible(bundle, recipe, now, okfVersion);

  // Legacy-alias probes (see the module comment above the alias helpers): resolved lazily, once.
  const legacyConventionId = recipe.docs.some((d) => governsKind(d, VIEW_KIND_NAME))
    ? await findLegacyViewConvention(bundle)
    : null;
  let legacyRegistryDocs: Map<ConceptId, OkfDocument> | null = null;
  const legacyRegistryDoc = async (id: ConceptId): Promise<OkfDocument | undefined> => {
    legacyRegistryDocs ??= new Map(
      (await query(bundle, { prefix: PAGE_REGISTRY_PREFIX })).map((doc) => [doc.id, doc]),
    );
    return legacyRegistryDocs.get(id);
  };
  const migrationWarnings: ValidationWarning[] = [];
  const migrationHelp =
    "run `node scripts/migrate-legacy-view-names.mjs --dir <bundle-root>` from the Superbee repository root to migrate it in place";

  const docs: RecipeDocResult[] = [];
  for (const d of recipe.docs) {
    if (legacyConventionId !== null && governsKind(d, VIEW_KIND_NAME)) {
      // A convention still governing the RETIRED legacy name is unmigrated state: skip creating
      // the current-name convention (never two conventions for one kind), but as an explicit
      // NON-SUCCESS — not a satisfied-looking skip.
      docs.push({ id: d.id, changed: false, migration_required: legacyConventionId });
      migrationWarnings.push({
        code: "MIGRATION_REQUIRED",
        message:
          `'${legacyConventionId}' still governs the retired legacy 'Page' kind name — ` +
          `'${d.id}' was not installed; ${migrationHelp}`,
        severity: "warning",
      });
      continue;
    }
    let doc = recipeDocumentForApply(d, okfVersion, now);
    let changed = true;
    let sourceDiffers = false;
    try {
      doc = await createRecipeDocument(bundle, doc, okfVersion, now);
    } catch (err) {
      if (err instanceof VersionConflict) {
        const existing = await readDoc(bundle, doc.id);
        if (!sameInstalledDoc(existing, doc, okfVersion)) {
          sourceDiffers = true;
          migrationWarnings.push({
            code: "RECIPE_SOURCE_DIFFERS",
            message:
              `recipe '${recipe.id}' source for '${doc.id}.md' differs from the existing convention; ` +
              "the existing bundle content was left untouched — run 'recipe evolve <same-name-or-path>' to inspect a safe additive upgrade plan",
            severity: "warning",
          });
        }
        changed = false;
      } else {
        throw err;
      }
    }
    docs.push({ id: doc.id, changed, ...(sourceDiffers ? { source_differs: true as const } : {}) });
  }

  const pages: RecipePageResult[] = [];
  for (const page of recipe.pages) {
    const registryAlias = legacyRegistryAlias(page.registry.id);
    const entryAlias = legacyEntryAlias(page.entry);
    const aliasDoc = registryAlias !== null && entryAlias !== null ? await legacyRegistryDoc(registryAlias) : undefined;
    if (registryAlias !== null && entryAlias !== null && aliasDoc !== undefined) {
      // Skip ONLY on a COMPLETE legacy pair: a partial legacy leftover (registry doc without its
      // blob) must not suppress the new install — that would leave no working card at all.
      // Creating under the new ids is always safe (expect-absent CAS; ids never collide across
      // prefixes), and the leftover is the audit's business, not the installer's.
      const legacyBlob = await readBlob(bundle, entryAlias);
      if (legacyBlob !== null) {
        // The counterpart's KIND decides the outcome: a registering View at the
        // legacy location genuinely satisfies the artifact; a RETIRED-name (Page-typed or
        // otherwise non-registering) counterpart holds the slot but no longer works — an
        // explicit non-success naming the remedy, never a satisfied-looking skip.
        const registers = parseRegistration(aliasDoc.id, aliasDoc.frontmatter) !== null;
        if (registers) {
          pages.push({
            registry_id: page.registry.id,
            entry: page.entry,
            registry_changed: false,
            entry_changed: false,
            changed: false,
            legacy_present: { registry: registryAlias, entry: entryAlias },
          });
        } else {
          pages.push({
            registry_id: page.registry.id,
            entry: page.entry,
            registry_changed: false,
            entry_changed: false,
            changed: false,
            migration_required: { registry: registryAlias, entry: entryAlias },
          });
          migrationWarnings.push({
            code: "MIGRATION_REQUIRED",
            message:
              `'${registryAlias}' holds this artifact's slot but still carries the retired legacy names ` +
              `and does not register — '${page.registry.id}' was not installed; ${migrationHelp}`,
            severity: "warning",
          });
        }
        continue;
      }
    }
    const desiredBytes = Buffer.from(page.html, "utf8");
    let entryChanged = true;
    try {
      await writeBlob(bundle, page.entry, desiredBytes, undefined, { expectedVersion: null });
    } catch (err) {
      if (!(err instanceof VersionConflict)) throw err;
      const existing = await readBlob(bundle, page.entry);
      const sameBytes = existing !== null && Buffer.from(existing.bytes).equals(desiredBytes);
      const sameContentType = existing?.contentType === resolveContentType(page.entry);
      if (!sameBytes || !sameContentType) throw recipeAssetConflict(recipe.id, page.entry);
      entryChanged = false;
    }

    let registry = recipeDocumentForApply(page.registry, okfVersion, now);
    let registryChanged = true;
    try {
      registry = await createRecipeDocument(bundle, registry, okfVersion, now);
    } catch (err) {
      if (!(err instanceof VersionConflict)) throw err;
      const existing = await readDoc(bundle, registry.id);
      if (!sameInstalledDoc(existing, registry, okfVersion)) throw recipeAssetConflict(recipe.id, `${registry.id}.md`);
      registryChanged = false;
    }

    pages.push({
      registry_id: registry.id,
      entry: page.entry,
      registry_changed: registryChanged,
      entry_changed: entryChanged,
      changed: registryChanged || entryChanged,
    });
  }

  const references: RecipeReferenceResult[] = [];
  for (const reference of recipe.references) {
    let desired = recipeDocumentForApply(reference.doc, okfVersion, now);
    let changed = true;
    try {
      desired = await createRecipeDocument(bundle, desired, okfVersion, now);
    } catch (err) {
      if (!(err instanceof VersionConflict)) throw err;
      const existing = await readDoc(bundle, desired.id);
      if (!sameInstalledDoc(existing, desired, okfVersion)) throw recipeAssetConflict(recipe.id, `${desired.id}.md`);
      changed = false;
    }
    references.push({ id: desired.id, changed });
  }

  const artifacts: Array<{ changed: boolean; legacy_present?: unknown; migration_required?: unknown }> = [
    ...docs,
    ...pages,
    ...references,
  ];
  const sourceDiffers = docs.filter((doc) => doc.source_differs).length;
  const counts: ApplyRecipeCounts = {
    created: artifacts.filter((a) => a.changed).length,
    existing: artifacts.filter((a) =>
      !a.changed && a.legacy_present === undefined && a.migration_required === undefined &&
      !("source_differs" in a && a.source_differs === true)
    )
      .length,
    legacy_present: artifacts.filter((a) => a.legacy_present !== undefined).length,
    migration_required: artifacts.filter((a) => a.migration_required !== undefined).length,
    ...(sourceDiffers > 0 ? { source_differs: sourceDiffers } : {}),
  };

  return {
    id: recipe.id,
    version: recipe.version,
    source: recipe.source,
    docs,
    pages,
    references,
    counts,
    changed:
      docs.some((d) => d.changed) ||
      pages.some((page) => page.changed) ||
      references.some((reference) => reference.changed),
    warnings: [...recipe.warnings, ...migrationWarnings],
  };
}

async function assertPortableTargetsCompatible(
  bundle: Bundle,
  recipe: LoadedRecipe,
  now: string,
  okfVersion: string,
): Promise<void> {
  const registries = new Map<ConceptId, OkfDocument>();
  if (recipe.pages.length > 0) {
    // Both accepted registry prefixes (views-registry/ current, pages-registry/ legacy) — the
    // query takes ONE prefix, so run it per prefix and merge (ids never collide across prefixes).
    for (const prefix of [PAGE_REGISTRY_PREFIX, VIEW_REGISTRY_PREFIX]) {
      const registryDocs = await query(bundle, { prefix });
      for (const doc of registryDocs) registries.set(doc.id, doc);
    }
  }
  for (const page of recipe.pages) {
    const existingBlob = await readBlob(bundle, page.entry);
    if (existingBlob) {
      const desiredBytes = Buffer.from(page.html, "utf8");
      const sameBytes = Buffer.from(existingBlob.bytes).equals(desiredBytes);
      const sameContentType = existingBlob.contentType === resolveContentType(page.entry);
      if (!sameBytes || !sameContentType) throw recipeAssetConflict(recipe.id, page.entry);
    }

    const existingRegistry = registries.get(page.registry.id);
    if (existingRegistry) {
      const desiredRegistry = recipeDocumentForApply(page.registry, okfVersion, now);
      if (!sameInstalledDoc(existingRegistry, desiredRegistry, okfVersion)) {
        throw recipeAssetConflict(recipe.id, `${page.registry.id}.md`);
      }
    }
  }

  const installedReferences = new Map<ConceptId, OkfDocument>();
  if (recipe.references.length > 0) {
    const referenceDocs = await query(bundle, { prefix: "references/" });
    for (const doc of referenceDocs) installedReferences.set(doc.id, doc);
  }
  for (const reference of recipe.references) {
    const existing = installedReferences.get(reference.doc.id);
    if (!existing) continue;
    const desired = recipeDocumentForApply(reference.doc, okfVersion, now);
    if (!sameInstalledDoc(existing, desired, okfVersion)) {
      throw recipeAssetConflict(recipe.id, `${reference.doc.id}.md`);
    }
  }
}

export function sameInstalledDoc(existing: OkfDocument, desired: OkfDocument, okfVersion: string): boolean {
  const { timestamp: _existingTimestamp, ...existingFrontmatter } = existing.frontmatter;
  const { timestamp: _desiredTimestamp, ...desiredFrontmatter } = desired.frontmatter;
  if (okfVersion === "0.2") {
    for (const frontmatter of [existingFrontmatter, desiredFrontmatter]) {
      const generated = plainRecord(frontmatter.generated);
      if (!generated) continue;
      const { at: _at, ...rest } = generated;
      frontmatter.generated = rest;
    }
  }
  return isDeepStrictEqual(existingFrontmatter, desiredFrontmatter) && existing.body === desired.body;
}

function recipeAssetConflict(recipeId: string, key: string): CliError {
  return new CliError(
    "ALREADY_EXISTS",
    `recipe '${recipeId}' cannot install '${key}' because a different target already exists; ` +
      "the existing bundle content was left untouched",
    { details: { recipe: recipeId, key } },
  );
}

/**
 * The convention docs currently present under `conventions/`, by id — ONE round-trip
 * (backend-agnostic, works over `--remote`), used by `recipes` to report whether a built-in is
 * already applied to `bundle` (every one of its docs' ids present) AND whether any installed
 * doc's content differs from the recipe source (the listing's `drift` bit). The query was always
 * a full read; returning the docs instead of discarding their content costs zero added I/O.
 */
export async function appliedConventionDocs(bundle: Bundle): Promise<Map<ConceptId, OkfDocument>> {
  const docs = await query(bundle, { prefix: CONVENTIONS_PREFIX });
  return new Map(docs.map((d) => [d.id, d]));
}

/**
 * True when at least one of `recipe`'s installed docs differs in content from the recipe source
 * (the same `sameInstalledDoc` comparison `recipe add` makes; timestamp-insensitive). Honest at
 * the literal level only: drift can be DELIBERATE — a dismissal record occupying the canonical
 * id, or a kind legitimately evolved via `kind field add` / `recipe evolve`. The listing pairs
 * the bit with descriptive help and NO fixing command (design appendix O2): a proactive "fix"
 * pointer here would re-propose exactly what a `kind dismiss` recorded declining.
 */
export function recipeDrifts(
  recipe: LoadedRecipe,
  installed: Map<ConceptId, OkfDocument>,
  okfVersion: string,
  now: string,
): boolean {
  const materialized = materializeRecipeForEdition(recipe, okfVersion);
  return materialized.docs.some((doc) => {
    const existing = installed.get(doc.id);
    return existing !== undefined && !sameInstalledDoc(existing, recipeDocumentForApply(doc, okfVersion, now), okfVersion);
  });
}

/** True when every convention doc `recipe` installs is already present in `appliedIds`. */
export function isRecipeApplied(recipe: LoadedRecipe, appliedIds: Set<ConceptId>): boolean {
  return recipe.docs.every((doc) => appliedIds.has(doc.id));
}
