# Finite local snapshot sources

`@superbee/core/source-engine` accepts bounded JSON observations through the same internal
pending replay, mapping, change detection, missing counters, commit and MachineState owner as
`observeSource`. `observeSnapshot` acquires one finite input and uses no network profile or
transport. HTTP declarations, profile validation and transport guards keep their existing API.

A Snapshot Source is an ordinary authored document, interpreted by `bindSnapshotSource` with the
loaded Kind registry and bundle edition. It need not install a new Kind. For a Kind `Result`
declaring `title` and `score`, a declaration's frontmatter can contain:

```yaml
type: Reference
title: Benchmark observations
resource: urn:example:benchmark
target_kind: Result
identity:
  id: "{key}"
fields:
  title: result.label
  score: result.score
owned_fields: [title, score]
auto_apply: [new, changed]
needs_review: [disappeared]
completeness: partial
```

The resource is an opaque bounded URN, never a path or fetch target. Identity paths follow the
existing Connector grammar and cannot also be mapped values. A caller supplies stable keys;
changing a display label or acquisition path must not change them. The closed snapshot is:

```json
{"v":1,"resource":"urn:example:benchmark","generation":1,"complete":false,"records":[{"key":"trial-001","result":{"label":"First trial","score":12.5}}]}
```

`decodeSnapshot(Uint8Array)` hashes exact original bytes using the existing byte hash owner,
including a UTF-8 BOM or whitespace, and rejects malformed UTF-8, nonfinite values, depth over
32, files over 2 MiB, more than 10,000 records, nonobject records and unknown envelope keys.
Admission re-decodes `DecodedSnapshot.bytes`; changing a derived summary cannot change the input.
Optional `diagnostics` contains at most 100 closed `{code,message,count?}` rows, with uppercase
codes up to 64 characters, messages up to 512 characters and nonnegative safe integer counts.
Diagnostics and mapped native values are private; hosts should expose only codes/counts/digests.

A complete declaration must name a `scope` logical label. A complete input must repeat that exact
scope and the declaration must itself be complete. Partial inputs never count missing records.
Complete inputs use the existing missing threshold and review signals; they do not delete targets.
Mapping gaps, supported null clears, list sets, value tables and human conflicts follow the
existing mapping and record-overlay owners. A target must be deliberately authored and linked;
there is no domain-document mirroring.

## Admission and publication

Call `admitSnapshot` before **any** adapter reconciliation, retry, Finding or state publication.
It validates the resource, binding, scope, every rendered ID, duplicates, fixed checkpoint,
generation and cumulative capacity. `observeSnapshot` calls the same admission defensively.
Refusals throw `SnapshotRefusal` with a fixed `SNAPSHOT_*` code. Invalid evidence throws
`SnapshotEvidenceRefusal` with `SNAPSHOT_EVIDENCE_INVALID`. Commit/store failures after admission
return the existing typed runtime outcome/reason rather than an input refusal.

The checkpoint is exactly `{v:1,generation,sha256}` in the existing cursor, with
`profile:{id:"local-snapshot",version:1}` and `open:false`. First generation can be any positive
safe integer. Lower generation refuses; equal generation/different exact hash refuses; equal
generation/equal hash replays pending work with **zero** fresh pages and no missing/complete clock
advancement. Greater generation is a new observation, including content that appeared earlier.
Generation order is caller/producer asserted. Binding changes after observation history refuse;
a different mapping/resource/scope deliberately uses a new source document/state key.

The host owns the source lock, exact private envelope, its limit and the final exact writer check.
Under that lock, read the envelope and one fresh SourceIndex, capture `SnapshotCapacityInput`
**before reconciliation**, and call admission. `envelopeOverheadBytes` must conservatively cover
all wrapper/binding/summary bytes, punctuation, version growth and newline outside Core's
observation/accepted data. Core counts retained IDs, old accepted tuples and possible fresh-index
target tuples, plus mapped fanout, carried values and record/pending/before/after/entry duplication
across reconciliation, replay and the fresh page. Its bound can refuse an otherwise executable
snapshot; valid 2 MiB inputs are not guaranteed to fit the host's envelope limit.

Keep that same captured capacity input through the run. Reconciliation may publish expanded
accepted tuples while preserving the observation; replacing the captured basis with that expanded
snapshot would double-budget growth and could cause a needless later refusal. After admission,
use the unchanged `createSourceOverlayAdapter.reconcile`, jointly publish its staged acceptance,
then call `observeSnapshot` with the same index/capacity basis, adapter commit and MachineState
port. The port publishes observation and staged acceptance together **after** overlay commit,
consumes only after publication and discards/stops on failure. A failed publication can follow
target writes; a later run converges under existing accepted-tuple and per-target CAS rules.

The run receipt adds `observation:"new"|"replay"`, generation, exact hash and capacity facts.
Read-only admission is an input/policy preview, not an evaluated target effect plan. Hosts should
report actual overlay outcomes after execution. The existing SourceIndex membership limitation
remains: a second identity claimant added during a run is seen only by a later fresh index/run.

## Evidence applicability

The optional closed evidence descriptor is separate from mapped content digests, document
freshness, authentication and verified authority provenance:

```json
{
  "v":1,
  "association":"caller_asserted",
  "inputs":[{"id":"original-model","sha256":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],
  "settings_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "required_identities":[{"id":"tool-bytes","sha256":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}]
}
```

`parseSnapshotEvidence` accepts unique logical IDs per array (1–128 ASCII letters/digits and
`._:-`, starting with a letter/digit) and lowercase `sha256:<64 hex>` digests. No descriptor field
selects a file or code. The two identity namespaces are separate. The host observes only explicitly
selected files and hashes **original invocation settings** with the existing
`@superbee/core/site-capabilities` `canonicalJson` owner. Output hashes cannot replace the expected
original input basis. Hashing an input now does not prove a previous tool invocation consumed it.

`assessSnapshotFreshness(expected, observed)` returns rows for every expected input, required
identity and settings digest. Missing/uncheckable dimensions are `unknown`. A known mismatch
returns `stale`, retaining unknown rows. With a nonempty expected original-input basis and all
required dimensions equal, the result is `current` relative to that caller-associated basis;
otherwise it is `unverifiable`. Absent/empty evidence cannot establish currentness. Informational
labels outside `required_identities` are outside this declared applicability comparison.

## Review-item prerequisite

The existing overlay owner requires a valid claimable `Signal` convention, even for an empty
change set. Install the existing definition deliberately before running a snapshot. Hosts pass
`signals: {feedKind: sourceDocument.frontmatter.type}` to the overlay adapter so it selects only
link vocabulary declared for the actual source Kind. A Signal convention declaring only
`from feed: Source Feed` supplies no typed feed link for a `Reference` snapshot source; the
Signal still retains the provider identity. A bundle may declare a link to its actual source
Kind to enable that existing vocabulary. No Source Feed URL or new attention engine is implied.
