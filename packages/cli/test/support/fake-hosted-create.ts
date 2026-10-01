// A stateful fake of `bundles.create.v1` (`POST /sync/v1/bundle-create`) and of the read routes
// a checkout of the created bundle uses, for `superbee publish` tests. No request leaves the
// process: the fake is a `fetch`.
//
// It answers as the hosted route does (superbee-hosted `docs/person-bundle-create.md`), and every
// answer shape is held to the golden exchanges captured from the real gateway (core's
// `test/fixtures/hosted-bundle-create-v1/`) by `hosted-create-fake-contract.test.ts`:
// - a request is identified by `X-Superbee-Write-Request` (a v4 UUID, else `400 invalid_input`);
//   the same identity with the same contents replays its answer (or finishes a reserved one), with
//   other contents is `request_conflict`;
// - the request schema: at most 1,000 documents (else `400 invalid_input`), a root `index.md`;
// - `workspace_not_found`, `bundle_create_unavailable`, `bundle_exists`, `document_id_collision`
//   (paths that fold together), `429 bundle_create_limit`, and `503 write_outcome_unknown` once
//   when `failNextCreate` is set (the same request then completes);
// - the staged creation (`bundle-create-begin`, `-stage`, `-blob`, `-commit`, superbee-hosted
//   `src/sync-v1-bundle-stage.ts`): a manifest under the same request id (another manifest
//   replaces it until the commit reserves, then is `request_conflict`; at most 3 open per
//   workspace, else `429 bundle_create_limit`), parts whose
//   every object must be its manifest entry's version and size (`validation_failed`), never
//   overlap what is staged (`validation_failed`), and keep the part bounds (500 objects, 3 MiB,
//   400 parts), raw blobs of exactly their declared size and version (else `400 invalid_input`),
//   then commits that answer `staging` with what is `missing`, reserve, answer `importing` for
//   `commitSteps` calls, and finish with the one-shot's own success answer. A plan hash with no
//   manifest is the host's `400 invalid_input` "Send bundle-create-begin again". Tests reach in
//   with `failNextCommit` (503 after reserving), `sweepStaging()` (the host's expiry sweep:
//   manifests and staged content go), `dropStagedBlobs()`, `interrupt` (the connection drops
//   at a given request, before or after the host applied it) and `onRequest`;
// - the created bundle is then served over whoami, bundles, capabilities (with its root), heads
//   and snapshot, in the host's own serialization (the managed `superbee_updated_by` field added).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { blobVersion, headsDigest, parseMarkdown, stringifyDoc } from "@superbee/core";
import { versionOfBytes } from "@superbee/core/versioning";

import { fixture, HOST, PRINCIPAL, TOKEN } from "./fake-hosted-sync.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The `bundles.create.v1` golden exchanges, captured from the real hosted gateway. */
export const CREATE_FIXTURES = path.resolve(here, "../../../core/test/fixtures/hosted-bundle-create-v1");

export function createFixture(name: string): { route: string; request: { headers: Record<string, string>; body: string }; response: { status: number; headers: Record<string, string>; body: string } } {
  return JSON.parse(readFileSync(path.join(CREATE_FIXTURES, `${name}.json`), "utf8"));
}

const WRITE_REQUEST = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION = "bundles.create.v1";

interface CreatedBundle {
  readonly workspace: string;
  readonly name: string;
  readonly docs: Map<string, { frontmatter: Record<string, unknown>; body: string; version: string }>;
  readonly root: { content: string; version: string } | null;
  readonly reserved: { dir: string; name: string; content: string }[];
  readonly blobs: { key: string; contentType: string; base64: string }[];
  readonly history: Record<string, unknown>[];
}

/** The staged routes this fake serves. */
export const STAGED_ROUTES = Object.freeze(["bundle-create-begin", "bundle-create-stage", "bundle-create-blob", "bundle-create-commit"] as const);
type StagedRoute = (typeof STAGED_ROUTES)[number];

/** The host's staged bounds (superbee-hosted `PERSON_BUNDLE_STAGE_BOUNDS`). */
export const FAKE_STAGE_BOUNDS = Object.freeze({
  documents: 10_000,
  reserved: 1_000,
  blobs: 1_000,
  history: 5_000,
  documentBytes: 64 * 1024,
  blobBytes: 16 * 1024 * 1024,
  currentBytes: 64 * 1024 * 1024,
  historyBytes: 64 * 1024 * 1024,
  manifestBytes: 3 * 1024 * 1024,
  partBytes: 3 * 1024 * 1024,
  partObjects: 500,
  parts: 400,
  missingListed: 1_000,
  openCreations: 3,
});

interface ManifestEntry {
  readonly version: string;
  readonly bytes: number;
}
interface StagedManifest {
  readonly workspace: string;
  readonly bundleId: string;
  readonly name: string;
  readonly root: string;
  readonly conventions: { id: string; frontmatter: Record<string, unknown>; body: string }[];
  readonly documents: (ManifestEntry & { id: string })[];
  readonly reserved: (ManifestEntry & { dir: string; name: string })[];
  readonly blobs: (ManifestEntry & { key: string; contentType: string })[];
  readonly history: (ManifestEntry & { documentId: string; ordinal: number; label: string; author: string | null; authoredAt: string })[];
}
/** One staged creation, by request id. */
interface StagedCreation {
  readonly requestId: string;
  readonly digest: string;
  readonly planHash: string;
  readonly manifest: StagedManifest;
  /** Every non-blob version with its declared size, and every blob version with its. */
  readonly versions: Map<string, number>;
  readonly blobVersions: Map<string, number>;
  /** False once the expiry sweep removed the manifest. */
  kept: boolean;
  /** The stored text of each staged version. */
  readonly staged: Map<string, string>;
  readonly blobs: Map<string, Uint8Array>;
  parts: number;
  reserved: boolean;
  created: { body: string; headers: Record<string, string> } | null;
}

/** Where the connection drops: at the `after`+1st request to `route`, before the host saw it, or after it applied it. */
export interface FakeInterrupt {
  readonly route: string;
  readonly after: number;
  readonly applied: boolean;
}

const MANIFEST_KEYS = ["workspace", "bundleId", "name", "root", "conventions", "documents", "reserved", "blobs", "history"];
const PART_KEYS = ["workspace", "bundleId", "planHash", "documents", "reserved", "history"];
const VERSION = /^sha256:[0-9a-f]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
const size = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");
const invalidInput = () => Response.json({ error: { code: "invalid_input" } }, { status: 400 });
const noManifest = () => refusal("staged_manifest_missing", "No staged manifest for this creation and plan hash. Send bundle-create-begin again, then retry.");
const outcomeUnknown = () =>
  Response.json({ error: { code: "write_outcome_unknown", message: "The bundle may be partly created. Send the same request again to finish or confirm it." } }, { status: 503 });
const limitRefusal = (message: string) => Response.json({ error: { code: "bundle_create_limit", message, retryable: false, writeState: "not_applied" } }, { status: 429 });

export interface FakeCreateHostOptions {
  tenants?: string[];
  /** Bundle ids already held in every workspace. */
  taken?: string[];
  /** The per-person create limit; unlimited when absent (D1). */
  limit?: number;
  /** Creation is not offered (`bundle_create_unavailable`). */
  unavailable?: boolean;
  /** Each workspace with its slug, as whoami names them; absent is a host from before qualified references. */
  workspaces?: { tenantId: string; slug: string | null }[];
}

function fold(segment: string): string {
  return segment.normalize("NFKD").toLowerCase().toUpperCase().toLowerCase();
}

function refusal(code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, operationId: OPERATION, error: { code, message, retryable: false, writeState: "not_applied" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export class FakeCreateHost {
  readonly bundles = new Map<string, CreatedBundle>();
  readonly requests: { path: string; body: Record<string, unknown>; headers: Headers }[] = [];
  readonly creates: { requestId: string | null; body: Record<string, unknown> }[] = [];
  /** Answer the next creation `503 write_outcome_unknown` after reserving it. */
  failNextCreate = false;
  /** Answer the next commit that reserves or writes `503 write_outcome_unknown`, after reserving. */
  failNextCommit = false;
  /** Commit calls after the reservation that answer `importing` before the bundle is created. */
  commitSteps = 0;
  /** Drop the connection once, at one request (see {@link FakeInterrupt}). */
  interrupt: FakeInterrupt | null = null;
  /** Runs before the host answers each request: the route and its count so far, this one included. */
  onRequest: ((route: string, count: number) => void) | null = null;
  /** Staged creations by request id. */
  readonly staged = new Map<string, StagedCreation>();
  /** Requests per route, for {@link interrupt}. */
  readonly routeCounts = new Map<string, number>();
  /** Serve no reads of created bundles (a host that is unreachable right after the creation). */
  hideCreated = false;
  private readonly recorded = new Map<string, { digest: string; status: number; body: string; headers: Record<string, string> }>();
  private readonly reservedIds = new Map<string, string>();
  /** The contents digest each reserved request id was reserved with. */
  private readonly reservedDigests = new Map<string, string>();
  private count = 0;
  private readonly options: FakeCreateHostOptions;

  constructor(options: FakeCreateHostOptions = {}) {
    this.options = options;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const route = url.pathname.replace(/^\/sync\/v1\//, "");
    const count = (this.routeCounts.get(route) ?? 0) + 1;
    this.routeCounts.set(route, count);
    this.onRequest?.(route, count);
    const cut = this.interrupt !== null && this.interrupt.route === route && count === this.interrupt.after + 1 ? this.interrupt : null;
    if (cut) {
      this.interrupt = null;
      if (!cut.applied) throw new TypeError("fetch failed: the connection dropped before the host answered");
      await this.answer(url, route, init);
      throw new TypeError("fetch failed: the connection dropped after the host applied the request");
    }
    return this.answer(url, route, init);
  }) as typeof fetch;

  private async answer(url: URL, route: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    assert.equal(url.origin, HOST);
    assert.equal(init?.method, "POST");
    if (route === "bundle-create-blob") {
      this.requests.push({ path: url.pathname, body: {}, headers });
      if (headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: { code: "unauthenticated" } }, { status: 401 });
      return this.blob(headers, init?.body);
    }
    const text = init?.body ? String(init.body) : "{}";
    const body = JSON.parse(text) as Record<string, unknown>;
    this.requests.push({ path: url.pathname, body, headers });
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: { code: "unauthenticated" } }, { status: 401 });
    const tenants = this.options.tenants ?? ["tenant:a"];
    if (route === "whoami") {
      return Response.json({ principalId: PRINCIPAL, credentialId: "cli", tenantIds: tenants, ...(this.options.workspaces ? { workspaces: this.options.workspaces } : {}), surface: "sync" });
    }
    if (route === "bundles") {
      return Response.json({
        ok: true,
        operationId: "bundles.list.v1",
        data: { bundles: [...this.bundles].map(([bundleId, b]) => ({ bundleId, name: b.name, purpose: "", domains: [], lifecycle: "active", sensitivity: "private" })) },
      });
    }
    if (route === "bundle-create") return this.create(text, body, headers, tenants);
    if (route === "bundle-create-begin") return this.begin(text, body, headers, tenants);
    if (route === "bundle-create-stage") return this.stage(text, body, headers);
    if (route === "bundle-create-commit") return this.commit(body, headers);
    if (this.hideCreated) return Response.json({ error: { code: "unavailable" } }, { status: 503 });
    // A qualified reference names the created bundle when its slug is the first workspace's (where the fake creates).
    const named = String(body.bundleId);
    const at = named.indexOf("/");
    const bare = at < 0 ? named : named.slice(0, at) === this.options.workspaces?.[0]?.slug ? named.slice(at + 1) : "";
    const bundle = this.bundles.get(bare);
    if (!bundle) return Response.json({ ok: false, operationId: "documents.read.v1", error: { code: "bundle_not_found", message: "The bundle is unavailable for this operation.", retryable: false } });
    if (route === "capabilities") {
      const base = JSON.parse(fixture("capabilities-operations").response.body) as Record<string, unknown>;
      return Response.json({ ...base, root: bundle.root });
    }
    const listing = this.heads(bundle);
    if (route === "heads") {
      const common = { etag: `"${listing.digest}"`, "x-superbee-root-version": bundle.root?.version ?? "none" };
      if (body.ifNoneMatch === listing.digest) return new Response(null, { status: 304, headers: common });
      return new Response(JSON.stringify(listing), { status: 200, headers: { "content-type": "application/json; charset=utf-8", ...common } });
    }
    if (route === "snapshot") {
      const lines = [JSON.stringify({ kind: "snapshot", count: listing.count, digest: listing.digest })];
      for (const head of listing.heads) {
        const doc = bundle.docs.get(head.id)!;
        lines.push(JSON.stringify({ kind: "doc", id: head.id, version: doc.version, frontmatter: doc.frontmatter, body: doc.body }));
      }
      lines.push(JSON.stringify({ kind: "end", count: listing.count }));
      return new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8", etag: `"${listing.digest}"` } });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  }

  private heads(bundle: CreatedBundle) {
    const heads = [...bundle.docs].map(([id, doc]) => ({ id, version: doc.version })).sort((a, b) => (a.id < b.id ? -1 : 1));
    return { count: heads.length, digest: headsDigest(heads), heads };
  }

  private create(text: string, body: Record<string, unknown>, headers: Headers, tenants: string[]): Response {
    const requestId = headers.get("x-superbee-write-request");
    this.creates.push({ requestId, body });
    const documents = body.documents as { id: string; frontmatter: Record<string, unknown>; body: string }[] | undefined;
    const reserved = (body.reserved ?? []) as { dir: string; name: string; content: string }[];
    const blobs = (body.blobs ?? []) as { key: string; contentType: string; base64: string }[];
    const history = (body.history ?? []) as Record<string, unknown>[];
    if (!requestId || !WRITE_REQUEST.test(requestId) || typeof body.workspace !== "string" || typeof body.bundleId !== "string" || !Array.isArray(documents) || documents.length > 1000) {
      return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
    }
    const digest = versionOfBytes(text);
    const earlier = this.recorded.get(requestId);
    if (earlier) {
      if (earlier.digest !== digest) return refusal("request_conflict", "This request id was already used for a different bundle or different contents.");
      return new Response(earlier.body, { status: earlier.status, headers: earlier.headers });
    }
    // A reserved, unfinished request is identified by its contents too (the creation ledger).
    const reservedDigest = this.reservedDigests.get(requestId);
    if (reservedDigest !== undefined && reservedDigest !== digest) return refusal("request_conflict", "This request id was already used for a different bundle or different contents.");
    if (!tenants.includes(body.workspace)) return refusal("workspace_not_found", "That workspace is not one of yours. Nothing was created.");
    if (this.options.unavailable) return refusal("bundle_create_unavailable", "This workspace does not offer bundle creation for this client. Nothing was created.");
    const bundleId = body.bundleId;
    const holder = this.reservedIds.get(bundleId);
    if ((this.options.taken ?? []).includes(bundleId) || this.bundles.has(bundleId) || (holder !== undefined && holder !== requestId)) {
      return refusal("bundle_exists", "That bundle id is taken. Choose another. Nothing was created.");
    }
    const paths = [...documents.map((doc) => `${doc.id}.md`), ...reserved.map((r) => (r.dir === "" ? r.name : `${r.dir}/${r.name}`)), ...blobs.map((b) => b.key)];
    const folded = new Set<string>();
    for (const file of paths) {
      const key = file.split("/").map(fold).join("/");
      if (folded.has(key)) return refusal("document_id_collision", "Two paths in the bundle would be one file on a case-insensitive disk. Nothing was created.");
      folded.add(key);
    }
    if (holder === undefined) {
      if (this.options.limit !== undefined && this.count >= this.options.limit) {
        return Response.json({ error: { code: "bundle_create_limit", message: "Your bundle creation limit in this workspace is used up. Nothing was created.", retryable: false, writeState: "not_applied" } }, { status: 429 });
      }
      this.count += 1;
      this.reservedIds.set(bundleId, requestId);
      this.reservedDigests.set(requestId, digest);
    }
    if (this.failNextCreate) {
      this.failNextCreate = false;
      return Response.json({ error: { code: "write_outcome_unknown", message: "The bundle may be partly created. Send the same request again to finish or confirm it." } }, { status: 503 });
    }
    const docs = new Map<string, { frontmatter: Record<string, unknown>; body: string; version: string }>();
    for (const doc of documents) {
      const frontmatter = { ...doc.frontmatter, superbee_updated_by: PRINCIPAL };
      docs.set(doc.id, { frontmatter, body: doc.body, version: versionOfBytes(stringifyDoc(frontmatter as never, doc.body)) });
    }
    const rootFile = reserved.find((r) => r.dir === "" && r.name === "index.md");
    this.bundles.set(bundleId, {
      workspace: body.workspace,
      name: String(body.name ?? bundleId),
      docs,
      root: rootFile ? { content: rootFile.content, version: versionOfBytes(rootFile.content) } : null,
      reserved,
      blobs,
      history,
    });
    const answer = JSON.stringify({
      ok: true,
      operationId: OPERATION,
      data: { workspace: body.workspace, bundleId, access: "write", documents: documents.length, reserved: reserved.length, blobs: blobs.length, history: { imported: history.length, verified: false } },
    });
    const answerHeaders = { "content-type": "application/json; charset=utf-8", "x-superbee-write-settled": requestId };
    this.recorded.set(requestId, { digest, status: 200, body: answer, headers: answerHeaders });
    return new Response(answer, { status: 200, headers: answerHeaders });
  }

  /** The host's expiry sweep: every staged manifest and everything staged under it goes; reservations stay. */
  sweepStaging(): void {
    for (const creation of this.staged.values()) {
      if (creation.created) continue;
      creation.kept = false;
      creation.staged.clear();
      creation.blobs.clear();
      creation.parts = 0;
    }
  }

  /** Every staged blob goes (the host finds one gone while it writes). */
  dropStagedBlobs(): void {
    for (const creation of this.staged.values()) creation.blobs.clear();
  }

  /** The staged routes this request id's creation has reached, by state. */
  stagedState(requestId: string): "staging" | "importing" | "created" | null {
    const creation = this.staged.get(requestId);
    if (!creation) return null;
    return creation.created ? "created" : creation.reserved ? "importing" : "staging";
  }

  private stagedRequest(headers: Headers): string | null {
    const requestId = headers.get("x-superbee-write-request");
    return requestId !== null && WRITE_REQUEST.test(requestId) ? requestId : null;
  }

  /** The workspace and id refusals every staged route shares with the one-shot. */
  private admission(workspace: unknown, bundleId: unknown, tenants: readonly string[]): Response | null {
    if (typeof workspace !== "string" || typeof bundleId !== "string") return invalidInput();
    if (!tenants.includes(workspace)) return refusal("workspace_not_found", "That workspace is not one of yours. Nothing was created.");
    if (this.options.unavailable) return refusal("bundle_create_unavailable", "This workspace does not offer bundle creation for this client. Nothing was created.");
    return null;
  }

  private status(creation: StagedCreation, written = false): Response {
    const state = creation.created ? "created" : creation.reserved ? "importing" : "staging";
    const missing = {
      versions: [...creation.versions.keys()].filter((v) => !creation.staged.has(v)).sort(),
      blobs: [...creation.blobVersions].filter(([v, bytes]) => creation.blobs.get(v)?.byteLength !== bytes).map(([v]) => v).sort(),
    };
    if (creation.created) {
      missing.versions = [];
      missing.blobs = [];
    }
    const distinct = new Map<string, number>([...creation.versions, ...creation.blobVersions]);
    const m = creation.manifest;
    return new Response(
      JSON.stringify({
        ok: true,
        operationId: OPERATION,
        data: {
          state,
          planHash: creation.planHash,
          expected: { documents: m.documents.length, reserved: m.reserved.length, blobs: m.blobs.length, history: m.history.length, versions: creation.versions.size, blobVersions: creation.blobVersions.size, bytes: [...distinct.values()].reduce((a, b) => a + b, 0) },
          staged: { versions: creation.versions.size - missing.versions.length, blobVersions: creation.blobVersions.size - missing.blobs.length },
          missing: { versions: missing.versions.slice(0, FAKE_STAGE_BOUNDS.missingListed), blobs: missing.blobs.slice(0, FAKE_STAGE_BOUNDS.missingListed) },
          ...(written ? { written: { documents: 0, reserved: 0, blobs: 0, history: 0 } } : {}),
        },
      }),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  /** The manifest as the host checks it before anything is kept, or the refusal. */
  private manifestOf(body: Record<string, unknown>): StagedManifest | Response {
    if (!onlyKeys(body, MANIFEST_KEYS) || typeof body.root !== "string" || !Array.isArray(body.documents) || !Array.isArray(body.reserved) || body.reserved.length < 1) return invalidInput();
    const conventions = (body.conventions ?? []) as unknown[];
    const blobs = (body.blobs ?? []) as unknown[];
    const history = (body.history ?? []) as unknown[];
    if (!Array.isArray(conventions) || !Array.isArray(blobs) || !Array.isArray(history)) return invalidInput();
    if (body.name !== undefined && typeof body.name !== "string") return invalidInput();
    const entry = (value: unknown, keys: string[]): value is Record<string, unknown> => onlyKeys(value, [...keys, "version", "bytes"]) && typeof value.version === "string" && VERSION.test(value.version) && size(value.bytes);
    if (!body.documents.every((d) => entry(d, ["id"]) && typeof d.id === "string")) return invalidInput();
    if (!body.reserved.every((r) => entry(r, ["dir", "name"]) && typeof r.dir === "string" && (r.name === "index.md" || r.name === "log.md"))) return invalidInput();
    if (!blobs.every((b) => entry(b, ["key", "contentType"]) && typeof b.key === "string" && typeof b.contentType === "string")) return invalidInput();
    if (!history.every((h) => entry(h, ["documentId", "ordinal", "label", "author", "authoredAt"]) && typeof h.documentId === "string" && Number.isSafeInteger(h.ordinal) && typeof h.label === "string" && (h.author === undefined || typeof h.author === "string") && typeof h.authoredAt === "string")) return invalidInput();
    if (!conventions.every((c) => onlyKeys(c, ["id", "frontmatter", "body"]) && typeof c.id === "string" && isRecord(c.frontmatter) && typeof c.body === "string")) return invalidInput();
    const m: StagedManifest = {
      workspace: String(body.workspace),
      bundleId: String(body.bundleId),
      name: String(body.name ?? body.bundleId),
      root: body.root,
      conventions: conventions as StagedManifest["conventions"],
      documents: body.documents as StagedManifest["documents"],
      reserved: body.reserved as StagedManifest["reserved"],
      blobs: blobs as StagedManifest["blobs"],
      history: (history as Record<string, unknown>[]).map((h) => ({ ...(h as unknown as StagedManifest["history"][number]), author: (h.author as string | undefined) ?? null })),
    };
    const bounds = FAKE_STAGE_BOUNDS;
    const tooLarge = (message: string) => refusal("result_too_large", `${message} Nothing was created.`);
    if (m.documents.length > bounds.documents) return tooLarge(`The bundle holds more than ${bounds.documents} documents, the staged creation bound.`);
    if (m.reserved.length > bounds.reserved) return tooLarge(`The bundle holds more than ${bounds.reserved} reserved files, the staged creation bound.`);
    if (m.blobs.length > bounds.blobs) return tooLarge(`The bundle holds more than ${bounds.blobs} blobs, the staged creation bound.`);
    if (m.history.length > bounds.history) return tooLarge(`The bundle holds more than ${bounds.history} imported versions, the staged creation bound. Publish without history, or with less of it.`);
    if ([...m.documents, ...m.reserved, ...m.history].some((e) => e.bytes > bounds.documentBytes)) return tooLarge("A document, reserved file or imported version exceeds 64 KiB.");
    if (m.blobs.some((b) => b.bytes > bounds.blobBytes)) return tooLarge("A blob exceeds 16 MiB.");
    const sizes = new Map<string, number>();
    for (const e of [...m.documents, ...m.reserved, ...m.blobs, ...m.history]) {
      if (sizes.has(e.version) && sizes.get(e.version) !== e.bytes) return refusal("validation_failed", "Two entries with the same version declare different sizes. Nothing was created.");
      sizes.set(e.version, e.bytes);
    }
    const distinct = (list: readonly ManifestEntry[]) => [...new Map(list.map((e) => [e.version, e.bytes])).values()].reduce((a, b) => a + b, 0);
    if (distinct([...m.documents, ...m.reserved, ...m.blobs]) > bounds.currentBytes) return tooLarge("The bundle's current state exceeds 64 MiB, the staged creation bound.");
    if (distinct(m.history) > bounds.historyBytes) return tooLarge("The bundle's imported history exceeds 64 MiB, the staged creation bound. Publish without history, or with less of it.");
    const paths = [...m.documents.map((d) => `${d.id}.md`), ...m.reserved.map((r) => (r.dir === "" ? r.name : `${r.dir}/${r.name}`)), ...m.blobs.map((b) => b.key)];
    const folded = new Set<string>();
    for (const file of paths) {
      const key = file.split("/").map(fold).join("/");
      if (folded.has(key)) return refusal("document_id_collision", "Two paths in the bundle differ only by case or Unicode form. Nothing was created.");
      folded.add(key);
    }
    const root = m.reserved.find((r) => r.dir === "" && r.name === "index.md");
    if (!root || root.version !== versionOfBytes(m.root) || root.bytes !== utf8Bytes(m.root)) return refusal("validation_failed", "The root index.md listed in reserved is not the one sent as root. Nothing was created.");
    const held = new Set(m.documents.map((d) => d.id));
    const ordinals = new Map<string, number>();
    for (const h of m.history) {
      if (!held.has(h.documentId)) return refusal("validation_failed", "Imported history names a document the bundle does not hold. Nothing was created.");
      if (!Number.isFinite(Date.parse(h.authoredAt)) || new Date(h.authoredAt).toISOString() !== h.authoredAt) return refusal("validation_failed", "Imported history's date is not in its normalized form. Nothing was created.");
      const ordinal = (ordinals.get(h.documentId) ?? 0) + 1;
      if (h.ordinal !== ordinal) return refusal("validation_failed", "Imported history's ordinals are not 1, 2, … in order for each document. Nothing was created.");
      ordinals.set(h.documentId, ordinal);
    }
    const documents = new Map(m.documents.map((d) => [d.id, d]));
    for (const c of m.conventions) {
      const text = stringifyDoc(c.frontmatter as never, c.body);
      const listed = documents.get(c.id);
      if (!listed || listed.version !== versionOfBytes(text) || listed.bytes !== utf8Bytes(text)) return refusal("validation_failed", "A listed convention is not in documents at its version and size. Nothing was created.");
      if (!c.id.startsWith("conventions/") || c.frontmatter.type !== "Convention") return refusal("validation_failed", "A listed convention is not a Kind convention: a document of type Convention under conventions/. Nothing was created.");
    }
    return m;
  }

  private begin(text: string, body: Record<string, unknown>, headers: Headers, tenants: readonly string[]): Response {
    const requestId = this.stagedRequest(headers);
    if (!requestId) return invalidInput();
    if (utf8Bytes(text) > FAKE_STAGE_BOUNDS.manifestBytes) return refusal("result_too_large", "The manifest exceeds 3 MiB, the staged creation bound. Publish without history, or with fewer files. Nothing was created.");
    const m = this.manifestOf(body);
    if (m instanceof Response) return m;
    const refused = this.admission(m.workspace, m.bundleId, tenants);
    if (refused) return refused;
    // One manifest has one digest whatever order its lists arrive in; the plan hash follows the history's order.
    const sorted = <T>(list: readonly T[], key: (item: T) => string) => [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const digest = versionOfBytes(JSON.stringify([m.workspace, m.bundleId, m.name, m.root, sorted(m.conventions, (c) => c.id), sorted(m.documents, (d) => d.id), sorted(m.reserved, (r) => `${r.dir}/${r.name}`), sorted(m.blobs, (b) => b.key), sorted(m.history, (h) => `${h.documentId}\n${String(h.ordinal).padStart(8, "0")}`)]));
    const planHash = versionOfBytes(JSON.stringify(["plan", m.bundleId, m.name, m.documents.map((d) => [d.id, d.version]).sort(), m.history.map((h) => [h.documentId, h.ordinal, h.label, h.authoredAt, h.version])]));
    let prior = this.staged.get(requestId);
    // Another manifest under the request id replaces an unreserved one; a reserved one is the request's.
    if ((prior?.reserved && prior.digest !== digest) || this.reservedDigests.has(requestId)) return refusal("request_conflict", "This request id was already used for a different bundle or different contents.");
    if (prior && prior.digest !== digest) {
      this.staged.delete(requestId);
      prior = undefined;
    }
    if (prior) {
      // After the sweep removed it, the manifest is kept again under the same plan.
      prior.kept = true;
      return this.status(prior);
    }
    const bundleId = m.bundleId;
    const holder = this.reservedIds.get(bundleId);
    if ((this.options.taken ?? []).includes(bundleId) || this.bundles.has(bundleId) || (holder !== undefined && holder !== requestId)) return refusal("bundle_exists", "That bundle id is taken. Choose another. Nothing was created.");
    if (this.options.limit !== undefined && this.count >= this.options.limit) return limitRefusal("Your bundle creation limit in this workspace is used up. Nothing was created.");
    const open = [...this.staged.values()].filter((c) => !c.reserved && c.kept && c.manifest.workspace === m.workspace).length;
    if (open >= FAKE_STAGE_BOUNDS.openCreations) return limitRefusal(`You have ${FAKE_STAGE_BOUNDS.openCreations} staged creations open in this workspace. Finish one, or wait for one to expire 7 days after it began. Nothing was created.`);
    const creation: StagedCreation = {
      requestId,
      digest,
      planHash,
      manifest: m,
      versions: new Map([...m.documents, ...m.reserved, ...m.history].map((e) => [e.version, e.bytes])),
      blobVersions: new Map(m.blobs.map((b) => [b.version, b.bytes])),
      kept: true,
      staged: new Map(),
      blobs: new Map(),
      parts: 0,
      reserved: false,
      created: null,
    };
    this.staged.set(requestId, creation);
    return this.status(creation);
  }

  /** The creation a staged request names, by its request id and plan hash, or the host's refusal. */
  private creationFor(headers: Headers, workspace: unknown, bundleId: unknown, planHash: unknown): StagedCreation | Response {
    const requestId = this.stagedRequest(headers);
    if (!requestId || typeof planHash !== "string" || !VERSION.test(planHash)) return invalidInput();
    const refused = this.admission(workspace, bundleId, this.options.tenants ?? ["tenant:a"]);
    if (refused) return refused;
    const creation = this.staged.get(requestId);
    if (creation && (creation.planHash !== planHash || creation.manifest.bundleId !== bundleId) && creation.reserved) return refusal("request_conflict", "This request id was already used for a different bundle or different contents.");
    if (!creation || !creation.kept || creation.planHash !== planHash) return noManifest();
    if (creation.manifest.bundleId !== bundleId) return refusal("request_conflict", "This request id was already used for a different bundle or different contents.");
    return creation;
  }

  private stage(text: string, body: Record<string, unknown>, headers: Headers): Response {
    if (utf8Bytes(text) > FAKE_STAGE_BOUNDS.partBytes || !onlyKeys(body, PART_KEYS)) return invalidInput();
    const documents = (body.documents ?? []) as Record<string, unknown>[];
    const reserved = (body.reserved ?? []) as Record<string, unknown>[];
    const history = (body.history ?? []) as Record<string, unknown>[];
    if (!Array.isArray(documents) || !Array.isArray(reserved) || !Array.isArray(history)) return invalidInput();
    if (!documents.every((d) => onlyKeys(d, ["id", "frontmatter", "body"]) && typeof d.id === "string" && isRecord(d.frontmatter) && typeof d.body === "string")) return invalidInput();
    if (!reserved.every((r) => onlyKeys(r, ["dir", "name", "content"]) && typeof r.dir === "string" && typeof r.name === "string" && typeof r.content === "string")) return invalidInput();
    if (!history.every((h) => onlyKeys(h, ["documentId", "ordinal", "label", "author", "authoredAt", "frontmatter", "body"]) && typeof h.documentId === "string" && Number.isSafeInteger(h.ordinal) && isRecord(h.frontmatter) && typeof h.body === "string")) return invalidInput();
    const creation = this.creationFor(headers, body.workspace, body.bundleId, body.planHash);
    if (creation instanceof Response) return creation;
    if (creation.created) return this.status(creation);
    const objects = documents.length + reserved.length + history.length;
    if (objects === 0) return refusal("validation_failed", "A part holds no objects. Nothing was created.");
    if (objects > FAKE_STAGE_BOUNDS.partObjects) return refusal("result_too_large", `A part holds more than ${FAKE_STAGE_BOUNDS.partObjects} objects. Nothing was created.`);
    const m = creation.manifest;
    const texts = new Map<string, string>();
    const matches = (named: string, entry: ManifestEntry | undefined, objectText: string): Response | null => {
      if (!entry) return refusal("validation_failed", `A staged object is not in the manifest: ${JSON.stringify(named)}. Nothing was created.`);
      if (entry.version !== versionOfBytes(objectText) || entry.bytes !== utf8Bytes(objectText)) return refusal("validation_failed", `A staged object's version or size is not the manifest's: ${JSON.stringify(named)}. Nothing was created.`);
      texts.set(entry.version, objectText);
      return null;
    };
    for (const doc of documents) {
      const refused = matches(String(doc.id), m.documents.find((d) => d.id === doc.id), stringifyDoc(doc.frontmatter as never, String(doc.body)));
      if (refused) return refused;
    }
    for (const file of reserved) {
      const refused = matches(`${String(file.dir)}/${String(file.name)}`, m.reserved.find((r) => r.dir === file.dir && r.name === file.name), String(file.content));
      if (refused) return refused;
    }
    for (const row of history) {
      const named = m.history.find((h) => h.documentId === row.documentId && h.ordinal === row.ordinal);
      const refused = matches(`${String(row.documentId)} #${String(row.ordinal)}`, named, stringifyDoc(row.frontmatter as never, String(row.body)));
      if (refused) return refused;
      if (named!.label !== row.label || named!.author !== ((row.author as string | undefined) ?? null) || named!.authoredAt !== new Date(String(row.authoredAt)).toISOString()) {
        return refusal("validation_failed", `A staged imported version's label, author or date is not the manifest's: ${JSON.stringify(`${String(row.documentId)} #${String(row.ordinal)}`)}. Nothing was created.`);
      }
    }
    const overlap = [...texts.keys()].filter((v) => creation.staged.has(v));
    if (overlap.length > 0) return refusal("validation_failed", `This part overlaps ${overlap.length} staged ${overlap.length === 1 ? "version" : "versions"}. Stage only what the last answer names as missing. Nothing was created.`);
    if (creation.parts >= FAKE_STAGE_BOUNDS.parts) return refusal("result_too_large", `This creation already holds ${FAKE_STAGE_BOUNDS.parts} parts, the staged creation bound. Pack more objects into each part. Nothing was created.`);
    creation.parts += 1;
    for (const [v, t] of texts) creation.staged.set(v, t);
    return this.status(creation);
  }

  private blob(headers: Headers, raw: unknown): Response {
    if (headers.get("content-type") !== "application/octet-stream" || !(raw instanceof Uint8Array)) return invalidInput();
    const version = headers.get("x-superbee-blob-version");
    const creation = this.creationFor(headers, headers.get("x-superbee-workspace"), headers.get("x-superbee-bundle"), headers.get("x-superbee-plan-hash"));
    if (creation instanceof Response) return creation;
    const declared = version === null ? undefined : creation.blobVersions.get(version);
    if (declared === undefined || declared > FAKE_STAGE_BOUNDS.blobBytes || raw.byteLength !== declared || blobVersion(raw) !== version) return invalidInput();
    if (!creation.created) creation.blobs.set(version!, raw);
    return new Response(JSON.stringify({ ok: true, operationId: OPERATION, data: { version, bytes: raw.byteLength } }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }

  private commit(body: Record<string, unknown>, headers: Headers): Response {
    if (!onlyKeys(body, ["workspace", "bundleId", "planHash"])) return invalidInput();
    const creation = this.creationFor(headers, body.workspace, body.bundleId, body.planHash);
    if (creation instanceof Response) return creation;
    if (creation.created) return new Response(creation.created.body, { status: 200, headers: creation.created.headers });
    const complete = () => creation.staged.size === creation.versions.size && [...creation.blobVersions].every(([v, bytes]) => creation.blobs.get(v)?.byteLength === bytes);
    const m = creation.manifest;
    if (!creation.reserved) {
      if (!complete()) return this.status(creation);
      const holder = this.reservedIds.get(m.bundleId);
      if ((this.options.taken ?? []).includes(m.bundleId) || this.bundles.has(m.bundleId) || (holder !== undefined && holder !== creation.requestId)) return refusal("bundle_exists", "That bundle id is taken. Choose another. Nothing was created.");
      if (this.options.limit !== undefined && this.count >= this.options.limit) return limitRefusal("Your bundle creation limit in this workspace is used up. Nothing was created.");
      this.count += 1;
      this.reservedIds.set(m.bundleId, creation.requestId);
      creation.reserved = true;
    }
    if (this.failNextCommit) {
      this.failNextCommit = false;
      return outcomeUnknown();
    }
    if (!complete()) return this.status(creation, true);
    if (this.commitSteps > 0) {
      this.commitSteps -= 1;
      return this.status(creation, true);
    }
    const docs = new Map<string, { frontmatter: Record<string, unknown>; body: string; version: string }>();
    for (const doc of m.documents) {
      const parsed = parseMarkdown(creation.staged.get(doc.version)!, doc.id);
      const frontmatter = { ...(parsed.frontmatter as Record<string, unknown>), superbee_updated_by: PRINCIPAL };
      docs.set(doc.id, { frontmatter, body: parsed.body ?? "", version: versionOfBytes(stringifyDoc(frontmatter as never, parsed.body ?? "")) });
    }
    this.bundles.set(m.bundleId, {
      workspace: m.workspace,
      name: m.name,
      docs,
      root: { content: m.root, version: versionOfBytes(m.root) },
      reserved: m.reserved.map((r) => ({ dir: r.dir, name: r.name, content: creation.staged.get(r.version)! })),
      blobs: m.blobs.map((b) => ({ key: b.key, contentType: b.contentType, base64: Buffer.from(creation.blobs.get(b.version)!).toString("base64") })),
      history: m.history.map((h) => ({ ...h, text: creation.staged.get(h.version)! })),
    });
    const answer = JSON.stringify({
      ok: true,
      operationId: OPERATION,
      data: { workspace: m.workspace, bundleId: m.bundleId, access: "write", documents: m.documents.length, reserved: m.reserved.length, blobs: m.blobs.length, history: { imported: m.history.length, verified: false } },
    });
    creation.created = { body: answer, headers: { "content-type": "application/json; charset=utf-8", "x-superbee-write-settled": creation.requestId } };
    creation.staged.clear();
    creation.blobs.clear();
    return new Response(answer, { status: 200, headers: creation.created.headers });
  }
}
