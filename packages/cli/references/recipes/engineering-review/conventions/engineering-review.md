---
type: Convention
title: Engineering Review
governs: Engineering Review
path: engineering-reviews/
description: One point-in-time verdict bound to one immutable target version, with the scope actually covered and the attacks the target survived.
links:
  answers: Engineering Review Request
  supersedes: Engineering Review
link_descriptions:
  answers: The request this round responds to.
  supersedes: The previous round this one replaces, because the target version moved.
expects_inbound:
  raised by: Review Finding
fields:
  required: [title, target, target_version, verdict, reviewer, round]
  optional: [scope_covered, scope_not_covered, probes_run, evidence_inspected, reviewed_at]
  values:
    verdict: [approved, changes_requested, blocked, inconclusive, superseded]
  value_descriptions:
    verdict:
      approved: This exact target version met the acceptance criteria; terminal for this round.
      changes_requested: Findings must be addressed and a new round opened against the repaired version.
      blocked: The review could not proceed - the target was unbuildable, unreachable, or misidentified.
      inconclusive: The review ran but the evidence available cannot settle the question; say what is missing.
      superseded: A later round against a newer target version replaced this one; terminal for this round.
  terminal:
    verdict: [approved, superseded]
  descriptions:
    title: A concise label for this round's outcome.
    target: The artifact reviewed - the same name the request used.
    target_version: The immutable version every claim in this round applies to, such as a commit SHA or a released artifact version.
    verdict: The persisted outcome of this round.
    reviewer: Who produced the verdict; coordination metadata, not authorization.
    round: The round number within this request, counting from 1.
    scope_covered: What was actually read and exercised.
    scope_not_covered: What was in scope but deliberately or unavoidably left unexamined.
    probes_run: The checks actually executed, not the checks intended.
    evidence_inspected: Existing evidence reused rather than reproduced, such as an exact-SHA CI run.
    reviewed_at: The ISO 8601 timestamp at which the verdict was recorded.
freshness_horizon: 90d
sections: [Scope covered, Findings, Evidence, Survived attacks, Unresolved risks]
---
# Engineering Review

A review is a claim about one immutable version. `target_version` is required so that claim cannot
float: when the target moves, this round does not follow it. Open a new round, link it with
`supersedes`, and set this one's verdict to `superseded`. A repaired head is an unreviewed head
until a round says otherwise.

Record what was NOT covered as deliberately as what was. `scope_not_covered` and the
`Unresolved risks` section are the difference between "I found no problems" and "I looked here and
found no problems" - only the second is useful to the next reader.

`Survived attacks` is where a review earns its verdict. Name the specific things you tried to break
and could not; a section that only restates the implementation is a summary, not a review.

Each defect worth tracking becomes its own `Review Finding` linked back here with `raised by`, so it
keeps its identity, its disposition, and its repair evidence across rounds. Prose in this document
never becomes the authority for whether a finding is resolved.
