---
type: Recipe
id: work-items
title: Work Items
version: "1"
summary: Tracker work items with normalized and source-native state; GitHub scalar mapping as an offline example.
content_policy: definitions-only
connectors: [connectors/github.md]
---
# Work Items

An example model for external tracker items. Install `source-feeds` first, then this recipe:

```sh
superbee recipe add examples/recipes/source-feeds
superbee recipe add examples/recipes/work-items
```

The recipe installs one Work Item convention and one GitHub Connector definition. Installing it
creates no Work Items, credentials or running integration. The GitHub mapping is proven only with
synthetic offline fixtures in `examples/integrations/work-items-github`, not a live GitHub profile.

The first mapping owns scalar facts. Labels, assignees, notes, tags, priority and estimates remain
human-owned. The convention declares list fields for future mappings; it does not give this
Connector ownership of them. Source-mapped lists, Linear, synced relationships, mirror mode and
live execution are separate increments. The built-in Task recipe is unchanged.
