---
type: View
title: Pulse — activity feed
entry: views/pulse.html
description: Live activity feed — every bundle doc, newest first, with type filters, search, and a markdown detail pane.
access: bundle-read
actor: mike/claude
timestamp: "2026-07-09T00:00:00.000Z"
---
A live feed of every document in the bundle, newest first, grouped by recency with type filter
chips and a search box. Selecting a row opens a detail pane that renders the doc's body as
markdown, including clickable relative doc links. New writes stream in over the bridge's `change`
events and land with a brief highlight — no reload.
