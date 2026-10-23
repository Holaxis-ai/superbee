# Accepted edit preservation

An accepted changed document remains locally recoverable until its own valid acknowledgement,
intentional authored supersession, or explicit recorded resolution discharges that obligation.
Acceptance is the successful document-plus-journal transaction, not every editor keystroke. A
possibly delivered predecessor needs its own payload; the newer working document is insufficient.

`intent-journal/Preservation.tla` is the unchanged checked model from the
[bounded pilot](https://github.com/Holaxis-ai/superbee-dev/blob/55b467055823bf790c80990e224ddc0dccd1e7ad/verification-runs/local-edit-preservation-20261023.md).
It is a focused abstraction, not a generated model or a refinement proof of this implementation.
Logical edit IDs and delivery request IDs are distinct. `accepted`, `superseded`, `acked`, and
`seen` are ghost history; they store no recoverable payload. Only `view` and live journal payloads
count as recovery copies. Remote authority content alone cannot discharge a local obligation.

## Transition correspondence

Paths below are relative to the repository root. Function names, rather than line numbers, are
the anchors to review when source changes. Test names identify executable evidence, not proofs.

| Model transition / obligation | Implementation owner | Implementation evidence |
| --- | --- | --- |
| `Accept`: atomic document and intent acceptance | `packages/browser-local/src/local-bundle.ts`: `commitLocal`, `journalingBackend`, `commitBodyLocal`; `packages/core/src/journaled-backend.ts`: `JournaledBackend` | `packages/core/test/journaled-backend-contract.ts`: `a journaled write records the document, its intent, and its meta rows together, and a failed document CAS records none of them` and superseding/CAS rows; adapter transaction-abort tests below |
| `Accept` coalescing: authored replacement of an unattempted save | `local-bundle.ts`: `composeIntent`, `commitBodyLocal` (body mode uses stricter evidence guards) | `packages/browser-local/test/sync.test.ts`: `compose-per-id`; `packages/core/test/journaled-backend-contract.ts`: `superseding an intent is a compare-and-swap on its state and attempts` |
| `Accept` chaining: preserve a possibly delivered predecessor's payload and identity | `local-bundle.ts`: `composeIntent`, `commitBodyLocal` | Shared journal contract: `accepted payload preservation` rows; `sync.test.ts`: `crash between claim and settlement` |
| `Claim`: durably mark an attempt before submission | `local-bundle.ts`: `push`; `packages/core/src/uncertain-write.ts`: `performUncertainWrite` | `sync.test.ts`: `crash between claim and settlement`, `crash before delivery` |
| `Crash`, `Reclaim`: volatile worker loss leaves durable payload and attempt count | `local-bundle.ts`: `reclaimInFlight`; backend reopen behavior | `sync.test.ts`: both crash rows reopen the same fake IndexedDB database; the first checks the older and newer payloads before recovery delivery |
| `Deliver`, `Acknowledge`: a correlated outcome settles only its own identity | `local-bundle.ts`: `settleIntent`, `pushBodyIntent`; `uncertain-write.ts`: `settleAgainstIntent` | `sync.test.ts`: lost acknowledgement, own-version rule, crash/settlement row checks the successor at its submission boundary; shared `accepted payload preservation` rows check unchanged successor and working document after settlement |
| `Resolve`: reviewed take-remote disposition atomically records a receipt and changes the view | `local-bundle.ts`: `resolveConflict`; `packages/core/src/journaled-backend.ts`: `assertJournalSnapshot` | `packages/browser-local/test/conflict-recovery.test.ts`: choice table, failed receipt rollback; `body-resolution.test.ts`: choice/race tables; `body-resolution-indexeddb.test.ts` |
| `Retire`: discard only discharged history while preserving needed predecessor evidence | `packages/browser-local/src/body-journal.ts`: `retireAcknowledgedBody`; `journaled-backend.ts`: `captureRetireAcknowledged`; both adapter `retireAcknowledged` methods | Shared `accepted payload preservation` and `acknowledged retirement removes only named acknowledged rows under the full guard` rows; `packages/browser-local/test/body-retirement.test.ts`: unsettled-work, chaining and crash/reload rows |

The shared journal rows run over IndexedDB (`packages/core/test/storage-backend-contract.test.ts`),
FileJournaledBackend (`packages/core/test/file-journaled-backend.test.ts`), and the test-only memory
adapter (`packages/browser-local/test/journaled-seam.test.ts`). They check the persistence seam;
they do not claim to execute the whole browser runtime on the file adapter. File interrupted-write,
replay and SIGKILL tests and IndexedDB abort/reopen tests provide separate adapter evidence.

## Assumptions and correspondence limits

- Atomic backend persistence and valid correlated acknowledgement are model assumptions. Adapter
  tests exercise those promises, but neither tests nor this model prove IndexedDB, fsync or media.
- The model is one document, two logical edits, two request IDs, one crash and one worker. It checks
  safety without fairness; it promises neither eventual delivery nor automatic exact-mode reclaim.
- `Deliver` collapses the network and outcome lookup. It does not verify server retention, stale
  responses, multi-realm coordination, permissions or the full body receipt protocol.
- `Resolve` covers take-remote disposition; keep/revise tests provide separate implementation
  coverage. Supersession ghost history is not a promised durable audit ledger. Body resolution
  receipts deliberately contain decisions and identities, not old body payloads.
- `Retire` conservatively keeps predecessor dependencies. Production body retirement can remove an
  acknowledged predecessor of the newest acknowledged row when retained evidence validates;
  the focused model does not express that relaxation. The model's broken retirement is artificial,
  not an identified production data-loss bug.
- Deletion, unsaved drafts, eviction, corruption, quota, logout policy, external writes and
  unbounded histories remain outside this model. Other tests can cover them without enlarging its
  claims. A test pass is not a proof that every source transition refines the model.

## Change review

Changes to the owners above must review the affected transition, durable boundary, discharge rule,
and regression rows. The review states whether the existing model still corresponds, requires an
update, or does not cover the change; an unchanged model needs a reason when semantics change.
Update this mapping and the applicable regression rows in the same change. Do not weaken the
property or redefine acceptance merely to make a check pass. A model counterexample requires an
implementation reproduction before being reported as an implementation defect.

Run the relevant implementation tests with the package's existing loader and the three
`intent-journal/Preservation.*.cfg` files through `run-tlc.sh` when changing this contract. The
existing TLA workflow already discovers these configs in its intent-journal area. Correct policy
must complete; the reachability control must violate `NoRecoveryWitness`; artificial unsafe cleanup
must violate `Preserved`. A failing control is expected only when it fails for its named reason.
