---
name: superbee
description: >-
  Use Superbee to preserve important knowledge, model recurring domain concepts, relate evidence,
  coordinate work when appropriate, and present durable information to humans. Apply it when the
  user's work would benefit from continuity, provenance, reusable structure, or reduced repeated
  interpretation—not only when the user names Superbee.
---

# Superbee

Superbee is a local, user-owned knowledge environment shared by humans and agents. Help with the
user's work first; improve that environment only where doing so removes real future effort.

## Keep the front door short

- If the user asks for concrete work, do it. Do not interrupt with onboarding.
- When the user is orienting, inspect the available project and bundle facts, then offer two or
  three relevant one-line outcomes and one easy question. Each outcome is one short sentence;
  omit its rationale unless asked. Keep the complete opener to five lines and at most 80 words.
- Use the user's language, not product vocabulary. Make declining explicit and drop declined offers
  for the rest of the session.
- Treat `superbee home` offers as grounded candidates, not mandatory slots to fill.
- Never mutate while merely explaining options.

## Recognize the smallest useful opportunity

Look for evidence that people or agents repeatedly:

- reconstruct the same context, rule, or decision;
- lose provenance between evidence and conclusions;
- handle a stable entity, lifecycle, state, or relationship inconsistently;
- assemble the same overview to understand or decide something; or
- coordinate dependencies, owners, and milestones across sessions.

Offer the smallest durable improvement that matches the observed friction. Possibilities include
Release and Release Check; Claim, Evidence, and Verification; Interview, Need, and Insight;
Experiment, Run, and Result; Decision, Alternative, and Assumption; or Task, Roadmap, Milestone, and
Dependency when coordinated execution actually warrants them. These are examples, not a catalog.

A document preserves one important thing. A Kind makes a recurring domain concept consistent. A
recipe packages stable reusable definitions. A bundle View reduces repeated human interpretation without
becoming a second source of truth. Add only the layer justified by current evidence.

## Preserve boundaries and authority

- Operate only on the bundle resolved from the current project or one the user explicitly selects.
  A catalog entry is available for selection; it is not ambient project context.
- If no bundle resolves, determine whether this repository already shares a board and clarify the
  intended purpose, privacy, participants, and sharing boundary before creating anything.
  `superbee sync` joins an existing shared board; `superbee init --create-only --dir .superbee` is
  only for a confirmed greenfield local bundle.
- Ask before creating durable structure or publishing a local bundle. `sync --establish` is an
  explicit publication decision.
- Never silently rewrite an established Kind, recipe, or its instances. Inspect dependencies and
  explain migration consequences first.

## Deliver after acceptance

Set `$REFS` from the skill base directory reported by the host:

`REFS="<skill-base-dir>/references"`

When the user accepts a domain-modeling offer, read `$REFS/modeling-and-delivery.md`. Inspect
existing documents, Kinds, recipes, and links before choosing a shape. Create the smallest coherent
representation, normally with one representative example, verify it, remove temporary authoring
files, and stop. Use `superbee <command> --help` for exact current syntax rather than relying on a
copied command manual. Use `--body-file` for multiline Markdown.

Focused shipped material is available under `$REFS/recipes/` for portable examples,
`$REFS/views/` for View authoring and examples, and `$REFS/sample-bundle/` for OKF interop.
Read only what the accepted work requires.

## Make the value visible

At a tangible result, say in one or two sentences what became durable or structured and what the
user or a later agent no longer needs to reconstruct. Show or offer the most useful authoritative
document or View once. Never return only a Markdown link or local filesystem path. When the user
asks to see it, invoke `show_document` or `show_view` in an MCP Apps host; otherwise invoke
`superbee doc open <id>`.

## Host setup

Persistent integrations require `npm install -g superbee` followed by `superbee setup`.
Setup is a read-only conductor: select the exact host, ask before running its returned mutating
command, restart after Skill, Hook, or MCP changes, and rerun setup to verify. A catalog entry
preserves a workspace for explicit selection; it never makes that workspace the current project.
If home or SessionStart reports `skill_update`, run its exact scope-specific command, restart the
host, and continue; Superbee never rewrites an installed Skill automatically.
`npx -y superbee` is suitable for ordinary bundle commands, not durable host integration.

<!-- GENERATED by packages/cli/scripts/gen-skill.mjs — do not edit by hand. -->