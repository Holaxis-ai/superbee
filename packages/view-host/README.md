# Superbee View host

The browser-safe host side of the Superbee View protocol (`docs/VIEW-PROTOCOL.md`), for a page
that runs a View in a sandboxed frame. Its one runtime dependency is `@superbee/core`.

| Entry | What it holds |
| --- | --- |
| `@superbee/view-host/view-bridge-host` | `createViewBridgeHost`: maps each View request onto a named operation that the page's `execute` callback runs |
| `@superbee/view-host/action-bridge` | The v1 View action contract: message parsing and replies |
| `@superbee/view-host/action-preparation` | `prepareViewDocumentAction`: the host-neutral proposal policy over Core |
| `@superbee/view-host/view-frame` | `viewFrameHeaders` and `viewFramePolicy`: the response headers a View entry is served with |
| `@superbee/view-host` | The host and the frame headers together |

```ts
import { createViewBridgeHost } from "@superbee/view-host";

const host = createViewBridgeHost(frame.contentWindow, { id: bundleId, name: bundleTitle }, execute, {
  operations: ["documents.read.v1", "documents.query.v1", "documents.relationships.v1", "documents.edges.v1"],
  invalidate: () => frame.remove(),
});
window.addEventListener("message", (event) => void host.receive(event));
```

| Request | Operation |
| --- | --- |
| `query` | `documents.query.v1` |
| `read`, `read-versioned`, `render-document` | `documents.read.v1` |
| `relationships` | `documents.relationships.v1` |
| `edges` | `documents.edges.v1` |
| `graph` | `bundles.graph.v1` |
| `action.propose` (v1) | the page's `proposeAction` |

`execute(operation, input, signal)` runs the operation on the person's behalf and answers its
result envelope, `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. Every input
carries the host's fixed `bundleId`. The host declares in `hello` only the requests whose
operation the page offers and refuses the rest with `FORBIDDEN`. The page owns the frame, the
data source, authorization and any confirmation; the host owns parsing, limits, queuing and the
protocol's replies. It admits messages only from the frame it was given, at the opaque origin a
`sandbox="allow-scripts"` frame has.

## What the page must do itself

The host trusts the frame it was given, not what is loaded in it. A page that embeds a View is
safe only if it also does these:

- **Keep the frame on the View.** Send the embedding page with a `Content-Security-Policy` whose
  `frame-src` (and `child-src`) allow only the page's own origin. Without it a View can navigate
  its frame to another site, and that site then receives every answer and has the network.
- **Sandbox the frame with scripts only.** Embed the entry in `<iframe sandbox="allow-scripts">`.
  Never add `allow-same-origin`, `allow-popups` or `allow-top-navigation`.
- **Serve the entry with `viewFrameHeaders(pageOrigin)`.** Take `pageOrigin` from the page's own
  configuration, never from a request header.
- **Authorize in `execute`.** Check who is asking on every call; the host passes requests
  through and does not know the viewer. Enforce the query and edges row ceilings there too: the
  host declares them in `hello` but answers whatever `execute` returns, up to its reply size cap.

This package is published by hand from a reviewed tarball, as `packages/browser-local/RELEASING.md`
describes; its workspace `prepublishOnly` refuses a direct publish.
