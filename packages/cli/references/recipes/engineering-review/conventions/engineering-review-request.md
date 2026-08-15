---
type: Convention
title: Engineering Review Request
governs: Engineering Review Request
path: engineering-review-requests/
description: A durable request for an independent review of one exact target version, stating the question, scope, risk tier, and the probes the reviewer must run.
links:
  supersedes: Engineering Review Request
link_descriptions:
  supersedes: A prior request this one replaces after the scope or target changed.
expects_inbound:
  answers: Engineering Review
fields:
  required: [title, progress_status, reviewer, requested_by, target, target_version, review_question, risk_tier]
  optional: [scope, non_goals, required_probes, budget, escalation_conditions, decided_at]
  values:
    progress_status: [requested, in_review, changes_requested, approved, canceled]
    risk_tier: [trivial, routine, high_risk]
  value_descriptions:
    progress_status:
      requested: Ready for the reviewer; no review round has started.
      in_review: A reviewer is actively working this request against the stated target version.
      changes_requested: The last round returned findings; the request waits on a repaired target.
      approved: A round approved this exact target version; terminal for this request.
      canceled: The requester withdrew the request; terminal for this request.
    risk_tier:
      trivial: Documentation, metadata, or test-only work with no runtime-behavior change.
      routine: Ordinary code change; one focused independent review of the exact target.
      high_risk: Security, concurrency, destructive-write, migration, or release mechanics; review plus adversarial QA.
  terminal:
    progress_status: [approved, canceled]
  descriptions:
    title: A concise label for the review being requested.
    progress_status: The persisted request lifecycle state, not an activity update.
    reviewer: The person or agent expected to produce the verdict; coordination metadata, not authorization.
    requested_by: Who is accountable for the scope, the evidence supplied, and resubmission.
    target: The artifact under review - a branch, package, document, or subsystem name.
    target_version: The immutable version review claims will apply to, such as a commit SHA or a released artifact version.
    review_question: The exact judgment the reviewer is asked to make.
    scope: What the reviewer should read and exercise.
    non_goals: What this round deliberately does not cover.
    required_probes: The checks the reviewer must actually run rather than reason about.
    budget: The effort ceiling agreed for this round.
    escalation_conditions: What would move this request to a higher risk tier mid-round.
    decided_at: The ISO 8601 timestamp at which the request reached a terminal status.
freshness_horizon: 30d
sections: [Scope, Acceptance criteria, Evidence to inspect, Non-goals]
---
# Engineering Review Request

State the target before the review starts, and state it exactly. `target_version` is the whole
point of this kind: a request that names a branch but no immutable version cannot produce a
verdict that stays true, because the branch moves underneath it.

The requester owns scope, acceptance criteria, and the evidence packet. The reviewer owns the
verdict. Neither owns the other's half, and a request that cannot state its acceptance criteria is
not ready to be reviewed.

`required_probes` exists because a review that only reads code confirms the reviewer's model, not
the system's behavior. Name the commands, fixtures, or artifacts the reviewer must actually
execute. `risk_tier` sets how much independent scrutiny the change earns; escalate it explicitly
through `escalation_conditions` rather than silently reviewing harder.

Each round produces a new `Engineering Review` linked back here with `answers`. Approval of one
target version never carries to a later one.

The lifecycle field is the logical `progress_status`, stored in this bundle as
`{{superbee:progress_status}}`. Author and query it by the logical name; the installer materializes
the concrete key for the bundle's OKF edition. Declaring it logically is what keeps a bundle
carrying this recipe upgradable, since OKF v0.2 reserves top-level `status` for
`draft|stable|deprecated` rather than workflow state.
