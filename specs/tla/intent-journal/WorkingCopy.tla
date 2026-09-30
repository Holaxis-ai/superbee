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
(*   PullKnown        pull: lastKnownDigest                                *)
(*   PullMark         pull: the in-progress pull marker                    *)
(*   PullHeld         pull: heldTargets snapshot                           *)
(*   PullHeads        pull: wire heads with If-None-Match; 304 -> complete *)
(*   PullDiff         pull: listing diff against base:<id>                 *)
(*   PullReadMany     pull: fetchAndApply -> readMany                      *)
(*   Apply*           pull: apply -> writeJournaled                        *)
(*   Rec*             reconcileDeletions -> deleteJournaled                *)
(*   RecEnd           pull: complete(answer.digest)                        *)
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
(*    folded into acquiring it.                                            *)
(*  - lseq is a ghost: the authority write the local copy of d reflects.   *)
(*    It exists only for NoRegress.                                        *)
(*                                                                         *)
(* Knobs. All FALSE is the code before sync() serialization and pull       *)
(* consistency were added. main has PullConsistency, and Serialize within  *)
(* one runtime (two tabs are still unserialized), but not AckInvalidates.  *)
(*   Serialize       one sync() at a time over the store                   *)
(*   PullConsistency pull fetches through readPresent and records the      *)
(*                   listing's digest only if every fetched document read  *)
(*                   back at its listed version, as bootstrap does         *)
(*   AckInvalidates  the acknowledging settle transaction also drops the   *)
(*                   recorded heads digest                                 *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Threads, Docs, Vals, Absent, NoBase, None,
          InitDoc,          \* initial (bootstrapped) state, Docs -> Vals \cup {Absent}
          MaxTP,            \* budget of third-party authority writes
          MaxCommits,       \* budget of local user commits
          Serialize, PullConsistency, AckInvalidates

VARIABLES
  doc,      \* local documents store: d -> Vals \cup {Absent}
  base,     \* meta row base:<id>: d -> Vals \cup {NoBase}; NoBase = row absent or version null
  intent,   \* journal: d -> [st, b, l]
  marker,   \* meta row holding the pull marker: [done, dig]
  auth,     \* the shared authority: d -> Vals \cup {Absent}
  aseq,     \* ghost: authority write counter per doc
  lseq,     \* ghost: authority write the local copy reflects
  role,     \* push role holder (Web Lock) or None
  busy,     \* threads inside sync() (used only by Serialize)
  pc,       \* per-thread program counter
  L,        \* per-thread locals of the running pull or push
  tp, commits

vars == <<doc, base, intent, marker, auth, aseq, lseq, role, busy, pc, L, tp, commits>>

Unsettled == {"pending", "inflight", "conflict"}
HeldIn(i, d) == i[d].st \in Unsettled
Held(d) == HeldIn(intent, d)

NoIntent == [st |-> "none", b |-> Absent, l |-> Absent]

Blank == [known |-> None, held |-> {},
          listing |-> [d \in Docs |-> Absent], lseqL |-> [d \in Docs |-> 0],
          todo |-> {}, cands |-> {}, fetched |-> [d \in Docs |-> Absent],
          fseq |-> [d \in Docs |-> 0], cur |-> None, expV |-> None,
          out |-> None, ackSeq |-> 0, consistent |-> TRUE]

Init ==
  /\ doc = InitDoc
  /\ base = [d \in Docs |-> IF InitDoc[d] = Absent THEN NoBase ELSE InitDoc[d]]
  /\ intent = [d \in Docs |-> NoIntent]
  \* bootstrap completed with its heads digest, which lastKnownDigest falls back to
  /\ marker = [done |-> TRUE, dig |-> InitDoc]
  /\ auth = InitDoc
  /\ aseq = [d \in Docs |-> 0]
  /\ lseq = [d \in Docs |-> 0]
  /\ role = None
  /\ busy = {}
  /\ pc = [t \in Threads |-> "idle"]
  /\ L = [t \in Threads |-> Blank]
  /\ tp = 0
  /\ commits = 0

SetL(t, f, v) == L' = [L EXCEPT ![t][f] = v]

\* sync() returns or rejects.
Finish(t) ==
  /\ pc' = [pc EXCEPT ![t] = "idle"]
  /\ L' = [L EXCEPT ![t] = Blank]
  /\ busy' = busy \ {t}

\* pull's complete(): an unconditional marker write.
Complete(t, dig) ==
  /\ marker' = [done |-> TRUE, dig |-> dig]
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
  /\ UNCHANGED <<base, marker, auth, aseq, lseq, role, busy, pc, L, tp>>

\* Someone else writes, creates or deletes on the authority.
ThirdParty(d, v) ==
  /\ tp < MaxTP
  /\ v # auth[d]
  /\ auth' = [auth EXCEPT ![d] = v]
  /\ aseq' = [aseq EXCEPT ![d] = @ + 1]
  /\ tp' = tp + 1
  /\ UNCHANGED <<doc, base, intent, marker, lseq, role, busy, pc, L, commits>>

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
       ELSE \* the role is held elsewhere: go straight to the pull
            /\ pc' = [pc EXCEPT ![t] = "pull_known"]
            /\ UNCHANGED <<role, L>>
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, tp, commits>>

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
  /\ UNCHANGED <<doc, base, marker, auth, aseq, lseq, role, busy, tp, commits>>

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
  /\ UNCHANGED <<doc, base, intent, marker, lseq, role, busy, tp, commits>>

\* settleIntent: a CAS on in_flight; committed moves base:<id> in the same transaction.
PushSettle(t) ==
  /\ pc[t] = "push_settle"
  /\ LET d == L[t].cur IN
     /\ intent[d].st = "inflight"   \* always true here (one pusher, no reclaim)
     /\ IF L[t].out = "committed"
          THEN /\ intent' = [intent EXCEPT ![d].st = "acked"]
               /\ base' = [base EXCEPT ![d] = intent[d].l]
               /\ lseq' = [lseq EXCEPT ![d] = L[t].ackSeq]
               /\ IF AckInvalidates
                    THEN marker' = [marker EXCEPT !.dig = None]
                    ELSE UNCHANGED marker
          ELSE /\ intent' = [intent EXCEPT ![d].st = "conflict"]
               /\ UNCHANGED <<base, lseq, marker>>
  /\ pc' = [pc EXCEPT ![t] = "push"]
  /\ L' = [L EXCEPT ![t].cur = None, ![t].out = None, ![t].ackSeq = 0]
  /\ UNCHANGED <<doc, auth, aseq, role, busy, tp, commits>>

PushEnd(t) ==
  /\ pc[t] = "push" /\ L[t].todo = {}
  /\ role' = None
  /\ pc' = [pc EXCEPT ![t] = "pull_known"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, busy, L, tp, commits>>

----------------------------------------------------------------------------
(* pull, heads path *)

\* known = lastKnownDigest
PullKnown(t) ==
  /\ pc[t] = "pull_known"
  /\ SetL(t, "known", IF marker.done THEN marker.dig ELSE None)
  /\ pc' = [pc EXCEPT ![t] = "pull_mark"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, tp, commits>>

\* The in-progress marker: an unconditional meta write.
PullMark(t) ==
  /\ pc[t] = "pull_mark"
  /\ marker' = [done |-> FALSE, dig |-> None]
  /\ pc' = [pc EXCEPT ![t] = "pull_held"]
  /\ UNCHANGED <<doc, base, intent, auth, aseq, lseq, role, busy, L, tp, commits>>

\* heldTargets snapshot
PullHeld(t) ==
  /\ pc[t] = "pull_held"
  /\ SetL(t, "held", {d \in Docs : Held(d)})
  /\ pc' = [pc EXCEPT ![t] = "pull_heads"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, tp, commits>>

\* wire heads with If-None-Match; a 304 completes with the known digest
PullHeads(t) ==
  /\ pc[t] = "pull_heads"
  /\ IF L[t].known # None /\ L[t].known = auth
       THEN /\ Complete(t, L[t].known)
            /\ UNCHANGED <<doc, base, intent, auth, aseq, lseq, role, tp, commits>>
       ELSE /\ L' = [L EXCEPT ![t].listing = auth, ![t].lseqL = aseq,
                              ![t].todo = {d \in Docs : auth[d] # Absent}]
            /\ pc' = [pc EXCEPT ![t] = "pull_diff"]
            /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, tp, commits>>

\* The listing diff: held targets (snapshot) are skipped; base is read outside any write.
PullDiff(t, d) ==
  /\ pc[t] = "pull_diff" /\ d \in L[t].todo
  /\ L' = [L EXCEPT ![t].todo = @ \ {d},
                    ![t].cands = IF d \in L[t].held \/ base[d] = L[t].listing[d]
                                   THEN @ ELSE @ \cup {d}]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, pc, tp, commits>>

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
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, tp, commits>>

\* apply: read base
ApplyReadBase(t, d) ==
  /\ pc[t] = "apply" /\ d \in L[t].todo
  /\ IF base[d] = L[t].fetched[d]
       THEN /\ SetL(t, "todo", L[t].todo \ {d})
            /\ UNCHANGED pc
       ELSE /\ L' = [L EXCEPT ![t].todo = @ \ {d}, ![t].cur = d]
            /\ pc' = [pc EXCEPT ![t] = "apply_local"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, tp, commits>>

\* apply: expectedVersion = localVersion
ApplyReadLocal(t) ==
  /\ pc[t] = "apply_local"
  /\ SetL(t, "expV", doc[L[t].cur])
  /\ pc' = [pc EXCEPT ![t] = "apply_txn"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, tp, commits>>

\* apply: writeJournaled checks unsettled intents and the document CAS, then writes the
\* document and base:<id>. A hold or version conflict is reported as held.
ApplyTxn(t) ==
  /\ pc[t] = "apply_txn"
  /\ LET d == L[t].cur IN
     IF Held(d) \/ doc[d] # L[t].expV
       THEN /\ UNCHANGED <<doc, base, lseq>>
       ELSE /\ doc' = [doc EXCEPT ![d] = L[t].fetched[d]]
            /\ base' = [base EXCEPT ![d] = L[t].fetched[d]]
            /\ lseq' = [lseq EXCEPT ![d] = L[t].fseq[d]]
  /\ pc' = [pc EXCEPT ![t] = "apply"]
  /\ L' = [L EXCEPT ![t].cur = None, ![t].expV = None]
  /\ UNCHANGED <<intent, marker, auth, aseq, role, busy, tp, commits>>

ApplyEnd(t) ==
  /\ pc[t] = "apply" /\ L[t].todo = {}
  /\ pc' = [pc EXCEPT ![t] = "rec_list"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, L, tp, commits>>

\* reconcileDeletions: present local documents that the listing does not name
RecList(t) ==
  /\ pc[t] = "rec_list"
  /\ SetL(t, "todo", {d \in Docs : doc[d] # Absent /\ L[t].listing[d] = Absent})
  /\ pc' = [pc EXCEPT ![t] = "rec"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, tp, commits>>

\* reconcileDeletions: expectedVersion = localVersion
RecReadLocal(t, d) ==
  /\ pc[t] = "rec" /\ d \in L[t].todo
  /\ L' = [L EXCEPT ![t].todo = @ \ {d}, ![t].cur = d, ![t].expV = doc[d]]
  /\ pc' = [pc EXCEPT ![t] = "rec_txn"]
  /\ UNCHANGED <<doc, base, intent, marker, auth, aseq, lseq, role, busy, tp, commits>>

\* reconcileDeletions: deleteJournaled. An unsettled intent keeps the document and nulls
\* its base version; a version conflict leaves it held.
RecTxn(t) ==
  /\ pc[t] = "rec_txn"
  /\ LET d == L[t].cur IN
     IF Held(d)
       THEN /\ base' = [base EXCEPT ![d] = NoBase]
            /\ UNCHANGED <<doc, lseq>>
     ELSE IF (L[t].expV # Absent /\ doc[d] # L[t].expV) \/ doc[d] = Absent
       THEN /\ UNCHANGED <<doc, base, lseq>>
     ELSE /\ doc' = [doc EXCEPT ![d] = Absent]
          /\ base' = [base EXCEPT ![d] = NoBase]
          /\ lseq' = [lseq EXCEPT ![d] = L[t].lseqL[d]]
  /\ pc' = [pc EXCEPT ![t] = "rec"]
  /\ L' = [L EXCEPT ![t].cur = None, ![t].expV = None]
  /\ UNCHANGED <<intent, marker, auth, aseq, role, busy, tp, commits>>

\* pull: complete(answer.digest)
RecEnd(t) ==
  /\ pc[t] = "rec" /\ L[t].todo = {}
  /\ Complete(t, IF PullConsistency /\ ~L[t].consistent THEN None ELSE L[t].listing)
  /\ UNCHANGED <<doc, base, intent, auth, aseq, lseq, role, tp, commits>>

----------------------------------------------------------------------------
Next ==
  \/ \E d \in Docs, v \in Vals : Commit(d, v)
  \/ \E d \in Docs, v \in Vals \cup {Absent} : ThirdParty(d, v)
  \/ \E t \in Threads :
       \/ SyncStart(t) \/ PushEnd(t) \/ PushDeliver(t) \/ PushSettle(t)
       \/ \E d \in Docs : PushClaim(t, d) \/ PullDiff(t, d) \/ ApplyReadBase(t, d) \/ RecReadLocal(t, d)
       \/ PullKnown(t) \/ PullMark(t) \/ PullHeld(t) \/ PullHeads(t) \/ PullReadMany(t)
       \/ ApplyReadLocal(t) \/ ApplyTxn(t) \/ ApplyEnd(t) \/ RecList(t) \/ RecTxn(t) \/ RecEnd(t)

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
  /\ doc \in [Docs -> Vals \cup {Absent}]
  /\ base \in [Docs -> Vals \cup {NoBase}]
  /\ auth \in [Docs -> Vals \cup {Absent}]
  /\ pc \in [Threads -> {"idle","push","push_deliver","push_settle","pull_known","pull_mark",
                          "pull_held","pull_heads","pull_diff","apply","apply_local","apply_txn",
                          "rec_list","rec","rec_txn"}]

\* A 304 is truthful: if the completed marker's digest names the authority's current state,
\* every unheld local document equals the authority's.
TruthfulDigest ==
  (marker.done /\ marker.dig = auth) => \A d \in Docs : ~Held(d) => doc[d] = auth[d]

\* No regression (an action property): an unheld document never moves to an authority state
\* older than one it already reflected.
NoRegress ==
  [][\A d \in Docs : (~HeldIn(intent, d) /\ ~HeldIn(intent', d)) => lseq'[d] >= lseq[d]]_vars
=============================================================================
