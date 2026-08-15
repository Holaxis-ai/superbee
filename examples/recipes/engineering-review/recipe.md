---
type: Recipe
id: engineering-review
title: Engineering Review
version: "1"
summary: Exact-target engineering review with stable findings, dispositions, and repair evidence.
content_policy: definitions-only
references:
  - references/engineering-review-playbook.md
  - references/view-authoring-v0.md
pages:
  - registry: views-registry/engineering-review-ledger.md
    entry: views/engineering-review/ledger.html
---
# Engineering Review

Install the operating model for reviews that bind to an exact target version, name findings that
stay individually addressable across rounds, and require executable proof before a finding is
called repaired. No review instances, project history, or organisation-specific policy travel
with it.

Four kinds carry the model: an `Engineering Review Request` states the exact target, question,
risk tier, and required probes; an `Engineering Review` records one verdict against one immutable
target version; a `Review Finding` is the stable unit of defect identity and disposition; and
`Repair Evidence` binds a finding to the commit that repaired it plus the parent-red and
head-green proofs. The ledger View is a live read-only projection that makes unresolved findings
and missing evidence visible; the documents remain the authority.

This is a companion to the lighter `review-workflow` recipe, not a replacement. `review-workflow`
models a durable request for a named human decision; this recipe models the evidence discipline of
a technical review round. Both install into the same bundle without collision.
