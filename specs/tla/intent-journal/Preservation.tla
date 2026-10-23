---------------------------- MODULE Preservation ----------------------------
EXTENDS Naturals, FiniteSets

(***************************************************************************)
(* Source-mapped focused model, NOT a proved refinement of IntentLifecycle. *)
(* e names a complete accepted local snapshot; r is its transport identity. *)
(* accepted/superseded/acked/seen are ghost history, NEVER payload copies.   *)
(* view/payload/authority are durable payload stores; resolution is a durable*)
(* reviewed-decision receipt. Worker is volatile; coalescing history is not *)
(* claimed to be a durable audit ledger in the implementation.              *)
(***************************************************************************)
CONSTANTS MaxEdits, MaxRid, MaxCrash, CorrectRetirement
Edits == 1..MaxEdits
Rids == 1..MaxRid
None == 0
Gone == [st |-> "gone", att |-> 0, after |-> None]
VARIABLES J, payload, view, authority, nextEdit, nextRid, worker,
          accepted, superseded, resolution, acked, crashes, seen
vars == <<J,payload,view,authority,nextEdit,nextRid,worker,
          accepted,superseded,resolution,acked,crashes,seen>>
(* Total read accessors: absence sentinel is not a function-domain member.
   They equal original reads on all valid IDs and do not enlarge stored domains. *)
JournalAt(r) == IF r \in Rids THEN J[r] ELSE Gone
PayloadAt(r) == IF r \in Rids THEN payload[r] ELSE None
SuccessorAt(e) == IF e \in Edits THEN superseded[e] ELSE None
Live == {r \in Rids : JournalAt(r).st \in {"pending","in_flight","conflict"}}
Latest == IF Live = {} THEN None ELSE CHOOSE r \in Live : \A q \in Live : q <= r
ChainHead == IF Live = {} THEN None ELSE CHOOSE r \in Live : \A q \in Live : r <= q
New(after) == [st |-> "pending", att |-> 0, after |-> after]
Init ==
 /\ J = [r \in Rids |-> Gone] /\ payload = [r \in Rids |-> None]
 /\ view = None /\ authority = None /\ nextEdit = 1 /\ nextRid = 1
 /\ worker = None /\ accepted = {} /\ superseded = [e \in Edits |-> None]
 /\ resolution = {} /\ acked = {}
 /\ crashes = 0 /\ seen = {}

(* One successful guarded transaction: document plus payload-bearing intent. *)
Accept ==
 /\ nextEdit <= MaxEdits /\ nextRid <= MaxRid
 /\ LET l == Latest
        coalesce == l # None /\ JournalAt(l).st = "pending" /\ JournalAt(l).att = 0
        pred == IF coalesce THEN JournalAt(l).after ELSE l
    IN /\ J' = [r \in Rids |-> IF r = nextRid THEN New(pred)
                               ELSE IF coalesce /\ r = l THEN Gone ELSE JournalAt(r)]
       /\ payload' = [r \in Rids |-> IF r = nextRid THEN nextEdit
                                     ELSE IF coalesce /\ r = l THEN None ELSE PayloadAt(r)]
       /\ superseded' = IF coalesce THEN [superseded EXCEPT ![PayloadAt(l)] = nextEdit] ELSE superseded
       /\ UNCHANGED resolution
       /\ seen' = seen \cup {"accept"} \cup (IF coalesce THEN {"coalesce"} ELSE {})
                       \cup (IF l # None /\ ~coalesce THEN {"chain"} ELSE {})
 /\ view' = nextEdit /\ accepted' = accepted \cup {nextEdit}
 /\ nextEdit' = nextEdit + 1 /\ nextRid' = nextRid + 1
 /\ UNCHANGED <<authority,worker,acked,crashes>>

Claim(r) ==
 /\ worker = None /\ JournalAt(r).st = "pending"
 /\ IF JournalAt(r).after = None THEN TRUE ELSE JournalAt(JournalAt(r).after).st = "acked"
 /\ J' = [J EXCEPT ![r].st = "in_flight", ![r].att = @ + 1]
 /\ worker' = r /\ seen' = seen \cup {"claim"}
 /\ UNCHANGED <<payload,view,authority,nextEdit,nextRid,accepted,superseded,resolution,acked,crashes>>

(* Submit may commit or expose a conflict. Lost answer leaves durable row. *)
Deliver ==
 /\ worker # None /\ JournalAt(worker).st = "in_flight"
 /\ \/ /\ authority' = PayloadAt(worker)
        /\ UNCHANGED J
     \/ /\ J' = [J EXCEPT ![worker].st = "conflict"]
        /\ worker' = None /\ UNCHANGED authority
 /\ seen' = seen \cup {"deliver"}
 /\ UNCHANGED <<payload,view,nextEdit,nextRid,accepted,superseded,resolution,acked,crashes>>
 /\ (J' = J => worker' = worker)

(* A valid acknowledgement is bound to the exact identity's payload. *)
Acknowledge ==
 /\ worker # None /\ JournalAt(worker).st = "in_flight"
 /\ authority = PayloadAt(worker) /\ authority # None
 /\ acked' = acked \cup {PayloadAt(worker)}
 /\ J' = [J EXCEPT ![worker].st = "acked"] /\ worker' = None
 /\ seen' = seen \cup {"ack"}
 /\ UNCHANGED <<payload,view,authority,nextEdit,nextRid,accepted,superseded,resolution,crashes>>

Crash ==
 /\ worker # None /\ crashes < MaxCrash
 /\ worker' = None /\ crashes' = crashes + 1
 /\ seen' = seen \cup {"crash"}
 /\ UNCHANGED <<J,payload,view,authority,nextEdit,nextRid,accepted,superseded,resolution,acked>>

Reclaim(r) ==
 /\ worker = None /\ JournalAt(r).st = "in_flight"
 /\ J' = [J EXCEPT ![r].st = "pending"]
 /\ seen' = seen \cup {"reclaim"}
 /\ UNCHANGED <<payload,view,authority,nextEdit,nextRid,worker,accepted,superseded,resolution,acked,crashes>>

(* Explicit user take-remote after conflict, atomically records a resolution
   event and changes durable view. This is intentional disposition, not loss. *)
Resolve ==
 /\ ChainHead # None /\ JournalAt(ChainHead).st = "conflict"
 /\ worker = None
 /\ \A r \in Live : r = ChainHead \/ (JournalAt(r).st = "pending" /\ JournalAt(r).att = 0)
 /\ resolution' = resolution \cup {[edit |-> PayloadAt(r), decision |-> "take-remote", remote |-> authority] : r \in Live}
 /\ UNCHANGED superseded
 /\ J' = [r \in Rids |-> IF r \in Live THEN Gone ELSE JournalAt(r)]
 /\ payload' = [r \in Rids |-> IF r \in Live THEN None ELSE PayloadAt(r)]
 /\ view' = authority /\ seen' = seen \cup {"resolve"}
 /\ UNCHANGED <<authority,nextEdit,nextRid,worker,accepted,acked,crashes>>

(* The deliberately broken guard can retire an older unacknowledged row
   only after the acceptance/claim/crash/successor witness is real. *)
UnsafeCandidate(r) ==
 /\ JournalAt(r).st = "pending" /\ JournalAt(r).att > 0
 /\ \E s \in Live : s > r /\ JournalAt(s).after = r
 /\ {"accept","claim","crash","reclaim","chain"} \subseteq seen
 /\ PayloadAt(r) # view /\ PayloadAt(r) # authority
 /\ SuccessorAt(PayloadAt(r)) = None /\ PayloadAt(r) \notin acked
 /\ ~\E receipt \in resolution : receipt.edit = PayloadAt(r)
Retire(r) ==
 /\ JournalAt(r).st = "acked" \/ (~CorrectRetirement /\ UnsafeCandidate(r))
 /\ worker # r
 /\ (JournalAt(r).st = "acked" => \E s \in Rids : s > r /\ JournalAt(s).st = "acked")
 /\ (JournalAt(r).st = "acked" => ~\E s \in Rids : JournalAt(s) # Gone /\ JournalAt(s).after = r)
 /\ J' = [J EXCEPT ![r] = Gone] /\ payload' = [payload EXCEPT ![r] = None]
 /\ seen' = seen \cup {"retire"}
 /\ UNCHANGED <<view,authority,nextEdit,nextRid,worker,accepted,superseded,resolution,acked,crashes>>

Next == Accept \/ Deliver \/ Acknowledge \/ Crash \/ Resolve
        \/ (\E r \in Rids : Claim(r) \/ Reclaim(r) \/ Retire(r))
Spec == Init /\ [][Next]_vars

Recoverable(e) == view = e \/ \E r \in Rids : PayloadAt(r) = e /\ JournalAt(r) # Gone
Disposed(e) == SuccessorAt(e) \in accepted \/ \E receipt \in resolution : receipt.edit = e
Preserved == \A e \in accepted : Disposed(e) \/ e \in acked \/ Recoverable(e)
TypeOK ==
 /\ accepted \subseteq Edits /\ acked \subseteq accepted
 /\ \A e \in Edits : SuccessorAt(e) = None \/ (e \in accepted /\ SuccessorAt(e) \in accepted /\ SuccessorAt(e) > e)
 /\ \A receipt \in resolution : receipt.edit \in accepted /\ receipt.decision = "take-remote" /\ receipt.remote \in Edits \cup {None}
 /\ view \in Edits \cup {None} /\ authority \in Edits \cup {None}
 /\ worker \in Rids \cup {None}
NoRecoveryWitness == ~\E r \in Rids : UnsafeCandidate(r)
=============================================================================
