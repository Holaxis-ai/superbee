---
type: Recipe
id: review-workflow
title: Review Workflow
version: "1"
summary: Durable human review requests with a live, generic evidence View.
content_policy: definitions-only
references:
  - references/view-authoring-v0.md
pages:
  - registry: views-registry/review-workflow-reviews.md
    entry: views/review-workflow/reviews.html
---
# Review Workflow

Install a durable human-review operating model without installing any review instances or project
content. The `Review Request` Kind is the decision authority; the View is a live, read-only
projection. Its versioned View-authoring reference travels into the target bundle with the
definitions, so agents can inspect and extend the UI without an agent-harness skill. Agents create
and update requests through the generic Kind-aware CLI.
