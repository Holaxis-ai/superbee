---
type: Convention
title: Repair Evidence
governs: Repair Evidence
path: repair-evidence/
description: The binding from one finding to the commit that repaired it and to the executable proof that the repair works.
links:
  repairs: Review Finding
link_descriptions:
  repairs: The finding this evidence closes.
fields:
  required: [title, repair_commit, repaired_version, probe, probe_source, parent_red, head_green]
  optional: [probe_command, parent_version, notes]
  values:
    probe_source: [real_artifact, hand_authored]
    parent_red: [proven, not_applicable, missing]
    head_green: [proven, failing, missing]
  value_descriptions:
    probe_source:
      real_artifact: The probe is built from the real generator, artifact, or format the defect occurs in.
      hand_authored: The probe uses a stand-in the author wrote; it can pass while the real path stays broken.
    parent_red:
      proven: The probe was run against the pre-repair implementation and failed there.
      not_applicable: No pre-repair state can express the probe, with the reason recorded in notes.
      missing: The red proof has not been produced; the repair is unproven.
    head_green:
      proven: The same probe was run at the repaired version and passed.
      failing: The probe still fails at the repaired version; the repair is incomplete.
      missing: The probe has not been run at the repaired version.
  terminal: {}
  descriptions:
    title: A concise label for the repair this evidence proves.
    repair_commit: The commit that owns the repair, so the change can be read on its own.
    repaired_version: The immutable version at which the head-green proof was produced.
    probe: The test, check, or reproduction that decides whether the defect is present.
    probe_source: Whether the probe exercises the real artifact or a hand-authored stand-in.
    parent_red: Whether the probe was proven to fail against the pre-repair implementation.
    head_green: Whether the same probe was proven to pass at the repaired version.
    probe_command: The exact command another person can run to reproduce both results.
    parent_version: The immutable pre-repair version the red proof ran against.
    notes: Anything a reader needs to interpret the proofs, including why parent_red is not_applicable.
freshness_horizon: 90d
sections: [Probe, Parent-red proof, Head-green proof]
---
# Repair Evidence

A green test at the repaired head proves almost nothing on its own: a probe that never could have
failed passes just as happily against a broken implementation. Evidence is complete only when the
SAME probe is proven red against the pre-repair implementation and green at the repaired version.

`parent_red: missing` and `head_green: missing` are honest states, and recording them is the point.
Evidence that names its own gap is far more useful than evidence that quietly omits half the proof,
and the ledger projection surfaces exactly those gaps.

`probe_source` records whether the probe is built from the real generator or artifact format, or
from a stand-in the author wrote. A hand-authored stand-in can encode the same wrong assumption the
implementation made, so it can pass while the real path stays broken. Prefer `real_artifact`; when
you cannot, say so here rather than in prose nobody queries.

`repair_commit` keeps repairs individually readable. One commit per finding means a reviewer can
see this round's delta without reconstructing it from a squashed history.
