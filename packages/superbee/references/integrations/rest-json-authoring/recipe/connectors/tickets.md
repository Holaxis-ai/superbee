---
type: Connector
title: Recorded ticket board
auth:
  kind: none
domains:
  - tickets.example.org
record_sources:
  - name: tickets
    profile: rest-json
    target_kind: Ticket
    mode: overlay
    identity:
      resource: https://tickets.example.org/boards/{board}
      id: '{id}'
    fields:
      title: title
      state:
        from: status
        values: { OPEN: open, DONE: closed }
        unmapped: keep
      priority:
        from: priority
        values: { low: low, high: high }
      url: html_url
    completeness: complete
    request:
      host: tickets.example.org
      method: GET
      path: /boards/{board}/items
      query:
        after: '{cursor}'
      items: items
      paging:
        kind: cursor
        cursor_path: next
      complete: always
---
# Recorded ticket board

All provider responses are synthetic. This declaration selects the shipped public rest-json
profile, never executable code from this directory.
