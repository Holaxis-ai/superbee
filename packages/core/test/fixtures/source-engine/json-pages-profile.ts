/**
 * A test profile over a paged JSON listing (`{ items, next?, next_url?, has_more? }`), with cursor
 * paging (an opaque `next` token, or a provider-supplied `next_url` requested as given) and
 * page-number paging. It exists for the engine and harness tests; real generic profiles are their
 * own slices. It stays inside the static egress check's allowed globals.
 */
import { unsupportedContent, type SourceProfile } from "../../../src/source-engine/index.js";

export interface JsonPagesSpec {
  host: string;
  /** A path whose `{name}` segments are the bound feed's parameters. */
  path: string;
  paging: "cursor" | "page-number";
  /** Whether a full pass lists every record. */
  complete: boolean;
  method: "GET" | "POST";
}

export interface JsonPagesCursor {
  after?: string;
  url?: string;
  page?: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const jsonPagesProfile: SourceProfile<JsonPagesSpec, JsonPagesCursor> = {
  id: "json-pages",
  version: 1,
  kind: "extension",

  validateSpec(spec) {
    const errors: Array<{ path: string; message: string }> = [];
    if (!record(spec)) return { ok: false, errors: [{ path: "", message: "is a mapping" }] };
    if (typeof spec.host !== "string" || !spec.host) errors.push({ path: "/host", message: "is a hostname" });
    if (typeof spec.path !== "string" || !spec.path.startsWith("/")) errors.push({ path: "/path", message: "starts with /" });
    const paging = spec.paging ?? "cursor";
    if (paging !== "cursor" && paging !== "page-number") errors.push({ path: "/paging", message: "is cursor or page-number" });
    const method = spec.method ?? "GET";
    if (method !== "GET" && method !== "POST") errors.push({ path: "/method", message: "is GET or POST" });
    if (errors.length) return { ok: false, errors };
    return { ok: true, spec: { host: spec.host as string, path: spec.path as string, paging: paging as JsonPagesSpec["paging"], complete: spec.complete !== false, method: method as JsonPagesSpec["method"] } };
  },

  hostsFor: (spec) => [spec.host],

  async observe({ spec, bound, cursor, resumed, transport }) {
    const path = spec.path.replace(/\{([a-z]+)\}/g, (_match, name: string) => encodeURIComponent(bound.parameters[name] ?? ""));
    let url: string;
    let page = 1;
    if (spec.paging === "page-number") {
      // A page number is valid within one pass only, so a resumed pass starts again at page 1.
      page = cursor === null || resumed ? 1 : cursor.page ?? 1;
      const target = new URL(`https://${spec.host}${path}`);
      target.searchParams.set("page", String(page));
      url = target.href;
    } else if (cursor?.url !== undefined) {
      url = cursor.url;
    } else {
      const target = new URL(`https://${spec.host}${path}`);
      if (cursor?.after !== undefined) target.searchParams.set("after", cursor.after);
      url = target.href;
    }
    const response = await transport.request({ url, method: spec.method, headers: { accept: "application/json" } });
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      unsupportedContent("invalid_json");
    }
    if (!record(body) || !Array.isArray(body.items)) unsupportedContent("no items array");
    const items = (body as { items: Array<Record<string, unknown>> }).items;
    if (spec.paging === "page-number") {
      const more = (body as { has_more?: unknown }).has_more === true;
      return { records: items, nextCursor: more ? { page: page + 1 } : null, more, complete: !more && spec.complete };
    }
    const { next, next_url: nextUrl } = body as { next?: unknown; next_url?: unknown };
    const nextCursor = typeof next === "string" ? { after: next } : typeof nextUrl === "string" ? { url: nextUrl } : null;
    return { records: items, nextCursor, more: nextCursor !== null, complete: nextCursor === null && spec.complete };
  },
};
