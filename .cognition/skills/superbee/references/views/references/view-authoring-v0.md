---
type: Reference
title: Bundle View authoring
protocol: v0+v1
timestamp: "2026-09-15T00:00:00.000Z"
---

# Bundle View authoring

Author **one durable View** for every host: a self-contained, responsive HTML blob under `views/...`
plus a `type: View` registry doc under `views-registry/...`. The local web shell, the MCP host, a
published Portal artifact and the hosted workspace all launch the same registry id, exact HTML
bytes, access declaration and bridge contract. The host chooses the available size and may offer
expansion; do not create separate inline, expanded, web or MCP implementations.

The protocol a View speaks is owned by one document in the Superbee repository:
`docs/VIEW-PROTOCOL.md` (https://github.com/Holaxis-ai/superbee/blob/main/docs/VIEW-PROTOCOL.md).
It holds the exact message shapes, the `field` filter grammar, what `open` means, the host
descriptor and capability registry, conformance levels, limits and the error table. This reference
is the short bundle-installed companion: enough to build a View from a bundle, with a copy of the
reference client. When the two disagree, the protocol document wins. It travels with portable
View-bearing recipes, so authoring does not depend on an agent-harness skill.

Legacy `Page` and `bridge` are retired authoring names. Use `type: View` and `access`; `superbee status`
reports legacy content that needs migration. Legacy wire names such as `open-page` remain stable.

## Trust model

The View runs in an opaque-origin, script-only sandbox with `connect-src 'none'`. It never receives
a credential, session token or data endpoint; its only channel to bundle data is `postMessage` to
the shell, which validates every request before touching bundle data. Approving a View means
approving its exact bytes and declared access; changed bytes or expanded access ask again. Approve
only a View whose source or author you trust. A View that declares `bundle-propose` may ask the
trusted shell to prepare one v1 scalar-field action; only the human's shell-native Apply choice
authorizes the write.

## The requests

Every request carries `bridge: "v0"` (or `"v1"` for `read-versioned` and `action.propose`), an
`id`, and a `type`; the reply echoes the id as `"<type>:result"` or `"error"` with a code. The
client below wraps all of them.

| request | ask | answer |
| --- | --- | --- |
| `hello` | who is hosting me | `{ bundle: { root, name }, mode, protocol, grant, host: { kind, capabilities, limits } }` |
| `query` | `{ type?, prefix?, field?, open?, limit? }` | `{ rows: [{ id, version, frontmatter }], count }` |
| `read` | `docId` | `{ id, frontmatter, body }` |
| `read-versioned` | `docId` | `{ doc, version }` |
| `render-document` | `docId` | `{ document: { id, version }, html, bounded }` |
| `edges` | `{ from?, to?, text? }` | `{ edges: [{ from, to, text }], count }` |
| `subscribe` | none | `{ ok: true }`, then `change` events |
| `host` | `capability, input?` | `{ capability, output }` or `FORBIDDEN` |
| `open-page` | `views-registry/...` id | none; fire-and-forget shell navigation |

`hello.result.grant` is `"read"` for `bundle-read` and `"propose"` for `bundle-propose`. Read
`hello.result.host.capabilities` to learn what this host honors (for example `query.field-or`,
`query.open`, `edges`, `subscribe-deltas`) instead of assuming; every host refuses what it does
not offer with a `FORBIDDEN` error, never silently.

Use `render-document` for canonical Markdown presentation: the returned `html` is inert markup
whose internal links carry `data-aslite-doc-id`. Style it inside the View and insert it unmodified;
do not ship another Markdown parser.

`change` events are a signal to re-query, never full state. `Bridge.watch(refresh)` subscribes
before the first snapshot, batches events, never overlaps refreshes, and works the same on a host
that pushes real deltas and on one that only nudges.

## `access`

The registry doc's `access` field decides whether the shell answers this View's bridge requests at
all, and the shell, not the View, enforces it:

- `access: bundle-read`: a **data view**. The read requests above are answered.
- `access: bundle-propose`: an **interactive view**. The same reads plus the narrow v1 proposal,
  each proposal confirmed in trusted shell chrome. Start the shell with `superbee ui --actor <name>`
  (or set `SUPERBEE_ACTOR`; `AGENTSTATE_LITE_ACTOR` remains a supported compatibility input) to
  enable proposals.
- `access: none`: a **content view**. Every bundle-data request answers `FORBIDDEN` before any
  bundle data is touched. It may still use `open-page` navigation.
- `bridge` is the legacy spelling of this field and is no longer read: a doc declaring only the
  legacy `bridge` field resolves to `access: none`. The repo's `migrate-legacy-view-names` script
  renames leftover legacy `bridge` fields to `access` in place, and `superbee status` lists them
  under its `legacy_naming` finding.
- The `View` convention declares `access` REQUIRED. At runtime the shell still fails closed for a
  doc the convention did not govern: absent, malformed or any other value is treated as
  `access: none`.

The launcher groups Views by this field: "Dashboards" for `bundle-read`, "Interactive" for
`bundle-propose`, and "Documents" for `none`.

## Authoring a view

Start from a working installed View when possible, then adapt it responsively for the space the
host provides. Keep data selection bounded and show empty, partial, over-limit and unavailable
states.

```sh
superbee blobs --prefix views/
superbee pull --doc-key views/review-workflow/reviews.html --out my-view.html
```

Keep HTML, CSS and JavaScript self-contained with no external hosts. A data View embeds the bridge
client below. A content View (`access: none`) may use only `openPage`; bundle-data calls return
`FORBIDDEN`.

Install the HTML blob and its registry entry:

```sh
superbee promote my-view.html --doc-key views/my-view.html
superbee new "View" my-view \
  --title "My view" \
  --entry views/my-view.html \
  --access bundle-read \
  --description "A live view of this bundle."
superbee ui --open
```

`new "View" my-view` applies the View Kind's declared `views-registry/` path. Use `access: none`
for a static report or diagram. Re-promoting the HTML updates the open View; the shell reloads it
with a fresh nonce. If the bundle does not yet declare the View Kind, install its View-bearing
recipe or promote the supplied `conventions/view.md` once before creating the registry entry.

Verify the same registered id in both surfaces: open it with `superbee ui`, then have an MCP-capable
desktop list and show that View. Confirm narrow and expanded layouts without changing the source.
Startup messages are optional: a View may stay quiet until human input and never has to send
`hello` to prove it loaded.

## The bridge client (embedded copy)

A byte-for-byte copy of the reference client in `docs/VIEW-PROTOCOL.md`.

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
    host: function (capability, input) {
      return send("host", input === undefined ? { capability: capability } : { capability: capability, input: input });
    },
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

A live view supplies only its domain snapshot and render work:

```js
Bridge.watch(async function (events) {
  var result = await Bridge.query({ type: "Task" });
  render(result.rows, events);
}).catch(showStartupError);
```

The seed views shipped beside this reference are working examples: `pulse.html` and `roadmap.html`
are `access: bundle-read` data views (`roadmap.html` exercises `edges` end to end), `about.html` is
an `access: none` content view, and `conformance/` is the fixture that exercises every request type
and reports one row per type.
