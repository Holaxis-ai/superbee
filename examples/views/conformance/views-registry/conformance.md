---
type: View
title: View protocol conformance
entry: views/conformance.html
description: Exercises every View bridge request type against the host and reports one row per type.
access: bundle-read
actor: mike/claude
timestamp: "2026-09-15T00:00:00.000Z"
---
The conformance fixture for `docs/VIEW-PROTOCOL.md`. It sends `hello`, `query`, `read`,
`read-versioned`, `edges`, `graph` (heads only; a host that does not declare `graph` is expected to
refuse it), `render-document`, `subscribe`, `host` (an undeclared capability, so a `FORBIDDEN`
reply is the expected outcome), `action.propose`, `burst` (12 `read` requests in flight at once,
expecting 12 results) and `open-page` (a registry id that must not exist), then renders a table
with the request name, a status and a one-line summary for each. The entry names its revision in
`<meta name="superbee-conformance-revision">`; a host that byte-copies it into its own harness
records that value beside its result.

Register it under exactly this id (`views-registry/conformance`) so every host runs the same bytes
with the same registration. It declares `access: bundle-read`, so a proposal is always refused and
the fixture reports the refusal rather than asking a human to apply anything.
