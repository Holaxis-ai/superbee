---
type: Convention
title: Shelf
governs: Shelf
fields:
  required: [title]
  optional: [status]
  values:
    status: [draft, stable, deprecated]
expects_inbound:
  holds: Box
---
A Shelf expects an inbound holds edge from a Box and carries a lifecycle status.
