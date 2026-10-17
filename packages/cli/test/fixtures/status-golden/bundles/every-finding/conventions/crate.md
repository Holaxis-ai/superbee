---
type: Convention
title: Crate
governs: Crate
fields:
  required: [title]
  optional: [superbee_progress_status]
  values:
    superbee_progress_status: [queued, done]
  terminal:
    superbee_progress_status: [done]
expects_inbound:
  contains: Box
---
Crate expects an inbound contains edge from a Box.
