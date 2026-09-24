---------------------------- MODULE MCWorkingCopy ----------------------------
\* Model values and the bootstrapped start state for WorkingCopy: x is shared at v0 and y
\* is absent on both sides.
EXTENDS WorkingCopy
CONSTANTS x, y, v0, v1, v2, t1, t2
MCInit == (x :> v0) @@ (y :> Absent)
=============================================================================
