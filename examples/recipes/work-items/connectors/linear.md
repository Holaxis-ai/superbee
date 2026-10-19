---
type: Connector
title: Linear issues (offline mapping)
description: Fixture-only Linear mapping on the shared Work Item fields; no provider transport or credentials.
version: "1"
auth: { kind: none }
domains: []
record_sources:
  - name: issues
    profile: linear-issues-fixture
    target_kind: Work Item
    mode: overlay
    identity:
      resource: "https://linear.app/team/{team}"
      id: "{id}"
    fields:
      title: title
      key: identifier
      url: url
      scope: team_key
      source_state: state_name
      state_category:
        from: state_type
        values: { triage: todo, backlog: todo, unstarted: todo, started: in_progress, completed: done, canceled: canceled, duplicate: canceled }
        unmapped: keep
      close_reason:
        from: close_reason
        values: { completed: completed, not_planned: not_planned, duplicate: duplicate }
        unmapped: keep
      priority:
        from: priority
        values: { "0": none, "1": urgent, "2": high, "3": medium, "4": low }
        unmapped: keep
      estimate: estimate
      labels: labels
      assignees: assignees
      opened_at: created_at
      source_updated_at: updated_at
      closed_at: closed_at
      due_on: due_on
      source_presence:
        from: source_presence
        values: { present: present, archived: archived, gone: gone }
        unmapped: keep
    completeness: partial
actions: []
events: []
---
# Linear issues

Inert mapping example only. No request, credential provider or admitted GraphQL profile is
installed. Team UUID scopes identity; team key is display metadata. Explicit archived and trashed
rows map presence, but absence from a fixture page never proves disappearance.
