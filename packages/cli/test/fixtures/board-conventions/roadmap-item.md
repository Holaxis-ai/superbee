---
type: Convention
title: Roadmap Item
governs: Roadmap Item
path: roadmap-items/
links:
  contains: Task
link_descriptions:
  contains: Tasks whose delivery is governed by this roadmap commitment.
fields:
  required:
    - title
    - superbee_progress_status
  optional:
    - description
    - sequence
  values:
    superbee_progress_status:
      - queued
      - active
      - done
  terminal:
    superbee_progress_status:
      - done
---

# Roadmap Item

A durable line of work spanning multiple tasks — the granular form of the single
`roadmap` spine doc. An item CONTAINS its tasks via links carrying the text `contains`
(a prose convention: the engine's links are untyped today — this recipe is the live test
of where that hurts). Backlinks from a task answer "which item owns this"; an item's
progress is DERIVED, never stored: list its contained tasks and read their workflow state (the
rollup). `progress_status` tracks the item itself: `queued` (not started) → `active` (any
contained task moving) → `done` (all contained tasks done or canceled). `done` is
TERMINAL: `list --open` excludes done items (Brian's ruling, `tasks/status-terminal-declaration.md`).
