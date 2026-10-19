---
type: Recipe
id: work-items
title: Work Items
version: "1"
summary: Tracker work items with normalized and source-native state; GitHub and inert Linear mappings as offline examples.
content_policy: definitions-only
connectors: [connectors/github.md, connectors/linear.md]
---
# Work Items

An example model for external tracker items. Install `source-feeds` first, then this recipe:

```sh
superbee recipe add examples/recipes/source-feeds
superbee recipe add examples/recipes/work-items
```

The recipe installs one Work Item convention and two Connector definitions. Installation creates
no Work Items, credentials or running integration. GitHub selects the first-party profile;
Linear is an explicit offline mapping double with no admitted profile or request authority.

Both mappings own their declared scalar and list facts; people retain body, notes, tags and
fields outside the selected feed's ownership. Linear additionally maps priority and estimate.
Recorded fixtures live in `examples/integrations/work-items-github` and
`examples/integrations/work-items-linear`. Relationships, mirror mode and live execution
remain separate work. The built-in Task recipe is unchanged.
