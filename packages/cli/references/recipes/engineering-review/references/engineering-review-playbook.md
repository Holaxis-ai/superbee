---
type: Reference
title: Engineering review playbook
protocol: v1
timestamp: "2026-08-15T00:00:00.000Z"
---

# Engineering review playbook

How to run a review round with the four kinds this recipe installs. It is generic: no project,
organisation, or release policy belongs here. Substitute your own risk tiers and gate names where
this document says "the gate".

## The one rule the rest follows from

A review claim is a claim about an exact version. Everything else in this playbook exists to keep
that true: `target_version` on the request and the review, `found_in_version` on the finding,
`repaired_version` on the evidence. When the target moves, no prior claim moves with it.

A note on field names: the request's lifecycle field is `progress_status`, not `status`. OKF v0.2
reserves top-level `status` for `draft|stable|deprecated`, so these kinds leave it free and a
bundle carrying them stays upgradable.

## Opening a round

Create an `Engineering Review Request` before the review starts.

```sh
superbee new "Engineering Review Request" widget-cache \
  --title "Widget cache invalidation" \
  --progress_status requested \
  --reviewer reviewer-name \
  --requested_by requester-name \
  --target "feat/widget-cache" \
  --target_version "<exact commit sha>" \
  --review_question "Does the cache stay correct across concurrent invalidation?" \
  --risk_tier high_risk \
  --required_probes "npm test -w cache; the concurrent-invalidation soak"
```

State the acceptance criteria in the body's `Acceptance criteria` section, and state the non-goals.
A request whose acceptance criteria cannot be written down is not ready to be reviewed; that is a
finding about the request, not a reason to review it anyway.

Give the reviewer a bounded packet: the exact version, the touched files, the question, the
acceptance criteria, and the evidence to inspect. Do not hand over conversation history. A reviewer
who must reconstruct settled context spends the budget on reconstruction.

## Sizing the round

`risk_tier` decides how much independent scrutiny the change earns. Assurance effort should track
the risk left AFTER the automated gates have had their say, not the size of the diff.

- `trivial` - documentation, metadata, or test-only corrections with no runtime-behavior change.
  Author validation plus the automated checks.
- `routine` - ordinary code change. One focused independent review of the exact version, plus the
  gate.
- `high_risk` - security, authentication, concurrency, destructive writes, migrations, remote-target
  selection, reconnect and replay, release mechanics. Independent review AND adversarial QA aimed at
  what no gate can reach.

Escalate explicitly by updating `risk_tier` and recording why in `escalation_conditions`. Reviewing
harder without saying so leaves the next reader with no idea how much scrutiny the change actually
received.

## Producing the verdict

Inspect existing evidence first, then independently reproduce the load-bearing parts. An exact-version
CI run you can point at is evidence; a CI run at a different version is not. Prefer one targeted
adversarial probe over re-running a broad suite that the gate already ran.

```sh
superbee new "Engineering Review" widget-cache-r1 \
  --title "Widget cache round 1" \
  --target "feat/widget-cache" \
  --target_version "<exact commit sha>" \
  --verdict changes_requested \
  --reviewer reviewer-name \
  --round 1 \
  --link "answers=engineering-review-requests/widget-cache"
```

Fill in every declared section. `Scope covered` and `Unresolved risks` carry as much information as
`Findings`: they are the difference between "no problems exist" and "I looked here and found none".
`Survived attacks` should name the specific things you tried to break and could not - a section that
restates the implementation is a summary, not a review.

Use `inconclusive` honestly. A review that cannot settle its question with the evidence available
should say so and name what is missing, rather than approving on the balance of impressions.

## Writing findings

One finding per defect, each its own document, each keeping its identity for the life of the work.

```sh
superbee new "Review Finding" widget-cache-stale-read \
  --title "Concurrent invalidation can serve a stale entry after eviction" \
  --severity high \
  --disposition unresolved \
  --defect_class "read path does not re-check the generation counter after acquiring the entry" \
  --found_in_version "<exact commit sha>" \
  --link "raised by=engineering-reviews/widget-cache-r1"
```

`defect_class` is the field that stops repair theatre. The title says what was observed; the class
says what pattern it instantiates. Write the class so that a repair covering only the observed
instance visibly fails to satisfy it. Then aim the next round's probe at the class.

`severity` is about consequence, not likelihood or effort. A rare critical stays critical.

## Closing findings

A finding leaves `unresolved` in exactly four ways, and each leaves a record.

- `repaired` - a repair landed and linked `Repair Evidence` proves it.
- `accepted_risk` - a named `owner` accepted it with a written `rationale`.
- `rejected_invalid` - analysis showed it was not a real defect, with a written `rationale`.
- `superseded` - a later finding replaced it, linked with `supersedes`.

Nothing else closes a finding. In particular, a later round's prose saying "addressed" does not: the
disposition field is the authority, and the ledger View reads it rather than writing it.

## Evidence that actually proves something

Complete evidence is two proofs about one probe:

- **Parent-red** - the probe fails against the pre-repair implementation. This is what shows the
  probe can detect the defect at all.
- **Head-green** - the same probe passes at the repaired version. This is what shows the repair
  works.

A head-green proof on its own says almost nothing: a probe that never could have failed passes just
as happily against a broken implementation.

```sh
superbee new "Repair Evidence" widget-cache-stale-read \
  --title "Generation re-check on the read path" \
  --repair_commit "<repair commit sha>" \
  --repaired_version "<exact commit sha>" \
  --probe "cache/test/concurrent-invalidation.test.ts" \
  --probe_source real_artifact \
  --parent_red proven \
  --head_green proven \
  --probe_command "npm test -w cache -- concurrent-invalidation" \
  --parent_version "<pre-repair commit sha>" \
  --link "repairs=review-findings/widget-cache-stale-read"
```

Run the parent-red proof with the REPAIRED probe against the PRE-REPAIR implementation. Checking out
the old commit entirely re-runs the old probe, which proves nothing about the new one.

Prefer `probe_source: real_artifact`. A hand-authored stand-in can encode the same wrong assumption
the implementation made, so it passes while the real path stays broken. When a real-artifact probe
is genuinely impossible, record `hand_authored` and say why in `notes` - do not upgrade the label to
make the ledger look better.

Record `missing` when a proof has not been produced. Honest gaps are the ledger's most useful
output; silent omissions are its worst failure.

## Rounds

A repaired head is an unreviewed head. Open a new `Engineering Review`, link it with `supersedes`,
and set the prior round's verdict to `superseded`. Approval never floats from one version to
another.

```sh
superbee doc update engineering-reviews/widget-cache-r1 --verdict superseded
superbee new "Engineering Review" widget-cache-r2 \
  --title "Widget cache round 2" \
  --target "feat/widget-cache" \
  --target_version "<repaired commit sha>" \
  --verdict approved \
  --reviewer reviewer-name \
  --round 2 \
  --link "answers=engineering-review-requests/widget-cache" \
  --link "supersedes=engineering-reviews/widget-cache-r1"
```

Once a review is open, land review-driven changes as appended, clearly labeled commits rather than
amending earlier ones, so each round's delta stays individually visible.

## Reading the state

```sh
superbee list --type "Review Finding" --open
superbee list --type "Review Finding" --field severity=critical,high
superbee link show review-findings/widget-cache-stale-read
```

`--open` uses each kind's declared terminal values, so an unresolved finding and a review round
still awaiting a repaired target both stay visible while closed ones drop out.

The ledger View (`superbee ui`, then the "Repair ledger" card) is the same state as a live
projection: unresolved findings first, then findings whose repair evidence is missing or incomplete.
It is a projection, never the authority. If the View and the documents disagree, the documents are
right and the View has a bug.

## What this playbook does not do

It does not replace human judgment with an automated gate, and it does not make an approval
transferable between versions. Its whole contribution is that a claim, a defect, and a proof each
carry the exact version they are true of.
