# Remote storage contract ownership

The remote registrations in `storage-backend-contract.test.ts` exercise **RemoteBackend + reference
router + ServerMemoryBackend**. They remain mandatory end-to-end acceptance tests. A passing row
establishes agreement of that composition; it does not establish that the client can repair an
arbitrary server. The ordinary and peer fixtures share the same injectable server-store factory.

In the table, **adapter** means enforced before requests or while decoding responses; **server**
means required of the wire authority (reference router and/or its store); **engine** means the core
mutation primitive. Mixed rows need all named owners. These are test ownership descriptions, not a
new runtime capability declaration. Local-only YAML/edition/graph rows do not register remotely.

| Remote row (suffix in the shared kit) | Ownership and limit of the remote evidence |
| --- | --- |
| shared invalid input rows refuse without changing stored content | Adapter validates keys; the separate no-request control proves refusal does not depend on router validation. |
| document reads expose stable content versions | Server stores data and computes content hashes; adapter extracts/transports tokens and maps reads. It does not recompute content hashes. |
| reads return the serialized body and read-built mutations keep one token | Reference router uses core document write policy to normalize before storage; server owns returned body shape; adapter carries body strings unchanged; engine builds mutations from reads. Noncanonical `read` and `readMany` controls must fail the same row. |
| concept ids are canonical, exact, and invertible | Adapter rejects noncanonical keys; server namespace must distinguish exact keys and enforce expect-absent. |
| the write key owns the returned document identity | Adapter uses route/request ids for both read paths; router/store also preserve key identity. A foreign-payload-id control proves the adapter's independent enforcement. |
| document CAS and expect-absent are fail-closed | Adapter sends preconditions and maps 412 into VersionConflict; server must atomically enforce them and report expected/actual. |
| readMany preserves order and reports a missing member | Server supplies ordered members and absence; adapter attaches positional request ids, checks cardinality, and maps 404. It cannot detect bodies silently reordered by a server. |
| list, prefix, and exists describe the same sorted namespace | Server supplies complete namespace/prefix/absence; adapter pages, filters prefix, deduplicates, sorts, and maps existence. |
| delete is idempotent, CAS-guarded, and purges history | Server owns deletion, enforcement, and history purge; adapter transports guards and maps results/errors. |
| reserved reads and writes obey the same version discipline | Server owns persistence, hashes and enforcement; adapter validates keys, transports guards/tokens, maps absence/conflict. |
| JSON extensions and read-built mutation agree | Adapter's remote codec captures admissible input; server persists/returns metadata; engine builds mutation. |
| Date extensions and read-built mutation agree | Adapter converts input Dates through its remote codec; server/router preserve JSON values; engine builds mutation. This does not qualify the local YAML value domain. |
| authored standard refusals preserve raw imported values and versions | Engine owns authored validation/grandfathering; server must preserve imported values and store accepted mutations. |
| unsafe keys fail at the storage boundary (blob) | Adapter validates before I/O, independently covered by shared no-request controls. |
| bytes, versions, absence, and sorted listing round-trip (blob) | Server stores bytes/hashes and supplies complete listings; adapter transports raw bytes, tokens, content type and absence, and sorts listings. |
| CAS, expect-absent, and byte-identical no-op (blob) | Server owns enforcement and no-op tokens; adapter transports bytes/guards and maps conflicts. |
| delete is idempotent and CAS-guarded (blob) | Server owns deletion/enforcement; adapter transports guards and maps absence/conflict. |
| a key nested under an existing file entry is absent for every observation | Server's namespace owns absence and contents; adapter maps the wire's absence results. |
| reports retained revisions newest-first | Server owns retention/order/attribution; adapter transports actor and maps revision rows. Hosted authority, rather than the client, attests agent identity. |
| concurrent writers produce one winner (atomic CAS) | Server owns atomic compare-and-swap across peers; adapter transports guards and conflicts. The unconditional-store control must fail at winner count. |
| concurrent claimants produce one winner and terminal refusals | Engine evaluates field preconditions and retries conflicts; correctness of the winner count also requires server CAS. This is not adapter-independent atomicity. |
| an implemented projection does not under-return body-free heads | Server must supply complete filtered heads and matching tokens; adapter requests projection/filter and constructs body-free rows. |
| locale-equal listing ties have stable code-point order | Adapter sorts returned document/blob keys; server must supply the complete set of distinct keys. |
| document case alias / normalization alias is refused where the host aliases that pair and distinct otherwise | Remote fixture declares exact identity: server must preserve distinct spellings; adapter must carry them intact. No filesystem alias-refusal guarantee is established remotely. |
| reserved-file directory alias is refused where the host aliases case and distinct otherwise | Server's exact directory namespace plus adapter key transport; no host-filesystem alias claim. |
| blob key alias is refused where the host aliases case and distinct otherwise | Server's exact blob namespace plus adapter key transport; no host-filesystem alias claim. |

`storage-backend-remote-controls.test.ts` calls the **same assertion functions** as the normal body
and atomic-CAS rows. Conforming controls pass through the real reference router. Nonconforming
stores change one behavior and must produce specific assertion values (missing newline or eight
winners), so a router/transport exception cannot satisfy the negative control. The tests pass by
observing those intended failures, not by accepting a broken composition as conforming.

Body normalization is inherited here: `RemoteBackend.read` and `readMany` deliberately do not
normalize returned bodies or invent new server version tokens. These controls change no production
contract and retain every original body, mutation, and CAS assertion.

The historical verbatim-write-store counterexample does not reproduce through the current reference
router: `handleWriteDoc` calls `writeDocVersionedGuarded`, whose write policy already normalizes the
body before invoking the store. A recording-store control pins this boundary. The negative controls
therefore return noncanonical bodies from server reads (ordinary and batch separately), while
leaving versions and every other store behavior intact. The reference router transports those
strings unchanged, as the wire permits. Their failure is evidence of the inherited read obligation,
not a request to add client normalization or change version authority.
