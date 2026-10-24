# View launch continuity

`@superbee/core/view-launch-contract` is an effect-free browser-safe leaf. A host creates one
fence, begins an immutable attempt for its selected View, and passes that attempt through its
asynchronous work. Only the exact current object from that fence passes `isCurrent`; copied or
cross-fence objects do not. `retire` is conditional and idempotent, so stale cleanup cannot retire
a replacement. Generations increase without wrapping; exhaustion retires current work and throws.

Fence successes, failures, replies, approval responses and timer callbacks before publishing host
state. A generation may label frame sizing or DOM metadata, but numeric equality grants no
currentness. The selection key is diagnostic, not a route or authority. A fence performs no
cleanup, cancellation, retries, persistence or host effects.

Attempts and `ViewLaunchFailureReason` describe local continuity/outcomes; they do not grant a
session, approve exact executable bytes, resolve registration, or replace host security/currentness
checks. Hosts retain their own frame readiness and resume semantics. This leaf is not exported from
the Core root barrel.
