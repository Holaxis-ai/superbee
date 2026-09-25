------------------------------- MODULE FsLock -------------------------------
(***************************************************************************)
(* Cross-process filesystem mutation lock and the filesystem push role.    *)
(*                                                                         *)
(* Code modeled:                                                           *)
(*   packages/core/src/filesystem-lock.ts       claimLockPath and helpers  *)
(*   packages/core/src/filesystem-push-role.ts  acquireSettled, request    *)
(*   packages/core/src/filesystem-host.ts       default POSIX host policy  *)
(*                                                                         *)
(* Actions and the code they model (filesystem-lock.ts unless noted):      *)
(*   StartRun        newOwner: a new process with a fresh token            *)
(*   Mkdir           claimLockPath: mkdir(<key>.lock)                      *)
(*   Read1, Read2    claimLockPath: readOwner before and after quarantine  *)
(*   Probe           quarantineStaleLock: hostname and processExists       *)
(*   RecheckOwner    quarantineStaleLock: re-read the owner token          *)
(*   Quar            quarantineStaleLock: rename to <key>.lock.stale-<h>   *)
(*   TCheck          claimLockPath: wait budget check, delay, retry        *)
(*   Timeout         timeoutError, then the caller's handling              *)
(*   RecheckDiag     timeoutError: re-read the owner before "stale"        *)
(*   Settle          filesystem-push-role.ts acquireSettled (lock age)     *)
(*   Ps              filesystem-push-role.ts request: start-time check     *)
(*   Lstat .. Write  claimLockPath: lstat, then writeFile(owner.json, wx)  *)
(*   CS              the caller's mutation while the lock is held          *)
(*   RelVerify       release: resolveOwnerRecord, changedOwnerRefusal      *)
(*   RelRename/RelRm removeReleasedLock: rename to .released-<h>, rm       *)
(*   RbRead .. RbRm  rollBackOwnClaim and isClaimedDirectory               *)
(*                                                                         *)
(* One lock path L plus the token-derived siblings L.stale-<h(t)>          *)
(* (staleLockQuarantinePath) and L.released-<h(t)>                         *)
(* (releasedLockRemnantPath). Every syscall or await that can interleave   *)
(* with other processes is one atomic step.                                *)
(*                                                                         *)
(* Abstractions:                                                           *)
(*  A1 Default host policy only: isDirectoryContentionError is always      *)
(*     false, so the unwitnessed-contention retry in claimLockPath and the *)
(*     retry loops in removeReleasedLock are not modeled. Every rename or  *)
(*     rm failure is single-shot.                                          *)
(*  A2 Owner-record reads are definitive. The code polls transient read    *)
(*     failures out (resolveOwnerRecord) and fails closed, so leaving them *)
(*     out only removes behaviors.                                         *)
(*  A3 One token per claim, and each run is its own OS process with its    *)
(*     own pid. pid(t) is live while t runs. PID reuse is the environment  *)
(*     action Reuse(t): another process, of any user, takes the pid        *)
(*     (processExists counts EPERM as alive).                              *)
(*  A4 Directory identity (dev, ino, birth time; isClaimedDirectory) is a  *)
(*     fresh id per mkdir. Birth time is assumed to be reported.           *)
(*  A5 POSIX rename(dir, dst): dst absent -> ok; dst an empty dir -> ok    *)
(*     and replaces it; dst non-empty -> ENOTEMPTY; src absent -> ENOENT.  *)
(*     A directory holding an opened-but-unwritten owner.json is non-empty.*)
(*  A6 writeFile(wx) is open(O_CREAT|O_EXCL) followed by a write through   *)
(*     the fd. The write lands in the directory the file was created in,   *)
(*     wherever that directory has since been renamed.                     *)
(*  A7 Time: the waitMs budget is a nondeterministic timeout bounded by    *)
(*     MaxRetries polls. The claim-grace age check in acquireSettled is    *)
(*     "young iff the directory's creator is still alive". The ps start    *)
(*     time is exact: "started after the claim" iff the pid now belongs to *)
(*     a later process.                                                    *)
(*  A8 The acquireSettled retry re-uses the same token. Sound: a claim     *)
(*     that timed out never wrote a record.                                *)
(*  A9 Assumed, not modeled: nothing external deletes a held <key>.lock    *)
(*     (for example a tmp cleaner).                                        *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  NWorkers,          \* concurrent command slots (processes contending for one key)
  MaxRuns,           \* sequential commands per slot; each is a new process and token
  MaxRetries,        \* waitMs budget, in polls
  Modes,             \* caller kinds: "plain" (store, CAS and user-state locks),
                     \*   "wait" (push role request {}), "ifAvail" (push role ifAvailable)
  OwnerRecheck,      \* quarantineStaleLock re-reads the owner token after the death probe
  DiagnosisRecheck,  \* timeoutError re-reads the owner before reporting "stale"
  NsFault,           \* the death probe may answer "dead" for a live owner (PID namespaces)
  PidReuse,          \* a dead owner's pid may be taken by an unrelated process
  HostChange,        \* the hostname may change once (for example a macOS network change)
  AllowCrash         \* processes may crash at any step

NONE  == 0      \* no owner.json in the directory
EMPTY == 99     \* owner.json opened with wx but not written yet (JSON parse fails)

Tokens == 1..(NWorkers * MaxRuns)
RunOf(t) == ((t - 1) % MaxRuns) + 1

VARIABLES
  lock,       \* the directory at L, or NoDir
  stale,      \* [Tokens -> dir] at L.stale-<h(t)>
  rel,        \* [Tokens -> dir] at L.released-<h(t)>
  nextId,     \* fresh directory identity
  pc, snap, claimed, wdir, mode, retries, settled,
  alive,      \* the claim's own process is running
  pidLive,    \* kill(pid(t), 0) succeeds (own process, or a reuser of the pid)
  ownerHost, host, hostChanged,
  diag, diagOk, relErr,
  reused      \* the pid of t was taken by a (single) foreign process

vars == <<lock, stale, rel, nextId, pc, snap, claimed, wdir, mode, retries, settled,
          alive, pidLive, ownerHost, host, hostChanged, diag, diagOk, relErr, reused>>

Dir(i, b, r) == [ex |-> TRUE, id |-> i, by |-> b, rec |-> r]
NoDir == [ex |-> FALSE, id |-> 0, by |-> 0, rec |-> NONE]

\* readOwner: only a parsed record counts.
ReadRec(d) == IF d.ex /\ d.rec \in Tokens THEN d.rec ELSE NONE

\* A5: the outcome of rename(src, dst).
RenameRes(src, dst) ==
  IF ~src.ex THEN "ENOENT"
  ELSE IF dst.ex /\ dst.rec # NONE THEN "ENOTEMPTY"
  ELSE "OK"

SameHost(o) == ownerHost[o] = host

\* processExists returns FALSE ("dead") iff ESRCH. Under NsFault the owner may be in
\* another PID namespace, so the probe can say dead while it is alive.
DeadAnswers(o) == {~pidLive[o]} \cup (IF NsFault /\ alive[o] THEN {TRUE} ELSE {})

\* A dead owner's record stays at L in a way that retrying can never clear.
Wedged(o) == lock.ex /\ lock.rec = o /\ ~alive[o] /\ (pidLive[o] \/ ownerHost[o] # host)

NeedsHuman == {"stale", "malformed", "staleOwner"}
RetryKinds == {"held", "busy", "busyClaiming"}

\* Is the diagnosis true in the state where it is issued?
Accurate(d, o) ==
  CASE d \in {"held", "busy"} -> (o = NONE \/ ~Wedged(o))       \* "retry" is honest
    [] d = "busyClaiming"     -> TRUE
    [] d = "stale"            -> (~lock.ex \/ (lock.rec = o /\ ~alive[o])) \* L is gone, or is o's dead lock
    [] d = "staleOwner"       -> ~alive[o]
    [] d = "malformed"        -> TRUE                             \* hedged in the message

Unchanged_env == UNCHANGED <<alive, pidLive, ownerHost, host, hostChanged, reused>>

Finish(t, d, o) ==
  /\ pc' = [pc EXCEPT ![t] = "finished"]
  /\ diag' = [diag EXCEPT ![t] = d]
  /\ diagOk' = [diagOk EXCEPT ![t] = Accurate(d, o)]

GoTo(t, l) == pc' = [pc EXCEPT ![t] = l] /\ UNCHANGED <<diag, diagOk>>

\* How a timeout surfaces once staleness is decided. Plain callers surface the error as is;
\* the push role runs acquireSettled on a malformed lock and, for ifAvailable, request's
\* start-time check on a live same-host owner.
Surface(t, o, isStale) ==
  IF mode[t] = "plain"
    THEN Finish(t, IF o = NONE THEN "malformed" ELSE IF isStale THEN "stale" ELSE "held", o)
  ELSE IF o = NONE
    THEN GoTo(t, "settle")
  ELSE IF mode[t] = "ifAvail" /\ ~isStale /\ SameHost(o)
    THEN GoTo(t, "ps")
  ELSE IF mode[t] = "ifAvail" /\ ~isStale
    THEN Finish(t, "busy", o)                                     \* foreign host
  ELSE Finish(t, IF isStale THEN "stale" ELSE "held", o)          \* rethrown

-----------------------------------------------------------------------------
Init ==
  /\ lock = NoDir
  /\ stale = [t \in Tokens |-> NoDir]
  /\ rel = [t \in Tokens |-> NoDir]
  /\ nextId = 1
  /\ pc = [t \in Tokens |-> "idle"]
  /\ snap = [t \in Tokens |-> NONE]
  /\ claimed = [t \in Tokens |-> 0]
  /\ wdir = [t \in Tokens |-> 0]
  /\ mode = [t \in Tokens |-> "plain"]
  /\ retries = [t \in Tokens |-> 0]
  /\ settled = [t \in Tokens |-> FALSE]
  /\ alive = [t \in Tokens |-> FALSE]
  /\ pidLive = [t \in Tokens |-> FALSE]
  /\ ownerHost = [t \in Tokens |-> 0]
  /\ host = 0
  /\ hostChanged = FALSE
  /\ diag = [t \in Tokens |-> "none"]
  /\ diagOk = [t \in Tokens |-> TRUE]
  /\ relErr = [t \in Tokens |-> FALSE]
  /\ reused = [t \in Tokens |-> FALSE]

\* A command starts. A slot's next run starts after the previous one ends.
StartRun(t) ==
  /\ pc[t] = "idle"
  /\ IF RunOf(t) = 1 THEN TRUE ELSE pc[t - 1] \in {"exited", "crashed"}
  /\ \E m \in Modes : mode' = [mode EXCEPT ![t] = m]
  /\ pc' = [pc EXCEPT ![t] = "mkdir"]
  /\ alive' = [alive EXCEPT ![t] = TRUE]
  /\ pidLive' = [pidLive EXCEPT ![t] = TRUE]
  /\ ownerHost' = [ownerHost EXCEPT ![t] = host]
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, claimed, wdir, retries, settled,
                 host, hostChanged, diag, diagOk, relErr, reused>>

\* mkdir(L). EEXIST is contention, so the next step reads the owner.
Mkdir(t) ==
  /\ pc[t] = "mkdir"
  /\ IF ~lock.ex
       THEN /\ lock' = Dir(nextId, t, NONE)
            /\ nextId' = nextId + 1
            /\ pc' = [pc EXCEPT ![t] = "lstat"]
       ELSE /\ pc' = [pc EXCEPT ![t] = "read1"]
            /\ UNCHANGED <<lock, nextId>>
  /\ UNCHANGED <<stale, rel, snap, claimed, wdir, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* existingOwner = readOwner(L). A parsed record leads to the quarantine attempt.
Read1(t) ==
  /\ pc[t] = "read1"
  /\ snap' = [snap EXCEPT ![t] = ReadRec(lock)]
  /\ pc' = [pc EXCEPT ![t] = IF ReadRec(lock) # NONE THEN "probe" ELSE "tcheck"]
  /\ UNCHANGED <<lock, stale, rel, nextId, claimed, wdir, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* quarantineStaleLock: hostname check and processExists(owner.pid), against the snapshot.
Probe(t) ==
  /\ pc[t] = "probe"
  /\ \E dead \in DeadAnswers(snap[t]) :
       pc' = [pc EXCEPT ![t] =
                IF SameHost(snap[t]) /\ dead
                  THEN (IF OwnerRecheck THEN "recheck" ELSE "quar")
                  ELSE "read2"]
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, claimed, wdir, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* quarantineStaleLock: after death is established, re-read the record and require the same
\* token before renaming. A mismatch is a failed quarantine.
RecheckOwner(t) ==
  /\ pc[t] = "recheck"
  /\ pc' = [pc EXCEPT ![t] = IF ReadRec(lock) = snap[t] THEN "quar" ELSE "read2"]
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, claimed, wdir, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* quarantineStaleLock: rename(L, L.stale-<h(snap)>). Whatever directory is at L now is moved.
Quar(t) ==
  /\ pc[t] = "quar"
  /\ LET o == snap[t]
         r == RenameRes(lock, stale[o])
     IN IF r = "OK"
          THEN /\ stale' = [stale EXCEPT ![o] = lock]
               /\ lock' = NoDir
               /\ pc' = [pc EXCEPT ![t] = "mkdir"]
          ELSE /\ pc' = [pc EXCEPT ![t] = "read2"]          \* ENOENT, or the destination exists
               /\ UNCHANGED <<lock, stale>>
  /\ UNCHANGED <<rel, nextId, snap, claimed, wdir, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* existingOwner = readOwner(L) after a failed quarantine or a non-stale owner.
Read2(t) ==
  /\ pc[t] = "read2"
  /\ snap' = [snap EXCEPT ![t] = ReadRec(lock)]
  /\ pc' = [pc EXCEPT ![t] = "tcheck"]
  /\ UNCHANGED <<lock, stale, rel, nextId, claimed, wdir, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* The budget check: time out, or delay(pollMs) and loop back to mkdir.
TCheck(t) ==
  /\ pc[t] = "tcheck"
  /\ \/ pc' = [pc EXCEPT ![t] = "timeout"] /\ UNCHANGED retries
     \/ /\ retries[t] < MaxRetries
        /\ retries' = [retries EXCEPT ![t] = @ + 1]
        /\ pc' = [pc EXCEPT ![t] = "mkdir"]
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, claimed, wdir, mode, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* timeoutError: `stale` probes the pid now, against the snapshot owner.
Timeout(t) ==
  /\ pc[t] = "timeout"
  /\ LET o == snap[t] IN
     \E dead \in (IF o = NONE THEN {FALSE} ELSE DeadAnswers(o)) :
       LET isStale == o # NONE /\ SameHost(o) /\ dead IN
       IF isStale /\ DiagnosisRecheck
         THEN GoTo(t, "diagread")
         ELSE Surface(t, o, isStale)
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, claimed, wdir, mode, retries, settled, relErr>>
  /\ Unchanged_env

\* timeoutError: report "stale" only while L still carries the snapshot owner's record.
RecheckDiag(t) ==
  /\ pc[t] = "diagread"
  /\ Surface(t, snap[t], ReadRec(lock) = snap[t])
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, claimed, wdir, mode, retries, settled, relErr>>
  /\ Unchanged_env

\* acquireSettled: lockAgeMs(L). Gone on the first attempt: retry once. Gone or young: a claim
\* or release in progress. Old: the malformed orphan error.
Settle(t) ==
  /\ pc[t] = "settle"
  /\ IF ~lock.ex /\ ~settled[t]
       THEN /\ settled' = [settled EXCEPT ![t] = TRUE]
            /\ retries' = [retries EXCEPT ![t] = 0]
            /\ pc' = [pc EXCEPT ![t] = "mkdir"]
            /\ UNCHANGED <<diag, diagOk>>
       ELSE /\ UNCHANGED <<settled, retries>>
            /\ IF ~lock.ex \/ alive[lock.by]                 \* A7: age < claimGraceMs
                 THEN Finish(t, IF mode[t] = "ifAvail" THEN "busy" ELSE "busyClaiming", NONE)
                 ELSE Finish(t, "malformed", NONE)
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, claimed, wdir, mode, relErr>>
  /\ Unchanged_env

\* request (ifAvailable): the pid started after the claim iff it now belongs to a later process (A7).
Ps(t) ==
  /\ pc[t] = "ps"
  /\ LET o == snap[t] IN
       IF pidLive[o] /\ ~alive[o] THEN Finish(t, "staleOwner", o) ELSE Finish(t, "busy", o)
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, claimed, wdir, mode, retries, settled, relErr>>
  /\ Unchanged_env

\* claimed = lstat(L). It can observe a successor directory.
Lstat(t) ==
  /\ pc[t] = "lstat"
  /\ claimed' = [claimed EXCEPT ![t] = IF lock.ex THEN lock.id ELSE 0]
  /\ pc' = [pc EXCEPT ![t] = "openwx"]
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, wdir, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* open(L/owner.json, wx). ENOENT -> rollback, then retry; EEXIST -> retry;
\* success -> the file exists, empty (A6).
OpenWx(t) ==
  /\ pc[t] = "openwx"
  /\ IF ~lock.ex
       THEN pc' = [pc EXCEPT ![t] = "rbRead"] /\ UNCHANGED <<lock, wdir>>
     ELSE IF lock.rec # NONE
       THEN pc' = [pc EXCEPT ![t] = "mkdir"] /\ UNCHANGED <<lock, wdir>>
     ELSE /\ lock' = [lock EXCEPT !.rec = EMPTY]
          /\ wdir' = [wdir EXCEPT ![t] = lock.id]
          /\ pc' = [pc EXCEPT ![t] = "write"]
  /\ UNCHANGED <<stale, rel, nextId, snap, claimed, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

SetRecById(d, i, t) == IF d.ex /\ d.id = i THEN [d EXCEPT !.rec = t] ELSE d

\* The write through the fd, which completes writeFile. The claim returns.
Write(t) ==
  /\ pc[t] = "write"
  /\ lock' = SetRecById(lock, wdir[t], t)
  /\ stale' = [o \in Tokens |-> SetRecById(stale[o], wdir[t], t)]
  /\ rel' = [o \in Tokens |-> SetRecById(rel[o], wdir[t], t)]
  /\ pc' = [pc EXCEPT ![t] = "cs"]
  /\ UNCHANGED <<nextId, snap, claimed, wdir, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* The caller's mutation runs; then it calls release.
CS(t) ==
  /\ pc[t] = "cs"
  /\ pc' = [pc EXCEPT ![t] = "relVerify"]
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, claimed, wdir, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* release re-reads the record; a different token is changedOwnerRefusal.
RelVerify(t) ==
  /\ pc[t] = "relVerify"
  /\ IF ReadRec(lock) = t
       THEN pc' = [pc EXCEPT ![t] = "relRename"] /\ UNCHANGED relErr
       ELSE pc' = [pc EXCEPT ![t] = "finished"] /\ relErr' = [relErr EXCEPT ![t] = TRUE]
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, claimed, wdir, mode, retries, settled, diag, diagOk>>
  /\ Unchanged_env

\* removeReleasedLock: rename(L, L.released-<h(t)>). The first failure throws (A1).
RelRename(t) ==
  /\ pc[t] = "relRename"
  /\ IF RenameRes(lock, rel[t]) = "OK"
       THEN /\ rel' = [rel EXCEPT ![t] = lock]
            /\ lock' = NoDir
            /\ pc' = [pc EXCEPT ![t] = "relRm"]
            /\ UNCHANGED relErr
       ELSE /\ pc' = [pc EXCEPT ![t] = "finished"]
            /\ relErr' = [relErr EXCEPT ![t] = TRUE]
            /\ UNCHANGED <<lock, rel>>
  /\ UNCHANGED <<stale, nextId, snap, claimed, wdir, mode, retries, settled, diag, diagOk>>
  /\ Unchanged_env

\* removeReleasedLock: rm(remnant). ENOENT counts as done.
RelRm(t) ==
  /\ pc[t] = "relRm"
  /\ rel' = [rel EXCEPT ![t] = NoDir]
  /\ pc' = [pc EXCEPT ![t] = "finished"]
  /\ UNCHANGED <<lock, stale, nextId, snap, claimed, wdir, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* rollBackOwnClaim reads the record. Our own token cannot be there (it was never written).
RbRead(t) ==
  /\ pc[t] = "rbRead"
  /\ pc' = [pc EXCEPT ![t] =
              IF ReadRec(lock) = t THEN "impossible"
              ELSE IF ReadRec(lock) # NONE THEN "mkdir" ELSE "rbIsClaimed"]
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, claimed, wdir, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* isClaimedDirectory: same dev, ino and birth time as the lstat after mkdir.
RbIsClaimed(t) ==
  /\ pc[t] = "rbIsClaimed"
  /\ pc' = [pc EXCEPT ![t] =
              IF lock.ex /\ claimed[t] # 0 /\ lock.id = claimed[t] THEN "rbRename" ELSE "mkdir"]
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, claimed, wdir, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* rollBackOwnClaim: rename(L, released). A throw is swallowed by the caller, which retries.
RbRename(t) ==
  /\ pc[t] = "rbRename"
  /\ IF RenameRes(lock, rel[t]) = "OK"
       THEN /\ rel' = [rel EXCEPT ![t] = lock]
            /\ lock' = NoDir
            /\ pc' = [pc EXCEPT ![t] = "rbRm"]
       ELSE /\ pc' = [pc EXCEPT ![t] = "mkdir"]
            /\ UNCHANGED <<lock, rel>>
  /\ UNCHANGED <<stale, nextId, snap, claimed, wdir, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* rollBackOwnClaim: rm(remnant, force).
RbRm(t) ==
  /\ pc[t] = "rbRm"
  /\ rel' = [rel EXCEPT ![t] = NoDir]
  /\ pc' = [pc EXCEPT ![t] = "mkdir"]
  /\ UNCHANGED <<lock, stale, nextId, snap, claimed, wdir, mode, retries, settled, diag, diagOk, relErr>>
  /\ Unchanged_env

\* The one-shot CLI command ends; the process exits and is reaped.
Exit(t) ==
  /\ pc[t] = "finished"
  /\ pc' = [pc EXCEPT ![t] = "exited"]
  /\ alive' = [alive EXCEPT ![t] = FALSE]
  /\ pidLive' = [pidLive EXCEPT ![t] = FALSE]
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, claimed, wdir, mode, retries, settled,
                 ownerHost, host, hostChanged, diag, diagOk, relErr, reused>>

-----------------------------------------------------------------------------
\* Environment

Crash(t) ==
  /\ AllowCrash
  /\ pc[t] \notin {"idle", "finished", "exited", "crashed"}
  /\ pc' = [pc EXCEPT ![t] = "crashed"]
  /\ alive' = [alive EXCEPT ![t] = FALSE]
  /\ pidLive' = [pidLive EXCEPT ![t] = FALSE]
  /\ UNCHANGED <<lock, stale, rel, nextId, snap, claimed, wdir, mode, retries, settled,
                 ownerHost, host, hostChanged, diag, diagOk, relErr, reused>>

\* One foreign process takes the dead pid (it may later exit, ReuserExit). At most once per pid.
Reuse(t) ==
  /\ PidReuse /\ pc[t] \in {"exited", "crashed"} /\ ~pidLive[t] /\ ~reused[t]
  /\ pidLive' = [pidLive EXCEPT ![t] = TRUE]
  /\ reused' = [reused EXCEPT ![t] = TRUE]
  /\ UNCHANGED <<lock, stale, rel, nextId, pc, snap, claimed, wdir, mode, retries, settled,
                 alive, ownerHost, host, hostChanged, diag, diagOk, relErr>>

ReuserExit(t) ==
  /\ PidReuse /\ pidLive[t] /\ ~alive[t]
  /\ pidLive' = [pidLive EXCEPT ![t] = FALSE]
  /\ UNCHANGED <<lock, stale, rel, nextId, pc, snap, claimed, wdir, mode, retries, settled,
                 alive, ownerHost, host, hostChanged, diag, diagOk, relErr, reused>>

HostnameChange ==
  /\ HostChange /\ ~hostChanged
  /\ host' = 1 - host
  /\ hostChanged' = TRUE
  /\ UNCHANGED <<lock, stale, rel, nextId, pc, snap, claimed, wdir, mode, retries, settled,
                 alive, pidLive, ownerHost, diag, diagOk, relErr, reused>>

-----------------------------------------------------------------------------
Step(t) ==
  \/ Mkdir(t) \/ Read1(t) \/ Probe(t) \/ RecheckOwner(t) \/ Quar(t) \/ Read2(t) \/ TCheck(t)
  \/ Timeout(t) \/ RecheckDiag(t) \/ Settle(t) \/ Ps(t)
  \/ Lstat(t) \/ OpenWx(t) \/ Write(t) \/ CS(t)
  \/ RelVerify(t) \/ RelRename(t) \/ RelRm(t)
  \/ RbRead(t) \/ RbIsClaimed(t) \/ RbRename(t) \/ RbRm(t)
  \/ Exit(t)

Next ==
  \/ \E t \in Tokens : StartRun(t) \/ Step(t) \/ Crash(t) \/ Reuse(t) \/ ReuserExit(t)
  \/ HostnameChange

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* Properties

\* Holding: from the successful owner write until the release rename has moved L away.
Holding(t) == pc[t] \in {"cs", "relVerify", "relRename"} /\ alive[t]

\* Mutual exclusion.
M1 == \A t, u \in Tokens : t # u => ~(Holding(t) /\ Holding(u))
\* A holder's own record is at L for as long as it holds the lock.
M2 == \A t \in Tokens : Holding(t) => (lock.ex /\ lock.rec = t)
\* A quarantine destination only ever holds its own dead owner's directory.
Fence == \A o \in Tokens : stale[o].ex => stale[o].rec = o
\* rollBackOwnClaim never finds a record this claim did not write.
NoImpossible == \A t \in Tokens : pc[t] # "impossible"
\* A "retry" diagnosis is issued only when retrying can succeed.
RetryDiagAccurate == \A t \in Tokens : diag[t] \in RetryKinds => diagOk[t]
\* A "stale" diagnosis names a lock whose owner really is dead.
StaleDiagAccurate == \A t \in Tokens : diag[t] \in {"stale", "staleOwner"} => diagOk[t]
=============================================================================
