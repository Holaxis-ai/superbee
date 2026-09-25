--------------------------- MODULE IntentLifecycle ---------------------------
(***************************************************************************)
(* Lifecycle of the intents of one document in the browser-local working  *)
(* copy, exact mode: compose (supersede or chain), push (list, predecessor *)
(* check, claim, uncertain delivery, settle), reclaim, resume, resolve,    *)
(* crashes, a lossy carrier, and an at-most-once authority.                *)
(*                                                                         *)
(* Code modeled (packages/browser-local/src/local-bundle.ts unless noted): *)
(*   Commit, RecoveryEdit  commitLocal, composeIntent                      *)
(*   Resume                resume                                          *)
(*   Resolve               resolveConflict through conflictChain           *)
(*   PStart                pushWithRole (push role, optional               *)
(*                         reclaimInFlight), push: pause check and         *)
(*                         listIntents("pending")                          *)
(*   PNext                 push: predecessor check, claim (updateIntent),  *)
(*                         and the fold of a refused chain                 *)
(*                         (foldRefusedChain, supersedingIntent)           *)
(*   PSubmit, PGiveUp,     packages/core/src/uncertain-write.ts            *)
(*   PLookup               performUncertainWrite: submissions and lookups  *)
(*   PSettle               settleIntent                                    *)
(*   Crash                 the page dies at any await of a push            *)
(*                                                                         *)
(* Abstractions:                                                           *)
(*  - Content is abstracted away: the authority's answer to the first      *)
(*    application of a request identity is chosen nondeterministically     *)
(*    (committed always possible; conflict, content refusal and            *)
(*    authorization refusal each within a budget). Later submissions and   *)
(*    lookups of the same identity return the recorded outcome             *)
(*    (at-most-once, as the reference outcome store). Retention expiry is  *)
(*    omitted; see identified-write for it.                                *)
(*  - Refusals have two classes. "content" is every refusal the authority  *)
(*    records as not applied, so the identity can only answer it again:    *)
(*    content codes and the busy codes (BUSY_REFUSAL_CODES). "auth" is     *)
(*    AUTHORIZATION_REFUSAL_CODES (lost permission, spent quota), which    *)
(*    records nothing and pauses the bundle. A busy answer that does not   *)
(*    say the write was not applied is a lost answer here.                 *)
(*  - Request identities are 1..MaxRid minted in order, so identity order  *)
(*    is journal sequence order.                                           *)
(*  - performUncertainWrite's lookup rounds are collapsed to one lookup    *)
(*    that may fail (consuming the loss budget); at most 2 submissions.    *)
(*  - The predecessor read and the claim are one step, and so are the fold *)
(*    guard's journal read and its guarded write. The fold's check that    *)
(*    the working document holds the successor's bytes always passes, as   *)
(*    content is abstracted away.                                          *)
(*  - deleteLocal composes like commitLocal here and is not modeled        *)
(*    separately.                                                          *)
(*  - The push role is a mutex taken for the whole push when               *)
(*    RoleDiscipline holds; a crash releases it (a Web Lock dies with its  *)
(*    page).                                                               *)
(*                                                                         *)
(* Knobs:                                                                  *)
(*   ReclaimBeforePush  every push first returns in_flight intents to      *)
(*                      pending (reclaimInFlight), as the CLI hosted sync  *)
(*                      does; pushWithRole reclaims only in body mode      *)
(*   AdmitRefused       exact-mode resolve admits a content-refused head,  *)
(*                      as body mode does                                  *)
(*   RoleDiscipline     every push runs under the push role                *)
(*   FoldRefusedCodes   the refusal classes whose never-sent chained       *)
(*                      successor push folds into one fresh intent on the  *)
(*                      refused head's premise: {} before the fold,        *)
(*                      {"content"} as the code folds (isContentRefusal)   *)
(*   FoldDropsEdit      mutant: the fold retires the chain and journals    *)
(*                      nothing                                            *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Pushers, MaxRid, MaxCommits, MaxCrash, MaxLoss, MaxConflict, MaxRefuse, MaxAuthRefuse,
          ReclaimBeforePush, AdmitRefused, RoleDiscipline, FoldRefusedCodes, FoldDropsEdit, None

Rids == 1..MaxRid
Gone == [st |-> "gone", att |-> 0, after |-> None, code |-> None]   \* an absent journal row
Outcomes == {"committed", "conflict", "refusedC", "refusedA"}

VARIABLES
  J,          \* journal: rid -> [st, att, after, code] or Gone
  nextRid,
  outcome,    \* authority's recorded outcome per rid (None = never applied)
  submitted,  \* ghost: submissions that reached the authority's handler, per rid
  paused,     \* meta row `sync` pause flag
  role,
  pc, P,      \* per-pusher program counter and locals
  budget,     \* environment budgets
  blindResubmit, retiredApplied, \* ghost flags for action-level safety checks
  badFold,    \* ghost: a fold retired a row the authority did not record as refused, or saw
  discarded   \* ghost: the person's last step was take-remote, which discards their edit

vars == <<J, nextRid, outcome, submitted, paused, role, pc, P, budget, blindResubmit, retiredApplied,
          badFold, discarded>>

Unsettled == {"pending", "in_flight", "conflict", "refused", "unknown"}
Live(r) == J[r] # Gone /\ J[r].st \in Unsettled
LiveRids == {r \in Rids : Live(r)}
Latest == IF LiveRids = {} THEN None ELSE CHOOSE r \in LiveRids : \A s \in LiveRids : s <= r
ChainHead == IF LiveRids = {} THEN None ELSE CHOOSE r \in LiveRids : \A s \in LiveRids : r <= s

BlankP == [list |-> <<>>, lrec |-> [r \in Rids |-> Gone], cur |-> None, catt |-> 0,
           datt |-> 0, subs |-> 0, need |-> FALSE, nullSeen |-> FALSE, out |-> None]

Init ==
  /\ J = [r \in Rids |-> Gone]
  /\ nextRid = 1
  /\ outcome = [r \in Rids |-> None]
  /\ submitted = [r \in Rids |-> 0]
  /\ paused = FALSE
  /\ role = None
  /\ pc = [p \in Pushers |-> "idle"]
  /\ P = [p \in Pushers |-> BlankP]
  /\ budget = [commits |-> MaxCommits, crash |-> MaxCrash, loss |-> MaxLoss,
               conflict |-> MaxConflict, refuse |-> MaxRefuse, authref |-> MaxAuthRefuse]
  /\ blindResubmit = FALSE
  /\ retiredApplied = FALSE
  /\ badFold = FALSE
  /\ discarded = FALSE

NewIntent(after) == [st |-> "pending", att |-> 0, after |-> after, code |-> None]

\* NoRetireOfApplied bookkeeping: no identity the authority has applied (recorded committed)
\* is superseded or resolved away; its successor would carry the retired intent's old base
\* and meet the person's own write as a conflict. An authorization refusal is not recorded,
\* so outcome stays None for it.
NoteRetired(rs) == retiredApplied' = (retiredApplied \/ \E r \in rs : outcome[r] = "committed")

----------------------------------------------------------------------------
(* User *)

\* composeIntent and writeJournaled (a supersede is a CAS on state and attempts). Commit is a
\* budgeted edit; RecoveryEdit is the edit the CLI prescribes for a refused change
\* (packages/cli/src/hosted/sync-rows.ts).
Compose ==
  LET l == Latest IN
  /\ nextRid <= MaxRid
  /\ IF l = None
       THEN /\ J' = [J EXCEPT ![nextRid] = NewIntent(None)]                       \* first intent
            /\ UNCHANGED retiredApplied
       ELSE IF (J[l].st = "pending" /\ J[l].att = 0) \/ J[l].st = "refused"     \* supersede
       THEN /\ J' = [J EXCEPT ![l] = Gone, ![nextRid] = NewIntent(J[l].after)]
            /\ NoteRetired({l})
       ELSE /\ J' = [J EXCEPT ![nextRid] = NewIntent(l)]                          \* chain
            /\ UNCHANGED retiredApplied
  /\ nextRid' = nextRid + 1
  /\ discarded' = FALSE

Commit ==
  /\ budget.commits > 0
  /\ Compose
  /\ budget' = [budget EXCEPT !.commits = @ - 1]
  /\ UNCHANGED <<outcome, submitted, paused, role, pc, P, blindResubmit, badFold>>

HasContentRefusal == \E r \in LiveRids : J[r].st = "refused" /\ J[r].code = "content"

RecoveryEdit ==
  /\ HasContentRefusal
  \* Model bound only: keep one identity spare so MaxRid never starves a fold.
  /\ FoldRefusedCodes # {} => nextRid < MaxRid
  /\ Compose
  /\ UNCHANGED <<outcome, submitted, paused, role, pc, P, budget, blindResubmit, badFold>>

\* resume: lift the pause, requeue authorization refusals only.
Resume ==
  /\ paused \/ \E r \in LiveRids : J[r].st = "refused" /\ J[r].code = "auth"
  /\ paused' = FALSE
  /\ J' = [r \in Rids |-> IF Live(r) /\ J[r].st = "refused" /\ J[r].code = "auth"
                            THEN [J[r] EXCEPT !.st = "pending"] ELSE J[r]]
  /\ UNCHANGED <<nextRid, outcome, submitted, role, pc, P, budget, blindResubmit, retiredApplied,
                 badFold, discarded>>

\* resolveConflict in exact mode, through conflictChain: the head must be a conflict row, or
\* with AdmitRefused a content refusal. The whole unsettled chain is retired in one
\* transaction (resolveIntents); keep-local records a fresh identity with no `after`,
\* take-remote records none.
ResolveEnabled ==
  /\ ChainHead # None
  /\ \/ J[ChainHead].st = "conflict"
     \/ AdmitRefused /\ J[ChainHead].st = "refused" /\ J[ChainHead].code = "content"

Resolve(keep) ==
  /\ ResolveEnabled
  /\ keep => nextRid <= MaxRid
  /\ LET chain == LiveRids IN
     /\ J' = [r \in Rids |-> IF r \in chain THEN Gone
                             ELSE IF keep /\ r = nextRid THEN NewIntent(None) ELSE J[r]]
     /\ NoteRetired(chain)
  /\ nextRid' = IF keep THEN nextRid + 1 ELSE nextRid
  /\ discarded' = ~keep
  /\ UNCHANGED <<outcome, submitted, paused, role, pc, P, budget, blindResubmit, badFold>>

----------------------------------------------------------------------------
(* Push *)

PendingInOrder(j) ==
  LET S == {r \in Rids : j[r] # Gone /\ j[r].st = "pending"}
      F[k \in 0..MaxRid] == IF k = 0 THEN <<>> ELSE IF k \in S THEN Append(F[k-1], k) ELSE F[k-1]
  IN F[MaxRid]

\* reclaimInFlight: in_flight -> pending, attempts max(1, att)
Reclaimed(j) == [r \in Rids |-> IF j[r] # Gone /\ j[r].st = "in_flight"
                                  THEN [j[r] EXCEPT !.st = "pending", !.att = IF @ < 1 THEN 1 ELSE @]
                                  ELSE j[r]]

\* pushWithRole: the role (ifAvailable), optional reclaim; push: the pause check and
\* listIntents("pending").
PStart(p) ==
  /\ pc[p] = "idle"
  /\ ~paused
  /\ RoleDiscipline => role = None
  /\ role' = IF RoleDiscipline THEN p ELSE role
  /\ LET j == IF ReclaimBeforePush THEN Reclaimed(J) ELSE J IN
     /\ J' = j
     /\ P' = [P EXCEPT ![p].list = PendingInOrder(j), ![p].lrec = j]
  /\ pc' = [pc EXCEPT ![p] = "next"]
  /\ UNCHANGED <<nextRid, outcome, submitted, paused, budget, blindResubmit, retiredApplied, badFold,
                 discarded>>

PEnd(p) ==
  /\ pc[p] = "next" /\ P[p].list = <<>>
  /\ pc' = [pc EXCEPT ![p] = "idle"]
  /\ P' = [P EXCEPT ![p] = BlankP]
  /\ role' = IF role = p THEN None ELSE role
  /\ UNCHANGED <<J, nextRid, outcome, submitted, paused, budget, blindResubmit, retiredApplied, badFold,
                 discarded>>

\* push: a missing predecessor counts as clear. The claim is a CAS on state only and
\* writes the listed attempts + 1. A never-sent intent that waits on a refusal in
\* FoldRefusedCodes, when the two are the document's whole unsettled journal, is folded
\* instead: one guarded transaction retires both and journals a fresh intent on the refused
\* head's premise (its `after`), which the same push then delivers. That is the supersede
\* compose applies to a refused latest intent, reached because the edit landed while the
\* head was in flight.
PNext(p) ==
  /\ pc[p] = "next" /\ P[p].list # <<>>
  /\ LET r == Head(P[p].list)
         lr == P[p].lrec[r]
         pred == lr.after
         blocked == pred # None /\ J[pred] # Gone /\ J[pred].st # "acked"
         canClaim == J[r] # Gone /\ J[r].st = "pending"
         fold == /\ blocked /\ canClaim /\ lr.att = 0 /\ J[r].att = 0
                 /\ J[pred].st = "refused" /\ J[pred].code \in FoldRefusedCodes
                 /\ LiveRids = {pred, r} /\ nextRid <= MaxRid
         folded == NewIntent(J[pred].after)
     IN IF fold
          THEN /\ J' = [q \in Rids |-> IF q \in {pred, r} THEN Gone
                                       ELSE IF q = nextRid /\ ~FoldDropsEdit THEN folded ELSE J[q]]
               /\ nextRid' = IF FoldDropsEdit THEN nextRid ELSE nextRid + 1
               /\ NoteRetired({pred, r})
               /\ badFold' = (badFold \/ outcome[pred] # "refusedC" \/ submitted[r] > 0)
               /\ P' = [P EXCEPT ![p].list = IF FoldDropsEdit THEN Tail(@) ELSE Append(Tail(@), nextRid),
                                 ![p].lrec[nextRid] = IF FoldDropsEdit THEN @ ELSE folded]
               /\ UNCHANGED pc
        ELSE IF blocked \/ ~canClaim
          THEN /\ P' = [P EXCEPT ![p].list = Tail(@)]
               /\ UNCHANGED <<J, pc, nextRid, retiredApplied, badFold>>
          ELSE /\ J' = [J EXCEPT ![r].st = "in_flight", ![r].att = lr.att + 1]
               \* performUncertainWrite gets the listed attempts
               /\ P' = [P EXCEPT ![p].list = Tail(@), ![p].cur = r, ![p].catt = lr.att + 1,
                                 ![p].datt = lr.att, ![p].subs = 0, ![p].need = (lr.att = 0),
                                 ![p].nullSeen = FALSE, ![p].out = None]
               /\ pc' = [pc EXCEPT ![p] = "deliver"]
               /\ UNCHANGED <<nextRid, retiredApplied, badFold>>
  /\ UNCHANGED <<outcome, submitted, paused, role, budget, blindResubmit, discarded>>

\* performUncertainWrite: one submission. The request may be lost before the authority
\* applies it, or applied with its answer lost; either yields "unknown" and a lookup.
PSubmit(p) ==
  /\ pc[p] = "deliver" /\ P[p].need /\ P[p].subs < 2
  /\ LET r == P[p].cur IN
     /\ blindResubmit' = (blindResubmit \/ (submitted[r] > 0 /\ ~P[p].nullSeen))
     /\ \/ \* lost before the handler
           /\ budget.loss > 0
           /\ budget' = [budget EXCEPT !.loss = @ - 1]
           /\ P' = [P EXCEPT ![p].subs = @ + 1, ![p].datt = @ + 1, ![p].need = FALSE, ![p].nullSeen = FALSE]
           /\ UNCHANGED <<outcome, submitted>>
        \/ \* reaches the handler: recorded outcome, or a first application
           /\ submitted' = [submitted EXCEPT ![r] = @ + 1]
           /\ \E o \in Outcomes, lost \in BOOLEAN :
                LET rec == IF outcome[r] # None THEN outcome[r] ELSE o IN
                /\ outcome[r] = None \/ o = "committed"   \* o irrelevant when recorded
                \* An authorization refusal happens before the identity is claimed, so
                \* nothing is recorded under it.
                /\ outcome' = [outcome EXCEPT ![r] = IF rec = "refusedA" THEN None ELSE rec]
                /\ outcome[r] = None =>
                     /\ (o = "conflict" => budget.conflict > 0)
                     /\ (o = "refusedC" => budget.refuse > 0)
                     /\ (o = "refusedA" => budget.authref > 0)
                /\ lost => budget.loss > 0
                /\ budget' = [budget EXCEPT
                      !.loss = IF lost THEN @ - 1 ELSE @,
                      !.conflict = IF outcome[r] = None /\ o = "conflict" THEN @ - 1 ELSE @,
                      !.refuse = IF outcome[r] = None /\ o = "refusedC" THEN @ - 1 ELSE @,
                      !.authref = IF outcome[r] = None /\ o = "refusedA" THEN @ - 1 ELSE @]
                /\ P' = [P EXCEPT ![p].subs = @ + 1, ![p].datt = @ + 1, ![p].need = FALSE,
                                  ![p].nullSeen = FALSE,
                                  ![p].out = IF lost THEN None ELSE rec]
  /\ pc' = [pc EXCEPT ![p] = IF P'[p].out # None THEN "settle" ELSE "deliver"]
  /\ UNCHANGED <<J, nextRid, paused, role, retiredApplied, badFold, discarded>>

\* performUncertainWrite: submissions exhausted -> UNKNOWN
PGiveUp(p) ==
  /\ pc[p] = "deliver" /\ P[p].need /\ P[p].subs >= 2
  /\ P' = [P EXCEPT ![p].out = "unknown"]
  /\ pc' = [pc EXCEPT ![p] = "settle"]
  /\ UNCHANGED <<J, nextRid, outcome, submitted, paused, role, budget, blindResubmit, retiredApplied,
                 badFold, discarded>>

\* performUncertainWrite: lookup; failure -> UNKNOWN; recorded -> it; null -> resubmit
PLookup(p) ==
  /\ pc[p] = "deliver" /\ ~P[p].need /\ P[p].out = None
  /\ LET r == P[p].cur IN
     \/ /\ budget.loss > 0
        /\ budget' = [budget EXCEPT !.loss = @ - 1]
        /\ P' = [P EXCEPT ![p].out = "unknown"]
        /\ pc' = [pc EXCEPT ![p] = "settle"]
     \/ /\ outcome[r] # None
        /\ P' = [P EXCEPT ![p].out = outcome[r]]
        /\ pc' = [pc EXCEPT ![p] = "settle"]
        /\ UNCHANGED budget
     \/ /\ outcome[r] = None
        /\ P' = [P EXCEPT ![p].need = TRUE, ![p].nullSeen = TRUE]
        /\ UNCHANGED <<budget, pc>>
  /\ UNCHANGED <<J, nextRid, outcome, submitted, paused, role, blindResubmit, retiredApplied, badFold,
                 discarded>>

\* settleIntent: a CAS on in_flight; attempts = max(advanced, claimed)
PSettle(p) ==
  /\ pc[p] = "settle"
  /\ LET r == P[p].cur
         a == IF P[p].datt > P[p].catt THEN P[p].datt ELSE P[p].catt
         o == P[p].out
     IN IF J[r] = Gone \/ J[r].st # "in_flight"
          THEN /\ UNCHANGED <<J, paused>>                                     \* settled-elsewhere
               /\ P' = [P EXCEPT ![p].cur = None]
          ELSE /\ J' = [J EXCEPT ![r] =
                   CASE o = "committed" -> [@ EXCEPT !.st = "acked", !.att = a]
                     [] o = "conflict"  -> [@ EXCEPT !.st = "conflict", !.att = a]
                     [] o = "refusedC"  -> [@ EXCEPT !.st = "refused", !.att = a, !.code = "content"]
                     [] o = "refusedA"  -> [@ EXCEPT !.st = "refused", !.att = a, !.code = "auth"]
                     [] OTHER           -> [@ EXCEPT !.st = "pending", !.att = a]]   \* unknown -> pending
               /\ paused' = (paused \/ o = "refusedA")
               \* an authorization refusal ends the push
               /\ P' = [P EXCEPT ![p].cur = None, ![p].list = IF o = "refusedA" THEN <<>> ELSE @]
  /\ pc' = [pc EXCEPT ![p] = "next"]
  /\ UNCHANGED <<nextRid, outcome, submitted, role, budget, blindResubmit, retiredApplied, badFold,
                 discarded>>

\* The page dies at any await of a push.
Crash(p) ==
  /\ pc[p] # "idle" /\ budget.crash > 0
  /\ budget' = [budget EXCEPT !.crash = @ - 1]
  /\ pc' = [pc EXCEPT ![p] = "idle"]
  /\ P' = [P EXCEPT ![p] = BlankP]
  /\ role' = IF role = p THEN None ELSE role
  /\ UNCHANGED <<J, nextRid, outcome, submitted, paused, blindResubmit, retiredApplied, badFold,
                 discarded>>

----------------------------------------------------------------------------
PushStep(p) == PStart(p) \/ PEnd(p) \/ PNext(p) \/ PSubmit(p) \/ PGiveUp(p) \/ PLookup(p) \/ PSettle(p)
UserExit == RecoveryEdit \/ Resume \/ Resolve(TRUE) \/ Resolve(FALSE)

Next ==
  \/ Commit
  \/ UserExit
  \/ \E p \in Pushers : PushStep(p) \/ Crash(p)

\* The host keeps syncing; the person acts on what the product tells them
\* (resolve a conflict, resume after permission returns, edit a refused file).
\* Environment faults (crash, loss, authority's choice) get no fairness and are budgeted.
Fairness ==
  /\ \A p \in Pushers : WF_vars(PStart(p) \/ PEnd(p) \/ PNext(p) \/ PSubmit(p) \/ PGiveUp(p) \/ PLookup(p) \/ PSettle(p))
  /\ WF_vars(Resume)
  /\ WF_vars(Resolve(TRUE) \/ Resolve(FALSE))
  /\ WF_vars(RecoveryEdit)

Spec == Init /\ [][Next]_vars /\ Fairness

\* The same without fairness on RecoveryEdit: the person never edits a refused change again.
FairnessNoEdit ==
  /\ \A p \in Pushers : WF_vars(PStart(p) \/ PEnd(p) \/ PNext(p) \/ PSubmit(p) \/ PGiveUp(p) \/ PLookup(p) \/ PSettle(p))
  /\ WF_vars(Resume)
  /\ WF_vars(Resolve(TRUE) \/ Resolve(FALSE))

SpecNoEdit == Init /\ [][Next]_vars /\ FairnessNoEdit

----------------------------------------------------------------------------
(* Properties *)

\* A second submission of one identity only after a null lookup in the same delivery.
NoBlindResubmit == ~blindResubmit
\* A possibly-delivered identity is durably recorded as such.
DurablyPossiblyDelivered == \A r \in Rids : (J[r] # Gone /\ submitted[r] > 0) => J[r].att >= 1
\* No identity that may have been applied is superseded or resolved away.
NoRetireOfApplied == ~retiredApplied
\* A chained intent is only ever submitted after its predecessor is acknowledged
\* (as an invariant: an in-flight chained intent's predecessor is acknowledged or gone).
ChainOrder == \A r \in Rids : (J[r] # Gone /\ J[r].st = "in_flight" /\ J[r].after # None)
                 => (J[J[r].after] = Gone \/ J[J[r].after].st = "acked")

\* Every change eventually settles as acknowledged or is resolved away.
EventuallyAllSettled == <>[](LiveRids = {})

\* A fold retires only a refusal the authority recorded as not applied, and a successor it
\* never received.
FoldRetiresOnlyUnapplied == ~badFold
\* Every live intent's predecessor is live or acknowledged: no intent waits on, or is premised
\* on, a retired row.
NoDanglingAfter == \A r \in LiveRids :
  J[r].after = None \/ (J[J[r].after] # Gone /\ (Live(J[r].after) \/ J[J[r].after].st = "acked"))
\* A content-refused identity is never submitted again (an action property).
NoResendOfContentRefusal ==
  [][\A r \in Rids : outcome[r] = "refusedC" => submitted'[r] = submitted[r]]_vars
\* At most one never-sent intent per document, and it is the latest.
OneUnsentIntent == \A r, s \in LiveRids : s > r => ~(J[r].st = "pending" /\ J[r].att = 0)
\* The person's latest edit is carried by a journal row unless they took the remote side.
EditKept == (nextRid > 1 /\ ~discarded) => J[nextRid - 1] # Gone
\* A pending change is eventually claimed or retired. Checked under SpecNoEdit, so it needs no
\* further edit by the person.
PendingProgress == \A r \in Rids : (Live(r) /\ J[r].st = "pending") ~> (~Live(r) \/ J[r].st # "pending")
=============================================================================
