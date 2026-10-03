# Source identity: lookup and grouped writes

An OKF v0.2 `sources[]` entry can name the external record a document extends: `resource` is the
provider namespace and `id` is the record within it. Two primitives make that identity usable
without a second query or write path.

## Lookup: the `sources` query facet

```ts
queryHeads(bundle, { type: "Event", sources: { resource: feedUrl, id: recordId } });
```

`QueryFilter.sources` is a `SourceIdentity` (`{ resource?, id? }`). A document matches when its
`sources` value is a list holding at least one entry that carries every supplied key. The rule:

- each supplied key must equal the entry's own property by exact, case-sensitive string equality,
  with no trimming, URL normalization or `String()` coercion;
- an entry that is not a mapping, or whose property is absent or not a string, never matches;
- a `sources` value that is not a list (a bare mapping, a string) never matches;
- a selector naming neither key imposes no constraint, like an empty `tags` list;
- the rule does not depend on the edition. In v0.1, `sources` is ordinary frontmatter and is
  read the same way.

The facet is evaluated by `matchesFilter`, the one predicate shared by `query`, `queryHeads`,
browser-local and the View bridge. `matchesSourceIdentity(entry, identity)` and
`hasSourceIdentity(sources, identity)` export the same rule for guards and planners.

Core has no portable frontmatter index, so a lookup scans head projections. The `index.md`
projection is a human-facing view, not a lookup index. The facet composes with `type` and `prefix`,
which backends may push down. Push-down contract: a backend MAY over-return and the engine
re-applies the predicate. `RemoteBackend` does not push `sources` yet. A later index or wire
parameter can narrow the scan without changing results.

## Write: `field-actions` input and the `sources` upsert action

```ts
mutateDocument({ bundle, registry, id, mode: "patch", strict: true, actor, producer, expectedVersion,
  input: { kind: "field-actions", actions: [
    { action: "set", field: "start", value: "2026-10-10T20:00:00-04:00" },
    { action: "upsert", field: "sources", value: { resource: feedUrl, id: recordId, revision: "r2" } },
  ] } });
```

- `field-actions` applies its actions in order to one fresh read through `prepareDocumentFieldAction`,
  the same preparation used by a single `field-action`. It then runs one metadata pass, one
  attribution (`generated.by` = producer, history actor), one Kind and OKF v0.2 validation, one
  `assertCandidate` call and one CAS write. Every step either commits or none does. A replay is a
  semantic no-op (`changed: false`, same version). `result.scopes` lists the per-action scopes.
  The list must be nonempty. `edit` and `replace-all` inside a group still need `expectedVersion`.
- `upsert` selects the single entry whose (`resource`, `id`) pair matches, using the identity rule
  above. It merges the value's properties into that entry, so the entry's other properties
  survive. If no entry matches, it appends the value. The `id` must be nonempty because an upsert
  may mint it. The action refuses in these cases:
  - more than one entry matches (`ambiguous-source`);
  - the `id` already names an entry under another resource (`source-id-conflict`, the same rule as
    `add`);
  - a property value is or contains a list;
  - `sources` is present but is not a list;
  - the bundle is OKF v0.1, like every other `sources` action.

  Malformed rows elsewhere in the list are preserved. The final candidate still passes the v0.2
  standard-field check.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Standalone `findBySource(bundle, identity)` | A second query surface that does not compose with `type`/`prefix` and that browser-local and Views would not share. |
| Reuse `QueryFilter.fields` | It compares top-level values with string coercion and cannot reach into mappings. Changing it would alter existing results. |
| A persisted sources index | Core has no frontmatter index to extend. A new one is a storage and sync concern across every backend. |
| Let ordinary `buildCandidate` patches change `sources` | This reopens the implicit whole-list replacement that collection actions deliberately closed. |
| `replace-document` mode | It works today, but it gives up list protection and makes every caller rebuild the whole list. |
| Pair selector on `edit` plus a caller-chosen add or edit | Every caller would reimplement upsert, and the decision would not be plain data. |
| A record-overlay write operation | Premature. The integration-contract design is still open. |
