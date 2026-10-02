----------------------------- MODULE WorkingCopy -----------------------------
(***************************************************************************)
(* Data flow of the browser-local intent-journal working copy in exact     *)
(* mode against a heads-capable wire authority: sync() = push, then pull.  *)
(*                                                                         *)
(* Code modeled (packages/browser-local/src/local-bundle.ts unless noted): *)
(*   SyncStart        platform/browser-local.ts createBrowserLocalRuntime  *)
(*                    sync(); push-role.ts withPushRole (ifAvailable)      *)
(*   Commit           commitLocal, composeIntent (supersede or new intent) *)
(*   PushClaim        push: updateIntent CAS pending -> in_flight          *)
(*   PushDeliver      packages/core/src/uncertain-write.ts                 *)
(*                    performUncertainWrite, settleAgainstIntent           *)
(*   PushSettle       settleIntent (committed moves base:<id>)             *)
(*   PullAck          pull: startedAt, and the acknowledgement row         *)
(*   PullKnown        pull: lastKnownDigest                                *)
(*   PullMark         pull: the in-progress pull marker                    *)
(*   PullHeld         pull: heldTargets snapshot                           *)
(*   PullHeads        pull: wire heads with If-None-Match; 304 -> complete *)
(*   PullDiff         pull: listing diff against base:<id>                 *)
(*   PullReadMany     pull: fetchAndApply -> readMany                      *)
(*   Apply*           pull: apply -> fencedSnapshot, writeJournaled        *)
(*   Rec*             reconcileDeletions -> fencedSnapshot, deleteJournaled*)
(*   RecEnd           pull: complete(answer.digest)                        *)
(*   Superseded       pull: report `superseded`; platform/browser-local.ts *)
(*                    syncOnce then pulls once more                        *)
(*   ThirdParty       another writer on the authority                      *)
(* writeJournaled and deleteJournaled are one transaction each             *)
(* (packages/core/src/indexeddb-backend.ts).                               *)
(*                                                                         *)
(* Threads are concurrent sync() runs over one store: two tabs, or two     *)
(* overlapping sync() calls on one runtime. With one thread it is the      *)
(* single-realm case (the CLI hosted checkout, which syncs under an        *)
(* exclusive checkout lock). One action is one IndexedDB transaction or    *)
(* one await.                                                              *)
(*                                                                         *)
(* Abstractions:                                                           *)
(*  - Versions are content-addressed on both sides (version = content), so *)
(*    a revert on the authority reproduces the same heads digest (ABA).    *)
(*    The managed-field difference between acknowledged and local versions *)
(*    is omitted.                                                          *)
(*  - Digest(listing) is the listing itself (Docs -> Vals \cup {Absent}).  *)
(*    The wire adapter's digest verification is assumed to pass.           *)
(*  - At most one intent per document. Commit is allowed when the document *)
(*    has no intent, an acknowledged one, or a never-delivered pending one *)
(*    (supersede). Chains, user deletes, crashes, lost answers, reclaim    *)
(*    and resolve belong to IntentLifecycle.                               *)
(*  - The deletion bound (deletionBound) never trips with two documents.   *)
(*  - forEachBatch runs one batch (DEFAULT_BATCH_SIZE exceeds |Docs|), and *)
(*    readMany is one atomic read of the authority.                        *)
(*  - The per-document loops pick documents in any order (a superset of    *)
(*    the code's listing order).                                           *)
(*  - The push role is a global mutex `role`; listIntents("pending") is    *)
(*    folded into acquiring it. A sync that finds the role held elsewhere  *)
(*    pulls here; the runtime returns without pulling, so the model has    *)
(*    more concurrent pulls than the code.                                 *)
(*  - Acknowledgement times are a counter, `acks`. A pull records the      *)
(*    counter it read at its start, and lastKnownDigest offers the digest  *)
(*    only if no acknowledgement has settled since. The code compares      *)
(*    timestamps with >=, which also drops a digest when an                *)
(*    acknowledgement shares the pull's start instant.                     *)
(*  - With PullFence, a guard refused under a fence that still holds is    *)
(*    classified (fenceStanding) in the refusing step, and marking retries *)
(*    or marks without a digest nondeterministically, which covers the     *)
(*    code's bounded retries (PULL_MARK_ATTEMPTS). A superseded pull may   *)
(*    pull again any number of times, where the runtime pulls once more.   *)
(*  - lseq is a ghost: the authority write the local copy of d reflects.   *)
(*    It exists only for NoRegress.                                        *)
(*                                                                         *)
(* Knobs. All FALSE is the code before sync() serialization, pull         *)
(* consistency, acknowledgement invalidation and the pull fence were added.*)
(* main has all four, with Serialize only within one runtime: two tabs are *)
(* two runtimes and are not serialized.                                    *)
(*   Serialize       one sync() at a time over the store                   *)
(*   PullConsistency pull fetches through readPresent and records the      *)
(*                   listing's digest only if every fetched document read  *)
(*                   back at its listed version, as bootstrap does         *)
(*   AckInvalidates  lastKnownDigest ignores a digest recorded by a pull,  *)
(*                   or the bootstrap, that started before the latest      *)
(*                   acknowledgement                                       *)
(*   PullFence       the pull marks with a fresh run token as a CAS over   *)
(*                   the marker its digest came from; every refresh and    *)
(*                   deletion is guarded by one snapshot of the document,  *)
(*                   its journal and base, the pull marker and the         *)
(*                   acknowledgement row; complete() is a CAS on its own   *)
(*                   marker. A failed fence supersedes the pull            *)
(*   FenceIgnoresMarker  mutant: the per-write guard pins the snapshot and *)
(*                   the acknowledgement row but not the pull marker       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Threads, Docs, Vals, Absent, NoBase, None,
          InitDoc,          \* initial (bootstrapped) state, Docs -> Vals \cup {Absent}
          MaxTP,            \* budget of third-party authority writes
          MaxCommits,       \* budget of local user commits
          Serialize, PullConsistency, AckInvalidates, PullFence, FenceIgnoresMarker

VARIABLES
  doc,      \* local documents store: d -> Vals \cup {Absent}
  base,     \* meta row base:<id>: d -> Vals \cup {NoBase}; NoBase = row absent or version null
  intent,   \* journal: d -> [st, b, l]
  marker,   \* meta row holding the pull marker: [done, dig, owner, ack]; owner is the pull
            \* that wrote it (its run token), kept only with PullFence; ack is `acks` at the
            \* pull's start (its startedAt)
  acks,     \* meta row `acknowledged`, rewritten by every acknowledgement: a counter here
  auth,     \* the shared authority: d -> Vals \cup {Absent}
  aseq,     \* ghost: authority write counter per doc
  lseq,     \* ghost: authority write the local copy reflects
  role,     \* push role holder (Web Lock) or None
  busy,     \* threads inside sync() (used only by Serialize)
  pc,       \* per-thread program counter
  L,        \* per-thread locals of the running pull or push
  tp, commits

vars == <<doc, base, intent, marker, auth, aseq, lseq, role, busy, pc, L, tp, commits, acks>>

Unsettled == {"pending", "inflight", "conflict"}
HeldIn(i, d) == i[d].st \in Unsettled
Held(d) == HeldIn(intent, d)

NoIntent == [st |-> "none", b |-> Absent, l |-> Absent]

Blank == [known |-> None, held |-> {}, mk |-> None, ack |-> 0, seen |-> None,
          listing |-> [d \in Docs |-> Absent], lseqL |-> [d \in Docs |-> 0],
          todo |-> {}, cands |-> {}, fetched |-> [d \in Docs |-> Absent],
          fseq |-> [d \in Docs |-> 0], cur |-> None, expV |-> None,
          out |-> None, ackSeq |-> 0, consistent |-> TRUE]

Init ==
  /\ doc = InitDoc
  /\ base = [d \in Docs |-> IF InitDoc[d] = Absent THEN NoBase ELSE InitDoc[d]]
  /\ intent = [d \in Docs |-> NoIntent]
  \* bootstrap completed with its heads digest, which lastKnownDigest falls back to
  /\ marker = [done |-> TRUE, dig |-> InitDoc, owner |-> None, ack |-> 0]
  /\ auth = InitDoc
  /\ aseq = [d \in Docs |-> 0]
  /\ lseq = [d \in Docs |-> 0]
  /\ role = None
  /\ busy = {}
  /\ pc = [t \in Threads |-> "idle"]
  /\ L = [t \in Threads |-> Blank]
  /\ tp = 0
  /\ commits = 0
  /\ acks = 0

SetL(t, f, v) == L' = [L EXCEPT ![t][f] = v]

\* sync() returns or rejects.
Finish(t) ==
  /\ pc' = [pc EXCEPT ![t] = "idle"]
  /\ L' = [L EXCEPT ![t] = Blank]
  /\ busy' = busy \ {t}

\* The in-progress marker a fenced pull wrote, and whether the pull still owns it.
OwnMark(t) == [done |-> FALSE, dig |-> None, owner |-> t, ack |-> 0]
FenceHolds(t) == (FenceIgnoresMarker \/ marker = OwnMark(t)) /\ acks = L[t].ack
\* What fencedSnapshot pins for one document besides the fence rows.
Snap(d) == <<doc[d], base[d], intent[d]>>
\* lastKnownDigest: the completed marker's digest, unless an acknowledgement settled since
\* the pull (or bootstrap) that recorded it started.
Offered == IF marker.done /\ (~AckInvalidates \/ marker.ack = acks) THEN marker.dig ELSE None

\* A superseded pull writes nothing more and records no marker. The runtime pulls once more;
\* here it may pull again or return.
Superseded(t) ==
  \/ Finish(t)
  \/ /\ pc' = [pc EXCEPT ![t] = "pull_ack"]
     /\ L' = [L EXCEPT ![t] = Blank]
     /\ UNCHANGED busy

\* pull's complete(): a marker write; with PullFence a CAS on the pull's own marker.
Complete(t, dig) ==
  IF PullFence /\ marker # OwnMark(t)
    THEN /\ Superseded(t)
         /\ UNCHANGED marker
    ELSE /\ marker' = [done |-> TRUE, dig |-> dig, owner |-> IF PullFence THEN t ELSE None,
                        ack |-> L[t].ack]
         /\ Finish(t)

----------------------------------------------------------------------------
(* Environment *)

\* A local edit in one journaled write. A first intent takes the shared base; over a
\* never-delivered pending one it supersedes, keeping that intent's base.
Commit(d, v) ==
  /\ commits < MaxCommits
  /\ v # doc[d]
  /\ intent[d].st \in {"none", "acked", "pending"}
  /\ doc' = [doc EXCEPT ![d] = v]
  /\ intent' = [intent EXCEPT ![d] =
        [st |-> "pending",
         b  |-> IF intent[d].st = "pending" THEN intent[d].b
                ELSE IF base[d] = NoBase THEN Absent ELSE base[d],
         l  |-> v]]
  /\ commits' = commits + 1
  /\ UNCHANGED <<base, marker, auth, aseq, lseq, role, busy, pc, L, tp, acks>>

\* Someone else writes, creates or deletes on the authority.
ThirdParty(d, v) ==
  /\ tp < MaxTP
  /\ v # auth[d]
  /\ auth' = [auth EXCEPT ![d] = v]
  /\ aseq' = [aseq EXCEPT ![d] = @ + 1]
  /\ tp' = tp + 1
  /\ UNCHANGED <<doc, base, intent, marker, lseq, role, busy, pc, L, commits, acks>>

----------------------------------------------------------------------------
(* sync() = pushWithRole, then pull *)

SyncStart(t) ==
  /\ pc[t] = "idle"
  /\ Serialize => busy = {}
  /\ busy' = busy \cup {t}
  /\ IF role = None
       THEN \* the push role (ifAvailable), then listIntents("pending")
            /\ role' = t
            /\ pc' = [pc EXCEPT ![t] = "push"]
            /\ SetL(t, "todo", {d \in Docs : intent[d].st = "pending"})
       ELSE \* the role is held elsewhere: go straight to the pull (see Abstractions)
            /\ pc' = [pc EXCEPT ![t] = "pull_ack"]
            /\ UNCHANGED <<role, L>>
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, tp, commits, acks>>

\* The claim: a CAS on state pending -> in_flight.
PushClaim(t, d) ==
  /\ pc[t] = "push" /\ d \in L[t].todo
  /\ IF intent[d].st = "pending"
       THEN /\ intent' = [intent EXCEPT ![d].st = "inflight"]
            /\ pc' = [pc EXCEPT ![t] = "push_deliver"]
            /\ L' = [L EXCEPT ![t].todo = @ \ {d}, ![t].cur = d]
       ELSE \* claimed elsewhere
            /\ SetL(t, "todo", L[t].todo \ {d})
            /\ UNCHANGED <<intent, pc>>
  /\ UNCHANGED <<doc, base, marker, auth, aseq, lseq, role, busy, tp, commits, acks>>

\* One submission: the authority's CAS on the intent's base (the answer is never lost here).
\* A conflict naming the intent's own version settles as committed (settleAgainstIntent).
PushDeliver(t) ==
  /\ pc[t] = "push_deliver"
  /\ LET d == L[t].cur IN
     IF auth[d] = intent[d].b
       THEN /\ auth' = [auth EXCEPT ![d] = intent[d].l]
            /\ aseq' = [aseq EXCEPT ![d] = @ + 1]
            /\ L' = [L EXCEPT ![t].out = "committed", ![t].ackSeq = aseq[d] + 1]
       ELSE IF auth[d] = intent[d].l
       THEN /\ L' = [L EXCEPT ![t].out = "committed", ![t].ackSeq = aseq[d]]
            /\ UNCHANGED <<auth, aseq>>
       ELSE /\ L' = [L EXCEPT ![t].out = "conflict"]
            /\ UNCHANGED <<auth, aseq>>
  /\ pc' = [pc EXCEPT ![t] = "push_settle"]
  /\ UNCHANGED <<doc, base, intent, marker, lseq, role, busy, tp, commits, acks>>

\* settleIntent: a CAS on in_flight; committed moves base:<id> and rewrites the
\* acknowledgement row in the same transaction. The pull marker is not written.
PushSettle(t) ==
  /\ pc[t] = "push_settle"
  /\ LET d == L[t].cur IN
     /\ intent[d].st = "inflight"   \* always true here (one pusher, no reclaim)
     /\ IF L[t].out = "committed"
          THEN /\ intent' = [intent EXCEPT ![d].st = "acked"]
               /\ base' = [base EXCEPT ![d] = intent[d].l]
               /\ lseq' = [lseq EXCEPT ![d] = L[t].ackSeq]
               /\ acks' = acks + 1
               /\ UNCHANGED marker
          ELSE /\ intent' = [intent EXCEPT ![d].st = "conflict"]
               /\ UNCHANGED <<base, lseq, marker, acks>>
  /\ pc' = [pc EXCEPT ![t] = "push"]
  /\ L' = [L EXCEPT ![t].cur = None, ![t].out = None, ![t].ackSeq = 0]
  /\ UNCHANGED <<doc, auth, aseq, role, busy, tp, commits>>

PushEnd(t) ==
  /\ pc[t] = "push" /\ L[t].todo = {}
  /\ role' = None
  /\ pc' = [pc EXCEPT ![t] = "pull_ack"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, busy, L, tp, commits, acks>>

----------------------------------------------------------------------------
(* pull, heads path *)

\* The pull's start: startedAt, then (with PullFence) the acknowledgement row its fence pins,
\* read once before marking.
PullAck(t) ==
  /\ pc[t] = "pull_ack"
  /\ SetL(t, "ack", acks)
  /\ pc' = [pc EXCEPT ![t] = "pull_known"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, tp, commits, acks>>

\* known = lastKnownDigest, with the marker it was read from.
PullKnown(t) ==
  /\ pc[t] = "pull_known"
  /\ L' = [L EXCEPT ![t].known = Offered,
                    ![t].mk = IF PullFence THEN marker ELSE None]
  /\ pc' = [pc EXCEPT ![t] = "pull_mark"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, tp, commits, acks>>

\* The in-progress marker. Unfenced it is an unconditional meta write. With PullFence it is a
\* CAS over the marker `known` came from; on a mismatch the pull reads again, or, past the
\* retry bound, marks anyway and offers no digest.
PullMark(t) ==
  /\ pc[t] = "pull_mark"
  /\ IF PullFence /\ marker # L[t].mk
       THEN \/ /\ pc' = [pc EXCEPT ![t] = "pull_known"]
               /\ UNCHANGED <<marker, L>>
            \/ /\ marker' = OwnMark(t)
               /\ SetL(t, "known", None)
               /\ pc' = [pc EXCEPT ![t] = "pull_held"]
       ELSE /\ marker' = IF PullFence THEN OwnMark(t) ELSE [done |-> FALSE, dig |-> None, owner |-> None, ack |-> 0]
            /\ pc' = [pc EXCEPT ![t] = "pull_held"]
            /\ UNCHANGED L
  /\ UNCHANGED <<doc, base, intent, auth, aseq, lseq, role, busy, tp, commits, acks>>

\* heldTargets snapshot
PullHeld(t) ==
  /\ pc[t] = "pull_held"
  /\ SetL(t, "held", {d \in Docs : Held(d)})
  /\ pc' = [pc EXCEPT ![t] = "pull_heads"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, tp, commits, acks>>

\* wire heads with If-None-Match; a 304 completes with the known digest
PullHeads(t) ==
  /\ pc[t] = "pull_heads"
  /\ IF L[t].known # None /\ L[t].known = auth
       THEN /\ Complete(t, L[t].known)
            /\ UNCHANGED <<doc, base, intent, auth, aseq, lseq, role, tp, commits, acks>>
       ELSE /\ L' = [L EXCEPT ![t].listing = auth, ![t].lseqL = aseq,
                              ![t].todo = {d \in Docs : auth[d] # Absent}]
            /\ pc' = [pc EXCEPT ![t] = "pull_diff"]
            /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, tp, commits, acks>>

\* The listing diff: held targets (snapshot) are skipped; base is read outside any write.
PullDiff(t, d) ==
  /\ pc[t] = "pull_diff" /\ d \in L[t].todo
  /\ L' = [L EXCEPT ![t].todo = @ \ {d},
                    ![t].cands = IF d \in L[t].held \/ base[d] = L[t].listing[d]
                                   THEN @ ELSE @ \cup {d}]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, pc, tp, commits, acks>>

\* fetchAndApply reads the candidates. Without PullConsistency, readMany rejects the whole batch
\* when a candidate is gone, and the pull fails with its marker incomplete. With it, a document
\* gone since the listing is answered as absent and reconciled like an unlisted one, and
\* `consistent` records whether every fetched document read back at its listed version.
PullReadMany(t) ==
  /\ pc[t] = "pull_diff" /\ L[t].todo = {}
  /\ LET gone == {d \in L[t].cands : auth[d] = Absent} IN
     IF L[t].cands = {}
       THEN /\ pc' = [pc EXCEPT ![t] = "rec_list"]
            /\ UNCHANGED <<L, busy>>
     ELSE IF gone # {} /\ ~PullConsistency
       THEN Finish(t)
     ELSE /\ L' = [L EXCEPT ![t].fetched = [d \in Docs |-> IF d \in L[t].cands THEN auth[d] ELSE Absent],
                            ![t].fseq = aseq,
                            ![t].todo = L[t].cands \ gone,
                            ![t].listing = [d \in Docs |-> IF d \in gone THEN Absent ELSE L[t].listing[d]],
                            ![t].lseqL = [d \in Docs |-> IF d \in gone THEN aseq[d] ELSE L[t].lseqL[d]],
                            ![t].consistent = \A d \in L[t].cands : auth[d] = L[t].listing[d]]
          /\ pc' = [pc EXCEPT ![t] = "apply"]
          /\ UNCHANGED busy
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, tp, commits, acks>>

\* apply: read base. With PullFence this is fencedSnapshot: one read of the document, its
\* journal, its base and the fence rows.
ApplyReadBase(t, d) ==
  /\ pc[t] = "apply" /\ d \in L[t].todo
  /\ IF PullFence /\ ~FenceHolds(t)
       THEN Superseded(t)
     ELSE IF base[d] = L[t].fetched[d]
       THEN /\ SetL(t, "todo", L[t].todo \ {d})
            /\ UNCHANGED <<pc, busy>>
     ELSE IF PullFence
       THEN /\ L' = [L EXCEPT ![t].todo = @ \ {d}, ![t].cur = d, ![t].expV = doc[d], ![t].seen = Snap(d)]
            /\ pc' = [pc EXCEPT ![t] = "apply_txn"]
            /\ UNCHANGED busy
       ELSE /\ L' = [L EXCEPT ![t].todo = @ \ {d}, ![t].cur = d]
            /\ pc' = [pc EXCEPT ![t] = "apply_local"]
            /\ UNCHANGED busy
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, tp, commits, acks>>

\* apply: expectedVersion = localVersion
ApplyReadLocal(t) ==
  /\ pc[t] = "apply_local"
  /\ SetL(t, "expV", doc[L[t].cur])
  /\ pc' = [pc EXCEPT ![t] = "apply_txn"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, tp, commits, acks>>

\* apply: writeJournaled checks unsettled intents and the document CAS, then writes the
\* document and base:<id>. A hold or version conflict is reported as held. With PullFence the
\* guard is checked first: a fence that no longer holds supersedes the pull; a snapshot that
\* moved under a fence that holds is held, and unless an intent holds the document the
\* working copy is not the listing's state.
ApplyTxn(t) ==
  /\ pc[t] = "apply_txn"
  /\ LET d == L[t].cur IN
     IF PullFence /\ ~FenceHolds(t)
       THEN /\ Superseded(t)
            /\ UNCHANGED <<doc, base, lseq>>
     ELSE /\ IF PullFence /\ Snap(d) # L[t].seen
               THEN /\ UNCHANGED <<doc, base, lseq>>
                    /\ L' = [L EXCEPT ![t].cur = None, ![t].expV = None, ![t].seen = None,
                                      ![t].consistent = @ /\ Held(d)]
             ELSE IF Held(d) \/ doc[d] # L[t].expV
               THEN /\ UNCHANGED <<doc, base, lseq>>
                    /\ L' = [L EXCEPT ![t].cur = None, ![t].expV = None, ![t].seen = None]
             ELSE /\ doc' = [doc EXCEPT ![d] = L[t].fetched[d]]
                  /\ base' = [base EXCEPT ![d] = L[t].fetched[d]]
                  /\ lseq' = [lseq EXCEPT ![d] = L[t].fseq[d]]
                  /\ L' = [L EXCEPT ![t].cur = None, ![t].expV = None, ![t].seen = None]
          /\ pc' = [pc EXCEPT ![t] = "apply"]
          /\ UNCHANGED busy
  /\ UNCHANGED <<intent, marker, auth, aseq, role, tp, commits, acks>>

ApplyEnd(t) ==
  /\ pc[t] = "apply" /\ L[t].todo = {}
  /\ pc' = [pc EXCEPT ![t] = "rec_list"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, L, tp, commits, acks>>

\* reconcileDeletions: present local documents that the listing does not name
RecList(t) ==
  /\ pc[t] = "rec_list"
  /\ SetL(t, "todo", {d \in Docs : doc[d] # Absent /\ L[t].listing[d] = Absent})
  /\ pc' = [pc EXCEPT ![t] = "rec"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, tp, commits, acks>>

\* reconcileDeletions: expectedVersion = localVersion; with PullFence, fencedSnapshot.
RecReadLocal(t, d) ==
  /\ pc[t] = "rec" /\ d \in L[t].todo
  /\ IF PullFence /\ ~FenceHolds(t)
       THEN Superseded(t)
       ELSE /\ L' = [L EXCEPT ![t].todo = @ \ {d}, ![t].cur = d, ![t].expV = doc[d],
                             ![t].seen = IF PullFence THEN Snap(d) ELSE None]
            /\ pc' = [pc EXCEPT ![t] = "rec_txn"]
            /\ UNCHANGED busy
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, tp, commits, acks>>

\* reconcileDeletions: deleteJournaled. An unsettled intent keeps the document and nulls
\* its base version; a version conflict leaves it held. With PullFence the guard is checked
\* first, as in ApplyTxn.
RecTxn(t) ==
  /\ pc[t] = "rec_txn"
  /\ LET d == L[t].cur IN
     IF PullFence /\ ~FenceHolds(t)
       THEN /\ Superseded(t)
            /\ UNCHANGED <<doc, base, lseq>>
     ELSE /\ IF PullFence /\ Snap(d) # L[t].seen
               THEN /\ UNCHANGED <<doc, base, lseq>>
                    /\ L' = [L EXCEPT ![t].cur = None, ![t].expV = None, ![t].seen = None,
                                      ![t].consistent = @ /\ Held(d)]
             ELSE /\ IF Held(d)
                       THEN /\ base' = [base EXCEPT ![d] = NoBase]
                            /\ UNCHANGED <<doc, lseq>>
                     ELSE IF (L[t].expV # Absent /\ doc[d] # L[t].expV) \/ doc[d] = Absent
                       THEN /\ UNCHANGED <<doc, base, lseq>>
                     ELSE /\ doc' = [doc EXCEPT ![d] = Absent]
                          /\ base' = [base EXCEPT ![d] = NoBase]
                          /\ lseq' = [lseq EXCEPT ![d] = L[t].lseqL[d]]
                  /\ L' = [L EXCEPT ![t].cur = None, ![t].expV = None, ![t].seen = None]
          /\ pc' = [pc EXCEPT ![t] = "rec"]
          /\ UNCHANGED busy
  /\ UNCHANGED <<intent, marker, auth, aseq, role, tp, commits, acks>>

\* pull: complete(answer.digest)
RecEnd(t) ==
  /\ pc[t] = "rec" /\ L[t].todo = {}
  /\ Complete(t, IF PullConsistency /\ ~L[t].consistent THEN None ELSE L[t].listing)
  /\ UNCHANGED <<doc, base, intent, auth, aseq, lseq, role, tp, commits, acks>>

----------------------------------------------------------------------------
Next ==
  \/ \E d \in Docs, v \in Vals : Commit(d, v)
  \/ \E d \in Docs, v \in Vals \cup {Absent} : ThirdParty(d, v)
  \/ \E t \in Threads :
       \/ SyncStart(t) \/ PushEnd(t) \/ PushDeliver(t) \/ PushSettle(t)
       \/ \E d \in Docs : PushClaim(t, d) \/ PullDiff(t, d) \/ ApplyReadBase(t, d) \/ RecReadLocal(t, d)
       \/ PullAck(t) \/ PullKnown(t) \/ PullMark(t) \/ PullHeld(t) \/ PullHeads(t) \/ PullReadMany(t)
       \/ ApplyReadLocal(t) \/ ApplyTxn(t) \/ ApplyEnd(t) \/ RecList(t) \/ RecTxn(t) \/ RecEnd(t)

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
  /\ doc \in [Docs -> Vals \cup {Absent}]
  /\ base \in [Docs -> Vals \cup {NoBase}]
  /\ auth \in [Docs -> Vals \cup {Absent}]
  /\ pc \in [Threads -> {"idle","push","push_deliver","push_settle","pull_ack","pull_known","pull_mark",
                          "pull_held","pull_heads","pull_diff","apply","apply_local","apply_txn",
                          "rec_list","rec","rec_txn"}]

\* A 304 is truthful: if the digest the next pull would offer names the authority's current
\* state, every unheld local document equals the authority's.
TruthfulDigest ==
  Offered = auth => \A d \in Docs : ~Held(d) => doc[d] = auth[d]

\* No regression (an action property): an unheld document never moves to an authority state
\* older than one it already reflected.
NoRegress ==
  [][\A d \in Docs : (~HeldIn(intent, d) /\ ~HeldIn(intent', d)) => lseq'[d] >= lseq[d]]_vars

\* Every pull write to the working copy (a refresh, a deletion, or a held deletion's base
\* rewrite) commits while that pull owns its in-progress marker and no acknowledgement has
\* settled since it read the acknowledgement row. Meaningful only with PullFence.
OwnedWrites ==
  [][\A t \in Threads :
       (pc[t] \in {"apply_txn", "rec_txn"} /\ pc'[t] # pc[t] /\ <<doc', base'>> # <<doc, base>>)
         => (marker = OwnMark(t) /\ acks = L[t].ack)]_vars

\* A digest is recorded only by the pull replacing its own in-progress marker. Meaningful only
\* with PullFence.
DigestByOwner ==
  [][(marker'.done /\ marker'.dig # None /\ marker' # marker)
       => (~marker.done /\ marker.owner # None /\ marker'.owner = marker.owner)]_vars
=============================================================================
