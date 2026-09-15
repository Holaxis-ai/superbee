---
type: Concept
title: OKF Alignment
description: How Superbee maps agent knowledge onto Open Knowledge Format primitives.
tags: [okf, design, mapping]
timestamp: 2026-07-01T12:00:00Z
---
# Summary

Superbee is an OKF-native store. Every agent artifact is one OKF concept
document: a markdown body with a YAML frontmatter block whose only required field
is `type`. Nothing here is a bespoke database record — it is the format itself.

# How it maps

* An agent **context note** becomes a concept doc — see the
  [cycle-okf-lite-vision](../context-notes/cycle-okf-lite-vision.md) note, whose
  `type` is `Context Note`.
* A **pointer** between notes becomes a standard markdown link, which the graph
  reverses into backlinks — see [The Link Graph](./link-graph.md).
* The format we conform to is the
  [Open Knowledge Format v0.1 (Draft)](../references/okf-spec.md).

# Citations

1. [Open Knowledge Format v0.1 (Draft)](../references/okf-spec.md)
