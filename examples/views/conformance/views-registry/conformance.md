---
type: View
title: View protocol conformance
entry: views/conformance.html
description: Exercises every View bridge request type against the host and reports one row per type.
access: bundle-read
actor: mike/claude
timestamp: "2026-09-15T00:00:00.000Z"
---
The conformance fixture for `docs/VIEW-PROTOCOL.md`. It sends `hello`, `query`, `query-newest`
(a `query` with `order: "newest"`, skipped unless the host declares `query.newest`), `read`,
`read-versioned`, `edges`, `graph` (heads only; a host that does not declare `graph` is expected to
refuse it), `render-document`, `subscribe`, `host` (an undeclared capability, so a `FORBIDDEN`
reply is the expected outcome), `action.propose`, `burst` (12 `read` requests in flight at once,
expecting 12 results), then `relationships`, `query-over-limit`, `query-field-or`, `query-open`,
`query-more`, `read-missing` and `read-versioned-missing`, each judged against the capabilities the
host declared in `hello` (a declared feature must be answered correctly, an undeclared one
refused), then the `edges-*` rows (exact ids, prefixes, lists of up to 32 ids, exact text, every
occurrence, self-links, links to missing documents and links in code, code point order, `USAGE`
for a malformed selector, `TOO_LARGE` above `limits.edges`), and last `open-page` (a registry id
that must not exist). Those rows need a small bundle: two to `limits.query` documents of at least
two types, a Kind with a terminal set plus one terminal document, and the expected table's
`edgeDocuments`; the table's `bundle` field lists it. It renders a table with the request name, a status
and a one-line summary for each. The entry names its revision in
`<meta name="superbee-conformance-revision">`; a host that byte-copies it into its own harness
records that value beside its result and asserts each row against
`packages/view-runtime/test/fixtures/view-conformance-expected.json` from the same commit.

Register it under exactly this id (`views-registry/conformance`) so every host runs the same bytes
with the same registration. It declares `access: bundle-read`, so a proposal is always refused and
the fixture reports the refusal rather than asking a human to apply anything.
