# View launch and recovery agreement

An exact View launch and a host session are separate authorities. Local UI and MCP already use
`mintActiveViewLaunch` for current registered bytes and the existing exact-byte approval subject.
An attempt generation orders host work; it never grants permission, proves current content or
replaces session, grant, installation or pin checks. Host-specific readiness is delivery evidence,
not proof of displayed pixels or human reading.

## Local browser entry

Use `superbee view open <viewId>` for an exact registered View in the selected local bundle. It
starts or reuses the same canonical-bundle/resolved-actor authority as managed document opening.
Remote View opening is unsupported by this command. The shell still mints current bytes and asks
for any required execution approval after browser enrollment.

For an embedded browser, `superbee view open <viewId> --no-open --json` prepares a private
`browser_launch.url`; navigate the selected browser to that exact value. Default opening reports
`open_requested`; `--no-open` reports `handoff_prepared`. Neither asserts rendering. The ordinary
`url` is a credential-free destination, useful only in a browser with the appropriate local session.
Default human-readable output omits the private handoff; JSON labels it `private` and `one_use`.

Handoff tickets are 32 random bytes, process-local, one-use, expire in 60 seconds and have at most
32 outstanding entries per authority. Only the authenticated exact management capability can mint
one for a supported host-built target. They are distinct from management and reusable browser
secrets. A handoff enrolls the browser in the entire selected UI authority, not only the named View.
It is private, not a share link or bookmark. Do not log it or paste it into chat. A fresh handoff
must be requested after expiry or ambiguous redemption; the bootstrap never retries redemption.

The fragment-bearing static bootstrap erases its fragment before an asynchronous same-origin
exchange. Only that secret-free document and the bounded ticket exchange precede browser-session
authentication. The shell, data routes and general `/__ui/*` assets remain session-gated. The
exchange requires exact loopback Host/Origin, a custom header and JSON content type; its responses
are cacheless, non-frameable and no-referrer. Redemption atomically consumes a live ticket and
sets the existing authority-specific HttpOnly/SameSite cookie. No ticket approves executable bytes.

Managed protocol2 requires this operation. A new controller discovers protocol1 in the same
authority slot, stops/replaces an authenticated inactive worker only after proving exact listener
exit, and refuses an incompatible worker with active browser clients. Indeterminate probes keep
the existing refusal/recovery policy. An unsupported handoff never falls back to a reusable-token
View URL. Existing document and foreground UI receipts retain their compatibility behavior.

## Behavioral agreement table

Each row belongs to its actual boundary tests. A portable unit test or an outcome mapping alone is
not host adoption. Hosted retains its own admission and delivery; adoption of a public component
requires its supported package dependency and runtime import, with separate deployment evidence.

| Case | Required behavior | Owning tests / receiving evidence |
| --- | --- | --- |
| A replaced by B; late A success, error, timeout, approval or reply | No A result mounts, clears B, delivers an action reply or changes B's status. Stale A may clean up its own resources. | Core attempt contract, UI `PageFrame`, MCP durable-view and Hosted registered-View adapter tests when adopted. |
| Retire A; late A tries to retire B | A cannot revive itself or retire B. Each host cancels its own work. | Same current-attempt owners. |
| Registry, entry, capability or installed binding changes | Revalidate through existing launch authority; newly changed bytes do not inherit old approval. | view-runtime launch; UI launch-version-trust; MCP launch; Hosted pin/binding owners. |
| Fresh browser, exact View | A supported private handoff establishes only the selected UI context, then normal current-byte approval/delivery. | UI-server `management-auth`, CLI `view`, installed fresh-browser receiving proof. |
| Expired, replayed or parallel handoff; foreign process; invalid target | At most one redemption; no session from invalid input, arbitrary destination, management authority or ordinary output secret. | UI-server `management-auth`; CLI `view` and `ui-managed-authority`. |
| Old inactive managed worker | Supported authenticated stop, exact exit proof and protocol2 replacement, then handoff; no token fallback. | CLI `ui-managed-authority`. |
| Old active managed worker / indeterminate probe / missing new operation | Conflict or existing safe refusal; no unsafe takeover, parallel authority or token fallback. | CLI `ui-managed-authority`. |
| Missing structured MCP result | Only the exact preserved claim can recover through the bounded existing App channel; no latest-launch guess or cookie recovery. | MCP `result-recovery`/pending-launch owners and supported `show_view` receiving proof. |
| View403 versus missing/ended context | A View refusal stays local; only affirmative host/session evidence indicates context recovery. | UI PageFrame/client session and Hosted transport owners. |
| Quiet View, blocked delivery or replaced frame | Keep source/origin/generation checks and each host's supported readiness evidence. A frame load is not proof of rendering. | UI PageFrame/view-delivery; MCP frame-load guard; Hosted registered entry owners. |
| Local self-contained execution document | Verify original source bytes before trusted policy decoration; retain opaque isolation and deny nested frames, network and workers. Encoding or unsupported prolog ends only the current delivery. | view-runtime generated-host owner; UI view-delivery in Chromium/WebKit and actual embedded-browser receiving proof. |
| Outage or hidden/resumed App | No fabricated revocation or automatic proposal/write replay; MCP resume revalidates into a new launch. | Existing UI/MCP/Hosted transport and durable activity/resume owners. |
| Hosted revoked grant/pin/installation, including working-copy reads | Current Hosted authority ends the View; attempt continuity admits no operation. | Hosted registered transport/working-copy owners after actual component adoption. |

## Local execution-document delivery

The local shell verifies the admitted source before its opaque host adds a fixed early child-frame
policy and encodes a self-contained data URL. Approval and content versions continue to identify
the original source, not the host's execution decoration. The original 512 KiB UTF-8 source ceiling
is unchanged; execution permits only the fixed policy overhead. Data URLs contain View content and
must not enter receipts, logs or durable state. A failed delivery never retries through a weaker
transport or sandbox.

The policy precedes source activity while preserving an optional initial BOM, ASCII whitespace,
complete strict leading comments and an ordinary HTML5 doctype. Documents without a doctype retain
quirks mode. Ambiguous/malformed comments, processing instructions and legacy declarations refuse
local delivery rather than scan through active markup for a later head. The source is never rewritten
in the bundle. Child CSP, script-only sandboxing, exact message sources and host-origin checks stay
independent of launch authorization. Quiet Views need no mandatory hello.

MCP retains its blob transport and resource policy; Hosted retains its authenticated HTTP entry.
Sharing the attempt fence does not require interchangeable transport or session credentials.

## Recovery meaning

`context-required` requires affirmative host evidence and offers that host's supported context
recovery. `expired` and `changed` require reopening/re-resolving the same selected target, with any
new approval. `denied` ends execution without bypass. `unavailable` indicates an unresolved host or
transport answer, and `delivery-failed` indicates missing declared delivery evidence; each may
offer explicit retry under fresh checks. Hosts may conceal missing-versus-denied resources. None of
these outcomes changes an existing wire error schema or authorizes a retry, write or login itself.

The fresh-context refusal and any post-authentication embedded-browser delivery failure are
separate receiving boundaries. Prove the exact installed browser journey and supported MCP
`show_view` separately. Shared counters, session tests and ordinary-browser success cannot establish
that an embedded pane rendered correctly. Keep tickets and real credentials out of evidence.
