---
type: Convention
title: Review Finding
governs: Review Finding
path: review-findings/
description: One stable, independently addressable defect or risk, carrying its defect class, disposition, and the version it was found in.
links:
  raised by: Engineering Review
  supersedes: Review Finding
link_descriptions:
  raised by: The review round that produced this finding.
  supersedes: An earlier finding this one replaces after re-analysis widened or narrowed it.
expects_inbound:
  repairs: Repair Evidence
fields:
  required: [title, severity, disposition, defect_class, found_in_version]
  optional: [owner, rationale, verified_in_version, dispositioned_at]
  values:
    severity: [critical, high, medium, low]
    disposition: [unresolved, repaired, accepted_risk, superseded, rejected_invalid]
  value_descriptions:
    severity:
      critical: Data loss, security exposure, or a broken release path; no target version ships with this open.
      high: A reachable correctness failure or a missing guarantee the change claims to provide.
      medium: A real defect with a bounded blast radius or an available workaround.
      low: A quality, clarity, or maintenance concern with no user-visible failure.
    disposition:
      unresolved: Open; no repair, acceptance, or rejection has been recorded.
      repaired: A repair landed AND linked Repair Evidence proves it; terminal.
      accepted_risk: A named owner accepted the risk with a recorded rationale; terminal.
      superseded: A later finding replaced this one; terminal.
      rejected_invalid: Analysis showed the finding was not a real defect, with a recorded rationale; terminal.
  terminal:
    disposition: [repaired, accepted_risk, superseded, rejected_invalid]
  descriptions:
    title: One sentence stating the defect, not the fix.
    severity: How bad this is if it reaches a user, independent of how likely it is.
    disposition: The persisted resolution state of this finding.
    defect_class: The structural pattern this finding is an instance of, so the repair can cover the class rather than the single observation.
    found_in_version: The immutable target version this finding was observed in.
    owner: Who is accountable for reaching a terminal disposition; coordination metadata, not authorization.
    rationale: Required in practice for accepted_risk and rejected_invalid - why this is not being repaired.
    verified_in_version: The immutable version at which the terminal disposition was confirmed.
    dispositioned_at: The ISO 8601 timestamp at which this finding reached a terminal disposition.
freshness_horizon: 30d
sections: [Defect class, Failure scenario, Repair expectation]
---
# Review Finding

The document id is the finding's stable identity. It is assigned once and never reused, so a
finding can be referenced, disputed, repaired, and re-verified across rounds without anyone having
to re-derive which finding round 3 meant by "the second one".

`defect_class` is the field that stops repair theatre. A finding says what was observed; the defect
class says what pattern it is an instance of. A repair that fixes the observation and leaves the
class intact is not a repair, and the class is what the next round's probe should attack.

Only two things move a finding out of `unresolved`, and both leave a record. `repaired` requires
linked `Repair Evidence` - a repair commit plus a probe proven red against the pre-repair
implementation and green at the repaired head. `accepted_risk` and `rejected_invalid` require a
named `owner` and a written `rationale`. A finding closed by assertion alone is a finding that will
come back.

Nothing derived - no view, no report, no summary - may set this field. The ledger projection reads
`disposition`; it never writes it.
