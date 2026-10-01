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
| `createRevealPolicy`, `RevealMode`, `RevealSurface`, `RevealResult`, `FOLLOW_MS`, `OFFER_MS` | One navigation preference/cadence/offer lifecycle; hosts resolve typed targets and run their ordinary navigation paths |
| `ToolDescriptor` | Direct callable descriptor; a separate browser registration adapter may expose the same object through WebMCP |
| `AssistantEvent`, `AssistantSourceRead`, `AssistantSourceRef` | Additive event envelope and host-created live/publication source references |
| `NavigationOrigin`, `NavigationTarget`, `NavigationOutcome`, `NavigationRequest`, `NavigationReceipt` | Identifier-based requests and receipts bound to the initiating session, turn, tool, surface and context |
| `mountAssistantPanel`, `AssistantPanelContext`, `AssistantPanelSession`, `AssistantPanelTransport`, `AssistantPanelOptions` | Same DOM panel for both hosts; transport, current context, safe text renderer, source opening and navigation are injected |

`createSurfaceContext({route, validate})` exposes `snapshot()`, `signal`, `begin(route)`, `clear(route?)`,
`revalidate(check)` and `stop()`. `begin` clears the previous selection and returns an admission
callback. The callback accepts one validated selection only while its generation is current. Any
transition aborts the preceding signal; A → B → A cannot admit a late A request. `revalidate` checks
current host authority and rejects a result after a transition. Snapshots are shallowly frozen;
host selections should contain immutable identifiers rather than mutable content.

`createRevealPolicy({surface, resolve, screenSignal, lifetime})` exposes `execute(input, invocation?)`
and `dispose()`. Input validation belongs to the host wrapper. Off refuses; suggestions offer; follow
navigates on a quiet surface, at most once per six seconds. A busy follow surface offers instead.
Offers expire after sixty seconds and clear on screen transition or lifetime abort. The host's
`navigate` must check current admission and mayLeave guards before reporting success. A successful
navigation can intentionally change the prior context revision.

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
