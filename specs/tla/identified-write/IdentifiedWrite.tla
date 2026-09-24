--------------------------- MODULE IdentifiedWrite ---------------------------
(***************************************************************************)
(* One identified, guarded whole-document write (an intent) delivered to a *)
(* shared authority that records outcomes by request identity, in a world  *)
(* with lost messages, deadlines, orphaned requests, outcome-store expiry, *)
(* store restart, and a third-party writer that can restore earlier bytes. *)
(* Versions are content hashes (packages/core/src/versioning.ts), so a     *)
(* version is its bytes and an A -> B -> A revert is invisible to CAS.     *)
(*                                                                         *)
(* Code modeled:                                                           *)
(*   Push, Timeout, LookupLost, Recv                                       *)
(*       packages/core/src/uncertain-write.ts performUncertainWrite,       *)
(*       settleAgainstIntent; packages/browser-local/src/local-bundle.ts   *)
(*       push (claim) and settleIntent                                     *)
(*   Keep, Take    local-bundle.ts resolveConflict (keep local, take       *)
(*                 remote) after inspectConflict                           *)
(*   Resume        local-bundle.ts resume                                  *)
(*   DeliverSub    packages/server/src/router.ts applyIdentified           *)
(*   DeliverLook   router.ts operation lookup; the reference wire maps its *)
(*                 404 to null (packages/core/src/remote-backend.ts        *)
(*                 lookupOperation)                                        *)
(*   Restart, Live packages/server/src/operation-outcomes.ts               *)
(*                 MemoryOperationOutcomeStore (retention, lost on restart)*)
(*   Recv "hosted" packages/core/src/hosted-transport/                     *)
(*                 whole-document-transport.ts lookupIntent                *)
(*                                                                         *)
(* Mode selects the client's rule for "the authority holds nothing under   *)
(* this key":                                                              *)
(*   "ref"     absence => null => resubmit (the reference wire).           *)
(*   "hosted"  absence within (retention - skew) of the anchor => null,    *)
(*             else UNKNOWN (the hosted transport; its anchor is the       *)
(*             intent's createdAt, Anchor = "created").                    *)
(*   "fixed"   a proposed rule: absence is evidence only if the store has  *)
(*             been up since the anchor and the anchor is inside the       *)
(*             retention window; otherwise read the head back: head =      *)
(*             local => committed, else a user-resolvable "unknownReview". *)
(* Guard = "server" adds a proposed server rule: a submission carries when *)
(* its identity was first sent, and the store refuses (records nothing     *)
(* for) a key it may have forgotten.                                       *)
(*                                                                         *)
(* Abstractions:                                                           *)
(*  - One document; contents {V1, Mine, Theirs}; the client's local bytes  *)
(*    are always Mine; the initial head is V1.                             *)
(*  - The server's claim, apply and record are one atomic step. Faithful   *)
(*    for the single-process memory store; it hides the in-progress wait   *)
(*    and the record-throws paths, which are not checked here.             *)
(*  - The lookup rounds of performUncertainWrite are collapsed to one      *)
(*    lookup that either answers or is lost.                               *)
(*  - The deadline is a nondeterministic Timeout while a submission is     *)
(*    outstanding. The abandoned request stays in the network and may      *)
(*    still be applied later (an orphan).                                  *)
(*  - One global clock (no skew between client and store); Skew is only    *)
(*    the safety margin. Lazy expiry is the predicate Live.                *)
(*  - The fixed-mode read-back is atomic with the lookup answer.           *)
(*  - Keep local re-bases on the head the review fetched, under a fresh    *)
(*    request identity; chained successors are not modeled.                *)
(*  - The hosted "not sent" authorization refusal is a local refusal after *)
(*    the claim that incremented attempts and before any send.            *)
(*  - Deletes are not modeled.                                             *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS Mode, Anchor, Guard, TTL, Skew, BoundedDelay, MaxT, MaxLoss, MaxTP, MaxRestart,
          MaxSubs, MaxAuth, MaxKeep, MaxResume

Content == {"V1", "Mine", "Theirs"}
Local   == "Mine"
Rids    == 1..(MaxKeep + 1)
NoTime  == -1          \* anchor for "never sent"

VARIABLES
  \* authority (reference router and memory outcome store, or the hosted host)
  head,       \* current document bytes = version
  hseq,       \* ghost: count of writes to head (identifies which write a head is)
  ownSeq,     \* ghost: hseq produced by this client's latest landed write (-1: none)
  applied,    \* ghost: applied[r] = number of times request r mutated the head
  rec,        \* rec[r] = [k |-> "none"|"committed"|"conflict", v, at]
  horizon,    \* time since which the store has seen every record (last restart)
  \* network
  reqs,       \* set of requests in flight
  resps,      \* set of responses in flight (only to the live request)
  \* client (journal row and performUncertainWrite program counter)
  cst,        \* "pending","sub","look","ack","conflict","refused","unknownReview","taken"
  rid,        \* current intent's request identity
  base, bseq, \* the intent's base bytes, and (ghost) which write the client saw
  claimed,    \* attempts > 0 (the journal claim records it before a send)
  subs,       \* submissions in this performUncertainWrite call
  createdAt, firstSend,
  \* ghosts and budgets
  lostUpdate, misleading, badAck, clock, losses, tps, restarts, auths, keeps, resumes

vars == <<head, hseq, ownSeq, applied, rec, horizon, reqs, resps, cst, rid, base, bseq,
          claimed, subs, createdAt, firstSend,
          lostUpdate, misleading, badAck, clock, losses, tps, restarts, auths, keeps, resumes>>

NoRec == [k |-> "none", v |-> "V1", at |-> 0]

Init ==
  /\ head = "V1" /\ hseq = 0 /\ ownSeq = -1
  /\ applied = [r \in Rids |-> 0]
  /\ rec = [r \in Rids |-> NoRec]
  /\ horizon = -1       \* the store has been up since before the client's history began
  /\ reqs = {} /\ resps = {}
  /\ cst = "pending" /\ rid = 1 /\ base = "V1" /\ bseq = 0
  /\ claimed = FALSE /\ subs = 0
  /\ createdAt = 0 /\ firstSend = NoTime
  /\ lostUpdate = FALSE /\ misleading = FALSE /\ badAck = FALSE
  /\ clock = 0 /\ losses = 0 /\ tps = 0 /\ restarts = 0 /\ auths = 0
  /\ keeps = 0 /\ resumes = 0

\* A record is answerable while now - recordedAt < retention.
Live(r) == rec[r].k # "none" /\ clock - rec[r].at < TTL

-----------------------------------------------------------------------------
(* Client: the absence rule *)
AnchorTime == IF Anchor = "created" THEN createdAt ELSE firstSend

\* hosted: now - createdAt <= retention - skew
HostedTrusts == AnchorTime = NoTime \/ clock - AnchorTime <= TTL - Skew
\* fixed: the store must have been up since the anchor, and the anchor inside the window.
\* The horizon comparison is strict, with the skew margin: a restart in the same instant as
\* the send may have come after it.
FixedCovered == AnchorTime = NoTime \/ (horizon + Skew < AnchorTime /\ clock - AnchorTime < TTL - Skew)

SendSubmit ==
  /\ reqs' = reqs \cup {[t |-> "sub", rid |-> rid, base |-> base, bseq |-> bseq, live |-> TRUE,
                         first |-> IF firstSend = NoTime THEN clock ELSE firstSend]}
  /\ subs' = subs + 1
  /\ claimed' = TRUE
  /\ firstSend' = IF firstSend = NoTime THEN clock ELSE firstSend
  /\ cst' = "sub"

SendLookup ==
  /\ reqs' = reqs \cup {[t |-> "look", rid |-> rid, base |-> base, bseq |-> bseq, live |-> TRUE, first |-> NoTime]}
  /\ cst' = "look"

(* push claims pending -> in_flight with attempts + 1; performUncertainWrite starts with a
   submission iff attempts was 0, otherwise with a lookup. *)
Push ==
  /\ cst = "pending"
  /\ \/ /\ ~claimed
        /\ SendSubmit
        /\ UNCHANGED <<auths, resps>>
     \/ /\ ~claimed                 \* hosted: refused AUTH_REQUIRED, "not sent"; the claim
        /\ auths < MaxAuth          \* already recorded attempts = 1
        /\ auths' = auths + 1
        /\ claimed' = TRUE
        /\ cst' = "refused"
        /\ UNCHANGED <<reqs, resps, subs, firstSend>>
     \/ /\ claimed
        /\ subs' = 0
        /\ SendLookup
        /\ UNCHANGED <<claimed, firstSend, auths, resps>>
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, rid, base, bseq, createdAt,
                 lostUpdate, misleading, badAck, clock, losses, tps, restarts, keeps, resumes>>

(* The deadline aborts the submission, which ends UNKNOWN and looks up. The request itself
   remains in the network as an orphan whose answer nobody reads. *)
Timeout ==
  /\ cst = "sub"
  \* a deadline that fires while the answer could still arrive is budgeted like a loss (else
  \* the deadline could win forever, an infinitely slow server); one after a real loss is free
  /\ LET early == (\E m \in reqs : m.live) \/ resps # {}
     IN /\ early => losses < MaxLoss
        /\ losses' = IF early THEN losses + 1 ELSE losses
  /\ LET dead == {IF m.live THEN [m EXCEPT !.live = FALSE] ELSE m : m \in reqs}
     IN reqs' = dead \cup {[t |-> "look", rid |-> rid, base |-> base, bseq |-> bseq, live |-> TRUE, first |-> NoTime]}
  /\ resps' = {}
  /\ cst' = "look"
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lostUpdate, misleading, badAck,
                 clock, tps, restarts, auths, keeps, resumes>>

(* A lookup that fails (its request or answer was lost) ends the call UNKNOWN; settleIntent
   returns the intent to pending with attempts kept. Enabled only when the lookup really was
   lost. *)
LookupLost ==
  /\ cst = "look"
  /\ ~\E m \in reqs : m.live
  /\ resps = {}
  /\ cst' = "pending"
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, reqs, resps, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lostUpdate, misleading, badAck,
                 clock, losses, tps, restarts, auths, keeps, resumes>>

(* Settling a recorded answer: settleAgainstIntent, applied again by settleIntent. *)
SettleState(o) ==
  IF o.k = "committed" THEN "ack"
  ELSE IF o.k = "conflict" /\ o.v = Local THEN "ack"
  ELSE "conflict"

ClientDone(newCst, ahead) ==   \* ahead: the head when the answer was produced (ghost)
  /\ cst' = newCst
  /\ misleading' = (misleading \/ (newCst = "conflict" /\ applied[rid] > 0))
  /\ badAck' = (badAck \/ (newCst = "ack" /\ applied[rid] = 0 /\ ahead # Local))

Recv ==
  /\ cst \in {"sub", "look"}
  /\ \E a \in resps :
       /\ resps' = resps \ {a}
       /\ CASE a.t = "rec" ->                               \* committed or conflict answer
                 /\ ClientDone(SettleState(a.o), a.o.v)     \* the head when the outcome was recorded
                 /\ UNCHANGED <<reqs, subs, claimed, firstSend>>
            [] a.t = "stale" ->                             \* server guard: the store refused a
                 /\ ClientDone(IF a.head = Local THEN "ack" ELSE "unknownReview", a.head)
                 /\ UNCHANGED <<reqs, subs, claimed, firstSend>>  \* key it cannot vouch for
            [] a.t = "absent" /\ cst = "look" ->            \* 404, or hosted "absent"
                 LET null == CASE Mode = "ref"    -> TRUE
                               [] Mode = "hosted" -> HostedTrusts
                               [] Mode = "fixed"  -> FixedCovered
                 IN IF null
                    THEN IF subs < MaxSubs
                         THEN /\ SendSubmit /\ misleading' = misleading /\ badAck' = badAck
                         ELSE /\ ClientDone("pending", a.head)      \* UNKNOWN -> pending
                              /\ UNCHANGED <<reqs, subs, claimed, firstSend>>
                    ELSE IF Mode = "hosted"
                         THEN /\ ClientDone("pending", a.head)      \* UNKNOWN
                              /\ UNCHANGED <<reqs, subs, claimed, firstSend>>
                         ELSE \* fixed: read the head back; never resubmit on the old base
                              /\ ClientDone(IF a.head = Local THEN "ack" ELSE "unknownReview", a.head)
                              /\ UNCHANGED <<reqs, subs, claimed, firstSend>>
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, rid, base, bseq, createdAt,
                 lostUpdate, clock, losses, tps, restarts, auths, keeps, resumes>>

(* resolveConflict keep-local: a fresh edit under a fresh request identity, based on the
   shared head the review fetched. *)
Keep ==
  /\ cst \in {"conflict", "unknownReview"}
  /\ keeps < MaxKeep
  /\ keeps' = keeps + 1
  /\ rid' = rid + 1
  /\ base' = head /\ bseq' = hseq
  /\ claimed' = FALSE /\ subs' = 0
  /\ createdAt' = clock /\ firstSend' = NoTime
  /\ cst' = "pending"
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, reqs, resps, lostUpdate, misleading, badAck,
                 clock, losses, tps, restarts, auths, resumes>>

Take ==
  /\ cst \in {"conflict", "unknownReview"}
  /\ cst' = "taken"
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, reqs, resps, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lostUpdate, misleading, badAck,
                 clock, losses, tps, restarts, auths, keeps, resumes>>

(* resume: refused-by-authorization -> pending, attempts kept *)
Resume ==
  /\ cst = "refused" /\ resumes < MaxResume
  /\ resumes' = resumes + 1
  /\ cst' = "pending"
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, reqs, resps, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lostUpdate, misleading, badAck,
                 clock, losses, tps, restarts, auths, keeps>>

-----------------------------------------------------------------------------
(* Authority *)
\* The store cannot vouch for a key first sent before its horizon or outside its window.
StaleIdentity(first) == first <= horizon + Skew \/ clock - first >= TTL - Skew

Reply(m, a) == resps' = IF m.live THEN resps \cup {a} ELSE resps

(* applyIdentified: claim; a recorded outcome is replayed; otherwise the guarded write (a CAS
   on the content version) is applied, and a typed 412 is recorded like a response. *)
DeliverSub(m) ==
  /\ m.t = "sub"
  /\ reqs' = reqs \ {m}
  /\ IF Live(m.rid)
     THEN /\ Reply(m, [t |-> "rec", o |-> rec[m.rid], head |-> head])
          /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, lostUpdate>>
     ELSE IF Guard = "server" /\ StaleIdentity(m.first)
     THEN \* the proposed server guard refuses, and records nothing
          /\ Reply(m, [t |-> "stale", o |-> NoRec, head |-> head])
          /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, lostUpdate>>
     ELSE IF head = m.base
          THEN /\ head' = Local /\ hseq' = hseq + 1
               /\ applied' = [applied EXCEPT ![m.rid] = @ + 1]
               /\ rec' = [rec EXCEPT ![m.rid] = [k |-> "committed", v |-> Local, at |-> clock]]
               \* ghost: the CAS matched bytes, but this client already landed a write after
               \* the base this submission carries: a stale resubmission re-applied over a
               \* head someone produced on top of our own landed write. (An ABA before the
               \* client's first landing is ordinary content-addressed CAS.)
               /\ lostUpdate' = (lostUpdate \/ ownSeq > m.bseq)
               /\ ownSeq' = hseq + 1
               /\ Reply(m, [t |-> "rec", o |-> [k |-> "committed", v |-> Local, at |-> clock], head |-> Local])
          ELSE /\ rec' = [rec EXCEPT ![m.rid] = [k |-> "conflict", v |-> head, at |-> clock]]
               /\ Reply(m, [t |-> "rec", o |-> [k |-> "conflict", v |-> head, at |-> clock], head |-> head])
               /\ UNCHANGED <<head, hseq, ownSeq, applied, lostUpdate>>
  /\ UNCHANGED <<horizon, cst, rid, base, bseq, claimed, subs, createdAt, firstSend,
                 misleading, badAck, clock, losses, tps, restarts, auths, keeps, resumes>>

(* The lookup: the recorded outcome, or 404 (absent). The absent answer carries the head
   only for the fixed rule's read-back. *)
DeliverLook(m) ==
  /\ m.t = "look"
  /\ reqs' = reqs \ {m}
  /\ Reply(m, IF Live(m.rid) THEN [t |-> "rec", o |-> rec[m.rid], head |-> head]
                             ELSE [t |-> "absent", o |-> NoRec, head |-> head, at |-> clock])
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, cst, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lostUpdate, misleading, badAck,
                 clock, losses, tps, restarts, auths, keeps, resumes>>

(* The memory outcome store forgets every record on restart. *)
Restart ==
  /\ restarts < MaxRestart
  /\ restarts' = restarts + 1
  /\ rec' = [r \in Rids |-> NoRec]
  /\ horizon' = clock
  /\ UNCHANGED <<head, hseq, ownSeq, applied, reqs, resps, cst, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lostUpdate, misleading, badAck,
                 clock, losses, tps, auths, keeps, resumes>>

(* Another writer, CAS against the head it read; it may restore earlier bytes (ABA). *)
ThirdParty(c) ==
  /\ tps < MaxTP /\ c # head
  /\ tps' = tps + 1
  /\ head' = c /\ hseq' = hseq + 1
  /\ UNCHANGED <<ownSeq, applied, rec, horizon, reqs, resps, cst, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lostUpdate, misleading, badAck,
                 clock, losses, restarts, auths, keeps, resumes>>

LoseReq(m) ==
  /\ losses < MaxLoss /\ losses' = losses + 1
  /\ reqs' = reqs \ {m}
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, resps, cst, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lostUpdate, misleading, badAck,
                 clock, tps, restarts, auths, keeps, resumes>>

LoseResp(a) ==
  /\ losses < MaxLoss /\ losses' = losses + 1
  /\ resps' = resps \ {a}
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, reqs, cst, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lostUpdate, misleading, badAck,
                 clock, tps, restarts, auths, keeps, resumes>>

(* One tick is a coarse unit (the store's retention is a few ticks). With BoundedDelay, no
   request or answer outlives a tick: a tick is longer than any HTTP request's life,
   including RemoteBackend's own transport retries. Without it, a request may sit in the
   network for the whole retention window. *)
Tick ==
  /\ clock < MaxT /\ clock' = clock + 1
  /\ reqs' = IF BoundedDelay THEN {} ELSE reqs
  /\ resps' = IF BoundedDelay THEN {} ELSE resps
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, cst, rid, base, bseq, claimed,
                 subs, createdAt, firstSend, lostUpdate, misleading, badAck,
                 losses, tps, restarts, auths, keeps, resumes>>

Client == Push \/ Timeout \/ LookupLost \/ Recv
Deliver == \E m \in reqs : DeliverSub(m) \/ DeliverLook(m)
User == Keep \/ Take \/ Resume
Env == Restart \/ (\E c \in Content : ThirdParty(c)) \/ (\E m \in reqs : LoseReq(m))
       \/ (\E a \in resps : LoseResp(a)) \/ Tick

Next == Client \/ Deliver \/ User \/ Env

\* Client steps and message delivery are fair; the user, loss, time, restarts and third
\* parties are not (they may stop at any point, and are bounded). Delivery fairness is split
\* by message type so an orphaned submission cannot starve behind a stream of lookups.
Spec == Init /\ [][Next]_vars /\ WF_vars(Client)
        /\ WF_vars(\E m \in reqs : DeliverSub(m)) /\ WF_vars(\E m \in reqs : DeliverLook(m))
        /\ WF_vars(Tick)   \* time passes (bounded by MaxT)

-----------------------------------------------------------------------------
TypeOK ==
  /\ head \in Content /\ cst \in {"pending","sub","look","ack","conflict","refused","unknownReview","taken"}
  /\ rid \in Rids

\* Each request identity mutates the document at most once.
AtMostOnce == \A r \in Rids : applied[r] <= 1
\* No submission lands on a base older than a write this client already landed (a
\* third-party write made on top of our landed write is never silently overwritten).
NoLostUpdate == ~lostUpdate
\* A conflict review is never shown for a request that already landed (its base would omit
\* the client's own write, and keep-local would overwrite a later third-party edit).
NoMisleadingConflict == ~misleading
\* Acknowledged => this request applied, or the head held exactly the local bytes.
AckHonest == ~badAck

Terminal == {"ack", "conflict", "refused", "unknownReview", "taken"}
\* Every intent eventually settles into something the user can see and act on.
EventuallySettles == <>[](cst \in Terminal)
=============================================================================
