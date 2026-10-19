---
type: Recipe
id: source-feeds
title: Source Feeds
version: "1"
summary: Monitored sources with the fields they own, and claimable Signals for the changes that need judgment.
content_policy: definitions-only
---
# Source Feeds

Installs the two Kinds a monitored integration needs: `Source Feed`, a source and the policy for
what its changes may do, and `Signal`, a durable, claimable flag that a source changed in a way that
needs judgment. `@superbee/core/record-overlay` reads a Source Feed as its policy and creates
Signals of this shape.

A keyless feed (an iCalendar URL, an RSS feed) sets `feed_kind` and `url`. A feed backed by a
declared Connector sets `feed_kind: connector`, `connector: connectors/<slug>`, `source: <name>` (an
entry of the Connector's `record_sources`) and a `url` the source's identity template admits; `bindSourceFeed` in `@superbee/core/connectors`
enforces the rest, and the source's `completeness` and `profile` win over the feed's.

This is an example recipe, installed by path (`superbee recipe add examples/recipes/source-feeds`).
Nothing runs a feed yet, so it is not offered in a bundle's home. A Signal's `change_kind` is open:
change kinds are the vocabulary of whoever raises the Signal.
