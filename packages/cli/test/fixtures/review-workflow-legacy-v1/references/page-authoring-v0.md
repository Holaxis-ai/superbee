---
type: Reference
title: Bundle Page authoring — bridge v0
protocol: v0
timestamp: "2026-07-15T00:00:00.000Z"
---

# Bundle Page authoring — bridge v0

Use this reference when creating or revising a human-facing Page in this bundle. It travels with
Page-bearing portable recipes so Page work does not depend on an agent-harness skill. The installed
CLI remains the authority for the runtime implementation; this document describes the stable `v0`
contract the Page declares and consumes.

A **bundle Page** is a self-contained HTML file promoted into an agentstate-lite bundle as a blob
under `pages/…`, declared by a `type: Page` registry doc, and rendered by `agentstate-lite ui`
inside a **sandboxed iframe**. Pages are bundle content — authored, versioned, attributed, and
synced like any other doc — while the shell is the launcher and trusted data broker.

## Trust model (why a page can never touch a credential)

The `ui` server serves two privilege tiers on one loopback origin:

- **Data API** (`/v0/*`): reachable ONLY with the shell's per-run session token/cookie.
- **Page bytes** (`/__page/<nonce>`): a page's static HTML, served for a short-lived **nonce**
  the session-authed shell mints (`POST /__page/mint`) for that page's one blob key. The nonce
  is not the session token, so it is rejected by every data route; the session token does not
  open the page route to arbitrary keys.

The iframe is `sandbox="allow-scripts"` with **no** `allow-same-origin`, so the page runs at an
**opaque origin**. Combined with a strict per-page CSP (`connect-src 'none'`), the page **cannot
open any network request at all** — no fetch, XHR, WebSocket, or EventSource. Its only channel to
the outside is `postMessage` to the shell, which brokers a narrow, **read-only** request set on
its behalf. A leaked token would still be useless: there is no code path from the page to the API.

## Message shapes

Every message carries `bridge: "v0"`. A request carries an `id`; the reply echoes it as
`"<type>:result"` (or `"error"`). The shell drops any message whose `event.source` is not the
page's own iframe; the page drops any message whose `event.source` is not `window.parent`.

### Page → shell (requests)

| type        | payload                                                    | reply `result`                                             |
| ----------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `hello`     | —                                                          | `{ bundle: { root, name }, mode, protocol: "v0", grant: "read" }` |
| `query`     | `{ params: { type?, prefix?, field?, open?, limit? } }`    | `{ rows: DocHead[], count }`                               |
| `read`      | `{ docId }`                                                | `{ id, frontmatter, body }`                                |
| `edges`     | `{ params: { from?, to?, text? } }`                        | `{ edges: { from, to, text }[], count }`                   |
| `subscribe` | —                                                          | `{ ok: true }`, then a stream of `change` events          |
| `open-page` | `{ pageId: "pages-registry/…" }`                           | none; fire-and-forget shell navigation                    |

`open-page` is the sole capability-independent action: both `bridge: none` and
`bridge: bundle-read` Pages may ask the shell to open another usable registered Page. The shell
accepts only a conservative `pages-registry/…` concept id, validates that it resolves to a
`type: Page` with a safe `pages/…` entry, and mounts the target normally with its own sandbox,
nonce, and bridge capability. It returns no target body, frontmatter, entry, HTML, or nonce. A
failed attempt can reveal that one caller-supplied registry id is not usable; this bounded
existence oracle is the only information exposed by navigation.

`DocHead` is `{ id, version, frontmatter }` — the same **head projection** `list` uses (full
frontmatter, never a body). `query` params:

- `type` / `prefix` — server-side facets (a bundle-relative id prefix, a frontmatter `type`).
- `field` — a client-side `key=value` filter; comma-separated values are OR (`status=todo,blocked`).
- `open` — drop terminal rows, derived from the BUNDLE'S OWN kind conventions exactly like
  `list --open`: a row is dropped iff the convention governing its `type` declares the row's
  current field value(s) terminal (`fields.terminal`, e.g. the Task kind's `done`/`canceled`).
  A row with no governing kind is kept; a bundle where no kind declares a terminal set filters
  nothing. (The shell loads the registry once per change from the server, which builds it with
  core's `loadKinds` — one registry, no bridge-side schema.)
- `limit` — cap the row count after filtering.

`edges` is the general graph query — the ONE primitive every edge-shaped question reduces to
(the same `queryEdges` atom `link list` is a CLI face over). `params`:

- `from` / `to` — each an exact concept id, a bundle-relative `prefix/` (trailing slash), or an
  array of either (union within the facet; giving both ANDs them). Omit a facet for "no
  restriction" — an empty/blank value is treated as omitted, not "match nothing".
- `text` — exact-match on the link's display text (never substring/regex).

Backlinks are `edges({ to: docId })`; a container's contents are `edges({ from: itemId, text:
"contains" })` (or whatever link text a bundle's convention uses) — there is no separate
backlinks-only bridge call. A source linking to the same target twice with different text yields
two rows (no dedup), matching `queryEdges`'s own granularity.

### Shell → page (server-initiated)

| type     | payload                                              |
| -------- | --------------------------------------------------- |
| `change` | `{ event: { changes: [{ id, version }], removed: [id] } }` |

`change` is pushed only to a page that has `subscribe`d. It is a **delta signal** — refetch with
`query` against it rather than trusting it as a full state. Removed ids have been deleted.

For live data pages, prefer `Bridge.watch(refresh)` over assembling the startup sequence yourself.
It subscribes before the first snapshot, passes an ordered batch of raw `change` event payloads to
each refresh, and never overlaps refresh calls. Events arriving during a refresh are coalesced into
one follow-up batch. A failed refresh does not poison later event-driven refreshes; `watch` does not
retry on a timer. Its returned Promise covers subscription plus the first refresh, so handle that
Promise to surface startup failures. Raw `subscribe` remains available when a page needs the
lower-level event stream.

**There are no mutation messages in v0.** Read-only is enforced *by construction*: the shell
defines no write/delete/update handler, so any such request returns an `error` reply.

## Live updates

The shell (only) holds one `EventSource('/events')`. The server watches the bundle — `fs.watch`
in `--dir` mode, a poll in `--remote` mode — diffs content-addressed **version tokens**, and pushes
a change delta. The shell fans doc changes into subscribed pages as `change` events, and
**hot-reloads** a page's iframe (with a fresh nonce) when the page's own HTML blob changes. (Remote
page-blob hot-reload is a labeled follow-up; live doc updates work in both modes.)

## `bridge` — the enforced data/content split

The registry doc's `bridge` field decides whether the shell will answer THIS page's bridge
requests at all — and the shell, not the page, is what enforces it:

- `bridge: bundle-read` — a **data page**. The shell answers `hello`/`query`/`read`/`edges`/
  `subscribe` as described above.
- `bridge: none` — a **content page**. The shell replies to every bundle-data request with a
  `FORBIDDEN` error, before touching any bundle data. It may still use `open-page` navigation.
- The `Page` convention declares `bridge` REQUIRED — every page is an intentional
  classification, not a silent default. At runtime the shell still fails closed for a doc this
  convention didn't govern (an external bundle, a hand-edited file that skipped the lint): absent,
  malformed, or any other value is treated as `bridge: none`. A page only gets bundle access by
  declaring exactly `bundle-read`.

The launcher groups pages by this same field: "Dashboards" for `bundle-read`, "Documents" for
`none`.

## Authoring a page

Start from an installed Page when possible—the working HTML is both a template and executable
evidence of the bridge version it uses:

```sh
aslite blobs --prefix pages/
aslite pull --doc-key pages/review-workflow/reviews.html --out my-page.html
```

Adapt the HTML as a self-contained file with inline CSS and JavaScript and no external hosts. A
data Page embeds the bridge client below. A content Page (`bridge: none`) may use only its
fire-and-forget `openPage` helper; its bundle-data calls return `FORBIDDEN`.

Install the HTML blob and its registry entry:

```sh
aslite promote my-page.html --doc-key pages/my-page.html
aslite new "Page" my-page \
  --title "My page" \
  --entry pages/my-page.html \
  --bridge bundle-read \
  --description "A live view of this bundle."
aslite ui --open
```

`new "Page" my-page` applies the Page Kind's declared `pages-registry/` path. Use `bridge: none`
for a static report or diagram. Re-promoting the HTML updates the open Page; the shell reloads it
with a fresh nonce. If the bundle does not yet declare the Page Kind, install its Page-bearing
recipe or promote the supplied `conventions/page.md` once before creating the registry entry.

The seed pages here are working examples: `pulse.html`/`roadmap.html` are `bridge: bundle-read`
data pages — `roadmap.html` is the one that exercises the `edges` request end-to-end (a live graph
view of Roadmap Items and the tasks each one `contains`) — and `about.html` is a `bridge: none`
content page (no bridge calls at all). `demo.sh` (repo only) wires all of this over a scratch copy
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
    edges: function (params) { return send("edges", { params: params }); },
    openPage: openPage,
    subscribe: function (cb) { subs.push(cb); return send("subscribe"); },
    watch: watch
  };
})();
```

A live page supplies only its domain snapshot and render work:

```js
Bridge.watch(async function (events) {
  var result = await Bridge.query({ type: "Task" });
  render(result.rows, events);
}).catch(showStartupError);
```
