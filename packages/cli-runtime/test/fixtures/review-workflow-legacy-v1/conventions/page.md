---
type: Convention
title: Page
governs: Page
path: pages-registry/
fields:
  required:
    - title
    - entry
    - bridge
  optional:
    - description
  values:
    bridge:
      - none
      - bundle-read
  terminal: {}
timestamp: "2026-07-10T00:00:00.000Z"
---
# Page

A bundle-hosted UI page. A `type: Page` doc is a **registry entry**: it names a self-contained
HTML blob (`entry`, a bundle-relative blob key under `pages/…`) that the `agentstate-lite ui`
launcher renders in a sandboxed, opaque-origin iframe. The page reaches bundle data only through
the read-only postMessage bridge documented in the bundle's
[Page authoring reference](../references/page-authoring-v0.md) — it never holds a credential.

- `title` (required) — the launcher card's heading.
- `entry` (required) — the HTML blob key, e.g. `pages/roadmap.html`.
- `description` (optional) — one line shown on the launcher card.
- `bridge` (required) — `none | bundle-read`. Required so every Page is an INTENTIONAL
  classification, not a silent default — an author who forgets to declare it gets a clear
  authoring-time lint, not a page that quietly renders empty against a full bundle. ENFORCED by
  the shell too, not just linted: absent, malformed, or any value other than exactly
  `bundle-read` is treated as `none` at runtime — fail-closed defense for a doc this convention
  didn't govern (an external bundle, a hand-edited file that skipped the lint).
  - `bundle-read` — a **data page**: the shell answers its bridge requests (`hello`/`query`/
    `read`/`edges`/`subscribe`) with live bundle data. Groups under the launcher's "Dashboards".
  - `none` — a **content page**: the shell DENIES every bundle-data request. Arbitrary
    self-contained HTML with zero bundle-data access — a report, a rendered design doc, a diagram.
    It may still ask the shell to open another registered Page. Groups under "Documents".

Both capabilities may use `open-page` to navigate to another valid `pages-registry/…` Page. This
shell action returns no target content or metadata and grants no bundle-data capability.

Pages sync, version, and attribute like any doc; the HTML bytes travel as an opaque blob via
`promote`/`pull`, never through the model context window.
