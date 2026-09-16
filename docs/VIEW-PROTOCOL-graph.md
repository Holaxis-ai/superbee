# View protocol fragment: the `graph` request

This fragment documents the v0 `graph` request. It is written as a section for
`docs/VIEW-PROTOCOL.md` and is meant to be folded into that document by the orchestrator once
the protocol document lands; it is not a second protocol authority.

## `graph`

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
  `bundle-propose` do). A row never carries a `body` key otherwise.
- `relationships` is the whole derived edge list, the same rows `edges` with no filter returns,
  in `from`, `to`, `text` order.
- `counts` reports the array lengths.
- `okfVersion` is the bundle's declared OKF edition, `0.1` when undeclared.

The OSS bridge answers no `model` and no `definitions`. A host that owns a model shape declares
the `graph.model` capability in `hello.host.capabilities` and adds those keys; a View must treat
them as absent unless that capability is declared.

## Limits

Declared as exported constants on `@superbee/view-runtime`:

| Constant | Value | Over the limit |
| --- | --- | --- |
| `GRAPH_MAX_DOCUMENTS` | 1000 | `TOO_LARGE` |
| `GRAPH_MAX_RELATIONSHIPS` | 10000 | `TOO_LARGE` |
| `MAX_REPLY_BYTES` | 2 MiB | `TOO_LARGE` (the shared reply check every request passes through) |

The document limit is checked before the edge scan runs. Exactly the limit is answered; one more
is refused. The reply byte limit is what bounds `includeBodies` in practice: a head-only graph of
a bundle can fit while the same graph with bodies is refused.

## Errors

- `USAGE`: the envelope is not exactly the shape above. A host built before this request answers
  `graph` with the same `USAGE` error and correlated id it gives every unknown v0 type, so a View
  can feature-detect `graph` by that reply or, once a host declares it, by
  `hello.host.capabilities`.
- `FORBIDDEN`: the launch has no bundle-data access, the same gate every data-bearing request has.
- `TOO_LARGE`: one of the three limits above.
- `RUNTIME`, `REVOKED`: as for every other request.

## Cost

`graph` performs one head scan for documents and one full-bundle scan inside `queryEdges` for
relationships; with `includeBodies` it additionally reads each document so that a row's body and
version come from one read. The host keeps no cache on a View's behalf. Portal's
`createPublicationBridge` answers `graph` through the shared service with no publication-specific
code.
