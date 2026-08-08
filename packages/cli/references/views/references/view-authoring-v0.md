---
type: Reference
title: Bundle View authoring — shared web and MCP contract
protocol: v0+v1
timestamp: "2026-07-22T00:00:00.000Z"
---

# Bundle View authoring — shared web and MCP contract

Author **one durable View** for both local web and MCP hosts: a self-contained, responsive HTML
blob under `views/…` plus a `type: View` registry doc under `views-registry/…`. Both hosts launch
the same registry id, exact HTML bytes, access declaration, and bridge contract. The host chooses
the available size and may offer expansion; do not create separate inline, expanded, web, or MCP
implementations.

Use the bridge for bundle data and `render-document` for canonical Markdown presentation. Style
the returned inert fragment inside the View; do not ship another Markdown parser. The sections
below are the exact protocol contract and copy-paste client. This contract travels with portable
View-bearing recipes, so authoring does not depend on an agent-harness skill.

Legacy `Page` and `bridge` are retired authoring names. Use `type: View` and `access`; `aslite status`
reports legacy content that needs migration. Legacy wire names such as `open-page` remain stable.

## Trust model (exact-byte approval + no credential)

The `ui` server serves two privilege tiers on one loopback origin:

- **Data API** (`/v0/*`): reachable ONLY with the shell's per-run session token/cookie.
- **View bytes** (`/__page/<nonce>`): a view's static HTML, served for a short-lived **nonce**
  the session-authed shell mints (`POST /__page/mint`) for that view's one blob key. The nonce
  is not the session token, so it is rejected by every data route; the session token does not
  open the page route to arbitrary keys.

The iframe is `sandbox="allow-scripts"` with **no** `allow-same-origin`, so the view runs at an
**opaque origin**. A strict per-view CSP (`connect-src 'none'`) blocks ordinary direct network APIs
such as fetch, XHR, WebSocket, and EventSource, while the View never receives the shell's credential
or a data endpoint. Those controls are defense-in-depth: a data-bearing View is executable code,
and approving its exact bytes and declared access is the decision to trust that code. Approve only
a View whose source or author you trust; changed bytes or expanded access ask again. The supported
bundle-data channel is `postMessage` to the shell, whose stable v0 bridge is read-only. A View that
declares `bundle-propose` may additionally ask trusted shell chrome to prepare one v1 scalar-field
action; only the human's shell-native Apply choice authorizes the CAS write.

## Message shapes

Every message carries `bridge: "v0"`. A request carries an `id`; the reply echoes it as
`"<type>:result"` (or `"error"`). The shell drops any message whose `event.source` is not the
view's own iframe; the view drops any message whose `event.source` is not `window.parent`.

### View → shell (requests)

| type        | payload                                                    | reply `result`                                             |
| ----------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `hello`     | —                                                          | `{ bundle: { root, name }, mode, protocol: "v0", grant }` |
| `query`     | `{ params: { type?, prefix?, field?, open?, limit? } }`    | `{ rows: DocHead[], count }`                               |
| `read`      | `{ docId }`                                                | `{ id, frontmatter, body }`                                |
| `render-document` | `{ docId }`                                         | `{ document: { id, version }, html, bounded }`              |
| `edges`     | `{ params: { from?, to?, text? } }`                        | `{ edges: { from, to, text }[], count }`                   |
| `subscribe` | —                                                          | `{ ok: true }`, then a stream of `change` events          |
| `open-page` | `{ pageId: "views-registry/…" }`                           | none; fire-and-forget shell navigation                    |

`hello.result.grant` is `"read"` for `bundle-read` and `"propose"` for `bundle-propose`.

`open-page` is the sole capability-independent action: `access: none`, `access: bundle-read`, and
`access: bundle-propose` Views may ask the shell to open another usable registered View. The shell
accepts only a conservative `views-registry/…` (or legacy-location `pages-registry/…`) concept
id, validates that it resolves to a `type: View` doc with a safe `views/…`
(or legacy-location `pages/…`) entry, and mounts the target normally with its own sandbox, nonce, and
bridge capability. It returns no target body, frontmatter, entry, HTML, or nonce. A failed
attempt can reveal that one caller-supplied registry id is not usable; this bounded existence
oracle is the only information exposed by navigation.

`DocHead` is `{ id, version, frontmatter }` — the same **head projection** `list` uses (full
frontmatter, never a body). `query` params:

`render-document` reads the canonical document and serializes its body with the shell's shared,
bounded Markdown renderer. The returned `html` is inert semantic markup: it contains no scripts,
event handlers, forms, controls, images, or navigable anchors. Internal concept links become
passive elements carrying `data-aslite-doc-id`; the View may delegate clicks on those markers to
its own selection logic and issue another `render-document` request. Insert only the unmodified
`html` returned by this request. The accompanying document `version` is the exact version rendered;
after a matching `change` event, refetch instead of treating old HTML as current. `bounded: true`
means renderer safety limits truncated or collapsed part of the input.

- `type` / `prefix` — server-side facets (a bundle-relative id prefix, a frontmatter `type`).
- `field` — a client-side `key=value` filter; comma-separated values are OR (`status=todo,blocked`).
  Scalar and array-valued fields use the same string-coerced membership rule as CLI `list`.
- `open` — drop terminal rows, derived from the BUNDLE'S OWN kind conventions exactly like
  `list --open`: a row is dropped iff the convention governing its `type` declares the row's
  current field value(s) terminal (`fields.terminal`, e.g. the Task kind's `done`/`canceled`).
  A row with no governing kind is kept; a bundle where no kind declares a terminal set filters
  nothing. (The shell loads the registry once per change from the server, which builds it with
  core's `loadKinds` — one registry, no bridge-side schema.)
- `limit` — a positive number caps `rows`; `0` or absence is unlimited. `count` remains the total
  matched after `field`/`open` filtering and before the cap, matching CLI `list`.

`edges` is the general graph query — the ONE primitive every edge-shaped question reduces to
(the same `queryEdges` atom `link list` is a CLI face over). `params`:

- `from` / `to` — each one exact nonblank concept id, a bundle-relative `prefix/` (trailing
  slash), or an array of 1–32 such strings (union within the facet; giving both ANDs them). Omit
  the property for "no restriction". Supplied empty/all-whitespace strings, empty arrays,
  blank/non-string array entries, and arrays above 32 are invalid. Every string is preserved
  byte-for-byte and may be at most 1,024 UTF-8 bytes; duplicate entries still count toward 32.
- `text` — one exact nonblank link-display string (never substring/regex), preserved byte-for-byte
  and at most 1,024 UTF-8 bytes; an empty/all-whitespace value is invalid.

Backlinks are `edges({ to: docId })`; a container's contents are `edges({ from: itemId, text:
"contains" })` (or whatever link text a bundle's convention uses) — there is no separate
backlinks-only bridge call. A source linking to the same target twice with different text yields
two rows (no dedup), matching `queryEdges`'s own granularity.

### Shell → view (server-initiated)

| type     | payload                                              |
| -------- | --------------------------------------------------- |
| `change` | `{ event: { changes: [{ id, version }], removed: [id] } }` |

`change` is pushed only to a view that has `subscribe`d. It is a **delta signal** — refetch with
`query` against it rather than trusting it as a full state. Removed ids have been deleted.

For live data views, prefer `Bridge.watch(refresh)` over assembling the startup sequence yourself.
It subscribes before the first snapshot, passes an ordered batch of raw `change` event payloads to
each refresh, and never overlaps refresh calls. Events arriving during a refresh are coalesced into
one follow-up batch. A failed refresh does not poison later event-driven refreshes; `watch` does not
retry on a timer. Its returned Promise covers subscription plus the first refresh, so handle that
Promise to surface startup failures. Raw `subscribe` remains available when a view needs the
lower-level event stream.

**There are no mutation messages in v0.** Read-only is enforced *by construction*: the shell
defines no write/delete/update handler, so any such request returns an `error` reply.

### Trusted action bridge v1

`access: bundle-propose` includes the v0 read surface and adds two exact v1 requests:

- `{ bridge: "v1", type: "read-versioned", id, docId }` returns one canonical document and the
  version from the same read.
- `{ bridge: "v1", type: "action.propose", requestId, action: { kind:
  "document.set-field", docId, field, value, expectedVersion } }` proposes changing one declared
  scalar field on an existing governed document.

The shell independently re-reads the View registry, exact HTML version, target document, and Kind;
shows canonical before/after values outside the iframe; and commits only after the human chooses
Apply. The approval token and immutable launch identity never enter the iframe. A stale target is a
visible conflict and is never retried behind the human's back. V1 is local `--dir` only and excludes
body writes, links, creation, deletion, remote writes, and persistent grants. Start the shell with
`aslite ui --actor <name>` (or set `AGENTSTATE_LITE_ACTOR`) to enable proposals.

## Live updates

The shell (only) holds one `EventSource('/events')`. The server watches the bundle — `fs.watch`
in `--dir` mode, a poll in `--remote` mode — diffs content-addressed **version tokens**, and pushes
a change delta. The shell fans doc changes into subscribed views as `change` events, and
**hot-reloads** a view's iframe (with a fresh nonce) when the view's own HTML blob changes. (Remote
view-blob hot-reload is a labeled follow-up; live doc updates work in both modes.)

## `access` — the enforced data/content split

The registry doc's `access` field decides whether the shell will answer THIS view's bridge
requests at all — and the shell, not the view, is what enforces it:

- `access: bundle-read` — a **data view**. The shell answers `hello`/`query`/`read`/
  `render-document`/`edges`/`subscribe` as described above.
- `access: bundle-propose` — an **interactive view**. It receives the same read surface and may
  submit the narrow v1 proposal above. Each proposal still requires trusted-shell confirmation.
- `access: none` — a **content view**. The shell replies to every bundle-data request with a
  `FORBIDDEN` error, before touching any bundle data. It may still use `open-page` navigation.
- `bridge` is the legacy spelling of this field, and it is no longer read: a doc declaring only
  the legacy `bridge` field resolves to `access: none` (every bundle-data request is denied).
  The repo's `migrate-legacy-view-names` script renames leftover legacy `bridge` fields to
  `access` in place, and `aslite status` lists them under its `legacy_naming` finding.
  Authoring uses `access`.
- The `View` convention declares `access` REQUIRED — every view is an intentional
  classification, not a silent default. At runtime the shell still fails closed for a doc this
  convention didn't govern (an external bundle, a hand-edited file that skipped the lint): absent,
  malformed, or any other value is treated as `access: none`. A view only gets bundle access by
  declaring exactly `bundle-read` or `bundle-propose`.

The launcher groups views by this same field: "Dashboards" for `bundle-read`, "Interactive" for
`bundle-propose`, and "Documents" for `none`.

## Authoring a view

Start from a working installed View when possible, then adapt it responsively for the space the
host provides. Keep data selection bounded and show empty, partial, over-limit, and unavailable
states.

```sh
aslite blobs --prefix views/
aslite pull --doc-key views/review-workflow/reviews.html --out my-view.html
```

Keep HTML, CSS, and JavaScript self-contained with no external hosts. A data View embeds the bridge
client below. A content View (`access: none`) may use only `openPage`; bundle-data calls return
`FORBIDDEN`.

Install the HTML blob and its registry entry:

```sh
aslite promote my-view.html --doc-key views/my-view.html
aslite new "View" my-view \
  --title "My view" \
  --entry views/my-view.html \
  --access bundle-read \
  --description "A live view of this bundle."
aslite ui --open
```

`new "View" my-view` applies the View Kind's declared `views-registry/` path. Use `access: none`
for a static report or diagram. Re-promoting the HTML updates the open View; the shell reloads it
with a fresh nonce. If the bundle does not yet declare the View Kind, install its View-bearing
recipe or promote the supplied `conventions/view.md` once before creating the registry entry.

Verify the same registered id in both surfaces: open it with `aslite ui`, then have an MCP-capable
desktop list and show that View. Confirm narrow and expanded layouts without changing the source.

The seed views here are working examples: `pulse.html`/`roadmap.html` are `access: bundle-read`
data views — `roadmap.html` is the one that exercises the `edges` request end-to-end (a live graph
view of Roadmap Items and the tasks each one `contains`) — and `about.html` is an `access: none`
content view (no bridge calls at all). `demo.sh` (repo only) wires all of this over a scratch copy
of this repo's own board.

## The bridge client (embedded copy)

```js
(function () {
  var PROTO = "v0", seq = 0, pending = {}, subs = [];
  function send(type, extra) {
    return new Promise(function (resolve, reject) {
      var id = String(++seq);
      pending[id] = { resolve: resolve, reject: reject };
      var msg = { bridge: PROTO, id: id, type: type };
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
    if (!m || m.bridge !== PROTO) return;
    if (m.type === "change") { subs.forEach(function (cb) { cb(m.event); }); return; }
    var p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    if (m.type === "error") p.reject(new Error((m.error && m.error.message) || "bridge error"));
    else p.resolve(m.result);
  });
  window.Bridge = {
    hello: function () { return send("hello"); },
    query: function (params) { return send("query", { params: params }); },
    read: function (docId) { return send("read", { docId: docId }); },
    renderDocument: function (docId) { return send("render-document", { docId: docId }); },
    edges: function (params) { return send("edges", { params: params }); },
    openPage: openPage,
    subscribe: function (cb) { subs.push(cb); return send("subscribe"); },
    watch: watch
  };
})();
```

Compose and style the trusted fragment inside the View; do not rewrite or concatenate its HTML:

```js
async function showDocument(docId) {
  var rendered = await Bridge.renderDocument(docId);
  documentPanel.innerHTML = rendered.html;
}
documentPanel.addEventListener("click", function (event) {
  var target = event.target instanceof Element ? event.target.closest("[data-aslite-doc-id]") : null;
  if (target) void showDocument(target.getAttribute("data-aslite-doc-id"));
});
```

```css
.document-panel [data-aslite-rendered-document] { line-height: 1.6; }
.document-panel h1 { font: 600 1.5rem/1.2 system-ui; }
.document-panel [data-aslite-doc-id] { cursor: pointer; text-decoration: underline; }
```

A live view supplies only its domain snapshot and render work:

```js
Bridge.watch(async function (events) {
  var result = await Bridge.query({ type: "Task" });
  render(result.rows, events);
}).catch(showStartupError);
```
