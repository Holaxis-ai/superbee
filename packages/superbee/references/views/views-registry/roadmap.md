---
type: View
title: Roadmap
entry: views/roadmap.html
description: Live graph view — Roadmap Items grouped by status, each expandable to its contained tasks with a derived rollup bar.
access: bundle-read
actor: mike/claude
timestamp: "2026-07-09T00:00:01.000Z"
---
Roadmap Items grouped into In motion / Committed / Candidate / Done, each expandable to the tasks
it `contains` (fetched with one call to the bridge's `edges` request) with a derived done/total
rollup bar. Updates to either an item or one of its tasks stream in live, no reload.
