---
type: Convention
title: Signal
governs: Signal
path: signals/
description: A durable, claimable flag that a monitored source changed in a way that needs judgment. Created deterministically; acted on by an agent or human.
links:
  from feed: Source Feed
claim:
  owner_field: assignee
  state_field: progress_status
fields:
  required:
    - title
    - progress_status
    - change_kind
    - observed_at
  optional:
    - provider
    - external_id
    - diff_summary
    - priority
    - assignee
    - resolution
    - expires_at
    - content_digest
    - about_doc
  types:
    observed_at: datetime
    expires_at: datetime
  values:
    progress_status:
      - todo
      - in_progress
      - done
      - dismissed
    priority:
      - urgent
      - normal
      - low
  terminal:
    progress_status:
      - done
      - dismissed
  descriptions:
    change_kind: 'What changed, in the vocabulary of whoever raised the Signal: new, changed, canceled, disappeared, page-changed, status-check, or a kind a profile or intake defines.'
    provider: The monitored source, as its feed URL or a tool name.
    external_id: The provider's id for the record the Signal is about.
    diff_summary: What changed, in one paragraph a claimant can judge without opening the source.
    resolution: What was done and why, written by whoever closed the signal.
    content_digest: Digest of the observed external record that raised this signal; used to deduplicate and collapse repeated changes.
    about_doc: Document id the signal concerns (cross-bundle references are not links).
freshness_horizon: 14d
---
# Signal

A durable, claimable flag that a monitored source changed in a way that needs judgment. Created
deterministically; acted on by an agent or human.
