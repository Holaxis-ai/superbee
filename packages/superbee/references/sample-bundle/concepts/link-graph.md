---
type: Concept
title: The Link Graph
description: How standard markdown links become an untyped directed graph with derived backlinks.
tags: [okf, links, graph]
timestamp: 2026-07-01T12:05:00Z
---
# Summary

OKF cross-links are ordinary markdown links `[text](target)` — never wikilinks.
A link `A -> B` is an *untyped* directed edge; the relationship kind lives in the
surrounding prose, not in a typed-edge slot. Backlinks are **derived**, not
stored: a consumer reverses the resolved edge set to compute "Cited by".

# Example

This concept explains the model that [OKF Alignment](./okf-alignment.md) depends
on, so the alignment note links here and this note links back — a two-way edge
the visualizer draws once and the backlink index reflects on both ends. The
governing rules are defined in the
[Open Knowledge Format v0.1 (Draft)](../references/okf-spec.md), §5.

# Citations

1. [Open Knowledge Format v0.1 (Draft)](../references/okf-spec.md)
