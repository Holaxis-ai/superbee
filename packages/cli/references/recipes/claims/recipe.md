---
type: Recipe
id: claims
title: Claims
version: 1.0.0
summary: "Declares the Claim kind: event-lifecycle claims for data-derived numbers (progress_status enum active/challenged/locked/deprecated, required provenance), composed entirely from lite primitives"
---

# Claims

Installs the `Claim` kind convention: a single source of truth for data-derived findings,
ported from the holaxis-claims event-sourced JSONL system onto lite's native primitives.

A claim is a `type: Claim` doc under `claims/<section>/`. Its **title carries the claim
text with its specific numbers** ("759 tests pass across six workspaces" — not "the suite
is green"). Its lifecycle is the validated `progress_status` enum: `active` (filed, working
hypothesis) → `challenged` (under independent verification) → `locked` (provenance chain
verified end-to-end; only locked claims belong in final outputs) — or `deprecated` (facts
changed; never delete, file a successor and link it). `reason` records how the number was
derived or why it changed; `evidence_command` + `evidence_commit` pin the exact
reproduction.

Everything composes from existing primitives — no claims engine:
- the optimistic lock is `doc update --expected-version` (capture the token with
  `doc read <id> --field head_version`);
- the event trail is doc history (native on enforced backends; git log on file bundles);
- actor attribution is the engine's own `--actor` on every write;
- **citations are links**: a document that cites a claim links to it, so `link show
  <claim>` lists every citing document — the blast radius of a deprecation, precomputed.

Rules of use (the discipline the schema cannot enforce): claims are the source of truth
for numbers — a number in a document without a locked claim is unverified; weight by
progress status; verify by re-running `evidence_command`, not by re-reading the claim; a locked
claim is never edited — deprecate it and file a successor.
