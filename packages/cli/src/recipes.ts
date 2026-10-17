// The CLI's built-in recipe CONTENT, starting with `context-notes` ("recipe zero").
//
// This is where Context Note SEEDING lives (moved out of `packages/core`: "the
// engine special-cases NOTHING about conventions"). Core owns the generic install and evolution
// semantics (`@superbee/core/recipe-lifecycle`) and the generic `kindConventionDoc` serializer;
// this module supplies the SPECIFIC content (each built-in kind's convention + seed prose body,
// plus the built-in recipes' manifest text) that `recipe-source-builtin.ts` serializes into recipe
// files for `parseRecipeFiles`, the ONE parse+validate path built-in and external recipes share.
//
// `context-notes` (recipe zero) is the spec-test that a recipe must model a convention doc WITH A
// BODY, not just bare frontmatter — `CONTEXT_NOTE_SEED_BODY` is the in-bundle authoring reference
// for kind conventions (see its own doc comment below).
import { PROGRESS_STATUS_FIELD, type KindConvention } from "@superbee/core";

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
 * materializer (core's `materializeRecipeForEdition`, which owns the token's interpretation) can
 * teach the physical workflow coordinate appropriate to the target OKF edition; `recipes.test.ts`
 * pins that an installed body equals `CONTEXT_NOTE_SEED_BODY` and carries no token.
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
