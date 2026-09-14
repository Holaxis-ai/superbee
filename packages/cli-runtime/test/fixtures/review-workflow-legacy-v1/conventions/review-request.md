---
type: Convention
title: Review Request
governs: Review Request
path: review-requests/
description: A durable request for a named human to judge a defined question against linked evidence.
links:
  reviews design: Design
  reviews task: Task
  reviews roadmap item: Roadmap Item
link_descriptions:
  reviews design: A design whose reasoning or contract is under review.
  reviews task: Implementation work whose scope or result informs the judgment.
  reviews roadmap item: The strategic commitment affected by the judgment.
fields:
  required: [title, status, reviewer, requested_by, question]
  optional: [decision_summary, decided_at]
  values:
    status: [requested, in_review, changes_requested, approved, canceled]
  value_descriptions:
    status:
      requested: Ready for the reviewer; no review is yet in progress.
      in_review: The reviewer is actively considering the request.
      changes_requested: Work must be addressed before another decision.
      approved: The reviewer accepted the proposal; terminal for this request.
      canceled: The requester withdrew the request; terminal for this request.
  terminal:
    status: [approved, canceled]
  descriptions:
    title: A concise label for the review outcome being sought.
    status: The persisted review lifecycle state, not an activity update.
    reviewer: The human expected to make the judgment; coordination metadata, not authorization.
    requested_by: The human accountable for the scope and evidence supplied.
    question: The exact judgment the reviewer is being asked to make.
    decision_summary: A concise persisted outcome recorded after the review.
    decided_at: The ISO 8601 timestamp at which the persisted decision was made.
sections: [Context, Requested decision, Acceptance criteria, Reviewer response]
---
# Review Request

Create a Review Request when a decision must survive chat history and remain visible to humans and
agents. The named reviewer owns the response; the requester owns scope, evidence, resubmission, and
cancellation. Record responses through version-guarded, attributed updates. The Page is a
projection and never becomes the decision authority.
