import { CLI_COMMAND_GROUPS } from "./command-spec.js";
import { commandName } from "./reference.js";

// One inventory owns auxiliary contracts, portable recipes, examples, and fixtures. A channel is
// only a projection target; it is never the source of truth. Both channels project these files
// under their references/ folder: the skill under plugins/…/skills/agentstate-lite/references/,
// npm under packages/cli/references/ (committed, shipped in the tarball via package.json `files`).
// The npm projection MIRRORS the skill projection dest-for-dest so one dest namespace serves the
// command/capability tables for both channels.

export const DISTRIBUTION_CHANNELS = ["skill", "npm"] as const;
export type DistributionChannel = (typeof DISTRIBUTION_CHANNELS)[number];

export const RESOURCE_ROLES = [
  "operating-reference",
  "portable-recipe",
  "worked-example",
  "interop-fixture",
] as const;
export type ResourceRole = (typeof RESOURCE_ROLES)[number];

export interface DistributionResource {
  /** Repo-root-relative authority. Generated plugin files are never authorities. */
  src: string;
  role: ResourceRole;
  /** Destination within each channel's optional auxiliary-resource root. */
  targets: Partial<Record<DistributionChannel, string>>;
}

export interface ProjectedResource {
  src: string;
  dest: string;
}

type SourceDestination = readonly [src: string, dest: string];

function allChannels(role: ResourceRole, entries: readonly SourceDestination[]): DistributionResource[] {
  return entries.map(([src, dest]) => ({ src, role, targets: { skill: dest, npm: dest } }));
}

export const DISTRIBUTION_RESOURCES: DistributionResource[] = [
  ...allChannels("operating-reference", [
    ["examples/views/references/view-authoring-v0.md", "views/references/view-authoring-v0.md"],
  ]),

  // Bundle View worked examples. View-bearing recipes carry their own required operating model.
  // Both columns renamed pages→views with the kind (the dest column is the skill's shipped
  // resource namespace — regenerated atomically with the SKILL.md prose that points at it).
  ...allChannels("worked-example", [
    ["examples/views/pulse.html", "views/pulse.html"],
    ["examples/views/roadmap.html", "views/roadmap.html"],
    ["examples/views/about.html", "views/about.html"],
    ["examples/views/conventions/view.md", "views/conventions/view.md"],
    ["examples/views/views-registry/pulse.md", "views/views-registry/pulse.md"],
    ["examples/views/views-registry/roadmap.md", "views/views-registry/roadmap.md"],
    ["examples/views/views-registry/about.md", "views/views-registry/about.md"],
  ]),

  // Installable definitions: the Claims example and the complete Review Workflow package.
  ...allChannels("portable-recipe", [
    ["examples/recipes/claims/recipe.md", "recipes/claims/recipe.md"],
    ["examples/recipes/claims/conventions/claim.md", "recipes/claims/conventions/claim.md"],
    ["examples/recipes/review-workflow/recipe.md", "recipes/review-workflow/recipe.md"],
    [
      "examples/recipes/review-workflow/conventions/review-request.md",
      "recipes/review-workflow/conventions/review-request.md",
    ],
    ["examples/recipes/review-workflow/conventions/view.md", "recipes/review-workflow/conventions/view.md"],
    [
      "examples/recipes/review-workflow/views-registry/review-workflow-reviews.md",
      "recipes/review-workflow/views-registry/review-workflow-reviews.md",
    ],
    [
      "examples/recipes/review-workflow/views/review-workflow/reviews.html",
      "recipes/review-workflow/views/review-workflow/reviews.html",
    ],
    [
      "examples/recipes/review-workflow/references/view-authoring-v0.md",
      "recipes/review-workflow/references/view-authoring-v0.md",
    ],
  ]),

  // Externally-shaped OKF interoperability fixture; never installed into an ordinary bundle.
  ...allChannels("interop-fixture", [
    ["examples/sample-bundle/index.md", "sample-bundle/index.md"],
    ["examples/sample-bundle/log.md", "sample-bundle/log.md"],
    ["examples/sample-bundle/concepts/index.md", "sample-bundle/concepts/index.md"],
    ["examples/sample-bundle/concepts/link-graph.md", "sample-bundle/concepts/link-graph.md"],
    ["examples/sample-bundle/concepts/okf-alignment.md", "sample-bundle/concepts/okf-alignment.md"],
    ["examples/sample-bundle/context-notes/index.md", "sample-bundle/context-notes/index.md"],
    [
      "examples/sample-bundle/context-notes/cycle-okf-lite-vision.md",
      "sample-bundle/context-notes/cycle-okf-lite-vision.md",
    ],
    ["examples/sample-bundle/references/index.md", "sample-bundle/references/index.md"],
    ["examples/sample-bundle/references/okf-spec.md", "sample-bundle/references/okf-spec.md"],
  ]),
];

export function projectResources(channel: DistributionChannel): ProjectedResource[] {
  return DISTRIBUTION_RESOURCES.flatMap(({ src, targets }) => {
    const dest = targets[channel];
    return dest === undefined ? [] : [{ src, dest }];
  });
}

/** The plugin-skill projection (plugins/…/skills/agentstate-lite/references/). */
export const SKILL_RESOURCES = projectResources("skill");
/** The npm projection (packages/cli/references/, shipped in the tarball) — mirrors SKILL_RESOURCES. */
export const NPM_RESOURCES = projectResources("npm");

// NOT DISTRIBUTED: the wire-protocol v0.1 contract currently lives only as project-bundle doc
// `docs/wire-protocol`. Shipping it requires a tracked distribution-neutral source or a
// bundle-aware release input; neither belongs in this ownership-only unit.

/**
 * Every command NAME (as {@link commandName} in reference.ts would extract it from a usage
 * string) mapped to the shipped-reference `dest`s its advertised capability depends on. Because
 * the npm projection mirrors the skill projection, ONE table serves both channels. `[]` means
 * self-contained — true of most commands. Empty defaults are projected from the canonical command
 * graph, so a newly advertised row cannot be omitted from this resource inventory.
 */
const SKILL_COMMAND_RESOURCE_OVERRIDES = {
  "recipe add": ["recipes/claims/recipe.md", "recipes/review-workflow/recipe.md"],
  ui: ["views/references/view-authoring-v0.md"],
} as const satisfies Partial<Record<string, readonly string[]>>;

const advertisedCommandNames = [
  ...new Set(CLI_COMMAND_GROUPS.flatMap((group) => group.commands.map((row) => commandName(row.usage)))),
];

export const SKILL_COMMAND_RESOURCES: Record<string, string[]> = Object.fromEntries(
  advertisedCommandNames.map((name) => [
    name,
    [...(SKILL_COMMAND_RESOURCE_OVERRIDES[name as keyof typeof SKILL_COMMAND_RESOURCE_OVERRIDES] ?? [])],
  ]),
);

/** One prose-level tripwire over BOTH rendered SKILL.md channels. */
export interface SkillCapabilityPattern {
  pattern: RegExp;
  requires: string[];
}

/**
 * Checked against the ACTUAL rendered SKILL.md of each channel by test/skill-distribution.test.ts,
 * which fails on a DEAD pattern (one that matches nothing in either rendered text) as well as on a
 * `requires` entry missing from a channel's projection.
 *
 * Honest limit: this cannot recognize a semantically novel capability described in prose that no
 * pattern below anticipates — command-shaped coverage comes from SKILL_COMMAND_RESOURCES' exhaustiveness
 * check above; adding a pattern row here is the same one-table discipline extended to free prose.
 */
export const SKILL_CAPABILITY_PATTERNS: SkillCapabilityPattern[] = [
  {
    // `type: Page` stays in the pattern: it is the accepted legacy kind name, and any prose
    // mentioning it (even a legacy note) must ship the authoring reference alongside.
    pattern: /type:\s*View|type:\s*Page|bundle view|postMessage|sandboxed iframe/i,
    requires: ["views/references/view-authoring-v0.md"],
  },
  {
    pattern: /recipe/i,
    requires: ["recipes/claims/recipe.md", "recipes/review-workflow/recipe.md"],
  },
];
