---
type: Convention
title: Claim
governs: Claim
path: claims/
links:
  supersedes: Claim
fields:
  required:
    - title
    - progress_status
    - reason
  optional:
    - artifacts
    - evidence_command
    - evidence_commit
  values:
    progress_status:
      - active
      - challenged
      - locked
      - deprecated
---

# Claim

A data-derived finding with provenance and a verification lifecycle. The `title` IS the
claim: one sentence carrying the specific numbers. `progress_status` is the lifecycle —
`active` (filed) → `challenged` (under independent check) → `locked` (verified
end-to-end; citable in final outputs) — or `deprecated` (superseded; never deleted).
`reason` says how the number was derived or why it changed. `evidence_command` is the
exact command that reproduces the number; `evidence_commit` the commit it ran against;
`artifacts` points at supporting files.

Transitions are CAS writes: capture the head with `doc read <id> --field head_version`,
pass it as `--expected-version` — a racing writer is refused, never silently overwritten
(the ported `--parent-event-id` semantics). Locked claims change only by deprecation plus
a linked successor. Documents that cite a claim link to it; backlinks enumerate every
citation when the claim changes.
