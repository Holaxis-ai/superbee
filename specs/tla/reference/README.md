# Reference models of unbuilt designs

The models here describe designs that are not built. No code on `main` implements them, CI does not
run them, and `run-tlc.sh` skips this directory unless a config is named. They are kept to seed the
work that builds each design: when that work starts, move the model next to the spec it extends,
check it against the code as built, and add its configs to CI.

Each model comes from the formal-verification round-2 report, where the design, the options it was
compared with and the open questions are written up: the D3 section (hosted retention) and the D4
section (identified-write ABA). Line references in the model headers are to the commit the models
were written against, not to current `main`. The configs follow the conventions in
[`../README.md`](../README.md#config-conventions); run one by name, for example:

```sh
TLA2TOOLS=/tmp/tla2tools.jar specs/tla/run-tlc.sh specs/tla/reference/*/*.cfg
```

## hosted-retention

`HostedRetention.tla` is a variant of the identified-write model with the hosted transport's
retention window. Past the window, today's hosted client reports UNKNOWN forever
(`identified-write`'s `bug-hosted-wedge`). The design (report option B) anchors trust in absence on the claim before the
last possible send, reads the head back past the window, and surfaces an outcome-unknown conflict
instead of resending.

| Config | Checks | Expected |
| --- | --- | --- |
| `HostedRetention.send-claim.cfg` | Option B safety: `AtMostOnce`, `NoLostUpdate`, `NoMisleadingConflict`, `AckHonest`, `NoSpuriousReview`, `AnchorCovers`, `NoResubmitPastWindow` | pass |
| `HostedRetention.send-claim-live.cfg` | Option B liveness: `EventuallySettles` | pass |
| `HostedRetention.bug-created-anchor.cfg` | Option C, read-back anchored on `createdAt`: a never-sent change is shown as outcome unknown | `NoSpuriousReview` violated |
| `HostedRetention.assumption-no-record-loss.cfg` | Option B assumes the host never loses an outcome record inside its window; a restart breaks it | `AtMostOnce` violated |

Not yet checked: a client crash between the claim and settlement (`AnchorCovers` across crashes).

## operation-ticket

`OperationTicket.tla` is a variant of the identified-write model with a server-issued outcome
ticket (report option C2): the store stamps an epoch and issue time, the client binds the ticket at its
first send, and with no live record the store applies only while the epoch is current and the
ticket is young, otherwise answering "unverifiable" with the head. `Cas = "revision"` models
report option A, a non-repeating revision premise, for comparison. `TicketChecks` selects which of
the store's two checks run, so the mutants can drop one.

| Config | Checks | Expected |
| --- | --- | --- |
| `OperationTicket.ticket.cfg` | Option C2 with one store restart: `AtMostOnce`, `NoLostUpdate`, `NoMisleadingConflict`, `AckHonest`, `TicketBoundOnce`, `EventuallySettles`, `NoApplyUnvouched` | pass |
| `OperationTicket.revision-restart.cfg` | Option A: a revision premise closes the restart ABA with no guard: `AtMostOnce`, `NoLostUpdate`, `AckHonest` | pass |
| `OperationTicket.mutant-no-epoch.cfg` | Mutant: the guard checks the ticket's age but not the store epoch; a restart re-applies the write | `AtMostOnce` violated |
| `OperationTicket.mutant-no-age.cfg` | Mutant: the guard checks the epoch but not the ticket's age; an expired record re-applies the write | `AtMostOnce` violated |
