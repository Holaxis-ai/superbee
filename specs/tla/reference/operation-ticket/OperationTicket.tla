---------------------------- MODULE OperationTicket ----------------------------
(***************************************************************************)
(* One identified, guarded whole-document write ("intent") delivered to a   *)
(* shared authority that records outcomes by request identity, in a world   *)
(* with lost messages, deadlines, orphaned requests, outcome-store expiry,  *)
(* store restart, and a third-party writer that can restore earlier bytes   *)
(* (versions are content hashes: packages/core/src/versioning.ts:46-53, so  *)
(* a version IS its bytes and ABA is visible to CAS).                       *)
(*                                                                          *)
(* Code modelled (superbee @ 236be16):                                      *)
(*  client primitive  packages/core/src/uncertain-write.ts:198-293          *)
(*  client journal    packages/browser-local/src/local-bundle.ts            *)
(*                    push 1541-1600, settleIntent 1399-1452,              *)
(*                    resume 1843-1856, resolveConflict/inspect 1040-1130   *)
(*  reference wire    packages/core/src/remote-backend.ts:494-506 (404=null)*)
(*  reference server  packages/server/src/router.ts:868-910 applyIdentified,*)
(*                    935-941 lookup; operation-outcomes.ts:105-184 store   *)
(*  hosted transport  packages/core/src/hosted-transport/                  *)
(*                    whole-document-transport.ts:287-331 lookupIntent      *)
(*                                                                          *)
(* Mode selects the client's rule for "the authority holds nothing under   *)
(* this key":                                                              *)
(*   "ref"    absence => null => resubmit            (uncertain-write:288-291,*)
(*            remote-backend.ts:498)                                        *)
(*   "hosted" absence within (retention - skew) of Anchor => null, else     *)
(*            UNKNOWN (whole-document-transport.ts:306-311; Anchor=created  *)
(*            is today's code, Date.parse(intent.createdAt))                *)
(*   "fixed"  PROPOSED: absence is evidence only if the store's horizon     *)
(*            (restart time) <= Anchor and now - Anchor < retention - skew;  *)
(*            otherwise read the head back: head = local => committed,      *)
(*            else a user-resolvable "unknownReview".                       *)
(*                                                                          *)
(* ABSTRACTIONS (deliberate):                                              *)
(*  - One document; contents {V1, Mine, Theirs}; the client's local bytes   *)
(*    are always Mine; the initial head is V1.                              *)
(*  - The server's claim/apply/record is one atomic step. Faithful for the  *)
(*    single-process memory store (claim is atomic, router.ts:880-910), and *)
(*    it hides the in_progress/wait path and the record-throws path         *)
(*    (operation-outcomes.ts:137-147, router.ts:893-896) - not checked here.*)
(*  - maxLookups (default 3) collapsed to one lookup that either answers or *)
(*    is lost; more rounds only add interleavings of the same answers.      *)
(*  - The deadline (uncertain-write.ts:216-224) is a nondeterministic       *)
(*    Timeout while a submission is outstanding; the abandoned request      *)
(*    stays in the network (remote-operations.ts:358 ignores the signal)    *)
(*    and may still be applied later (an orphan).                           *)
(*  - One global clock (no skew between client and store); Skew is the      *)
(*    safety margin constant only. Lazy expiry (operation-outcomes.ts:158)  *)
(*    is modelled as the predicate Live; observably equivalent.             *)
(*  - The fixed-mode read-back is atomic with the lookup answer.            *)
(*  - "Keep local" re-bases on the head the review fetched (inspectConflict *)
(*    reads the shared head fresh, local-bundle.ts:1086) under a fresh rid; *)
(*    chained successors (local-bundle.ts:785-797) are not modelled.        *)
(*  - The hosted AUTH "not sent" refusal is a local refusal after the claim *)
(*    that incremented attempts (local-bundle.ts:1570) and before any send. *)
(*  - Deletes are not modelled (the reference delete wedge D4 is a separate *)
(*    straight-line bug, see repro/).                                       *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS Cas, Mode, Anchor, Guard, TTL, Skew, BoundedDelay, MaxT, MaxLoss, MaxTP, MaxRestart,
          MaxSubs, MaxAuth, MaxKeep, MaxResume,
          TicketChecks  \* {"epoch", "age"}; a mutant drops one of the store's two checks

Content == {"V1", "Mine", "Theirs"}
Local   == "Mine"
Rids    == 1..(MaxKeep + 1)
NoTime  == -1          \* anchor for "never sent"

VARIABLES
  \* --- authority (reference router + memory outcome store / hosted host)
  head,       \* current document bytes = version
  hseq,       \* ghost: count of writes to head (identifies WHICH write a head is)
  ownSeq,     \* ghost: hseq produced by this client's latest landed write (-1: none)
  applied,    \* ghost: applied[r] = number of times request r mutated the head
  rec,        \* rec[r] = [k |-> "none"|"committed"|"conflict", v, at]
  horizon,    \* time since which the store has seen every record (last restart)
  \* --- network
  reqs,       \* set of requests in flight
  resps,      \* set of responses in flight (only to the live request)
  \* --- client (journal row + performUncertainWrite program counter)
  cst,        \* "pending","sub","look","ack","conflict","refused","unknownReview","taken"
  rid,        \* current intent's requestId
  base, bseq, \* the intent's base bytes, and (ghost) which write the client saw
  claimed,    \* attempts > 0 (the journal claim records it before a send)
  subs,       \* submissions in this performUncertainWrite call
  createdAt, firstSend, lastSend, lastClaim,
  \* --- ghosts and budgets
  lostUpdate, misleading, badAck, clock, losses, tps, restarts, auths, keeps, resumes

vars == <<head, hseq, ownSeq, applied, rec, horizon, reqs, resps, cst, rid, base, bseq,
          claimed, subs, createdAt, firstSend, lastSend, lastClaim,
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
  /\ createdAt = 0 /\ firstSend = NoTime /\ lastSend = NoTime /\ lastClaim = NoTime
  /\ lostUpdate = FALSE /\ misleading = FALSE /\ badAck = FALSE
  /\ clock = 0 /\ losses = 0 /\ tps = 0 /\ restarts = 0 /\ auths = 0
  /\ keeps = 0 /\ resumes = 0

(* operation-outcomes.ts:158-170: a record is answerable while now - recordedAt < retention *)
Live(r) == rec[r].k # "none" /\ clock - rec[r].at < TTL

-----------------------------------------------------------------------------
(* Client: absence rule, the heart of the model *)
AnchorTime == CASE Anchor = "created"   -> createdAt
                [] Anchor = "claim"     -> lastClaim
                [] Anchor = "lastSend"  -> lastSend
                [] Anchor = "firstSend" -> firstSend

\* hosted today: now - Date.parse(createdAt) <= retention - skew  (whole-document-transport.ts:309)
HostedTrusts == AnchorTime = NoTime \/ clock - AnchorTime <= TTL - Skew
\* proposed: the store must have been up since the anchor, and the anchor inside the window
\* The horizon comparison is STRICT (with the skew margin): a restart in the same instant as the
\* send may have come after it. (A first draft used horizon <= anchor; TLC refuted it.)
FixedCovered == AnchorTime = NoTime \/ (horizon + Skew < AnchorTime /\ clock - AnchorTime < TTL - Skew)

\* Guard = "ticket": the identity is bound at its first send to a server-issued ticket (store
\* epoch + store time) the client obtained at or before that send; a ticket may be up to one
\* tick stale. Modelled as a first-send stamp that may be EARLIER than the real send.
TicketChoices == IF Guard = "ticket" THEN {x \in (clock - 1)..clock : x >= 0} ELSE {clock}

SendSubmit ==   \* uncertain-write.ts:269-275 (subs < maxSubmissions checked by caller)
  \E tk \in TicketChoices :
  /\ reqs' = reqs \cup {[t |-> "sub", rid |-> rid, base |-> base, bseq |-> bseq, live |-> TRUE,
                         first |-> IF firstSend = NoTime THEN tk ELSE firstSend]}
  /\ subs' = subs + 1
  /\ claimed' = TRUE
  /\ firstSend' = IF firstSend = NoTime THEN tk ELSE firstSend
  /\ lastSend' = clock
  /\ cst' = "sub"

SendLookup ==
  /\ reqs' = reqs \cup {[t |-> "look", rid |-> rid, base |-> base, bseq |-> bseq, live |-> TRUE, first |-> NoTime]}
  /\ cst' = "look"

(* local-bundle.ts:1541-1580 push: claim pending -> in_flight with attempts+1, then
   performUncertainWrite starts with a submit iff attempts was 0 (uncertain-write.ts:267) *)
Push ==
  /\ cst = "pending"
  /\ lastClaim' = clock
  /\ \/ /\ ~claimed
        /\ SendSubmit
        /\ UNCHANGED <<auths, resps>>
     \/ /\ ~claimed                 \* hosted: refused AUTH_REQUIRED, "not sent"; the claim
        /\ auths < MaxAuth          \* already recorded attempts = 1 (local-bundle.ts:1570)
        /\ auths' = auths + 1
        /\ claimed' = TRUE
        /\ cst' = "refused"
        /\ UNCHANGED <<reqs, resps, subs, firstSend, lastSend>>
     \/ /\ claimed
        /\ subs' = 0
        /\ SendLookup
        /\ UNCHANGED <<claimed, firstSend, lastSend, auths, resps>>
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, rid, base, bseq, createdAt,
                 lostUpdate, misleading, badAck, clock, losses, tps, restarts, keeps, resumes>>

(* uncertain-write.ts:216-224: deadline -> abort -> UNKNOWN -> lookup. The request itself
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
                 createdAt, firstSend, lastSend, lastClaim, lostUpdate, misleading, badAck,
                 clock, tps, restarts, auths, keeps, resumes>>

(* uncertain-write.ts:283-289: a lookup that fails (its request or answer was lost) ends the
   call with UNKNOWN; settleIntent's unknown branch returns the intent to pending with attempts
   kept (local-bundle.ts:1450-1451). Only enabled when the lookup really was lost. *)
LookupLost ==
  /\ cst = "look"
  /\ ~\E m \in reqs : m.live
  /\ resps = {}
  /\ cst' = "pending"
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, reqs, resps, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lastSend, lastClaim, lostUpdate, misleading, badAck,
                 clock, losses, tps, restarts, auths, keeps, resumes>>

(* Settlement of a recorded answer: settleAgainstIntent (uncertain-write.ts:198-203) applied
   again unconditionally by settleIntent (local-bundle.ts:1413), then stateForOutcome. *)
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
       /\ CASE a.t = "rec" ->                               \* committed/conflict answer
                 /\ ClientDone(SettleState(a.o), a.o.v)  \* the head when the outcome was RECORDED
                 /\ UNCHANGED <<reqs, subs, claimed, firstSend, lastSend>>
            [] a.t = "stale" ->                             \* fixed+server guard: the store
                 /\ ClientDone(IF a.head = Local THEN "ack" ELSE "unknownReview", a.head)
                 /\ UNCHANGED <<reqs, subs, claimed, firstSend, lastSend>>  \* refused a key it cannot vouch for
            [] a.t = "absent" /\ cst = "look" /\ Mode = "fixed" /\ Guard = "quiesce"
                              /\ FixedCovered /\ a.at <= lastSend ->
                 \* covered, but an earlier copy of this request may still be in flight:
                 \* not yet evidence; end the call UNKNOWN and look again later
                 /\ ClientDone("pending", a.head)
                 /\ UNCHANGED <<reqs, subs, claimed, firstSend, lastSend>>
            [] a.t = "absent" /\ cst = "look" ->            \* 404 / hosted "absent"
                 LET null == CASE Mode = "ref"    -> TRUE
                               [] Mode = "hosted" -> HostedTrusts
                               [] Mode = "fixed"  -> FixedCovered
                 IN IF null
                    THEN IF subs < MaxSubs                  \* uncertain-write.ts:290-291,269-270
                         THEN /\ SendSubmit /\ misleading' = misleading /\ badAck' = badAck
                         ELSE /\ ClientDone("pending", a.head)      \* finish(UNKNOWN) -> pending
                              /\ UNCHANGED <<reqs, subs, claimed, firstSend, lastSend>>
                    ELSE IF Mode = "hosted"
                         THEN /\ ClientDone("pending", a.head)      \* UNKNOWN (whole-document-transport.ts:310)
                              /\ UNCHANGED <<reqs, subs, claimed, firstSend, lastSend>>
                         ELSE \* fixed: read the head back; never resubmit on the old base
                              /\ ClientDone(IF a.head = Local THEN "ack" ELSE "unknownReview", a.head)
                              /\ UNCHANGED <<reqs, subs, claimed, firstSend, lastSend>>
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, rid, base, bseq, createdAt, lastClaim,
                 lostUpdate, clock, losses, tps, restarts, auths, keeps, resumes>>

(* resolveConflict keep-local (local-bundle.ts:1118ff): a fresh edit under a fresh requestId,
   based on the shared head the review fetched. *)
Keep ==
  /\ cst \in {"conflict", "unknownReview"}
  /\ keeps < MaxKeep
  \* quiesce variant: resolution is offered only once no copy of the old request can still be
  \* in flight (a fresh rid does not dedupe against an orphan of the old one; TLC found this)
  /\ (Mode = "fixed" /\ Guard = "quiesce") => clock > lastSend
  /\ keeps' = keeps + 1
  /\ rid' = rid + 1
  /\ base' = head /\ bseq' = hseq
  /\ claimed' = FALSE /\ subs' = 0
  /\ createdAt' = clock /\ firstSend' = NoTime /\ lastSend' = NoTime /\ lastClaim' = NoTime
  /\ cst' = "pending"
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, reqs, resps, lostUpdate, misleading, badAck,
                 clock, losses, tps, restarts, auths, resumes>>

Take ==
  /\ cst \in {"conflict", "unknownReview"}
  /\ cst' = "taken"
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, reqs, resps, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lastSend, lastClaim, lostUpdate, misleading, badAck,
                 clock, losses, tps, restarts, auths, keeps, resumes>>

(* resume (local-bundle.ts:1843-1856): refused-by-authorization -> pending, attempts kept *)
Resume ==
  /\ cst = "refused" /\ resumes < MaxResume
  /\ resumes' = resumes + 1
  /\ cst' = "pending"
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, reqs, resps, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lastSend, lastClaim, lostUpdate, misleading, badAck,
                 clock, losses, tps, restarts, auths, keeps>>

-----------------------------------------------------------------------------
(* Authority *)
\* the store cannot vouch for a key first sent before its horizon or outside its window
StaleIdentity(first) == ("epoch" \in TicketChecks /\ first <= horizon + Skew)
                     \/ ("age" \in TicketChecks /\ clock - first >= TTL - Skew)

\* Cas = "content": today's premise, the version IS the bytes (versioning.ts:45-52).
\* Cas = "revision": the premise names WHICH write produced the head (a non-repeating token).
CasMatches(m) == IF Cas = "revision" THEN hseq = m.bseq ELSE head = m.base

Reply(m, a) == resps' = IF m.live THEN resps \cup {a} ELSE resps

(* router.ts:880-910 applyIdentified: claim; recorded -> replay; else apply the guarded write
   (CAS on content version), typed 412 is recorded like a response, then record. *)
DeliverSub(m) ==
  /\ m.t = "sub"
  /\ reqs' = reqs \ {m}
  /\ IF Live(m.rid)
     THEN /\ Reply(m, [t |-> "rec", o |-> rec[m.rid], head |-> head])
          /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, lostUpdate>>
     ELSE IF ((Mode = "fixed" /\ Guard = "server") \/ Guard = "ticket") /\ StaleIdentity(m.first)
     THEN \* PROPOSED server guard: the request says when its identity was first sent; the
          \* store refuses (records nothing) a key it may have forgotten (restart or expiry)
          /\ Reply(m, [t |-> "stale", o |-> NoRec, head |-> head])
          /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, lostUpdate>>
     ELSE IF CasMatches(m)
          THEN /\ head' = Local /\ hseq' = hseq + 1
               /\ applied' = [applied EXCEPT ![m.rid] = @ + 1]
               /\ rec' = [rec EXCEPT ![m.rid] = [k |-> "committed", v |-> Local, at |-> clock]]
               \* ghost: the CAS matched bytes, but this client already landed a write AFTER
               \* the base this submission carries: a stale resubmission re-applied over a
               \* head someone produced on top of our own landed write (the ABA double apply).
               \* (An ABA before the client's first landing is ordinary content-addressed CAS.)
               /\ lostUpdate' = (lostUpdate \/ ownSeq > m.bseq)
               /\ ownSeq' = hseq + 1
               /\ Reply(m, [t |-> "rec", o |-> [k |-> "committed", v |-> Local, at |-> clock], head |-> Local])
          ELSE /\ rec' = [rec EXCEPT ![m.rid] = [k |-> "conflict", v |-> head, at |-> clock]]
               /\ Reply(m, [t |-> "rec", o |-> [k |-> "conflict", v |-> head, at |-> clock], head |-> head])
               /\ UNCHANGED <<head, hseq, ownSeq, applied, lostUpdate>>
  /\ UNCHANGED <<horizon, cst, rid, base, bseq, claimed, subs, createdAt, firstSend, lastSend,
                 lastClaim, misleading, badAck, clock, losses, tps, restarts, auths, keeps, resumes>>

(* router.ts:935-941: recorded outcome or 404 (absent). The absent answer carries the head
   only for the fixed variant's read-back. *)
DeliverLook(m) ==
  /\ m.t = "look"
  /\ reqs' = reqs \ {m}
  /\ Reply(m, IF Live(m.rid) THEN [t |-> "rec", o |-> rec[m.rid], head |-> head]
                             ELSE [t |-> "absent", o |-> NoRec, head |-> head, at |-> clock])
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, cst, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lastSend, lastClaim, lostUpdate, misleading, badAck,
                 clock, losses, tps, restarts, auths, keeps, resumes>>

(* Default MemoryOperationOutcomeStore (legacy-router.ts:62, serve.ts:149): a restart forgets
   every record. *)
Restart ==
  /\ restarts < MaxRestart
  /\ restarts' = restarts + 1
  /\ rec' = [r \in Rids |-> NoRec]
  /\ horizon' = clock
  /\ UNCHANGED <<head, hseq, ownSeq, applied, reqs, resps, cst, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lastSend, lastClaim, lostUpdate, misleading, badAck,
                 clock, losses, tps, auths, keeps, resumes>>

(* Another writer, CAS against the head it read; it may restore earlier bytes (ABA). *)
ThirdParty(c) ==
  /\ tps < MaxTP /\ c # head
  /\ tps' = tps + 1
  /\ head' = c /\ hseq' = hseq + 1
  /\ UNCHANGED <<ownSeq, applied, rec, horizon, reqs, resps, cst, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lastSend, lastClaim, lostUpdate, misleading, badAck,
                 clock, losses, restarts, auths, keeps, resumes>>

LoseReq(m) ==
  /\ losses < MaxLoss /\ losses' = losses + 1
  /\ reqs' = reqs \ {m}
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, resps, cst, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lastSend, lastClaim, lostUpdate, misleading, badAck,
                 clock, tps, restarts, auths, keeps, resumes>>

LoseResp(a) ==
  /\ losses < MaxLoss /\ losses' = losses + 1
  /\ resps' = resps \ {a}
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, reqs, cst, rid, base, bseq, claimed, subs,
                 createdAt, firstSend, lastSend, lastClaim, lostUpdate, misleading, badAck,
                 clock, tps, restarts, auths, keeps, resumes>>

(* One tick is a coarse unit (the store's retention is a few ticks). With BoundedDelay, no
   request or answer outlives a tick: a tick is longer than any HTTP request's life, including
   RemoteBackend's own transport retries (remote-backend.ts:301-323). Without it, a request may
   sit in the network for the whole retention window. *)
Tick ==
  /\ clock < MaxT /\ clock' = clock + 1
  /\ reqs' = IF BoundedDelay THEN {} ELSE reqs
  /\ resps' = IF BoundedDelay THEN {} ELSE resps
  /\ UNCHANGED <<head, hseq, ownSeq, applied, rec, horizon, cst, rid, base, bseq, claimed,
                 subs, createdAt, firstSend, lastSend, lastClaim, lostUpdate, misleading, badAck,
                 losses, tps, restarts, auths, keeps, resumes>>

Client == Push \/ Timeout \/ LookupLost \/ Recv
Deliver == \E m \in reqs : DeliverSub(m) \/ DeliverLook(m)
User == Keep \/ Take \/ Resume
Env == Restart \/ (\E c \in Content : ThirdParty(c)) \/ (\E m \in reqs : LoseReq(m))
       \/ (\E a \in resps : LoseResp(a)) \/ Tick

Next == Client \/ Deliver \/ User \/ Env

\* Client steps and message delivery are fair; the user, loss, time, restarts and third
\* parties are not (they may stop at any point, and are bounded).
\* Delivery fairness is split by message type so an orphaned submission cannot starve behind
\* an endless stream of lookups (each type has at most a couple of distinct in-flight values).
Spec == Init /\ [][Next]_vars /\ WF_vars(Client)
        /\ WF_vars(\E m \in reqs : DeliverSub(m)) /\ WF_vars(\E m \in reqs : DeliverLook(m))
        /\ WF_vars(Tick)   \* time passes (bounded by MaxT)

-----------------------------------------------------------------------------
TypeOK ==
  /\ head \in Content /\ cst \in {"pending","sub","look","ack","conflict","refused","unknownReview","taken"}
  /\ rid \in Rids

\* A1: each requestId mutates the document at most once
AtMostOnce == \A r \in Rids : applied[r] <= 1
\* A3a: no submission lands on a base older than a write this client already landed
\*      (a third-party write made on top of our landed write is never silently overwritten)
NoLostUpdate == ~lostUpdate
\* A3b: a conflict review is never shown for a request that already landed (its "base" would
\*      omit the client's own write and keep-local would overwrite a later third-party edit)
NoMisleadingConflict == ~misleading
\* A2 (honest): acknowledged => this request applied, or the head held exactly local
AckHonest == ~badAck


\* Proposed for the ticket guard. Every copy of one identity carries the ticket bound at its
\* first send (a transport retry or a resubmission never re-stamps it).
TicketBoundOnce == \A m1, m2 \in reqs : (m1.t = "sub" /\ m2.t = "sub" /\ m1.rid = m2.rid) => m1.first = m2.first
\* Action property: the store applies an identity it holds no live record for only while it can
\* vouch for it (the ticket's epoch is current and the ticket is inside retention less skew).
NoApplyUnvouched == [][\A r \in Rids : applied'[r] > applied[r] =>
                         (Guard # "ticket" \/ \E m \in reqs : m.rid = r /\ m.t = "sub" /\ ~StaleIdentity(m.first))]_vars

Terminal == {"ack", "conflict", "refused", "unknownReview", "taken"}
\* L: every intent eventually settles into something the user can see and act on
EventuallySettles == <>[](cst \in Terminal)
=============================================================================
