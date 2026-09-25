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
// - the created bundle is then served over whoami, bundles, capabilities (with its root), heads
//   and snapshot, in the host's own serialization (the managed `superbee_updated_by` field added).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { headsDigest, stringifyDoc } from "@superbee/core";
import { versionOfBytes } from "@superbee/core/versioning";

import { fixture, HOST, PRINCIPAL, TOKEN } from "./fake-hosted-sync.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The `bundles.create.v1` golden exchanges, captured from the real hosted gateway. */
export const CREATE_FIXTURES = path.resolve(here, "../../../core/test/fixtures/hosted-bundle-create-v1");

export function createFixture(name: string): { request: { headers: Record<string, string>; body: string }; response: { status: number; headers: Record<string, string>; body: string } } {
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

export interface FakeCreateHostOptions {
  tenants?: string[];
  /** Bundle ids already held in every workspace. */
  taken?: string[];
  /** The per-person create limit; unlimited when absent (D1). */
  limit?: number;
  /** Creation is not offered (`bundle_create_unavailable`). */
  unavailable?: boolean;
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
    const headers = new Headers(init?.headers);
    const text = init?.body ? String(init.body) : "{}";
    const body = JSON.parse(text) as Record<string, unknown>;
    this.requests.push({ path: url.pathname, body, headers });
    assert.equal(url.origin, HOST);
    assert.equal(init?.method, "POST");
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: { code: "unauthenticated" } }, { status: 401 });
    const route = url.pathname.replace(/^\/sync\/v1\//, "");
    const tenants = this.options.tenants ?? ["tenant:a"];
    if (route === "whoami") return Response.json({ principalId: PRINCIPAL, credentialId: "cli", tenantIds: tenants, surface: "sync" });
    if (route === "bundles") {
      return Response.json({
        ok: true,
        operationId: "bundles.list.v1",
        data: { bundles: [...this.bundles].map(([bundleId, b]) => ({ bundleId, name: b.name, purpose: "", domains: [], lifecycle: "active", sensitivity: "private" })) },
      });
    }
    if (route === "bundle-create") return this.create(text, body, headers, tenants);
    if (this.hideCreated) return Response.json({ error: { code: "unavailable" } }, { status: 503 });
    const bundle = this.bundles.get(String(body.bundleId));
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
  }) as typeof fetch;

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
}
