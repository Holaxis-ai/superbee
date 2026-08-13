---
type: Convention
title: View
governs: View
path: views-registry/
fields:
  required:
    - title
    - entry
    - access
  optional:
    - description
    - entry_version
    - presentation
  values:
    access:
      - none
      - bundle-read
      - bundle-propose
    presentation:
      - workspace
      - inline
      - adaptive
  terminal: {}
timestamp: "2026-07-24T00:00:00.000Z"
---
# View

A bundle-hosted UI view. A `type: View` doc is a **registry entry**: it names a self-contained
HTML blob (`entry`, a bundle-relative blob key under `views/…`) that the `superbee ui`
launcher renders in a sandboxed, opaque-origin iframe. The view reaches bundle data only through
the narrow postMessage bridge documented in the bundle's
[View authoring reference](../references/view-authoring-v0.md) — it never holds a credential.
V0 is read-only; `bundle-propose` adds only a trusted-shell-confirmed v1 scalar action.

`Page` is the legacy name for this kind, and `bridge` the legacy spelling of `access` — and
neither is read any longer: a legacy `type: Page` doc does not register, and a doc declaring
only the legacy `bridge` field resolves to `access: none`. Docs under the legacy
`pages-registry/`/`pages/` prefixes stay recognized where they are once typed `View`; the
repo's `migrate-legacy-view-names` script renames leftover legacy names in place
(`superbee status` lists them under `legacy_naming`). Author views as `type: View` with `access`.

- `title` (required) — the launcher card's heading.
- `entry` (required) — the HTML blob key, e.g. `views/roadmap.html`.
- `entry_version` (optional) — an exact content-version pin. When present, every host refuses to
  launch the View if the current entry bytes no longer match it. Ordinary mutable Views may omit it.
- `description` (optional) — one line shown on the launcher card.
- `presentation` (optional) — an advisory host-layout hint: `workspace | inline | adaptive`.
  It never controls whether a host may run the View and never grants authority. A host may ignore
  it when its available surface differs from the author's preference.
- `access` (required) — `none | bundle-read | bundle-propose`. Required so every View is an INTENTIONAL
  classification, not a silent default — an author who forgets to declare it gets a clear
  authoring-time lint, not a view that quietly renders empty against a full bundle. ENFORCED by
  the shell too, not just linted: absent, malformed, or any value other than exactly
  `bundle-read` or `bundle-propose` is treated as `none` at runtime — fail-closed defense for a doc this convention
  didn't govern (an external bundle, a hand-edited file that skipped the lint).
  - `bundle-read` — a **data view**: the shell answers its bridge requests (`hello`/`query`/
    `read`/`render-document`/`edges`/`subscribe`) with live bundle data. Groups under the launcher's "Dashboards".
  - `bundle-propose` — an **interactive view**: includes the read surface and may propose one
    declared scalar field update. Every proposal is independently validated and shown in trusted
    shell chrome; only the human's Apply action authorizes a hard-CAS local write.
  - `none` — a **content view**: the shell DENIES every bundle-data request. Arbitrary
    self-contained HTML with zero bundle-data access — a report, a rendered design doc, a diagram.
    It may still ask the shell to open another registered View. Groups under "Documents".

Both capabilities may use `open-page` (the bridge's wire verb, kept stable across the rename) to
navigate to another valid registered View. This shell action returns no target content or
metadata and grants no bundle-data capability.

Views sync, version, and attribute like any doc; the HTML bytes travel as an opaque blob via
`promote`/`pull`, never through the model context window.
