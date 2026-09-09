---
type: Convention
title: Security Advisory
governs: Security Advisory
path: security-advisories/
description: >-
  The bundle-side coordination record for one security finding: its state, its
  owner, and - when it is not published - the reasoning that decided that and
  the conditions that would reopen it. It deliberately cannot carry the finding
  itself. Mechanism, reachability, reproductions, payloads and affected-code
  detail belong in the private advisory named by advisory_id. This bundle
  synchronizes, and SECURITY.md treats a synchronized destination as public
  regardless of observed visibility.
fields:
  required:
    - title
    - advisory_id
    - severity
    - status
    - disclosure_state
  optional:
    - evidence_class
    - owner
    - next_action
    - blocked_on
    - fixed_sha
    - affected_versions
    - patched_version
    - description
  descriptions:
    advisory_id: >-
      Opaque pointer to the private advisory holding the actual finding. Opaque
      means it names the advisory and nothing about its contents.
    severity: >-
      Coordination severity, so a reader can prioritize without knowing the
      mechanism. Record the severity actually judged, not the one a scoring
      vector produces mechanically.
    status: >-
      Where remediation stands. Independent of disclosure_state - a fix is often
      released long before, or without, any publication.
    disclosure_state: >-
      Whether the finding is pending publication, deliberately withheld, or
      public. 'withheld' is a decision and requires this document's Disclosure
      decision and Revisit when sections to be filled in.
    evidence_class: 'How the finding was established, without saying what it is.'
    owner: >-
      Who holds remediation. Disclosure and release decisions remain the human's
      regardless.
    next_action: >-
      The single next thing to do, and who does it. Written so it does not
      describe the defect.
    blocked_on: 'What prevents next_action, if anything.'
    fixed_sha: >-
      The commit carrying the fix, once that commit is public. Empty while a fix
      is unpublished - a commit pointer is affected-code detail.
    affected_versions: >-
      Published version range affected. Omit while a finding is embargoed and
      unfixed; naming unpatched versions before a remedy exists points at them.
    patched_version: First released version carrying the fix.
    description: One line for list views. Must not describe the defect.
  values:
    severity:
      - low
      - moderate
      - high
      - critical
    status:
      - investigating
      - fix_in_progress
      - fix_merged
      - released
      - closed
      - withdrawn
    disclosure_state:
      - embargoed
      - withheld
      - published
    evidence_class:
      - reported
      - reproduced
      - executed
  value_descriptions:
    disclosure_state:
      embargoed: 'Not yet public, publication still intended or undecided.'
      withheld: >-
        Deliberately not published, by a recorded judgment. Not a backlog item -
        a decision with reasoning and revisit conditions written down.
      published: >-
        Public. The advisory is the durable record from this point; this
        document is coordination only.
    status:
      fix_merged: >-
        On the default branch but not in a released version - users remain
        exposed.
      released: A patched version is installable.
      closed: Nothing outstanding.
    evidence_class:
      reported: 'Asserted, not independently confirmed.'
      reproduced: Confirmed by an independent party.
      executed: 'Demonstrated by running it, not by reading.'
  terminal:
    status:
      - closed
      - withdrawn
links:
  tracks: Task
link_descriptions:
  tracks: >-
    A follow-up this record tracks but does not close. The task carries the
    work; this record carries the coordination state.
sections:
  - Coordination
  - Disclosure decision
  - Revisit when
---

# Coordination

State, owner, and next gate. Write only what a reader needs in order to act. If a sentence would
help someone reproduce, locate, or assess the exploitability of the defect, it belongs in the
private advisory instead.

# Disclosure decision

Why this finding is embargoed, withheld, or published - in terms a security-literate reader could
check and disagree with. A decision recorded with accurate reasoning is defensible later; one
recorded with a convenient phrase is not. State the risk shape (is it remote or content-based, what
must the victim do) without stating the mechanism.

# Revisit when

The conditions that would change the decision. Named conditions turn a judgment into a policy;
left implicit, a decision quietly expires and nobody notices it should have been revisited.
