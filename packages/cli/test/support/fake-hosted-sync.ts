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
// - `/export` (superbee-hosted PR 650, `src/sync-v1-export.ts`): the portable export of the fake's
//   bundle as the host writes it (`fake-export-archive.ts`): the documents' stored bytes, the root
//   index, and any reserved files or blobs a test adds to `exportExtras`; a 404 `bundle_not_found`
//   for another bundle and a 400 `invalid_input` for any body but `{ bundleId }`.
// Every answer shape is held to the `/sync/v1` golden exchanges captured from the real hosted
// gateway (core's `test/fixtures/hosted-sync-v1/`) by `hosted-fake-contract.test.ts`; the export
// answers are held to them byte for byte.
// The host stores its own serialization (the managed `superbee_updated_by` field added), so a
// committed version is never the client's local version, as on the real host.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { headsDigest, stringifyDoc } from "@superbee/core";
import { versionOfBytes } from "@superbee/core/versioning";

import { exportArchive, type ExportState } from "./fake-export-archive.js";

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
}

const WRITE_REQUEST = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BINDING = /^sha256:[a-f0-9]{64}$/;

export interface Tombstone {
  tombstone: string;
  deletedVersion: string;
  revision: number;
}

export class FakeHost {
  readonly docs = new Map<string, HostedDoc>();
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
  /** What a test does to the archive bytes before they are answered (truncate, tamper). */
  exportHook: ((archive: Uint8Array) => Uint8Array | Response) | undefined;
  capabilities: string;
  principal: string;
  readonly origin: string;
  readonly token: string;
  private readonly rootVersion: string;
  private readonly options: FakeHostOptions;

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
    }
  }

  /** A change made on the host (another person, or the app). */
  put(id: string, frontmatter: Record<string, unknown>, body: string): string {
    const stored = { ...frontmatter, superbee_updated_by: "someone-else" };
    const raw = stringifyDoc(stored as never, body);
    const version = versionOfBytes(raw);
    this.docs.set(id, { frontmatter: stored, body, version, raw });
    return version;
  }

  remove(id: string): void {
    this.docs.delete(id);
  }

  /** A delete made on the host by someone else (another checkout's sync): it leaves a tombstone. */
  deleteWithTombstone(id: string): string {
    const doc = this.docs.get(id);
    assert.ok(doc, `the host has ${id}`);
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
    this.requests.push({ path: url.pathname, body, headers });
    assert.equal(url.origin, this.origin);
    assert.equal(init?.method, "POST");
    if (headers.get("authorization") !== `Bearer ${this.token}`) {
      const refusal = syncFixture("read-401-unauthenticated").response;
      return new Response(refusal.body, { status: refusal.status, headers: refusal.headers });
    }
    if (this.options.syncSurface === false) return Response.json({ error: "access_denied" }, { status: 403 });
    const route = url.pathname.replace(/^\/sync\/v1\//, "");
    if (this.unavailable && (route === "heads" || route === "snapshot")) {
      return Response.json({ error: { code: "backend_unavailable", message: "The bundle backend is unavailable.", retryable: true } }, { status: 503 });
    }
    switch (route) {
      case "whoami":
        return Response.json({ principalId: this.principal, credentialId: "cli", tenantIds: this.options.tenants ?? ["tenant-a"], surface: "sync" });
      case "bundles":
        return Response.json({
          ok: true,
          operationId: "bundles.list.v1",
          data: { bundles: (this.options.bundles ?? [BUNDLE]).map((bundleId) => ({ bundleId, name: bundleId, purpose: "", domains: [], lifecycle: "active", sensitivity: "internal" })) },
        });
      case "capabilities": {
        assert.equal(body.bundleId, BUNDLE);
        const { response } = fixture(this.capabilities);
        return new Response(response.body, { status: response.status, headers: response.headers });
      }
      case "heads": {
        assert.equal(body.bundleId, BUNDLE);
        const listing = this.heads();
        const common = { etag: `"${listing.digest}"`, "x-superbee-root-version": this.rootVersion };
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
      case "export":
        return this.export(body);
      case "create":
      case "replace":
      case "delete":
      case "outcome":
        return this.write(route, body, headers);
      default:
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
    }
  }) as typeof fetch;

  /** The root index the host serves: the capabilities answer's `root.content`. */
  rootIndex(): string {
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

  private export(body: Record<string, unknown>): Response {
    if (!onlyKeys(body, ["bundleId"]) || typeof body.bundleId !== "string") return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
    const state = this.currentExportState();
    if (body.bundleId !== state.bundleId) {
      return Response.json(
        { error: { code: "bundle_not_found", message: "The bundle is unavailable for this operation. Check your bundle access with a workspace administrator.", retryable: false } },
        { status: 404 },
      );
    }
    const archive = exportArchive(state, this.exportedAt());
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
    const call: WriteCall = { route, requestId, binding, recreate, body };
    this.writes.push(call);
    if (!requestId || !WRITE_REQUEST.test(requestId) || !binding || !BINDING.test(binding) || !onlyKeys(body, WRITE_BODY_KEYS[route === "outcome" ? outcomeOf(body) : route])) {
      return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
    }
    // The acknowledgement is a create's (and its outcome's) alone, and a version.
    const creates = route === "create" || (route === "outcome" && body.expectAbsent === true);
    if (recreate !== null && (!creates || !BINDING.test(recreate))) return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
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
    if (!recorded) {
      recorded = hooked?.kind === "record" ? { result: failure(operationId, hooked.code) } : route === "delete" ? this.applyDelete(body) : this.apply(route, operationId, body, recreate);
      this.recorded.set(requestId, recorded);
    }
    if (hooked?.kind === "apply-then-drop") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(recorded.result), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "x-superbee-write-settled": requestId } });
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
      return answer(this.tombstone(id, expected), true);
    }
    const latest = this.latestTombstone(id);
    if (latest && latest.deletedVersion === expected) return answer(latest.tombstone, false);
    return { result: failure(operationId, "document_not_found") };
  }

  private apply(route: "create" | "replace", operationId: string, body: Record<string, unknown>, recreate: string | null = null): Recorded {
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

function failure(operationId: string, code: string, currentVersion?: string): Record<string, unknown> {
  return {
    ok: false,
    operationId,
    error: { code, message: `refused: ${code}`, retryable: false, writeState: "not_applied", ...(currentVersion ? { currentVersion } : {}) },
  };
}
