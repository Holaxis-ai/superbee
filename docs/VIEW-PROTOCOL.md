# Superbee View protocol

This file is the repository authority for the contract a bundle View's code speaks to the host
that frames it. `@superbee/view-runtime` (`packages/view-runtime/src/bridge.ts`) implements the
host side for the OSS web shell, the OSS MCP app and the static publication bridge; the Portal and
the hosted workspace implement hosts of the same contract. Code and tests are behavior evidence,
not separate protocol specifications. The storage seam between a shell and its server is a
different contract: see [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

Every View authored against this document runs unchanged in every host. A host may honor fewer
query features, refuse writes, or add an extension, but it says so in the `hello` reply and it
refuses what it does not offer with an error reply. Nothing is silently dropped.

The bundle-installed authoring reference (`examples/views/references/view-authoring-v0.md`,
carried by View-bearing recipes) is a short pointer to this document plus a copy of the reference
client below. The conformance fixture View in `examples/views/conformance/` exercises every request
type and reports one row per type; other hosts byte-copy that View and name the revision they ran.

## Definition, admission and sandbox

A View is one self-contained HTML entry under `views/...` plus a `type: View` registry document
under `views-registry/...` (`parseRegistration` in `@superbee/core/page`). The registry document
declares `access`: `none`, `bundle-read` or `bundle-propose`; anything else fails closed to `none`.
Entry bytes are admitted by `admitActiveView`: at most 512 KiB of UTF-8 `text/html`. Every host
frames the entry as an opaque-origin, script-only sandbox with `connect-src 'none'`, so the only
channel to bundle data is `postMessage` to the parent. Inline everything; no external hosts.

## Envelope

A request is a plain JSON object carrying `bridge` (`"v0"`, or `"v1"` for the two v1 requests),
`type`, and an `id` of at most 128 UTF-8 bytes. The reply echoes `bridge` and `id` with `type`
`"<request type>:result"` and a `result`, or `type: "error"` with `error: { code, message }`.
Requests carry exactly the keys named below; an extra key is malformed (`USAGE`).

The View accepts only messages whose `event.source` is `window.parent`. The host accepts only
messages from the exact current frame and validates every request before touching bundle data.

## Requests

| type | bridge | payload | reply `result` |
| --- | --- | --- | --- |
| `hello` | v0 | none | `{ bundle: { root, name }, mode, protocol: "v0", grant, host }` |
| `query` | v0 | `{ params: { type?, prefix?, field?, open?, limit? } }` | `{ rows: DocHead[], count }` |
| `read` | v0 | `{ docId }` | `{ id, frontmatter, body }` |
| `read-versioned` | v1 | `{ docId }` | `{ doc: { id, frontmatter, body }, version }` |
| `render-document` | v0 | `{ docId }` | `{ document: { id, version }, html, bounded }` |
| `edges` | v0 | `{ params: { from?, to?, text? } }` | `{ edges: { from, to, text }[], count }` |
| `graph` | v0 | `{ includeBodies? }` | `{ okfVersion, documents, relationships, counts }` |
| `subscribe` | v0 | none | `{ ok: true }`, then `change` events |
| `host` | v0 | `{ capability, input? }` | `{ capability, output }` |
| `open-page` | v0 | `{ pageId }` (`id` optional) | none on success; an error reply when refused |
| `action.propose` | v1 | `{ requestId, action }` | `action.result` from the shell, or an error reply |

`DocHead` is `{ id, version, frontmatter }`: the head projection CLI `list` uses, never a body.
`docId` is at most 1024 UTF-8 bytes; concept-id safety is the backend's authority, the bridge only
bounds transport.

### `hello`

`grant` is `"read"` for `access: bundle-read` and `"propose"` for `access: bundle-propose`. A host
that performs no writes answers `"read"` regardless of the declaration.

`host` is the host descriptor:

```json
{
  "kind": "oss",
  "capabilities": ["edges", "graph", "open-page", "query.count", "query.field-or", "query.kind-projection", "query.open", "render-document", "subscribe-deltas"],
  "limits": { "query": 500, "edges": 1000, "graphDocuments": 1000, "graphRelationships": 10000, "replyBytes": 2097152 }
}
```

`kind` is `"oss"`, `"portal"` or `"hosted"`. `capabilities` is a sorted list of names from the
registry below; a View feature-detects here instead of guessing from `kind` or `mode`. `limits` are
host-declared ceilings; `0` means the host does not offer the request at all. The OSS service
declares exactly the limits it enforces (`BRIDGE_SERVICE_LIMITS`).

A host that embeds the View as its page (no border, the host's own title bar) adds two optional
fields to `host`. `frame` is `{ "title": "host", "height": "content", "maxHeight": <px> }`:
the host has printed the View's name, so the View may hide its own masthead, and the host sizes
the frame to the height the View reports through `frame.resize`, up to `maxHeight`. A View that
never reports keeps the host's floor and owns its own scroll; a View reports a height or keeps the
window, never both. `theme` is the host's own resolved design tokens, each a CSS value string
(`scheme`, `ground`, `surface`, `text`, `muted`, `accent`, `border`, `focus`, `fontSans`,
`fontDisplay`, `fontMono`, `radius`, `spacing`); a View may adopt them as `--sb-*` custom
properties and looks native, or ignore them and keep its own brand. Both are absent on the OSS
shell and on Portal; a View that ignores them draws exactly as before.

`bundle.root` is a filesystem path on the OSS web shell in `--dir` mode and `null` elsewhere;
Portal and hosted hosts may put an opaque artifact or slot id there. `bundle.name` is the display
name the shell shows, never an internal identifier. `mode` is host-specific (`dir`, `remote`,
`local-mcp`, `snapshot`, ...) and is informational only.

### `query`

`params` accepts only `type`, `prefix`, `field`, `open` and `limit`.

- `type` (string, at most 256 bytes, trimmed, nonempty) and `prefix` (string, at most 1024 bytes,
  trimmed, nonempty) are storage-side facets: an exact frontmatter `type` and a bundle-relative id
  prefix.
- `limit` is a safe integer from `0` to the host's `limits.query`; `0` or absence means the host's
  maximum. `count` is the number of rows that matched after `field` and `open` filtering and before
  the cap, matching CLI `list`. A host without `query.count` returns `count` equal to the rows it
  returned.
- `field` is one filter string, at most 1024 bytes, trimmed, nonempty. Its exact grammar is the one
  `applyQuerySelectionFilters` in `@superbee/core` applies:
  1. Split at the first `=`. If there is no `=`, or the key before it is empty, the filter is
     ignored and no rows are removed.
  2. `key` is the text before `=`, trimmed. `values` is the text after `=`, split on `,`, each
     value trimmed, empty values dropped. An empty `values` list matches nothing.
  3. A row matches when any value matches (OR). For every key except `progress_status` the row's
     raw frontmatter value is coerced: absent or `null` becomes an empty list, an array stays a
     list, a scalar becomes a one-element list, every element becomes a string, and the value must
     be a member. Scalars and arrays therefore use the same membership rule as CLI `list`.
  4. `progress_status` is a logical Kind field. The host resolves the physical field for the
     bundle's OKF edition (`status` on 0.1, `superbee_progress_status` on 0.2) through the Kind
     convention governing the row's `type`; a row whose `type` has no governing Kind does not match.
- `open: true` drops terminal rows exactly like CLI `list --open`: a row is dropped when the Kind
  convention governing its `type` declares `fields.terminal` and the row's own value for such a
  field is in the terminal set. A row with no governing Kind is kept; a bundle whose Kinds declare
  no terminal set drops nothing. `open: false` is accepted and means absent.

Rows carry full frontmatter. A host with `query.kind-projection` also projects logical Kind fields
(such as `progress_status`) beside the raw coordinate, so a View never needs to know the physical
field an edition selects. The same projection applies to `read` and `read-versioned`.

### `read` and `read-versioned`

Both return one canonical document with the logical Kind projection above. `read-versioned` also
returns the content-addressed `version` from the same read; use it as `expectedVersion` for a
proposal. A body above 1 MiB answers `TOO_LARGE`. `read-versioned` is a read: every host, including
read-only hosts, answers it. The OSS shells validate v1 envelopes before forwarding them: the `id`
is at most 64 characters and `docId` must be one canonical bundle-relative id (no leading slash,
backslash, empty, `.` or `..` segments).

### `render-document`

The host reads the canonical document and serializes its body with the shared bounded Markdown
renderer (`@superbee/markdown-renderer/static` on every host). The returned `html` is inert
semantic markup: no scripts, event handlers, forms, controls, images or navigable anchors. Internal
concept links become passive elements carrying `data-aslite-doc-id`; delegate clicks on those
markers to your own selection logic and issue another `render-document`. Insert only the unmodified
`html`. `document.version` is the exact version rendered; after a matching `change` event, refetch
rather than treating old HTML as current. `bounded: true` means renderer safety limits truncated or
collapsed part of the input. A missing document answers `NOT_FOUND`.

### `edges`

The one graph primitive every edge-shaped question reduces to (the `queryEdges` atom CLI `link list`
is a face over). `params` accepts only `from`, `to` and `text`:

- `from` and `to` are each one exact nonblank concept id, a bundle-relative `prefix/` (trailing
  slash), or an array of 1 to 32 such strings (union within a facet; giving both facets ANDs them).
  Omit a facet for no restriction. Empty or all-whitespace strings, empty arrays, blank or
  non-string entries, and arrays above 32 entries are malformed. Every string is preserved
  byte-for-byte and may be at most 1024 UTF-8 bytes; duplicates count toward 32.
- `text` is one exact nonblank link-display string (never a substring or pattern), preserved
  byte-for-byte, at most 1024 UTF-8 bytes.

Backlinks are `edges({ to: docId })`; a container's contents are `edges({ from: itemId, text:
"contains" })`. A source linking to one target twice with different text yields two rows. More rows
than `limits.edges` answers `TOO_LARGE`.

### `graph`

The whole-bundle projection for graph-shaped Views: every document head and every derived edge in
one reply, bounded by the two graph limits.

Request:

```json
{ "bridge": "v0", "id": "g1", "type": "graph", "includeBodies": true }
```

`includeBodies` is optional and must be a boolean when present. No other keys are admitted.

Reply (`type: "graph:result"`):

```json
{
  "okfVersion": "0.2",
  "documents": [
    { "id": "tasks/one", "version": "sha256:...", "frontmatter": { "type": "Task", "title": "One" }, "body": "..." }
  ],
  "relationships": [
    { "from": "tasks/one", "to": "tasks/two", "text": "two" }
  ],
  "counts": { "documents": 1, "relationships": 1 }
}
```

- `documents` is every concept document in the bundle, in id order. Each row carries `id`,
  `version` (the same content-addressed token `read` returns) and `frontmatter` projected with
  the same logical Kind fields `query` and `read` apply. `body` is present only when the request
  set `includeBodies: true` and the launch capability permits reads (`bundle-read` and
  `bundle-propose` do). A row never carries a `body` key otherwise. A row must not carry a body
  that a plain `read` would refuse: one document body above 1 MiB answers `TOO_LARGE` for the
  whole request, while the same graph without bodies stays answerable.
- `relationships` is the whole derived edge list, the same derivation and order as `edges` (which
  refuses above 1000 rows where `graph` answers up to 10000), in `from`, `to`, `text` order.
- `counts` reports the array lengths.
- `okfVersion` is the bundle's declared OKF edition, `0.1` when undeclared.

The OSS bridge answers no `model` and no `definitions`. A host that owns a model shape declares
the `graph.model` capability in `hello.host.capabilities` and adds those keys; a View must treat
them as absent unless that capability is declared.

Limits, declared as exported constants on `@superbee/view-runtime` and carried in
`hello.host.limits` by every host that runs the service:

| Constant | Value | `hello.host.limits` | Over the limit |
| --- | --- | --- | --- |
| `GRAPH_MAX_DOCUMENTS` | 1000 | `graphDocuments` | `TOO_LARGE` |
| `GRAPH_MAX_RELATIONSHIPS` | 10000 | `graphRelationships` | `TOO_LARGE` |
| `MAX_REPLY_BYTES` | 2 MiB | `replyBytes` | `TOO_LARGE` (the shared reply check every request passes through) |

The document limit is checked before the edge scan runs. Exactly the limit is answered; one more
is refused. The reply byte limit is what bounds `includeBodies` in practice: a head-only graph of
a bundle can fit while the same graph with bodies is refused.

Errors:

- `USAGE`: the envelope is not exactly the shape above. A host built before this request (one
  whose `hello` carries no `host` descriptor) answers `graph` with the same `USAGE` error and
  correlated id it gave every unknown v0 type; a host at this contract that does not offer `graph`
  leaves it out of `hello.host.capabilities` and answers `FORBIDDEN`. A View feature-detects
  `graph` by the descriptor first and by either reply code second.
- `FORBIDDEN`: the launch has no bundle-data access, the same gate every data-bearing request has,
  or the host does not offer `graph`.
- `TOO_LARGE`: one of the three limits above, or a document body above 1 MiB with `includeBodies`.
- `RUNTIME`, `REVOKED`: as for every other request.

Cost: `graph` performs one head scan for documents and one full-bundle scan inside `queryEdges`
for relationships; with `includeBodies` it additionally reads each document so that a row's body
and version come from one read. The host keeps no cache on a View's behalf. Portal's
`createPublicationBridge` answers `graph` through the shared service with no publication-specific
code.

### `subscribe` and `change`

`subscribe` answers `{ ok: true }`. Afterwards the host may push
`{ bridge: "v0", type: "change", event: { changes: [{ id, version }], removed: [id] } }`.

A host that declares `subscribe-deltas` pushes real deltas: `changes` names heads whose version
differs from the last delivery and `removed` names deleted ids. A host without `subscribe-deltas`
acknowledges `subscribe` and may push `change` with empty arrays; that means "re-query". In both
cases `change` is a signal, never full state: refetch with `query` and never trust it alone. The
reference client's `Bridge.watch` treats every `change` as a refresh trigger, so a View written
with it behaves correctly on both kinds of host.

The OSS web shell fans the server's watcher deltas into subscribed Views; the OSS MCP app polls the
service and delivers each delta once, acknowledged by generation. A delta above 100 rows or 256 KiB,
or a bundle above 10000 heads, ends the subscription with a reload-required signal from the host.

### `host` (reserved extension request)

`{ bridge: "v0", type: "host", id, capability, input? }` invokes one host extension. `capability`
is a name from the registry below (lowercase, dot or hyphen separated, at most 128 bytes); `input`,
when present, is a plain object; the whole request is at most 64 KiB. A host answers
`{ capability, output }` when it has a handler for that capability and `FORBIDDEN` otherwise. A
registered handler is always listed in `hello.host.capabilities`, so a View calls `host` only for a
capability it saw in `hello`. Extensions require a bundle-data grant; a `none` View is refused.

No host adds a View-facing request type outside this document. A host-specific feature is a
`host` capability with its input and output shape recorded in the registry below.

### `open-page`

`{ bridge: "v0", type: "open-page", pageId, id? }` asks the shell to open another registered View.
It is the sole capability-independent request: `access: none` Views may send it. The host accepts
only a `views-registry/...` (or legacy-location `pages-registry/...`) concept id, verifies that it
resolves to a `type: View` document with a safe entry, and mounts the target with its own sandbox
and grant. No target bytes are returned. On success nothing is replied and the source frame may
unload immediately, so the client sends it fire-and-forget. A host that validates targets answers
`NOT_FOUND` for an unusable id; a host that does not navigate answers `FORBIDDEN`. Either reply
carries the request `id` when one was sent. The OSS MCP app consumes the source launch before
resolving the target, so a View running there should send `open-page` last.

### `action.propose`

`{ bridge: "v1", type: "action.propose", requestId, action: { kind: "document.set-field", docId,
field, value, expectedVersion } }` proposes changing one declared scalar field on one governed
document. The whole message is at most 8 KiB; `field` at most 128 bytes; `value` a string of at
most 4 KiB, a finite number or a boolean. Only the OSS web shell and the OSS MCP app, with a
`bundle-propose` View and an actor, perform it: the shell re-reads the registry, exact entry
version, target document and Kind, shows canonical before and after values outside the frame, and
commits only after the human chooses Apply. The reply is `{ bridge: "v1", requestId, type: "action.result", result: { status,
... } }` with `status` one of `prepared`, `committed`, `unchanged`, `cancelled`, `conflict`,
`revoked`, `expired`, `rejected` or `failed`. A host that performs no writes, and the bridge
service itself when a proposal reaches it, answers `{ bridge: "v1", id: requestId, type: "error",
error: { code: "FORBIDDEN" } }`.

Write shapes are not yet converged across hosts (OSS proposes scalar fields, hosted proposes body
replacement, Portal proposes nothing). Until a human decision picks one, a View that must run
everywhere treats writes as optional and feature-detects `grant`.

## Capability registry

Names a host may list in `hello.host.capabilities`. `BRIDGE_HOST_CAPABILITIES` in
`@superbee/view-runtime` exports the same names.

| name | means | input and output |
| --- | --- | --- |
| `query.kind-projection` | `query`, `read` and `read-versioned` rows carry logical Kind fields beside raw coordinates | none (a query feature) |
| `query.field-or` | `field` honors comma-separated OR values | none |
| `query.open` | `open: true` drops Kind-declared terminal rows | none |
| `query.count` | `count` is the total matched before the cap | none |
| `edges` | the `edges` request is answered | none |
| `render-document` | the `render-document` request is answered | none |
| `open-page` | `open-page` navigates the shell | none |
| `subscribe-deltas` | `change` events carry real deltas | none |
| `graph` | the `graph` request is answered, bounded by `limits.graphDocuments` and `limits.graphRelationships` | none (a request); declared by every OSS host |
| `graph.model` | `graph` also returns `model` and `definitions` | reserved; no OSS host declares it until the model shape has an owner |
| `record.open` | the host opens its own reader for one document | `host` input `{ documentId }`; output `{ opened: true }`; `NOT_FOUND` for a missing document |
| `frame.resize` | the host sizes the View's frame to the reported document height, bounded by `host.frame.maxHeight` | `host` input `{ height }` (a finite CSS pixel count, at least 0); output `{ height }` as applied after the host's floor, ceiling and damping; `USAGE` for any other input. Answered at once; touches no bundle data and runs no operation, so a host lists it for a View with no operations too. Declared only with `host.frame` |

A host without a query capability still answers `query`; it just honors less. A host without
`edges`, `graph` or `render-document` answers those requests with `FORBIDDEN`.

## Conformance levels

A host states which query features it honors by listing the four `query.*` capabilities, and its
default and maximum limit through `limits.query`. OSS declares all four with a maximum of 500 rows
and `0` or absence meaning 500. A host may declare a subset; the conformance fixture View reports
what it observed so the declaration can be checked against behavior.

| feature | OSS web | OSS MCP | publication (Portal) | hosted (declared in its own repository) |
| --- | --- | --- | --- | --- |
| `query.kind-projection` | yes | yes | yes | its `hello` says |
| `query.field-or` | yes | yes | yes | its `hello` says |
| `query.open` | yes | yes | yes | its `hello` says |
| `query.count` | yes | yes | yes | its `hello` says |
| `limits.query` | 500 | 500 | 500 | its `hello` says |
| `edges` | yes | yes | yes | its `hello` says |
| `graph` | yes, without `model` | yes, without `model` | yes, through the shared service | its `hello` says |
| `graph.model` | no | no | no | its `hello` says |
| `render-document` | yes | yes | yes, pre-rendered from the snapshot | its `hello` says |
| `open-page` | yes | yes, consumes the source launch | yes when the embedding client navigates | its `hello` says |
| `subscribe-deltas` | yes | yes | no; `subscribe` is acknowledged, nothing is pushed | its `hello` says |
| `grant: "propose"` | with `bundle-propose` and an actor | with `bundle-propose` and an actor | no | no |

## Errors

Every error reply is `{ bridge, id, type: "error", error: { code, message } }`. `message` is
human-readable and never carries storage diagnostics or paths. What each code means to a View
author, host by host:

| code | meaning | OSS web and MCP | publication (Portal) | hosted |
| --- | --- | --- | --- | --- |
| `USAGE` | the request is malformed: wrong keys, bounds or value shapes | before any bundle work; `id` echoed only when it was a bounded string | same | `invalid_input` from the parent |
| `FORBIDDEN` | not offered here: no grant, an unknown launch, a write on a read-only host, a request type or capability the host does not offer | `access: none` data requests; unknown or expired launch; unsupported types | every write; unsupported types; undeclared extensions | `unsupported_operation`; anything outside the slot allowlist |
| `REVOKED` | the View changed while the request ran; reload | entry bytes or registration changed mid-request | never (immutable snapshot) | `denied` from the parent (grant lost, binding changed) |
| `TOO_LARGE` | the answer exceeded a declared limit; narrow the request | reply above `limits.replyBytes`, body above 1 MiB, edges above `limits.edges`, a graph above `limits.graphDocuments` or `limits.graphRelationships` | same | size errors from the parent |
| `RUNTIME` | the host failed; retry later or show "unavailable" | storage or renderer failure | same | `unavailable` from the parent |
| `NOT_FOUND` | the named document or View target does not exist | `render-document`, `open-page` | same | `document_not_found`; `record.open` on a missing document |

Legacy note: the MCP frame answers an `UNSUPPORTED` error locally when its host tool call fails; a
View treats any unlisted code like `RUNTIME`.

## Trust model

Approving a View means approving its exact bytes and declared `access`; changed bytes or expanded
access ask again. The View never receives a credential, session token or data endpoint. The OSS
web shell serves entry bytes at `/__page/<nonce>` for a short-lived nonce and forwards every bridge
request to `POST /__ui/views/bridge` with an opaque launch id; the launch is re-resolved before and
after each request, and a change between the two answers `REVOKED`. Hosts with their own approval
model (slot pins, artifact digests) enforce the same rule at their seam. A transport receipt the
shell may collect after frame load proves delivery, not authorization.

Startup messages are optional: a View may stay quiet until human input and never has to send
`hello` to prove it loaded.

## Limits

| limit | OSS value | declared in |
| --- | --- | --- |
| request `id` | 128 bytes | fixed |
| `docId` | 1024 bytes | fixed |
| `query` rows | 500 | `limits.query` |
| `edges` rows | 1000 | `limits.edges` |
| `graph` documents | 1000 | `limits.graphDocuments` |
| `graph` relationships | 10000 | `limits.graphRelationships` |
| document body | 1 MiB | fixed |
| any reply | 2 MiB | `limits.replyBytes` |
| `host` request | 64 KiB | fixed |
| `action.propose` message | 8 KiB | fixed |
| `change` delta | 100 rows, 256 KiB | fixed |
| subscription snapshot | 10000 heads | fixed |

## Reference client

The canonical copy. The bundle-installed authoring reference and the conformance fixture embed it
byte-for-byte; `packages/view-runtime/test/conformance.test.mjs` pins that agreement, and
`packages/cli/test/page-watch-helper.test.ts` pins the `watch` implementation across the shipped
example Views.

```js
(function () {
  var PROTO = "v0", ACTION_PROTO = "v1", seq = 0, pending = {}, subs = [];
  function send(type, extra, proto) {
    return new Promise(function (resolve, reject) {
      var id = String(++seq);
      pending[id] = { resolve: resolve, reject: reject };
      var msg = { bridge: proto || PROTO, id: id, type: type };
      if (extra) for (var k in extra) msg[k] = extra[k];
      parent.postMessage(msg, "*"); // parent origin is opaque to us; the shell validates by source
    });
  }
  // A shell action, deliberately separate from send(): the source frame may unload immediately,
  // so openPage is void/fire-and-forget and must not be awaited.
  function openPage(pageId) {
    parent.postMessage({ bridge: PROTO, type: "open-page", pageId: pageId }, "*");
  }
  function watch(refresh) {
    if (typeof refresh !== "function") return Promise.reject(new TypeError("Bridge.watch requires a refresh function"));
    var active = true, ready = false, running = false, queued = [];
    function schedule(initial) {
      running = true;
      var batch = queued.splice(0);
      return Promise.resolve().then(function () { return refresh(batch); }).then(function (value) {
        running = false;
        if (queued.length) void schedule(false);
        return value;
      }, function (err) {
        running = false;
        if (queued.length) void schedule(false);
        if (initial) throw err;
        console.error("Bridge.watch refresh failed", err);
      });
    }
    function onChange(event) {
      if (!active) return;
      queued.push(event);
      if (ready && !running) void schedule(false);
    }
    return window.Bridge.subscribe(onChange).then(function () {
      ready = true;
      return schedule(true);
    }, function (err) {
      active = false;
      throw err;
    });
  }
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return; // only trust the shell
    var m = e.data;
    if (!m || (m.bridge !== PROTO && m.bridge !== ACTION_PROTO)) return;
    if (m.type === "change") { subs.forEach(function (cb) { cb(m.event); }); return; }
    var p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    if (m.type === "error") {
      var err = new Error((m.error && m.error.message) || "bridge error");
      err.code = m.error && m.error.code; // one of USAGE, FORBIDDEN, REVOKED, TOO_LARGE, RUNTIME, NOT_FOUND
      p.reject(err);
    } else p.resolve(m.result);
  });
  window.Bridge = {
    hello: function () { return send("hello"); },
    query: function (params) { return send("query", { params: params }); },
    read: function (docId) { return send("read", { docId: docId }); },
    readVersioned: function (docId) { return send("read-versioned", { docId: docId }, ACTION_PROTO); },
    renderDocument: function (docId) { return send("render-document", { docId: docId }); },
    edges: function (params) { return send("edges", { params: params }); },
    graph: function (includeBodies) { return send("graph", includeBodies === undefined ? undefined : { includeBodies: includeBodies === true }); },
    host: function (capability, input) {
      return send("host", input === undefined ? { capability: capability } : { capability: capability, input: input });
    },
    openPage: openPage,
    subscribe: function (cb) { subs.push(cb); return send("subscribe"); },
    watch: watch
  };
})();
```

For live data prefer `Bridge.watch(refresh)` over assembling the startup sequence yourself. It
subscribes before the first snapshot, passes an ordered batch of raw `change` payloads to each
refresh, never overlaps refresh calls, coalesces events arriving during a refresh into one
follow-up batch, and does not retry on a timer. Its returned Promise covers subscription plus the
first refresh, so handle it to surface startup failures.

## Conformance fixture

`examples/views/conformance/` holds a registry document (`views-registry/conformance`) and one
self-contained entry (`views/conformance.html`) that embeds the client above and sends, in order,
`hello`, `query`, `read`, `read-versioned`, `edges`, `graph`, `render-document`, `subscribe`,
`host` (an undeclared capability, expecting `FORBIDDEN`), `action.propose`, `burst` (12 `read`
requests in flight at once) and `open-page` (a registry id that must not exist). A host may cap
in-flight requests, but it must queue or refuse the excess with an error reply, never drop it, so
the `burst` row expects all 12 results. It renders one table row per request with the request
name, a status (`answered`, `refused`, `sent`, `skipped` or `failed`) and a one-line summary, and
exposes the same rows on `window.__conformance` for harnesses. The View names its revision in
`<meta name="superbee-conformance-revision">`; a host that byte-copies it records that value with
its result. `packages/view-runtime/test/conformance.test.mjs` runs the entry against the OSS
service over a fixture bundle and asserts every row.

## Versioning

`bridge: "v0"` and `"v1"` name wire envelopes, not a semantic version. Additions in this document
are compatible with every existing v0 View: new reply fields (`host`), new request types (`graph`,
`host`) and new error semantics for requests that were never valid before. A change that alters an
existing reply or request shape needs a new envelope value and a change here first.
