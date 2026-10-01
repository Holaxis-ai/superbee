# @superbee/agent-surface

A small shared assistant surface for workspace and publication hosts. The package owns presentation
context revisions, admission tickets, cancellation and late-result fencing; suggestion/follow/off
navigation policy; a transport-injected browser panel; and the common event, source and navigation
types needed by those consumers. It has no runtime dependencies.

Hosts own route names, selection validation, source identities, target schemas, permissions, saved
content reads, navigation admission, unsaved-change protection, rendering and transport. Context is
orientation, never authorization. A successful read creates a source reference; a model cannot
create one by writing a URL. A host advertises only the navigation targets it can resolve.

## Public export map

All exports use `@superbee/agent-surface`. No private hosted imports or deep package imports are
supported.

| Export | Owner and caller |
| --- | --- |
| `createSurfaceContext`, `SurfaceContextError`, `SurfaceSnapshot` | Pure context lifecycle; hosted screen-context and Portal adapters validate their own selection shapes |
| `createRevealPolicy`, `RevealMode`, `RevealSurface`, `RevealResult`, `RevealNavigationContext`, `FOLLOW_MS`, `OFFER_MS` | One navigation preference/cadence/offer lifecycle; hosts resolve typed targets and run their ordinary navigation paths |
| `ToolDescriptor` | Direct callable descriptor; a separate browser registration adapter may expose the same object through WebMCP |
| `AssistantEvent`, `AssistantSourceRead`, `AssistantSourceRef` | Additive event envelope and host-created live/publication source references |
| `NavigationOrigin`, `NavigationTarget`, `NavigationOutcome`, `NavigationRequest`, `NavigationReceipt` | Identifier-based requests and receipts bound to the initiating session, turn, tool, surface and context |
| `mountAssistantPanel`, `AssistantPanelContext`, `AssistantPanelSession`, `AssistantPanelTransport`, `AssistantPanelOptions`, `AssistantNavigationCommit` | Same DOM panel for both hosts; transport, current context, safe text renderer, source opening and navigation are injected |

`createSurfaceContext({route, validate})` exposes `snapshot()`, `signal`, `begin(route)`, `clear(route?)`,
`revalidate(check)` and `stop()`. `begin` clears the previous selection and returns an admission
callback. The callback accepts one validated selection only while its generation is current. Any
transition aborts the preceding signal; A → B → A cannot admit a late A request. `revalidate` checks
current host authority and rejects a result after a transition. Snapshots are shallowly frozen;
host selections should contain immutable identifiers rather than mutable content.

`createRevealPolicy({surface, resolve, screenSignal, lifetime})` exposes `execute(input, invocation?)`
and `dispose()`. Input validation belongs to the host wrapper. Off refuses; suggestions offer; follow
navigates on a quiet surface, at most once per six seconds. A busy follow surface offers instead.
Offers expire after sixty seconds and clear on screen transition, target invalidation, invocation cancellation or lifetime
abort. The host's `navigate(target, {signal})` must recheck the supplied signal after awaited admission
and mayLeave guards, before committing navigation. Existing callbacks that accept only the target
remain compatible. A successful
navigation can intentionally change the prior context revision.

The panel supplies `navigate(request, signal, admitCommit)`. Its signal aborts outstanding navigation
on Stop, redirected/interrupted/failed turns, canceled tools, source binding or context revision
changes, and panel fencing/disposal. A successful `end_turn` leaves a valid offer available until the
person consumes it or the host's TTL expires. Hosts still recheck current target admission before
accepting an offer.

For SPA navigation, call `admitCommit()` immediately before the normal router's commit, after
awaited admission/draft guards; refuse if it returns false. Return `navigated` only for actual success.
The panel then records the initiating origin's receipt across that deliberate revision change,
provided the session and binding remain live. Cancellation before the host commits prevents
navigation; cancellation after an admitted, successful commit cannot undo it and does not relabel
that effect as failure. Replaced or disposed panels do not issue the old origin's receipt. Unmarked late results from unrelated context
changes cannot issue receipts. A reveal adapter can pass the callback in `execute(input,
{signal, admitCommit})`; follow hosts receive it in `RevealNavigationContext` and invoke it at the
actual route commit. Suggestions and off never need to invoke it.

For full-page navigation, the destination host owns completion: retain the initiating origin and
target, verify the actual destination and publication/source binding after admission, then record
the original `navigated` receipt. Issuing a browser navigation is not proof that its destination was
admitted; do not record success before that verification. The old panel's disposal cancels its
presentation operations without replacing the destination's completion check.

The package does not touch `document.modelContext`. A descriptor's `execute` is directly callable
in browsers without native WebMCP support. The host separately registers descriptors when available.

## Local artifact proof and publication

Build from the repository root with `npm run build`, then run `npm test -w @superbee/agent-surface`.
Pack the package once into a temporary directory using `npm pack --workspace @superbee/agent-surface
--pack-destination <directory>`. `node packages/agent-surface/scripts/verify-packed.mjs <tarball>`
installs those exact bytes in an external fixture and checks browser-safe ESM imports, declaration
imports and a direct tool invocation without WebMCP. It never builds, repacks or publishes them.

Consumers may use the exact local artifact for a disposable integration proof. Committed cross-repo
consumers require an exact compatible registry version after the maintainer's package bootstrap;
machine-specific paths and private sibling checkouts are not a distribution mechanism. No release
workflow or authenticated npm mutation is introduced by this package.

### Maintainer publication handoff

The first candidate is `@superbee/agent-surface@0.1.0-pre.1`, public access, channel `next`.
This package is versioned independently and has no runtime or peer dependencies. The existing
core/server and CLI release workflows do not publish it. Use the repository's manual literal-tarball
process, also used by browser-local. These instructions do not authorize publication or release tags.

1. Review and merge the preparation change. Record its actual merged source SHA and require green
   `CI required lanes` on that exact SHA. Obtain the maintainer's explicit release authorization and
   verify package publish access and npm's required interactive human approval. Refresh registry
   versions and dist-tags read-only; if this version already exists, compare its bytes and stop on
   divergence. Never reuse a published version for different bytes. First package creation needs a
   human bootstrap because npm staging cannot create a package.
2. From a clean checkout of that approved source, install with `npm ci`, run root build/typecheck,
   package tests and the standing packed consumer proof in `npm run test:scripts`. Pack the candidate
   once into a fresh artifact directory, retaining the npm JSON receipt:

   ```sh
   npm pack --workspace @superbee/agent-surface --json --pack-destination <artifact-directory>
   node packages/agent-surface/scripts/verify-packed.mjs <literal-tarball>
   ```

   Record source SHA, package/version, tarball SHA-256, receipt integrity and the verification result
   in the publisher handoff. The verifier checks legal-document bytes, the file allowlist, offline
   installation, ESM/declaration imports, direct invocation and browser bundling. Preserve those
   exact bytes through approval and publication; do not rebuild or repack an approved candidate.
3. Only the expressly authorized maintainer or publisher may publish the approved literal tarball
   with public access and `next`, including required interactive human approval. The workspace's
   `prepublishOnly` refusal is an accident-prevention guard; bypass it only for that separately
   approved literal artifact. No npm credential is supplied by this preparation. Manual artifacts
   do not acquire the other release workflows' attestations.
4. After publication, anonymously retrieve the exact registry version, compare downloaded bytes
   and registry integrity with the retained candidate, inspect exports/dependencies/access, and
   confirm the intended dist-tag. Record the evidence in the project bundle's Release record.
   Unexpected tag state requires an explicit maintainer decision; do not republish to repair it.
5. Prepare a separate consumer repin to the verified exact registry version in each manifest and
   lockfile. Verify clean installation without local tarball paths or dependency overrides, then
   complete the consumer's independent review, required CI and in-app proof. Publication alone
   does not complete integration or authorize production activation.
