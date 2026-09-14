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
