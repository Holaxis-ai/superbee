/** Closed declarative request grammar and provider-owned read scope. */
import { parse, visit, Kind } from "graphql/language/index.js";
import { CONNECTOR_KEYS, credentialHosts, type Connector, type ConnectorSource, type BoundFeed } from "./connectors.js";
import type { RequestRules, ProfileResponse } from "./source-engine/types.js";

export type Scalar = string | number | boolean | null;
export interface ConnectorRequest {
  host: string;
  method: "GET" | "POST";
  path: string;
  query?: Record<string, Scalar>;
  body?: Record<string, Scalar>;
  headers?: Record<string, string>;
  items: string;
  skip?: Array<{path: string; present: true}>;
  fields?: Record<string, {from?: string; type?: "text" | "integer" | "date" | "epoch-date" | "url"; const?: Scalar}>;
  paging?: {kind: "none" | "cursor" | "link-header" | "offset" | "page-number"; cursor_path?: string; next_path?: string; size_param?: string; size?: number; page_param?: string; offset_param?: string};
  watermark?: {field: string; param: string; overlap_seconds: number};
  complete?: "always" | "never" | {when_path: string; equals: Scalar};
  errors?: {deferred?: number[]; credential_refused?: number[]; not_found?: number[]};
  rate?: {requests: number};
  graphql?: {query: string; variables: Record<string, Scalar>; items?: string; page_info?: string};
}

const githubRules = Object.freeze({
  // GitHub Docs: REST issues/list-repository-issues, REST pagination, forming GraphQL calls.
  read_paths: Object.freeze(["/repos/{owner}/{repo}/issues", "/graphql"]),
  read_posts: Object.freeze([Object.freeze({path: "/graphql", graphql: true})]),
  headers: Object.freeze(["x-github-api-version"]),
  paging_query: Object.freeze(["page", "per_page"]),
  next: Object.freeze([Object.freeze({path: "/repositories/{id}/issues", id_path: "repository.id"})]),
});
export const AUTH_PROVIDER_REQUEST_RULES: Readonly<Record<string, typeof githubRules>> = Object.freeze({github: githubRules});
export function providerRequestRules(auth: Connector["auth"]): typeof githubRules | undefined {
  return AUTH_PROVIDER_REQUEST_RULES[auth.kind === "github-app" ? "github" : auth.provider ?? ""];
}
export const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const safeName = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(s) && !["__proto__", "prototype", "constructor"].includes(s);
const dotted = (s: unknown): s is string => typeof s === "string" && s.length <= 512 && (s === "" || s.split(".").every(safeName));
const scalar = (v: unknown): v is Scalar => v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v);
export const placeholders = (s: string): string[] => [...s.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m => m[1]!);

/** A parsed single query, with all string/id inputs supplied by bound variables. */
export function graphqlReadProblem(query: unknown, variables: unknown, parameters?: Readonly<Record<string, string>> | null): string | undefined {
  if (typeof query !== "string" || query.length > 65536 || !object(variables)) return "GraphQL requires a query and variables mapping";
  try {
    const ast = parse(query, {maxTokens: 5000});
    const ops = ast.definitions.filter(d => d.kind === Kind.OPERATION_DEFINITION);
    if (ops.length !== 1 || ops[0]!.operation !== "query" || ast.definitions.some(d => d.kind !== Kind.OPERATION_DEFINITION && d.kind !== Kind.FRAGMENT_DEFINITION)) return "GraphQL requires exactly one query operation";
    let problem: string | undefined;
    const names = new Set<string>();
    visit(ast, {
      StringValue() { problem = "GraphQL string arguments must use bound variables"; },
      VariableDefinition(node) {
        names.add(node.variable.name.value);
        if (node.defaultValue) problem = "GraphQL variable defaults are refused";
        let type = node.type;
        while (type.kind !== Kind.NAMED_TYPE) type = type.type;
        const value = variables[node.variable.name.value];
        if (!scalar(value)) problem = "GraphQL variables must be scalar";
        if (type.name.value === "String" || type.name.value === "ID") {
          if (parameters) {
            if (typeof value !== "string" || !Object.values(parameters).includes(value)) problem = "GraphQL string/id variables must equal a bound value";
          } else if (parameters !== null && (typeof value !== "string" || !/^\{(?:[A-Za-z][A-Za-z0-9_]*|cursor)\}$/.test(value))) problem = "GraphQL string/id variables must be one binding placeholder or cursor";
        }
      },
    });
    if (Object.keys(variables).some(n => !names.has(n))) return "GraphQL variables must be declared";
    return problem;
  } catch { return "GraphQL query syntax is invalid"; }
}

export function validateConnectorRequest(source: Pick<ConnectorSource, "request" | "identity">, connector?: Pick<Connector, "auth" | "domains">): Array<{path: string; message: string}> {
  const errors: Array<{path: string; message: string}> = [];
  const fail = (path: string, message: string): void => {errors.push({path: `/request${path}`, message});};
  const closed = (block: keyof typeof CONNECTOR_KEYS, value: unknown, path: string): value is Record<string, unknown> => {
    if (!object(value)) {fail(path, "must be a mapping"); return false;}
    for (const key of Object.keys(value)) if (!(CONNECTOR_KEYS[block] as readonly string[]).includes(key)) fail(`${path}/${key}`, `unknown ${block} key`);
    return true;
  };
  const r = source.request;
  if (!closed("request", r, "")) return errors;
  const params = placeholders(source.identity.resource);
  const allowed = new Set([...params, "cursor", "watermark", "page"]);
  const template = (v: unknown, path: string, pathMode = false): void => {
    if (!scalar(v)) {fail(path, "must be a scalar literal or placeholder"); return;}
    if (typeof v !== "string") return;
    if (v.length > 8192 || /%7[bd]/i.test(v)) fail(path, "encoded braces or oversized template refused");
    const without = v.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, n: string) => {if (!allowed.has(n)) fail(path, "unknown placeholder"); return "x";});
    if (/[{}]/.test(without)) fail(path, "nested or malformed placeholder");
    if (!pathMode && placeholders(v).length && !/^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(v)) fail(path, "placeholder must be the entire value");
  };
  if (typeof r.host !== "string" || !/^[a-z0-9.-]+$/.test(r.host)) fail("/host", "must be a lowercase hostname");
  if (r.method !== "GET" && r.method !== "POST") fail("/method", "must be GET or reviewed read-shaped POST");
  if (typeof r.path !== "string" || !r.path.startsWith("/") || r.path.startsWith("//") || /[?#\\]/.test(r.path)) fail("/path", "must be an absolute path template without query or fragment");
  else {
    template(r.path, "/path", true);
    for (const segment of r.path.split("/")) {
      let decoded = segment;
      try {decoded = decodeURIComponent(segment);} catch {fail("/path", "invalid encoding");}
      if (decoded === "." || decoded === ".." || /[/\\]/.test(decoded)) fail("/path", "dot segments and encoded separators refused");
      if (/[{}]/.test(segment) && !/^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(segment)) fail("/path", "path placeholder must be an entire segment");
    }
  }
  for (const key of ["query", "body", "headers"] as const) if (r[key] !== undefined) {
    if (!object(r[key])) fail(`/${key}`, "must be a scalar mapping");
    else for (const [name, value] of Object.entries(r[key]!)) {
      if (!safeName(name)) fail(`/${key}/${name}`, "invalid map key");
      template(value, `/${key}/${name}`);
    }
  }
  if (r.method === "GET" && r.body !== undefined) fail("/body", "GET has no body");
  if (!dotted(r.items)) fail("/items", "must be a dotted array path, or empty for the root array");
  if (r.skip !== undefined) {
    if (!Array.isArray(r.skip)) fail("/skip", "must be a list");
    else r.skip.forEach((s, i) => {if (closed("skip", s, `/skip/${i}`) && (!dotted(s.path) || s.path === "" || s.present !== true)) fail(`/skip/${i}`, "requires path and present: true");});
  }
  if (r.fields !== undefined) {
    if (!object(r.fields)) fail("/fields", "must be a mapping");
    else for (const [name, field] of Object.entries(r.fields)) {
      if (!dotted(name) || !name) {fail(`/fields/${name}`, "invalid normalized record path"); continue;}
      if (!closed("transform", field, `/fields/${name}`)) continue;
      if (field.from !== undefined && (!dotted(field.from) || !field.from)) fail(`/fields/${name}/from`, "requires dotted record path");
      if (field.from === undefined && !Object.hasOwn(field, "const")) fail(`/fields/${name}`, "requires from or const");
      if (Object.hasOwn(field, "const") && (!scalar(field.const) || field.from !== undefined || field.type !== undefined)) fail(`/fields/${name}/const`, "const is a scalar and excludes from/type");
      if (field.type !== undefined && !["text", "integer", "date", "epoch-date", "url"].includes(field.type)) fail(`/fields/${name}/type`, "unknown scalar transform");
    }
  }
  if (r.paging !== undefined && closed("paging", r.paging, "/paging")) {
    const p = r.paging;
    if (!["none", "cursor", "link-header", "offset", "page-number"].includes(p.kind)) fail("/paging/kind", "unknown paging kind");
    for (const key of ["cursor_path", "next_path"] as const) if (p[key] !== undefined && (!dotted(p[key]) || !p[key])) fail(`/paging/${key}`, "must be a dotted path");
    for (const key of ["size_param", "page_param", "offset_param"] as const) if (p[key] !== undefined && !safeName(p[key]!)) fail(`/paging/${key}`, "must be a parameter name");
    if (p.size !== undefined && (!Number.isSafeInteger(p.size) || p.size < 1 || p.size > 10000)) fail("/paging/size", "must be an integer from 1 to 10000");
    if ((p.kind === "offset" || p.kind === "page-number") && (!p.size || !(p.kind === "offset" ? p.offset_param : p.page_param))) fail("/paging", "numeric paging requires size and its parameter");
    if (p.kind === "cursor" && !p.cursor_path && !p.next_path) fail("/paging", "cursor paging requires cursor_path or next_path");
  }
  if (r.watermark !== undefined && closed("watermark", r.watermark, "/watermark")) {
    if (!dotted(r.watermark.field) || !r.watermark.field || typeof r.watermark.param !== "string" || !safeName(r.watermark.param) || !Number.isSafeInteger(r.watermark.overlap_seconds) || r.watermark.overlap_seconds < 0) fail("/watermark", "requires field, param and nonnegative overlap_seconds");
  }
  if (r.complete !== undefined && r.complete !== "always" && r.complete !== "never") {
    if (closed("complete", r.complete, "/complete") && (!dotted(r.complete.when_path) || !scalar(r.complete.equals))) fail("/complete", "requires when_path and scalar equals");
  }
  if (r.errors !== undefined && closed("errors", r.errors, "/errors")) {
    const seen = new Set<number>();
    for (const [key, list] of Object.entries(r.errors)) {
      if (!Array.isArray(list) || !list.every(s => Number.isInteger(s) && s >= 400 && s <= 599 && !seen.has(s) && !!seen.add(s))) fail(`/errors/${key}`, "requires disjoint HTTP error status sets");
    }
  }
  if (r.rate !== undefined && closed("rate", r.rate, "/rate") && (!Number.isSafeInteger(r.rate.requests) || r.rate.requests < 1)) fail("/rate/requests", "requires a positive integer");
  if (r.graphql !== undefined && closed("graphql", r.graphql, "/graphql")) {
    const problem = graphqlReadProblem(r.graphql.query, r.graphql.variables);
    if (problem) fail("/graphql", problem);
    if (r.method !== "POST" || r.body !== undefined) fail("/graphql", "requires POST without a body map");
    if (object(r.graphql.variables)) for (const [k, v] of Object.entries(r.graphql.variables)) template(v, `/graphql/variables/${k}`);
  }
  const mentions = JSON.stringify([r.path, r.query, r.body, r.graphql?.variables]);
  for (const p of params) if (!mentions.includes(`{${p}}`)) fail("", "every resource binding placeholder must appear in the request");
  if (connector) {
    const credential = credentialHosts(connector.auth).includes(r.host);
    const row = providerRequestRules(connector.auth);
    if (!credential && !connector.domains.includes(r.host)) fail("/host", "host is not declared");
    if (credential && !row?.read_paths.includes(r.path)) fail("/path", "path is outside the provider read_paths");
    if (r.method === "POST" && (!credential || !row?.read_posts.some(p => p.path === r.path))) fail("/method", "POST is outside provider read_posts");
    if (r.path === "/graphql" && !r.graphql) fail("/graphql", "GraphQL path requires a parsed query declaration");
    for (const name of Object.keys(r.headers ?? {})) if (name !== name.toLowerCase() || name !== "accept" && !row?.headers.includes(name)) fail(`/headers/${name}`, "header is outside the provider allowlist");
  }
  return errors;
}

export function readPath(value: unknown, path: string): unknown {
  let next = value;
  if (!path) return next;
  for (const name of path.split(".")) {
    if (!safeName(name) || !object(next) || !Object.hasOwn(next, name)) return undefined;
    next = next[name];
  }
  return next;
}
export function renderRequestValue(value: Scalar, parameters: Readonly<Record<string, string>>, dynamic: Record<string, string>): Scalar {
  return typeof value === "string" ? value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, n: string) => {
    const result = parameters[n] ?? dynamic[n];
    if (result === undefined) throw new Error("missing request binding");
    return result;
  }) : value;
}

/** Guard-owned rules. Caller hooks may narrow these rules but cannot widen them. */
export function declarationRequestRules(connector: Pick<Connector, "auth" | "domains">, bound: BoundFeed): RequestRules & {response(response: ProfileResponse): void} {
  const request = bound.source.request!;
  const row = providerRequestRules(connector.auth);
  const parameters = bound.parameters;
  const bindingsValid = placeholders(bound.source.identity.resource).every(name => typeof parameters[name] === "string" && parameters[name] !== "" && parameters[name] !== "." && parameters[name] !== "..");
  let repositoryId: string | undefined;
  const expectedPath = request.path.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, n: string) => encodeURIComponent(parameters[n] ?? ""));
  const valuesPresent = (url: URL, body?: string): boolean => {
    let bodyValues: unknown[] = [];
    if (body) try {
      const parsed: unknown = JSON.parse(body);
      if (object(parsed)) bodyValues = object(parsed.variables) ? Object.values(parsed.variables) : Object.values(parsed);
    } catch { return false; }
    const actual = [...url.pathname.split("/").map(v => {try{return decodeURIComponent(v);}catch{return "";}}), ...url.searchParams.values(), ...bodyValues];
    return Object.values(parameters).every(value => actual.includes(value));
  };
  const nextPath = (url: URL): boolean => repositoryId !== undefined && row?.next.some(form => url.pathname === form.path.replace("{id}", repositoryId!)) === true;
  const queryAllowed = (url: URL): boolean => {
    const p = request.paging;
    const dynamic = new Set([p?.size_param, p?.page_param, p?.offset_param, request.watermark?.param, ...(p?.kind === "link-header" ? row?.paging_query ?? [] : [])]);
    for (const [name, value] of url.searchParams) {
      if (dynamic.has(name)) continue;
      const declared = request.query?.[name];
      if (declared === undefined) return false;
      if (typeof declared === "string" && /^\{(?:cursor|page|watermark)\}$/.test(declared)) continue;
      try { if (String(renderRequestValue(declared, parameters, {})) !== value) return false; } catch {return false;}
    }
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (typeof value === "string" && /^\{(?:cursor|page|watermark)\}$/.test(value)) continue;
      try {if (url.searchParams.getAll(name).length !== 1 || url.searchParams.get(name) !== String(renderRequestValue(value, parameters, {}))) return false;} catch {return false;}
    }
    return true;
  };
  return {
    header: name => name === "accept" || row?.headers.includes(name) === true,
    url(url, hop) {
      if (!bindingsValid || url.hostname !== request.host || hop.method !== request.method || !queryAllowed(url)) return false;
      if (url.pathname === expectedPath) return request.method === "POST" || valuesPresent(url);
      return request.method === "GET" && (request.paging?.kind === "link-header" || !!request.paging?.next_path) && nextPath(url);
    },
    post(url, body) {
      const post = row?.read_posts.find(p => p.path === request.path);
      if (!post || url.pathname !== expectedPath || !valuesPresent(url, body)) return false;
      if (post.graphql) {
        try {
          const parsed: unknown = JSON.parse(body ?? "");
          if (!object(parsed) || Object.keys(parsed).some(k => k !== "query" && k !== "variables")) return false;
          // The body must execute the pinned declaration, so aliases/fragments cannot broaden its resource scope.
          const cursorVariables = Object.fromEntries(Object.entries(request.graphql?.variables ?? {}).filter(([, value]) => value === "{cursor}").map(([name]) => [name, object(parsed.variables) ? String(parsed.variables[name]) : ""]));
          return parsed.query === request.graphql?.query && !graphqlReadProblem(parsed.query, parsed.variables, {...parameters, ...cursorVariables});
        } catch {return false;}
      }
      return true;
    },
    response(response) {
      if (repositoryId !== undefined || response.url !== undefined && new URL(response.url).pathname !== expectedPath) return;
      let parsed: unknown;
      try {parsed = JSON.parse(response.body);} catch {return;}
      const records = readPath(parsed, request.items);
      if (!Array.isArray(records)) return;
      const resource = `https://${request.host}/repos/${parameters.owner}/${parameters.repo}`;
      const ids = records.flatMap(record => {
        const repository = readPath(record, "repository");
        return object(repository) && Number.isSafeInteger(repository.id) && Number(repository.id) > 0 && (repository.url === resource || repository.full_name === `${parameters.owner}/${parameters.repo}`) ? [String(repository.id)] : [];
      });
      if (ids.length === records.length && ids.length && ids.every(id => id === ids[0])) repositoryId = ids[0];
    },
  };
}
