# Atomic journal snapshots

`JournaledBackend` extends storage with atomic document, intent, and metadata writes. An adapter
advertises `journalSnapshotCas: true` only when it implements the complete optional guard contract.
Consumers must check this capability before relying on guarded operations. IndexedDB implements it
without changing its database schema. Existing unguarded calls retain their behavior.
Only an omitted or `undefined` guard selects that compatibility path. Defined malformed guards,
including `null`, `false`, zero, and the empty string, raise `JournalGuardConflict` before writes.

Build a `JournalGuard` from one `readWithJournal` result. Include the target, its exact document
`{version, raw}` or `null`, every target intent (including acknowledged history), and each metadata
key the operation will read, write, or remove. A metadata expectation is either `{present: false}`
or `{present: true, value}`. A present row whose value is `undefined` differs from absence.

`writeJournaled` accepts `guard` and an optional `removeMeta` list. All metadata puts and removals
must name keys included in the guard, and a key cannot appear in both lists. The adapter compares
the entire snapshot before changing anything, in the same transaction as the write, journal
changes, metadata puts, and removals. Removed keys require a guard even when already absent.
Any superseded intent must belong to the guarded target. A newly recorded request identity must
be absent from the entire journal, including acknowledged records and other targets; superseding
does not permit reusing the retired identity. Both checks share the write's transaction.

`deleteJournaled` accepts the same guard and compares it before every branch, including absent
documents and held intents. Normal metadata puts/removals and `onHeld` puts must all name observed
keys, even if their branch is not chosen. Overlapping puts/removals within a branch are refused;
normal removal and an `onHeld` put of the same key are mutually exclusive and remain valid.
Guarded deletion captures all options before storage work. Document deletion, permitted conflict
retirement, and metadata changes commit together; retirement cannot affect another target's
history. The existing `deleted`, `absent`, and `held` results and unguarded behavior remain.

`updateIntent` accepts the same guard and optional replacement `document`. Replacement requires
a guard; both the intent and the replacement must target that guard's document. The replacement
uses the existing document serialization and local byte-version calculation, without stamping
authoring metadata or creating another intent. Document replacement, intent advancement, and
metadata writes commit together. Guarded patches can change state, attempts, acknowledgment and
other outcome observations; they cannot change original identity, sequence, creation time, base,
local version, original content, or predecessor. Ordinary state comparison still applies.

`writeMeta(key, value, {expected, requireEmptyJournal})` supports metadata admission. The optional
presence-aware expectation and optional whole-journal emptiness check run with the put in one
transaction. Acknowledged history also makes the journal nonempty. This is not a reservation for
subsequent operations: later guarded mutations must continue checking the admitted metadata row.

`FileJournaledBackend` adds two metadata verbs outside the shared interface. `listMeta(prefix)`
returns every row whose key starts with `prefix`, in code-unit key order, as copies from the last
committed transaction. `removeMeta(key, {expected})` removes one row compare-and-swap: the
expectation is required, is compared in the removal's transaction, and a mismatch raises
`JournalGuardConflict` and writes nothing. It resolves `true` when it removed the row and `false`
when the row was absent as expected. A removal is an ordinary fsynced log record and uses the
existing record format.

All guarded inputs are captured before asynchronous storage work. Their data domain is primitive
values (including `undefined`), arrays, and acyclic plain records. Accessors, symbols, functions,
cycles, and other object prototypes such as `Date`, `Map`, or `Set` are refused. This includes
replacement documents and guarded metadata values. The existing synchronous `writeJournaled`
metadata producer remains supported; its returned data is captured before storage work.
The producer completes before any guard decision, so a write it triggers can invalidate the
captured premise. Legacy unguarded metadata remains an opaque structured-clone value store.

A mismatched or unsupported guard raises `JournalGuardConflict` and writes nothing. Storage
errors and transaction aborts also leave all participating records unchanged. Capture a fresh
snapshot before deciding whether to retry; never weaken a failed guard to a state-only update.
These guarantees describe database transactions, not a backup or power-loss guarantee.

The shared journal agreement tests run the same guard rows against IndexedDB and an independent
memory adapter. IndexedDB-specific tests additionally exercise transaction abort and reopen.

## Blob intents

The optional `BlobJournaledBackend` holds frozen ordinary-file intents. One owner decides every
blob transition: the pure functions in `blob-journal.ts` (`decideBlobAdmission`, `decideBlobUpdate`
with `nextBlobIntentRecord`, `decideBlobRetirement`, `decideBlobForget`, `decideBlobMetaWrite`). A backend only reads
its committed state through `BlobJournalView` and persists the decision. `FileJournaledBackend` and
the browser-safe `createMemoryBlobJournal()` (from `@superbee/core/storage`) both do this, and one
parity table runs every transition row, refusals included, against both.

- **Admission.** One unsettled (receipt-less) intent per bundle and key. A second one is refused
  as `BlobAdmissionConflict`, a `JournalGuardConflict`, unless the caller names every unsettled
  same-bundle intent on the key, exactly as stored, in `unsettled`. Intents of other bundles never
  block, but they share the key's guard, so they can cause a false guard conflict.
- **Claim.** `pending` or `unknown` to `in_flight` adds exactly one attempt, and only while every
  earlier attempt is proven not applied (`notAppliedThrough === attempts`).
- **Non-execution proof.** It extends the prefix by exactly the claimed attempt and returns the
  record to `pending`, with one kind of typed evidence. A `deletionHold` (the host's
  `428 deletions_held`) is accepted from `in_flight` or `unknown`. `notDispatched { code }` is
  accepted only from an `in_flight` claim this open journal handle made at that attempt, for a
  failure before the carrier was invoked or one the carrier refused as `denied` (by the carrier
  contract, nothing left). A claim found at open belongs to a process that may have
  sent it, so it stays lookup-only, as does any carrier or transport failure.
- **Settlement.** A receipt freezes the record; only terminal records retire.
- **Forgetting.** The optional `forgetBlobIntent` removes one receipt-less `unknown` record whose
  latest attempt is not proven unapplied, under the key's guard, on the caller's own evidence (the
  hosted client's: one fresh `absent` lookup). It is not a receipt: that delivery may still commit.

Patch keys with an `undefined` value are refused.

## File journal format

The file journal frames each record and snapshot with a format number and keeps the highest
format it has written:

| Format | First needed for |
|---|---|
| 1 | documents, reserved files, blobs, document intents, meta |
| 2 | blob intents |
| 3 | a blob intent carrying `notDispatched` evidence |

The reader accepts formats 1 to 3. A blob intent in a format-1 frame, or `notDispatched` evidence
in a format-2 frame, is `FileJournalCorruptError`. A newer format is `FileJournalFormatError`, so a
reader from before format 3 refuses a format-3 store with that typed error and changes no file. A
format bump ships a reader for every earlier layout.
