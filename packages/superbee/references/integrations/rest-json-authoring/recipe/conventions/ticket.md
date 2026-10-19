---
type: Convention
title: Ticket
governs: Ticket
path: tickets/
fields:
  required: [title, state]
  optional: [priority, note, url]
  values:
    state: [open, closed]
    priority: [low, high]
---
# Ticket

A synthetic issue from an example board. A person's notes stay outside the source-owned fields.
