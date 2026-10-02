// A stateful fake of the hosted sync route family (`/sync/v1`), for `superbee checkout` and
// `superbee sync` tests. No request leaves the process: the fake is a `fetch`.
//
// It starts from the host's golden exchanges (superbee-hosted `test/fixtures/hosted-transport/`,
// pinned byte-for-byte in core's `test/fixtures/hosted-transport/`): the capabilities answer, and
// the bundle the snapshot fixture serves, at the versions the fixtures name. From there it answers
// as the hosted routes do, and the fixtures remain the grammar it is checked against:
// - reads: the heads listing (digest, `304` on a matching `ifNoneMatch`, the root version header,
//   `none` for a bundle built without a root), the snapshot stream and `documents.read.v1`, in the
//   shapes the fixtures pin; heads and snapshot a page at a time under `pageSize` (a cursor pins
//   the listing's digest, and a listing that moved since is `409 concurrent_change`), and
//   `503 backend_unavailable` while `unavailable` is set;
// - refusals: `403 {"error":"access_denied"}` on every route for a client built without the sync
//   surface, and `insufficient_scope` on every write for a person built without write access;
// - writes (`/create`, `/replace`, superbee-hosted `docs/sync-v1-writes.md` at PR 591): one
//   whole document per request, identified by `X-Superbee-Write-Request` and pinned by
//   `X-Superbee-Checkout`, compare-and-swap on absence or on `expectedVersion`, never a merge; a
//   recorded answer carries `X-Superbee-Write-Settled`; a repeated identity answers its recorded
//   result; the capacity refusal is `429 {"error":{"code":"request_capacity","scope",…}}`;
// - `/delete` and the tombstone check on creates (superbee-hosted `docs/documents-delete-operation.md`
//   and `docs/sync-v1-writes.md` at PR 606 head 93bd1ab1): a delete at exactly `expectedVersion`
//   leaves a tombstone (`data.version`, with `deletedVersion` and `deleted: true`); a new identity
//   at the same base answers `changed: false` naming it; a create of a tombstoned id is refused as
//   `version_conflict` naming the latest tombstone unless `X-Superbee-Recreate` names exactly it,
//   and without `currentVersion` when it acknowledges a tombstone the id does not have;
// - an unknown outcome (the `unknown` write hook): the identity is reserved but never settled, the
//   write answers `write_outcome_unknown` with no settled header, and its outcome is `pending`;
// - `/outcome`: the `encodeIdentifiedOutcome` answer (`schemaVersion` 1, `absent`, `committed`
//   with the committed bytes as base64, or none for a delete, or `refused`).
// - `/history` (superbee-hosted `documents.history.v1`, `src/sync-v1-reads.ts`): each live
//   document's lineage, newest first, paged with `limit` and `before`, `total` on the first page,
//   each version's stored bytes with `includeContent`; `document_not_found` for an absent document
//   (a delete moves the lineage to the tombstone, and a recreate starts at seq 1 again); the agent
//   label a write named in `X-Superbee-Via` as the host records it. `history: false` is a gateway
//   from before the route: its `404 {"error":"not_found"}`.
// - `/export` (superbee-hosted PR 650, `src/sync-v1-export.ts`): the portable export of the fake's
//   bundle as the host writes it (`fake-export-archive.ts`): the documents' stored bytes, the root
//   index, and any reserved files or blobs a test adds to `exportExtras`; a 404 `bundle_not_found`
//   for another bundle and a 400 `invalid_input` for any body but `{ bundleId }` or the paged
//   `{ bundleId, paged: true, cursor? }`. A paged request answers `exportPageObjects` objects a page,
//   each page's manifest stating `page` with the `<revision>.<from>` cursor of the next; a cursor
//   whose revision is no longer the bundle's is `409 concurrent_change`. `exportPaging: false` is a
//   gateway from before the paged export.
// - qualified references (superbee-hosted `docs/data-organizations.md`, "Qualified references"):
//   with `workspaces`, whoami names each workspace's slug; a bundle-scoped body may name the bundle
//   `<slug>/<bundle-id>`, which reaches the bundle only when `slug` is its workspace's (another
//   slug is absent, as for another bundle). The recorded request keeps the body as sent.
// - `/operations` and `/run` (superbee-hosted `src/sync-v1-reads.ts`, G1): the listing is the golden
//   `operations-200` answer (a composition pinned to `documents.history.v1`) unless a test sets
//   `operationsListing`; another bundle's listing is the capabilities `404 bundle_not_found`. A run
//   of an id the listing does not name is `400 unknown_operation`, a malformed envelope or an input
//   naming another bundle is `400 invalid_input`, another bundle is the `200 bundle_not_found`
//   result; `documents.history.v1` answers as `/history` does, and any other listed id answers
//   `runHook`'s data in the `ok` envelope the goldens pin. `operations: false` is a gateway from
//   before both routes: the family's unknown-route 404 on each.
// - model changes (superbee-hosted `docs/sync-v1-fixtures.md`, the definitions exchanges;
//   designs/hosted-model-evolution.md sections 4.1 and 4.2): with `definitionWrites`, the
//   capabilities answer carries it, and the writes follow the answer the fake serves. The kernel's
//   fence refuses `invalid_input` a write under folded `conventions/` or `views-registry/`, or of
//   type `Convention` or `View`, except, when the answer says `allowed`, a `Convention` under
//   `conventions/` exactly as spelled. That write is proved against the stored documents with
//   core's Kind rules: a Kind a stored document fails, or a removed Kind still in use, refuses
//   `definition_incompatible` with `definitionDetails`. Document writes are validated against the
//   stored Kinds (`validation_failed`). Without `definitionWrites` none of this applies.
// - the front page (superbee-hosted `bundles.root.replace.v1`, `POST /sync/v1/root`, the lane
//   front-page wire contract): with `rootWrites`, the capabilities answer carries it, and the route
//   replaces the root `index.md` compare-and-swap on `expectedVersion` (or `expectAbsent`), with no
//   request identity (a `X-Superbee-Write-Request` is refused `400` here, so a client that sends
//   one fails loudly). A version is the SHA-256 of the stored bytes; the capabilities answer and
//   the heads' root version header follow the stored root. `rootHook` answers or drops a write.
// - any other route: the family's unknown-route answer, `404 {"error":"not_found"}`.
// Every answer shape is held to the `/sync/v1` golden exchanges captured from the real hosted
// gateway (core's `test/fixtures/hosted-sync-v1/`) by `hosted-fake-contract.test.ts`; the export
// answers are held to them byte for byte.
// The host stores its own serialization (the managed `superbee_updated_by` field added), so a
// committed version is never the client's local version, as on the real host.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildKindRegistry, CONVENTION_TYPE, headsDigest, isConventionId, stringifyDoc, validateAgainstKind, type OkfDocument } from "@superbee/core";
import { versionOfBytes } from "@superbee/core/versioning";
import { isAcceptedDeletionCount, isAgentLabelVia } from "@superbee/core/hosted-transport";
import { deletionHold } from "../../src/hosted/sync-scan.js";

import { exportArchive, exportInventorySize, type ExportState } from "./fake-export-archive.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, "../../../core/test/fixtures/hosted-transport");
export const HOST = "https://hosted.example";
export const BUNDLE = "team.knowledge";
export const PRINCIPAL = "principal-7";

interface Fixture {
  response: { status: number; headers: Record<string, string>; body: string };
}

export function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Fixture;
}

/** The `/sync/v1` golden exchanges, captured from the real hosted gateway (core's `test/fixtures/hosted-sync-v1/`). */
export const SYNC_FIXTURES = path.resolve(here, "../../../core/test/fixtures/hosted-sync-v1");

export function syncFixture(name: string): Fixture {
  return JSON.parse(readFileSync(path.join(SYNC_FIXTURES, `${name}.json`), "utf8")) as Fixture;
}

export function jwt(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(claims)}.sig`;
}

export const TOKEN = jwt({ aud: `${HOST}/mcp`, sub: "auth0|person" });

export interface HostedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
  version: string;
  raw: string;
}

type Recorded = { result: Record<string, unknown>; content?: { version: string; raw: string } };

export interface WriteCall {
  route: "create" | "replace" | "delete" | "outcome";
  requestId: string | null;
  binding: string | null;
  /** The `X-Superbee-Recreate` header, when sent. */
  recreate: string | null;
  /** The `X-Superbee-Via` header, when sent. */
  via: string | null;
  /** The `X-Superbee-Accept-Deletes` header, when sent. */
  acceptDeletes: string | null;
  body: Record<string, unknown>;
}

/** What a test may do to one write before the host answers it. */
export type WriteHook = (call: WriteCall) =>
  | { kind: "respond"; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: "apply-then-drop" }
  | { kind: "drop" }
  | { kind: "record"; code: string }
  /** Publication failed after the identity was reserved: `200 write_outcome_unknown`, and the
   * identity's outcome stays `pending`. Nothing is applied. */
  | { kind: "unknown" }
  | undefined;

export interface FakeHostOptions {
  /** The host's origin; the bearer token it admits is one whose audience is `<origin>/mcp`. */
  origin?: string;
  capabilities?: string;
  tenants?: string[];
  bundles?: string[];
  principal?: string;
  /** Serve heads and snapshot this many documents to a page (the host's page size is 1,000). */
  pageSize?: number;
  /** False serves a bundle with no root index: the heads' root version header is `none`. */
  root?: boolean;
  /** False is a client whose binding does not list the sync surface: every route is `403`. */
  syncSurface?: boolean;
  /** False is a person with only a read grant: every write is refused `insufficient_scope`. */
  writable?: boolean;
  /** False is a gateway from before `/history`: the route is the family's unknown-route 404. */
  history?: boolean;
  /**
   * True models the host's mass-delete hold (superbee-hosted `docs/sync-v1-writes.md`): the
   * documents present at construction or `put` by the host are the old ones; a delete of one that
   * would make over half of them deleted (at least min(3, B)) answers `428 deletions_held`,
   * unrecorded, unless `X-Superbee-Accept-Deletes` covers the count. The fake's window never
   * rolls; client creates are new and never counted.
   */
  massDeleteHold?: boolean;
  /**
   * Each workspace with its slug, as whoami names them. Absent: each tenant is its own slug. Null:
   * a host from before qualified references, whose whoami names no workspaces.
   */
  workspaces?: { tenantId: string; slug: string | null }[] | null;
  /** The slug of the workspace that holds the bundle (default: the first workspace's): a reference naming it reaches the bundle. */
  slug?: string;
  /** False is a gateway from before `/operations` and `/run`: both are the family's unknown-route 404. */
  operations?: boolean;
  /**
   * What the capabilities answer says about model changes: absent, a workspace without them (the
   * answer and the writes are the fake's as before). Set, the answer carries it and the writes
   * follow it (the model-changes item above).
   */
  definitionWrites?: "allowed" | "refused";
  /** False is a gateway from before the paged export: a paged request's body is `400 invalid_input`. */
  exportPaging?: boolean;
  /**
   * What the capabilities answer says about replacing the root `index.md`: absent, a host from
   * before the root write (the answer has no `rootWrites`, and the route refuses the write as a
   * person without the grant would). Set, the answer carries it and the route follows it.
   */
  rootWrites?: "allowed" | "refused";
}

/** One root write as the fake received it. */
export interface RootCall {
  binding: string | null;
  writeRequest: string | null;
  via: string | null;
  body: Record<string, unknown>;
}

/** What a test may do to one root write before the host answers it. */
export type RootHook = (call: RootCall) => { kind: "respond"; status: number; body: unknown } | { kind: "apply-then-drop" } | { kind: "drop" } | undefined;

/** One operation descriptor, as the listing route answers it. */
export type OperationDescriptor = Record<string, unknown> & { operationId: string };

/** One version of a live document's lineage, as the host's history rows hold it. */
export interface HistoryRow {
  seq: number;
  version: string;
  actor: string;
  timestamp: string;
  agent?: string;
  raw: string;
}

/** The agent label the host records for a sync write: the credential, and the agent it named. */
export const recordedAgentLabel = (via: string | null) => (via === null ? "sync/credential:cli" : `sync/credential:cli;via=${via}`);

const WRITE_REQUEST = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BINDING = /^sha256:[a-f0-9]{64}$/;

export interface Tombstone {
  tombstone: string;
  deletedVersion: string;
  revision: number;
}

export class FakeHost {
  readonly docs = new Map<string, HostedDoc>();
  /** Each live document's lineage, oldest first (the history route answers it newest first). */
  readonly histories = new Map<string, HistoryRow[]>();
  /** The instant each history row records. */
  historyNow: () => Date = () => new Date();
  /** Every deletion of each id, oldest first; the last is the latest tombstone. */
  readonly tombstones = new Map<string, Tombstone[]>();
  /** The bundle revision: bumped by every write and delete, kept across deletion. */
  revision = 1;
  readonly requests: { path: string; body: unknown; headers: Headers }[] = [];
  readonly writes: WriteCall[] = [];
  readonly recorded = new Map<string, Recorded>();
  /** Documents applied by the write routes, in order. */
  readonly applied: string[] = [];
  hook: WriteHook | undefined;
  /** True while storage fails: heads and snapshot answer `503 backend_unavailable`. */
  unavailable = false;
  /** Identities reserved whose publication failed: their outcome is `pending`. */
  readonly pending = new Set<string>();
  /** Reserved files and blobs the export carries beside the documents and the root index. */
  readonly exportExtras = new Map<string, Uint8Array>();
  /** The whole bundle the export serves, when a test sets it; otherwise the fake's own state. */
  exportState: ExportState | undefined;
  /** The export instant. */
  exportedAt: () => Date = () => new Date();
  /** Objects one page of a paged export carries (the host's is 500). */
  exportPageObjects = 500;
  /** Called before each export answer, with the request body: a test moves the bundle between pages. */
  exportBefore: ((body: Record<string, unknown>) => void) | undefined;
  /** What a test does to the archive bytes before they are answered (truncate, tamper). */
  exportHook: ((archive: Uint8Array) => Uint8Array | Response) | undefined;
  /** The listing `/operations` answers, when a test sets it; otherwise the golden `operations-200` listing. */
  operationsListing: OperationDescriptor[] | undefined;
  /** The data a run of a listed operation other than `documents.history.v1` answers. */
  runHook: ((operationId: string, input: Record<string, unknown>) => unknown) | undefined;
  capabilities: string;
  /** The root `index.md` the host stores, once a root write or `putRoot` changed it (else the fixture's). */
  private storedRoot: { content: string; version: string } | null | undefined;
  /** Every root write received, in order. */
  readonly rootCalls: RootCall[] = [];
  rootHook: RootHook | undefined;
  principal: string;
  readonly origin: string;
  readonly token: string;
  private readonly rootVersion: string;
  private readonly options: FakeHostOptions;
  /** The ids the mass-delete hold counts as old, and the old documents deleted so far. */
  private readonly oldIds = new Set<string>();
  private oldDeleted = 0;

  constructor(options: FakeHostOptions = {}) {
    this.options = options;
    this.origin = options.origin ?? HOST;
    this.token = this.origin === HOST ? TOKEN : jwt({ aud: `${this.origin}/mcp`, sub: "auth0|person" });
    this.capabilities = options.capabilities ?? "capabilities-operations";
    this.principal = options.principal ?? PRINCIPAL;
    this.rootVersion = options.root === false ? "none" : fixture("heads-200").response.headers["x-superbee-root-version"]!;
    for (const line of fixture("snapshot-complete").response.body.trim().split("\n")) {
      const row = JSON.parse(line) as { kind: string; id: string; version: string; frontmatter: Record<string, unknown>; body: string };
      if (row.kind !== "doc") continue;
      this.docs.set(row.id, { frontmatter: row.frontmatter, body: row.body, version: row.version, raw: stringifyDoc(row.frontmatter as never, row.body) });
      this.record(row.id, "someone-else", undefined);
      this.oldIds.add(row.id);
    }
  }

  /** A write of `id`'s current bytes, appended to its lineage. */
  private record(id: string, actor: string, agent: string | undefined): void {
    const doc = this.docs.get(id)!;
    const rows = this.histories.get(id) ?? [];
    rows.push({ seq: rows.length + 1, version: doc.version, actor, timestamp: this.historyNow().toISOString(), ...(agent === undefined ? {} : { agent }), raw: doc.raw });
    this.histories.set(id, rows);
  }

  /** A change made on the host (another person, or the app). */
  put(id: string, frontmatter: Record<string, unknown>, body: string): string {
    const stored = { ...frontmatter, superbee_updated_by: "someone-else" };
    const raw = stringifyDoc(stored as never, body);
    const version = versionOfBytes(raw);
    this.docs.set(id, { frontmatter: stored, body, version, raw });
    this.record(id, "someone-else", undefined);
    this.oldIds.add(id);
    return version;
  }

  remove(id: string): void {
    this.docs.delete(id);
    this.histories.delete(id);
  }

  /** A delete made on the host by someone else (another checkout's sync): it leaves a tombstone. */
  deleteWithTombstone(id: string): string {
    const doc = this.docs.get(id);
    assert.ok(doc, `the host has ${id}`);
    if (this.oldIds.has(id)) this.oldDeleted += 1;
    return this.tombstone(id, doc.version);
  }

  /** Whether this person may make the write: always, unless the host was built read-only.
   * An outcome is a lookup, never refused this way. */
  private writable(route: string): boolean {
    return route === "outcome" || this.options.writable !== false;
  }

  latestTombstone(id: string): Tombstone | undefined {
    return this.tombstones.get(id)?.at(-1);
  }

  private tombstone(id: string, deletedVersion: string): string {
    const revision = this.revision;
    const tombstone = versionOfBytes(JSON.stringify({ deletedVersion, id, revision, superbee: "tombstone" }));
    this.tombstones.set(id, [...(this.tombstones.get(id) ?? []), { tombstone, deletedVersion, revision }]);
    this.docs.delete(id);
    this.histories.delete(id);
    this.revision += 1;
    return tombstone;
  }

  heads() {
    const heads = [...this.docs].map(([id, doc]) => ({ id, version: doc.version })).sort((a, b) => (a.id < b.id ? -1 : 1));
    return { count: heads.length, digest: headsDigest(heads), heads };
  }

  /** One page of the listing, as the host serves it: a cursor pins the listing's digest and names
   * the last id served; a listing that moved since is a restart. */
  private page(listing: ReturnType<FakeHost["heads"]>, cursor: unknown): { heads: { id: string; version: string }[]; next?: string } | "restart" {
    const size = this.options.pageSize ?? 1000;
    const pin = listing.digest.slice("sha256:".length);
    let start = 0;
    if (cursor !== undefined) {
      const [digest, after] = String(cursor).split(".");
      if (digest !== pin || after === undefined) return "restart";
      const last = Buffer.from(after, "base64url").toString("utf8");
      start = listing.heads.findIndex((head) => head.id > last);
      if (start < 0) start = listing.heads.length;
    }
    const heads = listing.heads.slice(start, start + size);
    const more = start + size < listing.heads.length;
    return { heads, ...(more ? { next: `${pin}.${Buffer.from(heads.at(-1)!.id, "utf8").toString("base64url")}` } : {}) };
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    this.requests.push({ path: url.pathname, body: structuredClone(body), headers });
    assert.equal(url.origin, this.origin);
    assert.equal(init?.method, "POST");
    if (headers.get("authorization") !== `Bearer ${this.token}`) {
      const refusal = syncFixture("read-401-unauthenticated").response;
      return new Response(refusal.body, { status: refusal.status, headers: refusal.headers });
    }
    if (this.options.syncSurface === false) return Response.json({ error: "access_denied" }, { status: 403 });
    const route = url.pathname.replace(/^\/sync\/v1\//, "");
    // A qualified reference reaches the bundle in the workspace it names; the routes read the bare id.
    if (!["whoami", "bundles"].includes(route) && typeof body.bundleId === "string" && body.bundleId.includes("/")) {
      const [slug, bare] = body.bundleId.split("/");
      body.bundleId = slug === (this.options.slug ?? this.workspaces()?.[0]?.slug) && bare === BUNDLE ? BUNDLE : `absent.${bare}`;
    }
    if (this.unavailable && (route === "heads" || route === "snapshot")) {
      return Response.json({ error: { code: "backend_unavailable", message: "The bundle backend is unavailable.", retryable: true } }, { status: 503 });
    }
    switch (route) {
      case "whoami":
        return Response.json({
          principalId: this.principal,
          credentialId: "cli",
          tenantIds: this.options.tenants ?? ["tenant-a"],
          ...(this.workspaces() ? { workspaces: this.workspaces() } : {}),
          surface: "sync",
        });
      case "bundles":
        return Response.json({
          ok: true,
          operationId: "bundles.list.v1",
          data: { bundles: (this.options.bundles ?? [BUNDLE]).map((bundleId) => ({ bundleId, name: bundleId, purpose: "", domains: [], lifecycle: "active", sensitivity: "internal" })) },
        });
      case "capabilities": {
        if (body.bundleId !== BUNDLE && String(body.bundleId).startsWith("absent.")) return bundleNotFound();
        assert.equal(body.bundleId, BUNDLE);
        const { response } = fixture(this.capabilities);
        let answer = this.definitionWrites === null ? response.body : JSON.stringify({ ...JSON.parse(response.body), definitionWrites: this.definitionWrites });
        if (this.storedRoot !== undefined || this.options.rootWrites !== undefined) {
          answer = JSON.stringify({
            ...JSON.parse(answer),
            ...(this.storedRoot !== undefined ? { root: this.storedRoot } : {}),
            ...(this.options.rootWrites !== undefined ? { rootWrites: this.options.rootWrites } : {}),
          });
        }
        return new Response(answer, { status: response.status, headers: response.headers });
      }
      case "heads": {
        if (body.bundleId !== BUNDLE && String(body.bundleId).startsWith("absent.")) return bundleNotFound();
        assert.equal(body.bundleId, BUNDLE);
        const listing = this.heads();
        const common = { etag: `"${listing.digest}"`, "x-superbee-root-version": this.storedRoot === undefined ? this.rootVersion : (this.storedRoot?.version ?? "none") };
        if (body.cursor === undefined && body.ifNoneMatch === listing.digest) return new Response(null, { status: 304, headers: common });
        const page = this.page(listing, body.cursor);
        if (page === "restart") return restart();
        return new Response(JSON.stringify({ count: listing.count, digest: listing.digest, ...page }), { status: 200, headers: { "content-type": "application/json; charset=utf-8", ...common } });
      }
      case "snapshot": {
        const listing = this.heads();
        const page = this.page(listing, body.cursor);
        if (page === "restart") return restart();
        const lines = [JSON.stringify({ kind: "snapshot", count: listing.count, digest: listing.digest })];
        for (const head of page.heads) {
          const doc = this.docs.get(head.id)!;
          lines.push(JSON.stringify({ kind: "doc", id: head.id, version: doc.version, frontmatter: doc.frontmatter, body: doc.body }));
        }
        lines.push(JSON.stringify(page.next === undefined ? { kind: "end", count: listing.count } : { kind: "page", count: page.heads.length, next: page.next }));
        return new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8", etag: `"${listing.digest}"` } });
      }
      case "read": {
        if (!onlyKeys(body, ["bundleId", "documentId"])) return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
        if (body.bundleId !== BUNDLE) return Response.json({ ok: false, operationId: "documents.read.v1", error: { code: "bundle_not_found", message: "The bundle is unavailable for this operation.", retryable: false } });
        const id = String(body.documentId);
        const doc = this.docs.get(id);
        if (!doc) {
          return Response.json({ ok: false, operationId: "documents.read.v1", error: { code: "document_not_found", message: "No document", retryable: false } });
        }
        return Response.json({ ok: true, operationId: "documents.read.v1", data: { document: { id, frontmatter: doc.frontmatter, body: doc.body }, version: doc.version } });
      }
      case "history":
        return this.options.history === false ? unknownRoute() : this.history(body);
      case "operations":
        return this.options.operations === false ? unknownRoute() : this.operations(body);
      case "run":
        return this.options.operations === false ? unknownRoute() : this.run(body);
      case "export":
        return this.export(body);
      case "create":
      case "replace":
      case "delete":
      case "outcome":
        return this.write(route, body, headers);
      case "root":
        return this.rootWrite(body, headers);
      default:
        return unknownRoute();
    }
  }) as typeof fetch;

  /** The root the host stores now: its exact content and version, or null without one. */
  root(): { content: string; version: string } | null {
    if (this.storedRoot !== undefined) return this.storedRoot;
    const { response } = fixture(this.capabilities);
    const root = (JSON.parse(response.body) as { root: { content: string; version: string } | null }).root;
    return root ? { content: root.content, version: root.version } : null;
  }

  /** A change to the front page made on the host (another person, in the app). */
  putRoot(content: string): string {
    const version = versionOfBytes(content);
    this.storedRoot = { content, version };
    this.revision += 1;
    return version;
  }

  /** `POST /sync/v1/root`: the front page's compare-and-swap replace, as the wire contract states it. */
  private rootWrite(body: Record<string, unknown>, headers: Headers): Response {
    const call: RootCall = { binding: headers.get("x-superbee-checkout"), writeRequest: headers.get("x-superbee-write-request"), via: headers.get("x-superbee-via"), body: structuredClone(body) };
    this.rootCalls.push(call);
    const invalid = () => Response.json({ error: { code: "invalid_input" } }, { status: 400 });
    if (!call.binding || !BINDING.test(call.binding) || call.writeRequest !== null || (call.via !== null && !isAgentLabelVia(call.via))) return invalid();
    const creates = body.expectAbsent === true;
    if (!onlyKeys(body, creates ? ["bundleId", "content", "expectAbsent"] : ["bundleId", "content", "expectedVersion"]) || typeof body.content !== "string" || body.bundleId !== BUNDLE) return invalid();
    if (!creates && (typeof body.expectedVersion !== "string" || !BINDING.test(body.expectedVersion))) return invalid();
    const operationId = "bundles.root.replace.v1";
    if (this.options.writable === false || this.options.rootWrites !== "allowed") return Response.json(failure(operationId, "insufficient_scope"));
    const hooked = this.rootHook?.(call);
    if (hooked?.kind === "respond") return new Response(JSON.stringify(hooked.body), { status: hooked.status, headers: { "content-type": "application/json" } });
    if (hooked?.kind === "drop") throw new TypeError("fetch failed");
    const content = body.content;
    const current = this.root();
    let answer: Record<string, unknown>;
    if (content.startsWith("\uFEFF")) answer = failure(operationId, "invalid_input");
    else if (creates && current) answer = failure(operationId, "document_exists", current.version);
    else if (!creates && body.expectedVersion !== current?.version) answer = failure(operationId, "version_conflict", current?.version);
    else if (edition(content) !== edition(current?.content ?? "")) answer = failure(operationId, "validation_failed");
    else {
      const version = versionOfBytes(content);
      const changed = version !== current?.version;
      if (changed) this.putRoot(content);
      answer = { ok: true, operationId, data: { bundleId: BUNDLE, version, changed } };
    }
    if (hooked?.kind === "apply-then-drop") throw new TypeError("fetch failed");
    return Response.json(answer);
  }

  /** The workspaces whoami names, or null for a host from before qualified references. */
  private workspaces(): { tenantId: string; slug: string | null }[] | null {
    if (this.options.workspaces !== undefined) return this.options.workspaces;
    return (this.options.tenants ?? ["tenant-a"]).map((tenantId) => ({ tenantId, slug: /^[a-z0-9-]+$/.test(tenantId) ? tenantId : null }));
  }

  /** The root index the host serves: the capabilities answer's `root.content`. */
  rootIndex(): string {
    if (this.storedRoot) return this.storedRoot.content;
    const { response } = fixture(this.capabilities);
    return (JSON.parse(response.body) as { root: { content: string } }).root.content;
  }

  /** The bundle as the export route reads it from storage. */
  currentExportState(): ExportState {
    if (this.exportState) return this.exportState;
    const files = new Map<string, Uint8Array>([["index.md", Buffer.from(this.rootIndex(), "utf8")]]);
    for (const [id, doc] of this.docs) files.set(`${id}.md`, Buffer.from(doc.raw, "utf8"));
    for (const [file, bytes] of this.exportExtras) files.set(file, bytes);
    return { tenantId: (this.options.tenants ?? ["tenant-a"])[0]!, bundleId: BUNDLE, revision: this.revision, files };
  }

  /** The descriptors `/operations` lists. */
  listing(): OperationDescriptor[] {
    return this.operationsListing ?? (JSON.parse(syncFixture("operations-200").response.body) as { operations: OperationDescriptor[] }).operations;
  }

  private operations(body: Record<string, unknown>): Response {
    if (!onlyKeys(body, ["bundleId"]) || typeof body.bundleId !== "string") return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
    if (body.bundleId !== BUNDLE) return Response.json({ error: { code: "bundle_not_found", message: BUNDLE_UNAVAILABLE, retryable: false } }, { status: 404 });
    if (this.operationsListing === undefined) {
      const { response } = syncFixture("operations-200");
      return new Response(response.body, { status: response.status, headers: response.headers });
    }
    return new Response(JSON.stringify({ operations: this.operationsListing }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }

  private run(body: Record<string, unknown>): Response {
    const invalid = () => Response.json({ error: { code: "invalid_input" } }, { status: 400 });
    const { bundleId, operationId, input } = body;
    if (!onlyKeys(body, ["bundleId", "operationId", "input"]) || typeof bundleId !== "string" || typeof operationId !== "string" || typeof input !== "object" || input === null || Array.isArray(input)) return invalid();
    // The listing is what the host runs by id: any other id, a write's included, is refused before anything else.
    if (!this.listing().some((descriptor) => descriptor.operationId === operationId)) return Response.json({ error: { code: "unknown_operation" } }, { status: 400 });
    const operationInput = input as Record<string, unknown>;
    if (operationInput.bundleId !== bundleId) return invalid();
    if (bundleId !== BUNDLE) return Response.json({ ok: false, operationId, error: { code: "bundle_not_found", message: BUNDLE_UNAVAILABLE, retryable: false } });
    if (operationId === "documents.history.v1") return this.history(operationInput);
    const data = this.runHook?.(operationId, operationInput);
    assert.notEqual(data, undefined, `the fake lists ${operationId} but no runHook answers it`);
    return new Response(JSON.stringify({ ok: true, operationId, data }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }

  private history(body: Record<string, unknown>): Response {
    const operationId = "documents.history.v1";
    const { limit = 20, before, includeContent } = body;
    const int = (value: unknown, max: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
    if (
      !onlyKeys(body, ["bundleId", "documentId", "limit", "before", "includeContent"]) ||
      typeof body.bundleId !== "string" ||
      typeof body.documentId !== "string" ||
      !int(limit, 100) ||
      (before !== undefined && !int(before, Number.MAX_SAFE_INTEGER)) ||
      (includeContent !== undefined && includeContent !== true)
    )
      return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
    if (body.bundleId !== BUNDLE) return Response.json({ ok: false, operationId, error: { code: "bundle_not_found", message: "The bundle is unavailable for this operation.", retryable: false } });
    const rows = this.histories.get(body.documentId);
    // A kernel result, as the host answers it (a bundle refused before the kernel is plain JSON).
    if (!rows || !this.docs.has(body.documentId))
      return new Response(JSON.stringify({ ok: false, operationId, error: { code: "document_not_found", message: "The document was not found.", retryable: false } }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    const older = [...rows].reverse().filter((row) => before === undefined || row.seq < (before as number));
    const page = older.slice(0, limit as number);
    const versions = page.map((row) => ({
      seq: row.seq,
      version: row.version,
      actor: row.actor,
      timestamp: row.timestamp,
      ...(row.agent === undefined ? {} : { agent: row.agent }),
      ...(includeContent ? { content: row.raw } : {}),
    }));
    const data = { documentId: body.documentId, versions, more: older.length > page.length, ...(before === undefined ? { total: rows.length } : {}) };
    return new Response(JSON.stringify({ ok: true, operationId, data }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }

  private export(body: Record<string, unknown>): Response {
    const invalid = () => Response.json({ error: { code: "invalid_input" } }, { status: 400 });
    const paged = this.options.exportPaging !== false && body.paged === true;
    if (typeof body.bundleId !== "string" || !(paged ? onlyKeys(body, ["bundleId", "paged", "cursor"]) : onlyKeys(body, ["bundleId"]))) return invalid();
    let cursor: { revision: number; from: number } | undefined;
    if (paged && body.cursor !== undefined) {
      const match = typeof body.cursor === "string" ? /^(0|[1-9][0-9]{0,14})\.([1-9][0-9]{0,5})$/.exec(body.cursor) : null;
      if (!match) return invalid();
      cursor = { revision: Number(match[1]), from: Number(match[2]) };
    }
    this.exportBefore?.(body);
    const state = this.currentExportState();
    if (body.bundleId !== state.bundleId) {
      return Response.json(
        { error: { code: "bundle_not_found", message: "The bundle is unavailable for this operation. Check your bundle access with a workspace administrator.", retryable: false } },
        { status: 404 },
      );
    }
    let page: { from: number; size: number } | undefined;
    if (paged) {
      if (cursor && cursor.revision !== state.revision) {
        return Response.json({ error: { code: "concurrent_change", message: "The bundle changed since the first page. Start again from the first page.", retryable: true } }, { status: 409 });
      }
      if (cursor && cursor.from >= exportInventorySize(state)) return invalid();
      page = { from: cursor?.from ?? 0, size: this.exportPageObjects };
    }
    const archive = exportArchive(state, this.exportedAt(), page);
    const answered = this.exportHook ? this.exportHook(archive) : archive;
    if (answered instanceof Response) return answered;
    return new Response(answered, {
      status: 200,
      headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${state.bundleId}-${state.revision}.zip"` },
    });
  }

  private write(route: "create" | "replace" | "delete" | "outcome", body: Record<string, unknown>, headers: Headers): Response {
    const requestId = headers.get("x-superbee-write-request");
    const binding = headers.get("x-superbee-checkout");
    const recreate = headers.get("x-superbee-recreate");
    const via = headers.get("x-superbee-via");
    const acceptDeletes = headers.get("x-superbee-accept-deletes");
    const call: WriteCall = { route, requestId, binding, recreate, via, acceptDeletes, body };
    this.writes.push(call);
    if (!requestId || !WRITE_REQUEST.test(requestId) || !binding || !BINDING.test(binding) || !onlyKeys(body, WRITE_BODY_KEYS[route === "outcome" ? outcomeOf(body) : route])) {
      return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
    }
    // The acknowledgement is a create's (and its outcome's) alone, and a version.
    const creates = route === "create" || (route === "outcome" && body.expectAbsent === true);
    if (recreate !== null && (!creates || !BINDING.test(recreate))) return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
    // The agent a client names is attribution only: checked like the host checks it, never authority.
    if (via !== null && !isAgentLabelVia(via)) return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
    // The hold's acknowledgment is a delete's (and its outcome's) alone: 1 to 100,000.
    const deletes = route === "delete" || (route === "outcome" && outcomeOf(body) === "delete");
    if (acceptDeletes !== null && (!deletes || !/^[1-9][0-9]*$/.test(acceptDeletes) || !isAcceptedDeletionCount(Number(acceptDeletes)))) return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
    if (!this.writable(route)) {
      const operationId = route === "create" ? "documents.create.v1" : route === "replace" ? "documents.replace.v1" : "documents.delete.v1";
      return Response.json({ ok: false, operationId, error: { code: "insufficient_scope", message: "Your access to this bundle does not allow this write. Nothing was written.", retryable: false, writeState: "not_applied" } });
    }
    const hooked = this.hook?.(call);
    if (hooked?.kind === "respond") return new Response(JSON.stringify(hooked.body), { status: hooked.status, headers: { "content-type": "application/json", ...hooked.headers } });
    if (hooked?.kind === "drop") throw new TypeError("fetch failed");
    if (route === "outcome") return this.outcome(requestId, binding, body);
    if (hooked?.kind === "unknown" && !this.recorded.has(requestId)) {
      this.pending.add(requestId);
      const operationId = route === "create" ? "documents.create.v1" : route === "replace" ? "documents.replace.v1" : "documents.delete.v1";
      return new Response(
        JSON.stringify({ ok: false, operationId, error: { code: "write_outcome_unknown", message: "The save outcome is unknown. Read the same document before making another write; do not create a replacement ID.", retryable: false, writeState: "unknown" } }),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
    const operationId = route === "create" ? "documents.create.v1" : route === "replace" ? "documents.replace.v1" : "documents.delete.v1";
    let recorded = this.recorded.get(requestId);
    if (!recorded && route === "delete" && this.options.massDeleteHold) {
      const held = this.deletionHeld(body, acceptDeletes === null ? undefined : Number(acceptDeletes));
      if (held) return held;
    }
    if (!recorded) {
      const model = hooked?.kind === "record" ? null : this.modelRefusal(route, operationId, body);
      recorded = hooked?.kind === "record" ? { result: failure(operationId, hooked.code) } : model ? { result: model } : route === "delete" ? this.applyDelete(body) : this.apply(route, operationId, body, recreate, via);
      this.recorded.set(requestId, recorded);
    }
    if (hooked?.kind === "apply-then-drop") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(recorded.result), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "x-superbee-write-settled": requestId } });
  }

  /** The host's mass-delete hold for a delete not yet recorded: its `428`, or null when admitted. */
  private deletionHeld(body: Record<string, unknown>, accepted: number | undefined): Response | null {
    const id = String(body.documentId);
    if (!this.oldIds.has(id) || this.docs.get(id)?.version !== body.expectedVersion) return null;
    const live = [...this.docs.keys()].filter((key) => this.oldIds.has(key)).length;
    const deletions = this.oldDeleted + 1;
    const baseline = live + this.oldDeleted;
    if (!deletionHold(1, live, this.oldDeleted).held || (accepted !== undefined && deletions <= accepted)) return null;
    return Response.json(
      { error: { code: "deletions_held", deletions, baseline, message: `This would make ${deletions} deletions in 24 hours of the ${baseline} documents this bundle held. Nothing was deleted; a person must confirm this mass delete.`, retryable: false, writeState: "not_applied" } },
      { status: 428 },
    );
  }

  /** What the capabilities answer says about model changes: the one value the answer serves and the writes follow. */
  private get definitionWrites(): "allowed" | "refused" | null {
    return this.options.definitionWrites ?? null;
  }

  /** The stored Kinds, as core reads them from `conventions/`, with `change` applied (a document, or a removal). */
  private kinds(change?: { id: string; doc: OkfDocument | null }) {
    const conventions = [...this.docs]
      .filter(([id, doc]) => isConventionId(id) && doc.frontmatter.type === CONVENTION_TYPE && id !== change?.id)
      .map(([id, doc]) => ({ id, frontmatter: doc.frontmatter, body: doc.body }) as OkfDocument);
    if (change?.doc) conventions.push(change.doc);
    return buildKindRegistry(conventions.sort((a, b) => (a.id < b.id ? -1 : 1)));
  }

  /**
   * The host's answer to a write the model rules refuse (the model-changes item in the header), or
   * null when they admit it and the ordinary write runs. Only with `definitionWrites`.
   */
  private modelRefusal(route: "create" | "replace" | "delete", operationId: string, body: Record<string, unknown>): Record<string, unknown> | null {
    const served = this.definitionWrites;
    if (served === null) return null;
    const id = String(body.documentId);
    const folded = id.toLowerCase();
    const under = (folder: string) => folded === folder || folded.startsWith(`${folder}/`);
    const types = [this.docs.get(id)?.frontmatter.type, route === "delete" ? undefined : (body.frontmatter as Record<string, unknown>).type].filter((type) => type !== undefined);
    const definition = served === "allowed" && isConventionId(id);
    if (under("views-registry") || types.includes("View")) return failure(operationId, "invalid_input");
    if (definition ? types.some((type) => type !== CONVENTION_TYPE) : under("conventions") || types.includes(CONVENTION_TYPE)) return failure(operationId, "invalid_input");
    const stored = (type: string) => [...this.docs].filter(([docId, doc]) => !isConventionId(docId) && doc.frontmatter.type === type);
    if (definition) {
      // The proof: the Kind this write leaves must hold every stored document of its type.
      const candidate = route === "delete" ? null : ({ id, frontmatter: body.frontmatter, body: String(body.body) } as OkfDocument);
      const before = this.docs.get(id);
      const findings: Record<string, unknown>[] = [];
      if (candidate) {
        const kind = this.kinds({ id, doc: candidate }).kinds.get(String(candidate.frontmatter.governs));
        const failing = new Map<string, { field?: string; detail: string; ids: string[] }>();
        for (const [docId, doc] of kind ? stored(kind.governs) : []) {
          for (const warning of validateAgainstKind({ id: docId, frontmatter: doc.frontmatter, body: doc.body } as OkfDocument, kind!)) {
            const key = `${warning.code}\0${warning.field ?? ""}`;
            const row = failing.get(key) ?? { ...(warning.field ? { field: warning.field } : {}), detail: warning.code, ids: [] };
            if (!row.ids.includes(docId)) row.ids.push(docId);
            failing.set(key, row);
          }
        }
        for (const row of failing.values()) findings.push({ rule: "instance_invalid", conventionId: id, type: kind!.governs, ...(row.field ? { field: row.field } : {}), detail: row.detail, instances: { count: row.ids.length, ids: row.ids.slice(0, 16) } });
      } else if (before) {
        const governs = String(before.frontmatter.governs);
        const using = stored(governs).map(([docId]) => docId);
        if (using.length > 0) findings.push({ rule: "convention_removed_in_use", conventionId: id, type: governs, instances: { count: using.length, ids: using.slice(0, 16) } });
      }
      if (findings.length === 0) return null;
      return {
        ok: false,
        operationId,
        error: { code: "definition_incompatible", message: "The model change would break documents or other Kinds in this bundle; nothing was saved. The details name what to fix first.", retryable: false, writeState: "not_applied", definitionDetails: { version: 1, findings: findings.slice(0, 16), truncated: findings.length > 16 } },
      };
    }
    // A document write is validated against the stored Kinds, as the host's kernel does.
    if (route === "delete") return null;
    const frontmatter = body.frontmatter as Record<string, unknown>;
    const kind = this.kinds().kinds.get(String(frontmatter.type));
    if (kind && validateAgainstKind({ id, frontmatter, body: String(body.body) } as OkfDocument, kind).length > 0) {
      return { ok: false, operationId, error: { code: "validation_failed", message: "The candidate or bundle conventions failed validation; no change was saved.", retryable: false, writeState: "not_applied" } };
    }
    return null;
  }

  private applyDelete(body: Record<string, unknown>): Recorded {
    const operationId = "documents.delete.v1";
    const id = String(body.documentId);
    const expected = String(body.expectedVersion);
    const existing = this.docs.get(id);
    const answer = (tombstone: string, changed: boolean): Recorded => ({
      result: { ok: true, operationId, data: { bundleId: BUNDLE, documentId: id, version: tombstone, deletedVersion: expected, changed, deleted: true } },
    });
    if (existing && existing.version !== expected) return { result: failure(operationId, "version_conflict", existing.version) };
    if (existing) {
      this.applied.push(id);
      if (this.oldIds.has(id)) this.oldDeleted += 1;
      return answer(this.tombstone(id, expected), true);
    }
    const latest = this.latestTombstone(id);
    if (latest && latest.deletedVersion === expected) return answer(latest.tombstone, false);
    return { result: failure(operationId, "document_not_found") };
  }

  private apply(route: "create" | "replace", operationId: string, body: Record<string, unknown>, recreate: string | null = null, via: string | null = null): Recorded {
    const id = String(body.documentId);
    const existing = this.docs.get(id);
    if (route === "create" && existing) return { result: failure(operationId, "document_exists", existing.version) };
    if (route === "create") {
      // The tombstone check on a sync create: admitted only when it names the id's latest deletion.
      const latest = this.latestTombstone(id)?.tombstone;
      if ((latest ?? null) !== recreate) return { result: failure(operationId, "version_conflict", latest) };
    }
    if (route === "replace" && !existing) return { result: failure(operationId, "document_not_found") };
    if (route === "replace" && existing!.version !== body.expectedVersion) return { result: failure(operationId, "version_conflict", existing!.version) };
    const frontmatter = { ...(body.frontmatter as Record<string, unknown>), superbee_updated_by: this.principal };
    const raw = stringifyDoc(frontmatter as never, String(body.body));
    const version = versionOfBytes(raw);
    this.docs.set(id, { frontmatter, body: String(body.body), version, raw });
    // An unchanged replace writes no version.
    if (route === "create" || existing!.version !== version) this.record(id, this.principal, recordedAgentLabel(via));
    this.revision += 1;
    this.applied.push(id);
    return {
      result: { ok: true, operationId, data: { bundleId: BUNDLE, documentId: id, version, changed: route === "create" || existing!.version !== version } },
      content: { version, raw },
    };
  }

  private outcome(requestId: string, binding: string, body: Record<string, unknown>): Response {
    const recorded = this.recorded.get(requestId);
    const envelope = { schemaVersion: 1, requestId, binding };
    if (!recorded) return Response.json({ ...envelope, status: this.pending.has(requestId) ? "pending" : "absent" });
    assert.equal((recorded.result as { data?: { documentId?: unknown } }).data?.documentId ?? body.documentId, body.documentId);
    if ((recorded.result as { ok?: unknown }).ok === true && !recorded.content) return Response.json({ ...envelope, status: "committed", result: recorded.result });
    if (recorded.content) {
      return Response.json({
        ...envelope,
        status: "committed",
        result: recorded.result,
        content: { encoding: "base64", version: recorded.content.version, bytes: Buffer.from(recorded.content.raw, "utf8").toString("base64") },
      });
    }
    return Response.json({ ...envelope, status: "refused", result: recorded.result });
  }
}

/** The `okf_version` a root's frontmatter states, as the host compares editions (absent: none). */
function edition(content: string): string | null {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  const line = match?.[1]?.split("\n").find((text) => text.startsWith("okf_version:"));
  return line === undefined ? null : line.slice("okf_version:".length).trim().replace(/^["']|["']$/g, "");
}

/** The family's answer to a route it does not have (a gateway from before the route). */
const unknownRoute = () => Response.json({ error: "not_found" }, { status: 404 });

const BUNDLE_UNAVAILABLE = "The bundle is unavailable for this operation. Check your bundle access with a workspace administrator.";

/** The refusal of a page whose listing moved since the first page pinned it. */
const restart = () => Response.json({ error: { code: "concurrent_change", message: "The bundle changed since the first page. Start again from the first page.", retryable: true } }, { status: 409 });

const onlyKeys = (body: Record<string, unknown>, allowed: readonly string[]) => Object.keys(body).every((key) => allowed.includes(key));

/** The strict input of each write (the outcome route takes the body of the write it identifies). */
const WRITE_BODY_KEYS = {
  create: ["bundleId", "documentId", "expectAbsent", "frontmatter", "body"],
  replace: ["bundleId", "documentId", "expectedVersion", "frontmatter", "body"],
  delete: ["bundleId", "documentId", "expectedVersion"],
} as const;

const outcomeOf = (body: Record<string, unknown>): keyof typeof WRITE_BODY_KEYS => (body.expectAbsent === true ? "create" : body.body === undefined ? "delete" : "replace");

/** The working copy routes' answer for a bundle no admitted workspace serves (the export's golden exchange). */
function bundleNotFound(): Response {
  const { response } = syncFixture("export-404-bundle-not-found");
  return new Response(response.body, { status: response.status, headers: response.headers });
}

function failure(operationId: string, code: string, currentVersion?: string): Record<string, unknown> {
  return {
    ok: false,
    operationId,
    error: { code, message: `refused: ${code}`, retryable: false, writeState: "not_applied", ...(currentVersion ? { currentVersion } : {}) },
  };
}
