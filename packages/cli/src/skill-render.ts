// Pure renderer for the npm-carried SKILL.md. gen-skill.mjs bundles this module in memory and
// writes the committed package projection. NO I/O: the eager Skill contains judgment and safety
// boundaries; the live CLI remains the syntax authority and focused references carry accepted
// cross-command workflows.
import { commandName } from "./reference.js";
import { NPM_RESOURCES } from "./distribution-resources.js";

export { NPM_RESOURCES, commandName };

const NPM_COORDINATE = "superbee";
const NPX = `npx -y ${NPM_COORDINATE}`;

export function renderNpm(): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("name: superbee");
  lines.push("description: >-");
  lines.push(
    "  Use Superbee to preserve important knowledge, model recurring domain concepts, relate evidence,",
  );
  lines.push(
    "  coordinate work when appropriate, and present durable information to humans. Apply it when the",
  );
  lines.push(
    "  user's work would benefit from continuity, provenance, reusable structure, or reduced repeated",
  );
  lines.push("  interpretation—not only when the user names Superbee.");
  lines.push("---");
  lines.push("");
  lines.push("# Superbee");
  lines.push("");
  lines.push("Superbee is a local, user-owned knowledge environment shared by humans and agents. Help with the");
  lines.push("user's work first; improve that environment only where doing so removes real future effort.");
  lines.push("");
  lines.push("## Keep the front door short");
  lines.push("");
  lines.push("- If the user asks for concrete work, do it. Do not interrupt with onboarding.");
  lines.push("- When the user is orienting, inspect the available project and bundle facts, then offer two or");
  lines.push("  three relevant one-line outcomes and one easy question. Each outcome is one short sentence;");
  lines.push("  omit its rationale unless asked. Keep the complete opener to five lines and at most 80 words.");
  lines.push("- Use the user's language, not product vocabulary. Make declining explicit and drop declined offers");
  lines.push("  for the rest of the session.");
  lines.push("- Treat `superbee home` offers as grounded candidates, not mandatory slots to fill.");
  lines.push("- Never mutate while merely explaining options.");
  lines.push("");
  lines.push("## Recognize the smallest useful opportunity");
  lines.push("");
  lines.push("Look for evidence that people or agents repeatedly:");
  lines.push("");
  lines.push("- reconstruct the same context, rule, or decision;");
  lines.push("- lose provenance between evidence and conclusions;");
  lines.push("- handle a stable entity, lifecycle, state, or relationship inconsistently;");
  lines.push("- assemble the same overview to understand or decide something; or");
  lines.push("- coordinate dependencies, owners, and milestones across sessions.");
  lines.push("");
  lines.push("Offer the smallest durable improvement that matches the observed friction. Possibilities include");
  lines.push("Release and Release Check; Claim, Evidence, and Verification; Interview, Need, and Insight;");
  lines.push("Experiment, Run, and Result; Decision, Alternative, and Assumption; or Task, Roadmap, Milestone, and");
  lines.push("Dependency when coordinated execution actually warrants them. These are examples, not a catalog.");
  lines.push("");
  lines.push("A document preserves one important thing. A Kind makes a recurring domain concept consistent. A");
  lines.push("recipe packages stable reusable definitions. A bundle View reduces repeated human interpretation without");
  lines.push("becoming a second source of truth. Add only the layer justified by current evidence.");
  lines.push("");
  lines.push("## Preserve boundaries and authority");
  lines.push("");
  lines.push("- Operate only on the bundle resolved from the current project or one the user explicitly selects.");
  lines.push("  A catalog entry is available for selection; it is not ambient project context.");
  lines.push("- If no bundle resolves, determine whether this repository already shares a board and clarify the");
  lines.push("  intended purpose, privacy, participants, and sharing boundary before creating anything.");
  lines.push("  `superbee sync` joins an existing shared board; `superbee init --create-only --dir .superbee` is");
  lines.push("  only for a confirmed greenfield local bundle.");
  lines.push("- Ask before creating durable structure or publishing a local bundle. `sync --establish` is an");
  lines.push("  explicit publication decision.");
  lines.push("- Never silently rewrite an established Kind, recipe, or its instances. Inspect dependencies and");
  lines.push("  explain migration consequences first.");
  lines.push("");
  lines.push("## Deliver after acceptance");
  lines.push("");
  lines.push("Set `$REFS` from the skill base directory reported by the host:");
  lines.push("");
  lines.push('`REFS="<skill-base-dir>/references"`');
  lines.push("");
  lines.push("When the user accepts a domain-modeling offer, read `$REFS/modeling-and-delivery.md`. Inspect");
  lines.push("existing documents, Kinds, recipes, and links before choosing a shape. Create the smallest coherent");
  lines.push("representation, normally with one representative example, verify it, remove temporary authoring");
  lines.push("files, and stop. Use `superbee <command> --help` for exact current syntax rather than relying on a");
  lines.push("copied command manual. Use `--body-file` for multiline Markdown.");
  lines.push("");
  lines.push("Focused shipped material is available under `$REFS/recipes/` for portable examples,");
  lines.push("`$REFS/views/` for View authoring and examples, and `$REFS/sample-bundle/` for OKF interop.");
  lines.push("Read only what the accepted work requires.");
  lines.push("");
  lines.push("## Make the value visible");
  lines.push("");
  lines.push("At a tangible result, say in one or two sentences what became durable or structured and what the");
  lines.push("user or a later agent no longer needs to reconstruct. Show or offer the most useful authoritative");
  lines.push("document or View once. Never return only a Markdown link or local filesystem path. When the user");
  lines.push("asks to see it, invoke `show_document` or `show_view` in an MCP Apps host; otherwise invoke");
  lines.push("`superbee doc open <id>`.");
  lines.push("");
  lines.push("## Host setup");
  lines.push("");
  lines.push(`Persistent integrations require \`npm install -g ${NPM_COORDINATE}\` followed by \`superbee setup\`.`);
  lines.push("Setup is a read-only conductor: select the exact host, ask before running its returned mutating");
  lines.push("command, restart after Skill, Hook, or MCP changes, and rerun setup to verify. A catalog entry");
  lines.push("preserves a workspace for explicit selection; it never makes that workspace the current project.");
  lines.push(`\`${NPX}\` is suitable for ordinary bundle commands, not durable host integration.`);
  lines.push("");
  lines.push("<!-- GENERATED by packages/cli/scripts/gen-skill.mjs — do not edit by hand. -->");
  return lines.join("\n");
}
