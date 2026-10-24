# Identity ordering compatibility

Local engine list/query/head and edge results, View catalog pages and bridge identity lists, and
new publication captures use Core's `compareCodeUnits`: lexicographic UTF-16 code-unit order.
For example, `a-b`, `a.b`, `a2`, `a_b`, `ab` now appear in that order. Case is significant;
astral characters sort by surrogate code units, not Unicode code points. Human title-based
presentation sorting is unchanged.

This is an observable ordering correction. A capped query can return a different subset, and a
View catalog cursor now uses the same code-unit comparison as its catalog. Consumers should
restart in-progress catalog pagination across an upgrade rather than mix ordering rules. The
View v0/v1 envelope names and request/reply shapes remain unchanged; `docs/VIEW-PROTOCOL.md`
specifies the revised ID order. Newest-first time ordering keeps its existing code-unit ID tie-break.

New publication captures sort documents by ID, reserved objects by `dir/name`, blobs by key,
Views by ID, and relationships by `(from, to, text, href)` with this comparator. Capturing identical
source bytes no longer depends on ICU collation. Source versions, object bytes and object digests
are unchanged. A fresh capture's `snapshotDigest` can differ from an earlier capture when these
arrays previously had a different order, so downstream artifacts derived from it may need rebuilding.

Publication snapshot schema v1 and its canonical JSON/SHA-256 digest calculation are unchanged.
The schema admits historical array order, and array order remains part of the digest. Readers
continue to accept existing v1 manifests without sorting their stored arrays, rewriting serialized
bytes or recomputing their identity. Re-capture is explicit; no persisted manifest migration runs.
Read APIs may project an ID-ordered list from an older snapshot without changing that snapshot.

The shared `@superbee/core/string-identity-agreement` rows exercise punctuation, case, combining
characters and astral/private-use order. Consumer tests use these rows within each surface's
accepted identity grammar; View registration IDs remain ASCII-only.
