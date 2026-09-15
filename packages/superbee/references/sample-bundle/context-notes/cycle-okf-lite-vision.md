---
type: Context Note
title: cycle-okf-lite-vision
description: Handoff for the OKF-native Superbee vision cycle.
tags: [claude-orchestrator, superbee, cycle-okf-lite-vision]
timestamp: 2026-07-01T12:10:00Z
---
# Summary

This cycle established that Superbee should be OKF-native rather than a
store that merely exports to OKF. Notes, links, and freshness map cleanly onto
OKF concept docs, markdown links, and the `timestamp` field; remote sync is
deferred to a later adapter. Treat the OKF mapping as settled; treat the exact
cross-link form (relative vs absolute) as a deliberate, documented choice.

# Decisions

* Emit **relative** cross-links in produced bundles.
  Rationale: relative links populate the reference visualizer's edge/backlink
  graph, which skips absolute links.

# Open Questions

* Should the producer mirror Google's stricter `type+title+description+timestamp`
  requirement, or only the spec's single required `type`? Unresolved until we
  see how minimal real notes get.

# Pointers

* [OKF Alignment](../concepts/okf-alignment.md) — the concept that records the
  full mapping this cycle settled.
* [Open Knowledge Format v0.1 (Draft)](../references/okf-spec.md) — the spec the
  decisions above are grounded in.
