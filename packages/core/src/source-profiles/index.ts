/** Credential-free declarative profiles. All requests go through the source engine's transport. */
import { validateConnectorRequest, readSourcePath, renderRequestValue } from "../connectors.js";
import type { ConnectorSource } from "../connectors.js";
import type { SourceProfile, ObserveContext } from "../source-engine/types.js";
import { unsupportedContent } from "../source-engine/index.js";

export interface RestJsonCursor {
  token?: string;
  url?: string;
  page?: number;
  offset?: number;
  watermark?: string;
  /** The watermark at the beginning of a pass; stable while that pass pages. */
  since?: string;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const scalar = (v: unknown): v is string | number | boolean | null => v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v);

function put(record: Record<string, unknown>, path: string, value: unknown): void {
  const names = path.split(".");
  let next = record;
  for (const name of names.slice(0, -1)) {
    if (!object(next[name])) next[name] = {};
    next = next[name] as Record<string, unknown>;
  }
  next[names[names.length - 1]!] = value;
}
function transform(value: unknown, type: string | undefined): unknown {
  if (value === undefined || value === null || type === undefined) return value;
  if (!scalar(value)) unsupportedContent("transform requires a scalar");
  switch (type) {
    case "text": return String(value);
    case "integer": {
      if (typeof value === "boolean" || !/^-?\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) unsupportedContent("invalid integer");
      return Number(value);
    }
    case "date":
    case "epoch-date": {
      const ms = type === "epoch-date" ? Number(value) * 1000 : Date.parse(String(value));
      if (!Number.isFinite(ms)) unsupportedContent("invalid date");
      try {return new Date(ms).toISOString();} catch {unsupportedContent("invalid date");}
    }
    case "url": {
      try {
        const url = new URL(String(value));
        if (url.protocol !== "https:" && url.protocol !== "http:" || url.username || url.password) unsupportedContent("invalid URL");
        return url.href;
      } catch {unsupportedContent("invalid URL");}
    }
    default: unsupportedContent("unknown transform");
  }
}

export const restJsonProfile: SourceProfile<ConnectorSource, RestJsonCursor> = Object.freeze({
  id: "rest-json",
  version: 1,
  kind: "generic",
  validateSpec(value: unknown) {
    if (!object(value) || !object(value.identity) || typeof value.identity.resource !== "string" || !object(value.request)) return {ok: false as const, errors: [{path: "/request", message: "rest-json requires a source with identity and request"}]};
    const source = value as unknown as ConnectorSource;
    const errors = validateConnectorRequest(source);
    if (source.request?.graphql) errors.push({path: "/request/graphql", message: "use graphql-cursor for GraphQL"});
    return errors.length ? {ok: false as const, errors} : {ok: true as const, spec: source};
  },
  hostsFor: (source: ConnectorSource) => [source.request!.host],
  async observe(ctx: ObserveContext<ConnectorSource, RestJsonCursor>) {
    const {spec, bound, transport, resumed, mode} = ctx;
    const r = spec.request!;
    const paging = r.paging;
    const previous = ctx.cursor;
    const validCursor = (value: unknown): boolean => value === null || object(value) && Object.entries(value).every(([key, v]) =>
      ["token", "url", "watermark", "since"].includes(key) ? typeof v === "string" : ["page", "offset"].includes(key) && typeof v === "number");
    if (!validCursor(previous)) unsupportedContent("invalid cursor");
    const numeric = paging?.kind === "page-number" || paging?.kind === "offset";
    const start = mode === "complete" && previous === null;
    const page = numeric && resumed ? 1 : previous?.page ?? 1;
    const offset = numeric && resumed ? 0 : previous?.offset ?? 0;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(offset) || offset < 0) unsupportedContent("invalid numeric cursor");
    let since = previous?.since;
    if (since === undefined && previous?.watermark && r.watermark && !start) {
      const ms = Date.parse(previous.watermark) - r.watermark.overlap_seconds * 1000;
      if (!Number.isFinite(ms)) unsupportedContent("invalid watermark");
      since = new Date(ms).toISOString();
    }
    const dynamic = {cursor: previous?.token ?? "", page: String(paging?.kind === "offset" ? offset : page), watermark: since ?? ""};
    const render = (v: string | number | boolean | null) => renderRequestValue(v, bound.parameters, dynamic);
    const path = r.path.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const value = bound.parameters[name] ?? dynamic[name as keyof typeof dynamic];
      if (value === undefined || value === "." || value === "..") unsupportedContent("missing request binding");
      return encodeURIComponent(value);
    });
    const target = new URL(`https://${r.host}${path}`);
    for (const [name, value] of Object.entries(r.query ?? {})) {
      if (value === "{cursor}" && !previous?.token || value === "{watermark}" && !since) continue;
      target.searchParams.set(name, String(render(value)));
    }
    if (paging?.size_param && paging.size) target.searchParams.set(paging.size_param, String(paging.size));
    if (paging?.kind === "page-number") target.searchParams.set(paging.page_param!, String(page));
    if (paging?.kind === "offset") target.searchParams.set(paging.offset_param!, String(offset));
    if (r.watermark && since) target.searchParams.set(r.watermark.param, since);
    const headers = Object.fromEntries(Object.entries(r.headers ?? {accept: "application/json"}).map(([k, v]) => [k, String(render(v))]));
    if (ctx.validators && mode === "incremental") for (const [k,v] of Object.entries(ctx.validators)) headers[k] = v;
    const body = r.body ? JSON.stringify(Object.fromEntries(Object.entries(r.body).map(([k,v]) => [k,render(v)]))) : undefined;
    // Provider URLs are never rendered as templates. The engine checks the provider's listed paging forms.
    const response = await transport.request({url: numeric && resumed ? target.href : previous?.url ?? target.href, method: r.method, headers, ...(body !== undefined ? {body} : {})});
    if (response.status === 304) return {records: [], nextCursor: previous, more: false, complete: false};
    let parsed: unknown;
    try { parsed = JSON.parse(response.body); } catch {unsupportedContent("invalid_json");}
    const items = readSourcePath(parsed, r.items);
    if (!Array.isArray(items) || !items.every(object)) unsupportedContent("items must be an array of records");
    let watermark = previous?.watermark;
    let skipped = 0;
    const records: Record<string, unknown>[] = [];
    for (const item of items as Record<string, unknown>[]) {
      if (r.watermark) {
        const value = readSourcePath(item, r.watermark.field);
        if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) unsupportedContent("invalid record watermark");
        if (!watermark || Date.parse(value) > Date.parse(watermark)) watermark = new Date(value).toISOString();
      }
      if (r.skip?.some(rule => readSourcePath(item, rule.path) !== undefined)) {skipped++; continue;}
      const normalized = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
      for (const [name, field] of Object.entries(r.fields ?? {})) {
        const value = Object.hasOwn(field, "const") ? field.const : transform(readSourcePath(item, field.from!), field.type);
        if (value !== undefined) put(normalized, name, value);
      }
      records.push(normalized);
    }
    let token: string | undefined;
    let url: string | undefined;
    let more = false;
    if (paging?.kind === "link-header") {
      const header = response.headers.link ?? "";
      const links: string[] = [];
      let angle = false;
      let quoted = false;
      let begin = 0;
      for (let i = 0; i < header.length; i++) {
        const ch = header[i];
        if (ch === "<" && !quoted) angle = true;
        else if (ch === ">" && !quoted) angle = false;
        else if (ch === '"' && !angle && header[i - 1] !== "\\") quoted = !quoted;
        else if (ch === "," && !angle && !quoted) {links.push(header.slice(begin, i)); begin = i + 1;}
      }
      if (angle || quoted) unsupportedContent("malformed Link header");
      if (header) links.push(header.slice(begin));
      for (const link of links) {
        const match = /^\s*<([^>]+)>\s*((?:;.*)?)$/.exec(link);
        if (!match) unsupportedContent("malformed Link header");
        const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i.exec(match[2]!);
        if ((rel?.[1] ?? rel?.[2] ?? "").split(/\s+/).includes("next")) {
          if (url) unsupportedContent("multiple next links");
          try {url = new URL(match[1]!, response.url).href;} catch {unsupportedContent("invalid next link");}
        }
      }
      more = url !== undefined;
    } else if (paging?.kind === "cursor") {
      const next = readSourcePath(parsed, paging.next_path ?? paging.cursor_path!);
      if (next !== undefined && next !== null && next !== "") {
        if (typeof next !== "string") unsupportedContent("cursor must be a string");
        if (paging.next_path) {try {url = new URL(next, response.url).href;} catch {unsupportedContent("invalid next URL");}}
        else token = next;
        more = true;
      }
    } else if (numeric) more = items.length >= paging!.size!;
    const nextCursor: RestJsonCursor = {
      ...(token !== undefined ? {token} : {}), ...(url !== undefined ? {url} : {}),
      ...(numeric && more ? paging!.kind === "page-number" ? {page: page + 1} : {offset: offset + paging!.size!} : {}),
      ...(watermark ? {watermark} : {}), ...(more ? {since: since ?? ""} : {}),
    };
    const declaredComplete = r.complete === "always" || object(r.complete) && readSourcePath(parsed, r.complete.when_path) === r.complete.equals;
    const validators: Record<string, string> = {};
    if (response.headers.etag) validators["if-none-match"] = response.headers.etag;
    if (response.headers["last-modified"]) validators["if-modified-since"] = response.headers["last-modified"];
    return {records, nextCursor: Object.keys(nextCursor).length ? nextCursor : null, more, complete: !more && declaredComplete && !resumed,
      ...(skipped ? {diagnostics: [{code: "records_skipped", message: "records skipped by declared presence rule", count: skipped}]} : {}),
      ...(Object.keys(validators).length ? {validators} : {}),
    };
  },
});

export const SOURCE_PROFILES = Object.freeze([Object.freeze({id: restJsonProfile.id, version: restJsonProfile.version, kind: restJsonProfile.kind})]);
/** Inert lookup. Extensions are explicit caller imports, never discovered or executed here. */
export function getSourceProfile(id: string): SourceProfile<ConnectorSource, RestJsonCursor> | undefined {
  return id === restJsonProfile.id ? restJsonProfile : undefined;
}
