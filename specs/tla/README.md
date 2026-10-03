# TLA+ specifications

These TLA+ models describe three concurrency mechanisms whose correctness depends on how
separately committed steps interleave. The TLC model checker explores every interleaving within
small bounds. The models are checked against their own invariants; they are not generated from or
linked to the TypeScript source. Each spec's header maps its actions to the functions they model,
so a change to one of those functions should be mirrored in the spec.

| Area | Spec | Models |
| --- | --- | --- |
| `filesystem-lock/` | `FsLock.tla` | The cross-process mkdir lock (`packages/core/src/filesystem-lock.ts`) and the filesystem push role (`packages/core/src/filesystem-push-role.ts`) |
| `intent-journal/` | `WorkingCopy.tla` | Browser-local sync data flow: push, pull by heads, digest recording and deletion reconciliation (`packages/browser-local/src/local-bundle.ts`) |
| `intent-journal/` | `IntentLifecycle.tla` | The lifecycle of one document's intents: compose, claim, uncertain delivery, settle, reclaim, resume and resolve |
| `identified-write/` | `IdentifiedWrite.tla` | At-most-once delivery of an identified guarded write across lost answers, outcome expiry and store restarts (`packages/core/src/uncertain-write.ts`, `packages/server/src/router.ts`) |

## Status: fixes on `main` and design targets

Each spec has one `*.fixed.cfg` whose invariants and properties must all hold, and a set of
variant configs that must each produce one named counterexample. The fixed configs turn on knobs
that model fixes. Some of those fixes are on `main`; the others are design targets that `main`
does not implement:

- `FsLock.fixed.cfg` models the owner re-checks before quarantine and before a "stale" diagnosis,
  which are on `main` (#310).
- `WorkingCopy.fixed.cfg` models pull consistency (#314) and one `sync()` at a time per runtime
  (#311), which are on `main`. It also turns on `AckInvalidates` (an acknowledgement drops the
  recorded heads digest), a design target that `main` does not implement.
- `IntentLifecycle.fixed.cfg` turns on `ReclaimBeforePush` and `AdmitRefused`, both design
  targets. The CLI hosted sync already reclaims before every push; exact-mode `pushWithRole` does
  not.
- `IdentifiedWrite.fixed.cfg` models a proposed protocol (a client read-back rule plus a server
  stale-identity guard) that `main` does not implement. The documented at-most-once claims on
  `main` describe the current behavior instead (#312).

A fixed config therefore describes `main` only where every knob it turns on is a fix on `main`.
A variant config that turns off a fix on `main` reproduces the behavior before that fix, not the
current code. A config marked "open" below describes a defect that is still present on `main`.

## Running the models

The checker needs Java 11 or newer and `tla2tools.jar`. CI uses the TLA+ tools release and SHA-256
pinned in [`.github/workflows/tla-specs.yml`](../../.github/workflows/tla-specs.yml); download the
same release and check it before use:

```sh
curl -fsSL -o /tmp/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
echo "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  /tmp/tla2tools.jar" | shasum -a 256 -c
```

Check every config, one area, or one config with the runner:

```sh
TLA2TOOLS=/tmp/tla2tools.jar specs/tla/run-tlc.sh
TLA2TOOLS=/tmp/tla2tools.jar specs/tla/run-tlc.sh specs/tla/intent-journal/*.cfg
TLA2TOOLS=/tmp/tla2tools.jar specs/tla/run-tlc.sh specs/tla/filesystem-lock/FsLock.fixed.cfg
```

The runner prints one line per config and exits non-zero when any config does not produce its
expected result: a fixed config that finds an error or does not finish, or a variant config that
finds no counterexample or a different one. On a mismatch it prints the end of TLC's output,
including the counterexample trace. Each area takes a few minutes on four cores; the fixed configs
dominate.

To see a counterexample trace or experiment with constants, run TLC directly from the spec's
directory. A config named `<Module>.<variant>.cfg` runs against `MC<Module>.tla` when that file
exists (it supplies model values), otherwise against `<Module>.tla`:

```sh
cd specs/tla/filesystem-lock
java -XX:+UseParallelGC -cp /tmp/tla2tools.jar tlc2.TLC -workers auto -deadlock \
  -config FsLock.bug-quarantine-aba.cfg FsLock.tla
```

`-deadlock` turns off deadlock checking, because every model has bounded budgets and reaches
terminal states by design.

### Config conventions

The first line of every config is `\* expect: pass` or `\* expect: <TLC error text>`, for example
`\* expect: Invariant M1 is violated`. The second line says what the config checks. A variant
config checks only the invariant or property it is expected to violate, so the reported
counterexample does not depend on the order in which TLC's workers find errors. Variant configs
use the smallest constants that still reproduce their counterexample.

When a fix lands, its knob should already be on in the fixed config; keep the variant config that
turns it off, since it shows the fixed config is strong enough to catch that defect. When a new
defect is found, add a variant config that reproduces it before changing the fixed config.

## filesystem-lock

`FsLock.tla` models one lock path, its token-derived `.stale-*` and `.released-*` siblings, and
contending one-shot processes that each claim, mutate and release. Callers are store locks
(`plain`), waiting push-role requests (`wait`) and `ifAvailable` push-role requests.

| Config | Checks | Expected |
| --- | --- | --- |
| `FsLock.fixed.cfg` | Mutual exclusion (`M1`), a holder's record stays at the lock path (`M2`), quarantine destinations hold only their dead owner's directory (`Fence`), rollback never meets a foreign record (`NoImpossible`), and honest "retry" and "stale" diagnoses; three contenders, plain and `ifAvailable` callers, crashes | pass |
| `FsLock.bug-quarantine-aba.cfg` | Before the quarantine re-check was added (#310), a lock released and reclaimed after the owner snapshot is moved aside while held | `M1` violated |
| `FsLock.bug-stale-diagnosis.cfg` | Before the diagnosis re-check was added (#310), a live replacement lock is reported as stale | `StaleDiagAccurate` violated |
| `FsLock.bug-pid-reuse-diagnosis.cfg` | Open: a crashed holder's reused pid keeps plain and waiting callers on a "retry" diagnosis | `RetryDiagAccurate` violated |
| `FsLock.bug-hostname-change-diagnosis.cfg` | Open: after a hostname change, a crashed holder's lock is diagnosed as "retry" forever | `RetryDiagAccurate` violated |
| `FsLock.assumption-pid-namespace.cfg` | Contenders that share the lock root from different PID namespaces break exclusion even with both re-checks | `M1` violated |

Assumptions the fixed config relies on:

- Every process that shares a lock root is in the same PID namespace and on the same host, so
  `kill(pid, 0)` answering "no such process" means the owner is dead. Containers that share `/tmp`
  and the hostname but not the PID namespace violate this; `FsLock.assumption-pid-namespace.cfg`
  shows the result.
- Nothing outside the lock protocol deletes a held lock directory (for example a temporary-file
  cleaner).
- The host uses the default POSIX policy, so directory contention errors never occur and every
  failed rename or removal is final.
- The filesystem reports directory birth times, and POSIX rename semantics hold (renaming onto a
  non-empty directory fails).
- Owner-record reads are definitive; the code polls transient read errors out and fails closed.

## intent-journal

`WorkingCopy.tla` models two documents, one or two concurrent `sync()` runs over one store, a
third-party writer, and content-addressed versions, so an authority revert reproduces an earlier
heads digest. `TruthfulDigest` says a 304 answer never hides a difference between an unheld local
document and the authority; `NoRegress` says an unheld document never moves back to an older
authority state.

| Config | Checks | Expected |
| --- | --- | --- |
| `WorkingCopy.fixed.cfg` | `TruthfulDigest` and `NoRegress` with two runs serialized (#311) and pull consistency (#314), both on `main`, and `AckInvalidates` (design target) | pass |
| `WorkingCopy.bug-ack-keeps-digest.cfg` | Open: an acknowledgement keeps the recorded heads digest, so a later return to that digest answers 304 over a stale copy, in a single realm | `TruthfulDigest` violated |
| `WorkingCopy.bug-pull-inconsistent-digest.cfg` | Before pull consistency was added (#314), pull records the listing's digest after a document changed between the heads answer and its fetch | `TruthfulDigest` violated |
| `WorkingCopy.bug-overlapping-sync.cfg` | Two unserialized runs: a pull whose listing predates a push acknowledgement deletes the acknowledged create | `NoRegress` violated |

`main` serializes `sync()` calls within one runtime (#311). Two tabs over one store are two
runtimes and are not serialized by it, so `WorkingCopy.bug-overlapping-sync.cfg` still describes
them.

`IntentLifecycle.tla` models one document's journal with crashes, lost requests and answers,
authority conflicts, content and authorization refusals, and an authority that records each
request identity's outcome. Its invariants say a request identity is resubmitted only after a
lookup found nothing, a possibly delivered identity is durably marked, an identity that may have
been applied is never superseded or resolved away, and chained intents are submitted in order.
`EventuallyAllSettled` says every change is eventually acknowledged or resolved away.

| Config | Checks | Expected |
| --- | --- | --- |
| `IntentLifecycle.fixed.cfg` | All invariants and `EventuallyAllSettled` with `ReclaimBeforePush` and `AdmitRefused` (design targets), every fault kind | pass |
| `IntentLifecycle.bug-never-reclaim.cfg` | Open: exact-mode `pushWithRole` never reclaims, so a crash after the claim leaves the intent in flight forever | `EventuallyAllSettled` violated |
| `IntentLifecycle.bug-refused-head-wedge.cfg` | Open: a content-refused head with a chained successor has no exit in exact mode | `EventuallyAllSettled` violated |
| `IntentLifecycle.bug-claim-aba.cfg` | Open: `push` called outside the push role; the claim compares state only, so an intent claimed before can skip its lookup | `NoBlindResubmit` violated |

Abstractions: a pull or push step is one IndexedDB transaction or one await; the push role is a
mutex; the lookup rounds are collapsed to one lookup that may fail; retention expiry is left to
`identified-write`. See each spec's header for the full list.

## identified-write

`IdentifiedWrite.tla` models one identified write, a lossy network with deadlines and orphaned
requests, an outcome store with retention and restarts, and a third party that can restore earlier
bytes. `Mode` selects how the client treats "no outcome recorded": the reference wire resubmits,
the hosted transport trusts absence only within retention of the intent's creation, and the
proposed rule trusts absence only when the store provably saw the first send.

| Config | Checks | Expected |
| --- | --- | --- |
| `IdentifiedWrite.fixed.cfg` | `AtMostOnce`, `NoLostUpdate`, `NoMisleadingConflict`, `AckHonest` and `EventuallySettles` for the proposed client rule plus server guard (design target) | pass |
| `IdentifiedWrite.bug-ref-expiry.cfg` | Open: on the reference wire, a write whose answer was lost is applied again after its record expires and a third party reverted | `AtMostOnce` violated |
| `IdentifiedWrite.bug-ref-restart.cfg` | Open: the same through a memory outcome store restart, with no expiry | `AtMostOnce` violated |
| `IdentifiedWrite.bug-ref-misleading-conflict.cfg` | Open: a write that already landed is shown as a conflict | `NoMisleadingConflict` violated |
| `IdentifiedWrite.bug-hosted-wedge.cfg` | Open: the hosted transport reports UNKNOWN forever once absence falls outside retention of `createdAt` | `EventuallySettles` violated |
| `IdentifiedWrite.bug-no-server-guard.cfg` | The proposed client rule without the server guard: a restart with a duplicate request in flight applies it twice | `AtMostOnce` violated |

Abstractions: time is a few coarse ticks with retention of two ticks; the server's claim, apply
and record are one atomic step (faithful for the single-process memory store); there is one
document and one client; deletes are not modeled.
