/**
 * `@superbee/core/connectors`: the parser's refusals (one case per code), the secret tripwire's
 * no-echo rule, credential hosts that only core's table supplies, the pin digest over every key the
 * closed-shape table accepts, and the mapping primitives.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTH_PROVIDERS,
  changeBetween,
  checkConnectorAgainstKinds,
  CONNECTOR_DOCUMENT_KEYS,
  CONNECTOR_ERROR_CODES,
  CONNECTOR_KEYS,
  connectorPinDigest,
  credentialHosts,
  findingsFor,
  mapRecord,
  parseConnectorDoc,
  type Connector,
  type ConnectorBlock,
  type ConnectorErrorCode,
  type ConnectorParseResult,
  type MappingDiagnostic,
} from "../src/connectors.js";
import { isStandardDocumentSetField } from "../src/document-field-actions.js";
import { mutateDocument } from "../src/document-mutation.js";
import { parseMarkdown } from "../src/frontmatter.js";
import { buildKindRegistry, type KindRegistry } from "../src/kinds.js";
import { isManagedDocumentMetadataField } from "../src/managed-document-metadata.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { assertAuthoredOkfStandardFields } from "../src/okf-standard-fields.js";
import { NEVER_OWNED } from "../src/record-overlay/policy.js";
import type { OkfDocument } from "../src/types.js";
import { CONNECTOR_ID, CONNECTOR_MD, EVENT_CONVENTION_MD, parseExampleConnector } from "./fixtures/connectors/example-calendar.js";

const base = (): { frontmatter: Record<string, unknown>; body: string } => {
  const { frontmatter, body } = parseMarkdown(CONNECTOR_MD);
  return { frontmatter: structuredClone(frontmatter) as Record<string, unknown>, body };
};
const parse = (frontmatter: Record<string, unknown>, options: { body?: string; id?: string; kinds?: KindRegistry } = {}): ConnectorParseResult =>
  parseConnectorDoc({ id: options.id ?? CONNECTOR_ID, frontmatter, body: options.body ?? "" } as OkfDocument, options.kinds ? { kinds: options.kinds } : {});
const codes = (result: ConnectorParseResult): string[] => (result.ok ? [] : result.errors.map((e) => e.code));
const errorsOf = (result: ConnectorParseResult) => (result.ok ? [] : result.errors);

/** Parse with one edit and expect exactly the given code among the refusals, at the given path. */
function refuses(edit: (fm: Record<string, any>) => void, code: ConnectorErrorCode, path?: string, options: { body?: string; id?: string; kinds?: KindRegistry } = {}): void {
  const { frontmatter } = base();
  edit(frontmatter);
  const result = parse(frontmatter, options);
  assert.equal(result.ok, false, `${code} expected; parsed`);
  const hit = errorsOf(result).filter((e) => e.code === code);
  assert.ok(hit.length > 0, `${code} expected; got ${JSON.stringify(errorsOf(result))}`);
  if (path !== undefined) assert.ok(hit.some((e) => e.path === path), `${code} at ${path}; got ${JSON.stringify(hit)}`);
}

const source = (fm: Record<string, any>) => fm.record_sources[0];
const eventKinds = (): KindRegistry => {
  const { frontmatter, body } = parseMarkdown(EVENT_CONVENTION_MD);
  return buildKindRegistry([{ id: "conventions/event", frontmatter, body }]);
};

// ------------------------------------------------------------------------------------------- parse

test("the example declaration parses with defaults filled and no warnings", () => {
  const result = parse(base().frontmatter, { kinds: eventKinds() });
  assert.ok(result.ok, JSON.stringify(errorsOf(result)));
  const c = result.connector;
  assert.deepEqual(c.auth, { kind: "none" });
  assert.deepEqual(c.domains, ["calendar.example.org"]);
  assert.equal(c.version, "1");
  assert.deepEqual(c.sources[0]!.fields.title, { from: "summary" });
  assert.deepEqual(c.sources[0]!.fields.event_status, { from: "status", values: { CONFIRMED: "scheduled", TENTATIVE: "scheduled", CANCELLED: "canceled" }, unmapped: "keep" });
  assert.deepEqual(c.events[0], { name: "changed", signature: { scheme: "hmac-sha256", header: "x-signature-256" }, references: ["events"] });
  assert.deepEqual(result.warnings, []);
});

test("a registry that lacks the target Kind defers its rules with a warning; checkConnectorAgainstKinds then refuses it", () => {
  const empty = buildKindRegistry([]);
  const result = parse(base().frontmatter, { kinds: empty });
  assert.ok(result.ok);
  assert.deepEqual(result.warnings.map((w) => w.code), ["CONNECTOR_TARGET_KIND_DEFERRED"]);
  assert.deepEqual(checkConnectorAgainstKinds(result.connector, empty).map((e) => [e.code, e.path]), [["CONNECTOR_TARGET_KIND_INVALID", "/record_sources/0/target_kind"]]);
  assert.deepEqual(checkConnectorAgainstKinds(result.connector, eventKinds()), []);
});

test("every refusal is returned in one pass, each with a JSON pointer", () => {
  const { frontmatter } = base();
  frontmatter.title = "";
  frontmatter.domains = ["127.1"];
  source(frontmatter).profile = "ICS";
  source(frontmatter).mode = "mirror";
  const result = parse(frontmatter);
  assert.deepEqual(errorsOf(result).map((e) => [e.code, e.path]), [
    ["CONNECTOR_MALFORMED", "/title"],
    ["CONNECTOR_DOMAIN_INVALID", "/domains/0"],
    ["CONNECTOR_PROFILE_INVALID", "/record_sources/0/profile"],
    ["CONNECTOR_MODE_UNSUPPORTED", "/record_sources/0/mode"],
  ]);
});

test("CONNECTOR_MALFORMED: type, title, auth, block shapes, empty declarations and value sets", () => {
  refuses((fm) => { fm.type = "Convention"; }, "CONNECTOR_MALFORMED", "/type");
  refuses((fm) => { delete fm.title; }, "CONNECTOR_MALFORMED", "/title");
  refuses((fm) => { delete fm.auth; }, "CONNECTOR_MALFORMED", "/auth");
  refuses((fm) => { fm.auth = "none"; }, "CONNECTOR_MALFORMED", "/auth");
  refuses((fm) => { fm.record_sources = { events: {} }; }, "CONNECTOR_MALFORMED", "/record_sources");
  refuses((fm) => { fm.record_sources = []; fm.events = []; }, "CONNECTOR_MALFORMED", "");
  refuses((fm) => { source(fm).completeness = "full"; }, "CONNECTOR_MALFORMED", "/record_sources/0/completeness");
  refuses((fm) => { delete source(fm).completeness; }, "CONNECTOR_MALFORMED", "/record_sources/0/completeness");
  refuses((fm) => { source(fm).mode = 1; }, "CONNECTOR_MALFORMED", "/record_sources/0/mode");
  refuses((fm) => { source(fm).fields = {}; }, "CONNECTOR_MALFORMED", "/record_sources/0/fields");
  refuses((fm) => { fm.actions = [{ name: "a", method: "FETCH", host: "calendar.example.org" }]; }, "CONNECTOR_MALFORMED", "/actions/0/method");
  refuses((fm) => { fm.actions = [{ name: "a", method: "GET", host: "calendar.example.org", confirm: "sometimes" }]; }, "CONNECTOR_MALFORMED", "/actions/0/confirm");
  refuses((fm) => { fm.actions = [{ name: "a", method: "GET", host: "calendar.example.org", input: { n: { type: "float" } } }]; }, "CONNECTOR_MALFORMED", "/actions/0/input/n/type");
  refuses(() => {}, "CONNECTOR_MALFORMED", "", { id: "conventions/example-calendar" });
});

test("CONNECTOR_UNKNOWN_KEY inside every closed block, identity and signature included", () => {
  refuses((fm) => { fm.auth.hosts = ["collector.example"]; }, "CONNECTOR_UNKNOWN_KEY", "/auth/hosts");
  refuses((fm) => { source(fm).cursor = "token"; }, "CONNECTOR_UNKNOWN_KEY", "/record_sources/0/cursor");
  refuses((fm) => { source(fm).identity.fetch = "https://elsewhere.example.org/"; }, "CONNECTOR_UNKNOWN_KEY", "/record_sources/0/identity/fetch");
  refuses((fm) => { source(fm).fields.event_status.default = "scheduled"; }, "CONNECTOR_UNKNOWN_KEY", "/record_sources/0/fields/event_status/default");
  refuses((fm) => { fm.actions = [{ name: "a", method: "GET", host: "calendar.example.org", path: "/x" }]; }, "CONNECTOR_UNKNOWN_KEY", "/actions/0/path");
  refuses((fm) => { fm.actions = [{ name: "a", method: "GET", host: "calendar.example.org", input: { n: { type: "string", pattern: ".*" } } }]; }, "CONNECTOR_UNKNOWN_KEY", "/actions/0/input/n/pattern");
  refuses((fm) => { fm.events[0].url = "https://hooks.example.org/"; }, "CONNECTOR_UNKNOWN_KEY", "/events/0/url");
  refuses((fm) => { fm.events[0].signature.algorithm = "sha1"; }, "CONNECTOR_UNKNOWN_KEY", "/events/0/signature/algorithm");
  const { frontmatter } = base();
  frontmatter.x_extension = { anything: true };
  assert.equal(parse(frontmatter).ok, true, "top-level keys outside the table are tolerated");
});

test("CONNECTOR_AUTH_INVALID: unknown kinds, providers outside core's table, keys of another kind, schemes and permissions", () => {
  refuses((fm) => { fm.auth = { kind: "basic" }; }, "CONNECTOR_AUTH_INVALID", "/auth/kind");
  refuses((fm) => { fm.auth = { kind: "token" }; }, "CONNECTOR_AUTH_INVALID", "/auth/provider");
  for (const provider of ["gitlab", "constructor", "__proto__", "toString"]) {
    refuses((fm) => { fm.auth = { kind: "oauth2", provider }; }, "CONNECTOR_AUTH_INVALID", "/auth/provider");
  }
  refuses((fm) => { fm.auth = { kind: "none", provider: "github" }; }, "CONNECTOR_AUTH_INVALID", "/auth/provider");
  refuses((fm) => { fm.auth = { kind: "token", provider: "github", permissions: { issues: "read" } }; }, "CONNECTOR_AUTH_INVALID", "/auth/permissions");
  refuses((fm) => { fm.auth = { kind: "signed-webhook", scheme: "hmac-sha1" }; }, "CONNECTOR_AUTH_INVALID", "/auth/scheme");
  refuses((fm) => { fm.auth = { kind: "github-app", permissions: { issues: "admin" } }; }, "CONNECTOR_AUTH_INVALID", "/auth/permissions/issues");
});

test("credential hosts come only from core's table: the document cannot name, add or overlap one", () => {
  assert.ok(Object.isFrozen(AUTH_PROVIDERS) && Object.isFrozen(AUTH_PROVIDERS.github));
  assert.throws(() => { (AUTH_PROVIDERS as Record<string, readonly string[]>).collector = ["collector.example"]; });
  const { frontmatter } = base();
  frontmatter.auth = { kind: "token", provider: "github" };
  frontmatter.domains = ["calendar.example.org", "collector.example.org"];
  const parsed = parse(frontmatter);
  assert.ok(parsed.ok);
  assert.deepEqual(credentialHosts(parsed.connector.auth), ["api.github.com"], "domains never widen a credential's hosts");
  assert.deepEqual(credentialHosts({ kind: "github-app" }), ["api.github.com"]);
  assert.deepEqual(credentialHosts({ kind: "token", provider: "constructor" }), []);
  for (const kind of ["none", "signed-webhook"] as const) assert.deepEqual(credentialHosts({ kind }), []);
  refuses((fm) => { fm.auth = { kind: "token", provider: "github" }; fm.domains = ["api.github.com"]; }, "CONNECTOR_DOMAIN_INVALID", "/domains/0");
  refuses((fm) => { fm.auth = { kind: "token", provider: "github", hosts: ["collector.example.org"] }; }, "CONNECTOR_UNKNOWN_KEY", "/auth/hosts");
  const action = (host: string) => (fm: Record<string, any>) => { fm.auth = { kind: "token", provider: "github" }; fm.actions = [{ name: "create", method: "POST", host }]; };
  const { frontmatter: ok } = base();
  action("api.github.com")(ok);
  assert.equal(parse(ok).ok, true, "an action may target a credential host");
  refuses(action("uploads.github.com"), "CONNECTOR_ACTION_INVALID", "/actions/0/host");
});

test("CONNECTOR_DOMAIN_INVALID: grammar, address literals, duplicates", () => {
  for (const domain of ["127.1", "0x7f.1", "10.0.0.1", "calendar.example.org.", "Calendar.example.org", "*.example.org", "example.org:443", "localhost", "https://example.org", "-bad.example.org", "a..example.org", "[::1]", "x".repeat(64) + ".example.org", "", 7]) {
    refuses((fm) => { fm.domains = [domain]; }, "CONNECTOR_DOMAIN_INVALID", "/domains/0");
  }
  refuses((fm) => { fm.domains = ["calendar.example.org", "calendar.example.org"]; }, "CONNECTOR_DOMAIN_INVALID", "/domains/1");
  refuses((fm) => { fm.auth = { kind: "github-app" }; fm.domains = ["api.github.com"]; }, "CONNECTOR_DOMAIN_INVALID", "/domains/0");
});

test("CONNECTOR_DUPLICATE: sources, actions, events and references", () => {
  refuses((fm) => { fm.record_sources.push(structuredClone(source(fm))); }, "CONNECTOR_DUPLICATE", "/record_sources/1/name");
  refuses((fm) => { fm.actions = [{ name: "a", method: "GET", host: "calendar.example.org" }, { name: "a", method: "GET", host: "calendar.example.org" }]; }, "CONNECTOR_DUPLICATE", "/actions/1/name");
  refuses((fm) => { fm.events.push(structuredClone(fm.events[0])); }, "CONNECTOR_DUPLICATE", "/events/1/name");
  refuses((fm) => { fm.events[0].references = ["events", "events"]; }, "CONNECTOR_DUPLICATE", "/events/0/references/1");
});

test("CONNECTOR_PROFILE_INVALID, CONNECTOR_TARGET_KIND_INVALID and CONNECTOR_MODE_UNSUPPORTED", () => {
  for (const profile of ["ICS", "", "ics profile", 3]) refuses((fm) => { source(fm).profile = profile; }, "CONNECTOR_PROFILE_INVALID", "/record_sources/0/profile");
  for (const kind of ["", "  ", "Convention", "View", "Connector", "Reference", "Source Feed", "Signal"]) {
    refuses((fm) => { source(fm).target_kind = kind; }, "CONNECTOR_TARGET_KIND_INVALID", "/record_sources/0/target_kind");
  }
  refuses((fm) => { source(fm).mode = "mirror"; }, "CONNECTOR_MODE_UNSUPPORTED", "/record_sources/0/mode");
  const { frontmatter } = base();
  source(frontmatter).mode = "mirror";
  assert.match(errorsOf(parse(frontmatter))[0]!.message, /I4/);
  refuses((fm) => { source(fm).mode = "sync"; }, "CONNECTOR_MODE_UNSUPPORTED", "/record_sources/0/mode");
});

test("CONNECTOR_IDENTITY_UNSTABLE: resource template rules and id templates", () => {
  const resource = (value: unknown) => (fm: Record<string, any>) => { source(fm).identity.resource = value; };
  for (const bad of [
    "http://calendar.example.org/{feed}.ics",
    "https://{tenant}.example.org/feed.ics",
    "https://calendar.example.org:8443/{feed}.ics",
    "https://calendar.example.org/{feed}.ics#top",
    "https://calendar.example.org/{a}{b}.ics",
    "https://calendar.example.org/{feed}/{feed}.ics",
    "https://calendar.example.org/{Feed}.ics",
    "https://calendar.example.org/../{feed}.ics",
    "https://calendar.example.org/feed.ics?{key}=1",
    "https://calendar.example.org/feed.ics?key=x{v}",
    "https://calendar.example.org/{feed.ics",
    "https://calendar.example.org/a b/{feed}",
    "calendar.example.org/{feed}.ics",
    "",
    7,
  ]) refuses(resource(bad), "CONNECTOR_IDENTITY_UNSTABLE", "/record_sources/0/identity/resource");
  for (const good of ["https://calendar.example.org/feed.ics", "https://calendar.example.org/c/{feed}/events?page={page}&format=ics"]) {
    const { frontmatter } = base();
    resource(good)(frontmatter);
    assert.equal(parse(frontmatter).ok, true, good);
  }
  const id = (value: unknown) => (fm: Record<string, any>) => { source(fm).identity.id = value; };
  for (const bad of ["uid", "", "{}", "{a..b}", "{__proto__}", "{uid", "{summary}", "{calendar.id}{uid}", "x-{a}{b}-y"]) refuses(id(bad), "CONNECTOR_IDENTITY_UNSTABLE", "/record_sources/0/identity/id");
  const { frontmatter } = base();
  id("{calendar.id}#{uid}")(frontmatter);
  assert.equal(parse(frontmatter).ok, true);
});

test("encoded dot segments, separators and malformed escapes in template literals are refused", () => {
  for (const bad of [
    "https://calendar.example.org/%2e%2e/{feed}.ics",
    "https://calendar.example.org/%2E./{feed}.ics",
    "https://calendar.example.org/.%2e/{feed}.ics",
    "https://calendar.example.org/%2e/{feed}.ics",
    "https://calendar.example.org/a%2Fb/{feed}.ics",
    "https://calendar.example.org/a%5Cb/{feed}.ics",
    "https://calendar.example.org/%2F{feed}.ics",
    "https://calendar.example.org/{feed}%2f.ics",
    "https://calendar.example.org/%zz/{feed}.ics",
  ]) refuses((fm) => { source(fm).identity.resource = bad; }, "CONNECTOR_IDENTITY_UNSTABLE", "/record_sources/0/identity/resource");
  const { frontmatter } = base();
  source(frontmatter).identity.resource = "https://calendar.example.org/My%20Calendar/{feed}.ics";
  assert.equal(parse(frontmatter).ok, true, "other escapes stay literal");
});

test("Kind fields named after Object.prototype members are read as own declarations only, never thrown on", () => {
  const kinds = buildKindRegistry([{
    id: "conventions/odd", body: "",
    frontmatter: { type: "Convention", title: "Odd", governs: "Odd", fields: { required: ["title"], optional: ["valueOf", "toString", "hasOwnProperty"], values: { toString: ["a", "b"] } } },
  }]);
  const { frontmatter } = base();
  source(frontmatter).target_kind = "Odd";
  source(frontmatter).fields = {
    valueOf: { from: "v", values: { A: "a" } },
    toString: { from: "t", values: { A: "a", Z: "z" } },
    hasOwnProperty: "h",
  };
  let result: ConnectorParseResult | undefined;
  assert.doesNotThrow(() => { result = parse(frontmatter, { kinds }); });
  assert.deepEqual(errorsOf(result!).map((e) => [e.code, e.path]), [["CONNECTOR_VALUES_INVALID", "/record_sources/0/fields/toString/values/Z"]], "only the declared enum is enforced");
  const { frontmatter: ok } = base();
  source(ok).target_kind = "Odd";
  source(ok).fields = { valueOf: { from: "v", values: { A: "a" } }, hasOwnProperty: "h" };
  const parsed = parse(ok);
  assert.ok(parsed.ok);
  assert.doesNotThrow(() => assert.deepEqual(checkConnectorAgainstKinds(parsed.connector, kinds), []));
});

test("CONNECTOR_FIELD_INVALID and CONNECTOR_FIELD_NEVER_OWNED: key grammar, path grammar and fields no source may own", () => {
  for (const key of ["1st", "event-status", "constructor"]) refuses((fm) => { source(fm).fields[key] = "x"; }, "CONNECTOR_FIELD_INVALID", `/record_sources/0/fields/${key}`);
  for (const from of ["a..b", "a b", "__proto__", "a.prototype", ""]) {
    refuses((fm) => { source(fm).fields.note = { from }; }, "CONNECTOR_FIELD_INVALID", "/record_sources/0/fields/note/from");
  }
  refuses((fm) => { source(fm).fields.note = "a.constructor"; }, "CONNECTOR_FIELD_INVALID", "/record_sources/0/fields/note");
  for (const key of ["type", "sources", "status", "tags", "verified", "generated", "stale_after", "superbee_updated_by", "actor", "timestamp", "progress_status", "superbee_progress_status", "body"]) {
    refuses((fm) => { source(fm).fields[key] = "x"; }, "CONNECTOR_FIELD_NEVER_OWNED", `/record_sources/0/fields/${key}`);
  }
});

test("with a Kind: undeclared keys, claim fields, enum tables and list types", () => {
  const kinds = buildKindRegistry([{
    id: "conventions/item", body: "",
    frontmatter: {
      type: "Convention", title: "Item", governs: "Item", claim: { owner_field: "assignee", state_field: "progress_status" },
      fields: {
        required: ["title", "progress_status"], optional: ["assignee", "labels", "links", "state"],
        values: { progress_status: ["todo", "done"], state: ["open", "closed"] }, types: { labels: "string-list", links: "https-url-list" },
      },
    },
  }]);
  const withItem = (fields: Record<string, unknown>) => (fm: Record<string, any>) => { source(fm).target_kind = "Item"; source(fm).fields = fields; };
  refuses(withItem({ venue: "venue" }), "CONNECTOR_FIELD_UNDECLARED", "/record_sources/0/fields/venue", { kinds });
  refuses(withItem({ assignee: "owner" }), "CONNECTOR_FIELD_NEVER_OWNED", "/record_sources/0/fields/assignee", { kinds });
  refuses(withItem({ labels: { from: "labels", values: { BUG: "bug" } } }), "CONNECTOR_LIST_FIELD_UNSUPPORTED", "/record_sources/0/fields/labels", { kinds });
  refuses(withItem({ links: { from: "links", values: { A: "https://a.example" } } }), "CONNECTOR_LIST_FIELD_UNSUPPORTED", "/record_sources/0/fields/links", { kinds });
  refuses(withItem({ state: "state" }), "CONNECTOR_VALUES_INVALID", "/record_sources/0/fields/state", { kinds });
  refuses(withItem({ state: { from: "state", values: { OPEN: "open", GONE: "deleted" } } }), "CONNECTOR_VALUES_INVALID", "/record_sources/0/fields/state/values/GONE", { kinds });
  const { frontmatter } = base();
  withItem({ title: "name", state: { from: "state", values: { OPEN: "open", CLOSED: "closed" } } })(frontmatter);
  assert.equal(parse(frontmatter, { kinds }).ok, true, "title counts as declared by every Kind");
});

test("CONNECTOR_VALUES_INVALID without a Kind: unmapped needs a table, two policies, string rows", () => {
  refuses((fm) => { source(fm).fields.title = { from: "summary", unmapped: "keep" }; }, "CONNECTOR_VALUES_INVALID", "/record_sources/0/fields/title/unmapped");
  refuses((fm) => { source(fm).fields.event_status.unmapped = "skip"; }, "CONNECTOR_VALUES_INVALID", "/record_sources/0/fields/event_status/unmapped");
  refuses((fm) => { source(fm).fields.event_status.values = { CONFIRMED: 1 }; }, "CONNECTOR_VALUES_INVALID", "/record_sources/0/fields/event_status/values/CONFIRMED");
  refuses((fm) => { source(fm).fields.event_status.values = {}; }, "CONNECTOR_VALUES_INVALID", "/record_sources/0/fields/event_status/values");
  refuses((fm) => { source(fm).fields.event_status.values = ["scheduled"]; }, "CONNECTOR_VALUES_INVALID", "/record_sources/0/fields/event_status/values");
});

test("CONNECTOR_ACTION_INVALID and CONNECTOR_EVENT_INVALID", () => {
  const action = (extra: Record<string, unknown>) => (fm: Record<string, any>) => { fm.actions = [{ name: "create", method: "POST", host: "calendar.example.org", ...extra }]; };
  refuses(action({ host: "elsewhere.example.org" }), "CONNECTOR_ACTION_INVALID", "/actions/0/host");
  refuses(action({ input: { count: { type: "integer", values: ["1"] } } }), "CONNECTOR_ACTION_INVALID", "/actions/0/input/count/values");
  refuses(action({ input: { Count: { type: "integer" } } }), "CONNECTOR_ACTION_INVALID", "/actions/0/input/Count");
  const { frontmatter } = base();
  action({ input: { title: { type: "string", required: true }, kind: { type: "string", values: ["note", "task"] } } })(frontmatter);
  const parsed = parse(frontmatter);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.connector.actions[0], { name: "create", method: "POST", host: "calendar.example.org", confirm: "always", input: { title: { type: "string", required: true }, kind: { type: "string", required: false, values: ["note", "task"] } } });
  refuses((fm) => { fm.events[0].references = ["tasks"]; }, "CONNECTOR_EVENT_INVALID", "/events/0/references/0");
  refuses((fm) => { fm.events[0].signature.header = "X-Signature"; }, "CONNECTOR_EVENT_INVALID", "/events/0/signature/header");
  refuses((fm) => { fm.events[0].signature.scheme = "hmac-sha1"; }, "CONNECTOR_EVENT_INVALID", "/events/0/signature/scheme");
});

test("every error code has a refusal case above", () => {
  // The cases in this file name each code; this guards the list against a new code with no test.
  assert.deepEqual([...CONNECTOR_ERROR_CODES].sort(), [
    "CONNECTOR_ACTION_INVALID", "CONNECTOR_AUTH_INVALID", "CONNECTOR_DOMAIN_INVALID", "CONNECTOR_DUPLICATE", "CONNECTOR_EVENT_INVALID",
    "CONNECTOR_FIELD_INVALID", "CONNECTOR_FIELD_NEVER_OWNED", "CONNECTOR_FIELD_UNDECLARED", "CONNECTOR_IDENTITY_UNSTABLE",
    "CONNECTOR_LIST_FIELD_UNSUPPORTED", "CONNECTOR_MALFORMED", "CONNECTOR_MODE_UNSUPPORTED", "CONNECTOR_PROFILE_INVALID",
    "CONNECTOR_SECRET_PRESENT", "CONNECTOR_TARGET_KIND_INVALID", "CONNECTOR_UNKNOWN_KEY", "CONNECTOR_VALUES_INVALID",
  ]);
});

// ------------------------------------------------------------------------------------ YAML aliases

/** Extra top-level YAML placed first, so its anchors precede every use. */
const withYaml = (extra: string): string => CONNECTOR_MD.replace("type: Connector\n", `type: Connector\n${extra}\n`);
const parseYaml = (markdown: string): ConnectorParseResult => {
  const { frontmatter, body } = parseMarkdown(markdown);
  return parseConnectorDoc({ id: CONNECTOR_ID, frontmatter, body });
};
const timed = <T>(run: () => T): { value: T; ms: number } => {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
};

test("a YAML alias is a typed refusal, and neither a circular alias nor an alias expansion can stall the parser", () => {
  const loop = timed(() => parseYaml(withYaml("x_loop: &loop\n  - *loop")));
  assert.deepEqual(errorsOf(loop.value).map((e) => [e.code, e.path]), [["CONNECTOR_MALFORMED", "/x_loop/0"]]);
  assert.ok(loop.ms < 1000, `${loop.ms}ms`);
  const levels = ["x_b0: &a0 [x,x,x,x,x,x,x,x,x]"];
  for (let i = 1; i <= 9; i++) levels.push(`x_b${i}: &a${i} [${Array(9).fill(`*a${i - 1}`).join(",")}]`);
  assert.ok(levels.join("\n").length <= 500, "a document under 500 bytes that expands to nine to the ninth leaves");
  const bomb = timed(() => parseYaml(withYaml(levels.join("\n"))));
  assert.equal(bomb.value.ok, false);
  assert.ok(errorsOf(bomb.value).every((e) => e.code === "CONNECTOR_MALFORMED" && /aliases/.test(e.message)));
  assert.ok(errorsOf(bomb.value).length <= 81, "one refusal per alias written, never per expanded leaf");
  assert.ok(bomb.ms < 1000, `${bomb.ms}ms`);
  const shared = parseYaml(withYaml("x_shared: &shared { from: summary }").replace("      title: summary", "      title: *shared"));
  assert.deepEqual(errorsOf(shared).map((e) => [e.code, e.path]), [["CONNECTOR_MALFORMED", "/record_sources/0/fields/title"]], "inside a closed block too");
  const scalar = parseYaml(withYaml("x_kind: &k Event").replace("    target_kind: Event", "    target_kind: *k"));
  assert.equal(scalar.ok, true, "an alias to a scalar shares nothing");
});

// ---------------------------------------------------------------------------------------- secrets

const SECRET = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

test("CONNECTOR_SECRET_PRESENT names a path and never the value; a secret-looking key reports its parent", () => {
  const cases: Array<[(fm: Record<string, any>) => void, string]> = [
    [(fm) => { fm.auth.token = "anything"; }, "/auth"],
    [(fm) => { fm.auth.Client_Secret = "anything"; }, "/auth"],
    [(fm) => { fm.description = SECRET; }, "/description"],
    [(fm) => { fm.x_note = `Bearer ${SECRET}`; }, "/x_note"],
    [(fm) => { fm.x_note = "xoxb-123456-abcdef"; }, "/x_note"],
    [(fm) => { fm.x_key = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----"; }, "/x_key"],
    [(fm) => { source(fm).identity.resource = "https://user:pass@calendar.example.org/{feed}.ics"; }, "/record_sources/0/identity/resource"],
    [(fm) => { source(fm).fields.event_status.values[SECRET] = "scheduled"; }, "/record_sources/0/fields/event_status/values"],
    [(fm) => { fm.events[0].signature.cookie = "x"; }, "/events/0/signature"],
  ];
  for (const [edit, path] of cases) {
    const { frontmatter } = base();
    edit(frontmatter);
    frontmatter.title = "";
    const result = parse(frontmatter);
    assert.deepEqual(errorsOf(result).map((e) => [e.code, e.path]), [["CONNECTOR_SECRET_PRESENT", path]], "only the secret refusal, so nothing else can echo it");
    const text = JSON.stringify(errorsOf(result));
    for (const leak of [SECRET, "anything", "pass@", "MIIB", "xoxb-123456"]) assert.ok(!text.includes(leak), `${leak} echoed in ${text}`);
  }
});

test("a token anywhere in a frontmatter string or key is refused, as in the body, naming only a path", () => {
  const bearer = "Bearer abcdef0123456789abcdef01";
  const cases: Array<[(fm: Record<string, any>) => void, string]> = [
    [(fm) => { fm.description = `Test with ${SECRET} locally`; }, "/description"],
    [(fm) => { fm.title = `Calendar (${SECRET})`; }, "/title"],
    [(fm) => { fm.version = `1 built with ${SECRET}`; }, "/version"],
    [(fm) => { fm.x_note = `header Authorization: ${bearer}`; }, "/x_note"],
    [(fm) => { fm.x_notes = ["fine", `call it with ${bearer} please`]; }, "/x_notes/1"],
    [(fm) => { source(fm).fields.event_status.values.CONFIRMED = `scheduled ${SECRET}`; }, "/record_sources/0/fields/event_status/values/CONFIRMED"],
    [(fm) => { source(fm).fields.event_status.values[`a ${SECRET}`] = "scheduled"; }, "/record_sources/0/fields/event_status/values"],
    [(fm) => { fm.x_slack = "ping xoxb-12345678-abcdef here"; }, "/x_slack"],
  ];
  for (const [edit, path] of cases) {
    const { frontmatter } = base();
    edit(frontmatter);
    const result = parse(frontmatter);
    assert.deepEqual(errorsOf(result).map((e) => [e.code, e.path]), [["CONNECTOR_SECRET_PRESENT", path]], path);
    const text = JSON.stringify(errorsOf(result));
    for (const leak of [SECRET, "abcdef0123456789", "xoxb-12345678"]) assert.ok(!text.includes(leak), `${leak} echoed in ${text}`);
  }
  const { frontmatter } = base();
  frontmatter.description = "Requests carry a Bearer token; GitHub tokens start with ghp_ and are never written here.";
  assert.equal(parse(frontmatter).ok, true, "prose about tokens is not a token");
});

test("userinfo anywhere, lowercase bearer and tokens glued into keys are refused without echo, in any realm", () => {
  const cases: Array<[(fm: Record<string, any>) => void, string]> = [
    [(fm) => { fm.description = "Fetch https://reader:hunter2@calendar.example.org/feed.ics daily."; }, "/description"],
    [(fm) => { fm.x_note = "mirror at ftp://reader@files.example.org/x"; }, "/x_note"],
    [(fm) => { source(fm).identity.resource = "https://calendar.example.org/{feed}.ics?src=https://reader:hunter2@x.example.org/"; }, "/record_sources/0/identity/resource"],
    [(fm) => { fm.x_note = "bearer abcdef0123456789abcdef01"; }, "/x_note"],
    [(fm) => { fm.auth[`x${SECRET}`] = true; }, "/auth"],
    [(fm) => { source(fm).fields[`f${SECRET.replace("ghp_", "ghp_")}`] = "a"; }, "/record_sources/0/fields"],
  ];
  for (const [edit, path] of cases) {
    const { frontmatter } = base();
    edit(frontmatter);
    const result = parse(frontmatter);
    assert.deepEqual(errorsOf(result).map((e) => [e.code, e.path]), [["CONNECTOR_SECRET_PRESENT", path]], path);
    const text = JSON.stringify(errorsOf(result));
    for (const leak of ["hunter2", "reader", SECRET.slice(4), "abcdef0123456789"]) assert.ok(!text.includes(leak), `${leak} echoed in ${text}`);
  }
  for (const body of ["Mirror: https://reader:hunter2@calendar.example.org/feed.ics\n", "Send bearer abcdef0123456789abcdef01 upstream.\n"]) {
    assert.deepEqual(codes(parse(base().frontmatter, { body })), ["CONNECTOR_SECRET_PRESENT"], body);
  }
  assert.equal(parse(base().frontmatter, { body: "Write to support@example.org or see https://calendar.example.org/help.\n" }).ok, true);
});

test("data names (mapping keys, values natives, input and permission names) are not credential slots", () => {
  const { frontmatter } = base();
  source(frontmatter).fields.event_status.values = { SECRET: "scheduled", Token: "canceled", PASSWORD: "scheduled" };
  source(frontmatter).fields.token = "access.token";
  frontmatter.actions = [{ name: "create", method: "POST", host: "calendar.example.org", input: { password: { type: "string" } } }];
  const parsed = parse(frontmatter);
  assert.ok(parsed.ok, JSON.stringify(errorsOf(parsed)));
  const { frontmatter: app } = base();
  app.auth = { kind: "github-app", permissions: { secrets: "read", authorization: "read" } };
  assert.equal(parse(app).ok, true);
  refuses((fm) => { fm.x_settings = { api_key: "x" }; }, "CONNECTOR_SECRET_PRESENT", "/x_settings");
  refuses((fm) => { source(fm).identity.token = "x"; }, "CONNECTOR_SECRET_PRESENT", "/record_sources/0/identity");
  refuses((fm) => { fm.actions = [{ name: "a", method: "GET", host: "calendar.example.org", input: { n: { type: "string", secret: true } } }]; }, "CONNECTOR_SECRET_PRESENT", "/actions/0/input/n");
  const { frontmatter: words } = base();
  source(words).fields.highs_temperature = "summary";
  source(words).fields.weighs_kilograms = "summary";
  source(words).fields.event_status.values = { laughs_and_cheers: "scheduled", ...source(words).fields.event_status.values };
  words.x_thighs_measurement = "inseam";
  const wordsParsed = parse(words);
  assert.ok(wordsParsed.ok, `data names that contain a token prefix must parse: ${JSON.stringify(errorsOf(wordsParsed))}`);
});

test("the body is scanned for token shapes, not for words", () => {
  const body = (text: string) => parse(base().frontmatter, { body: text });
  assert.equal(body("Requests use a Bearer token issued per workspace; see the Bearer authentication note.\n").ok, true);
  assert.equal(body("Tokens look like ghp_ followed by characters.\n").ok, true);
  for (const leak of [`Use ${SECRET} to test.\n`, "Header: Bearer abcdef0123456789abcdef01\n", "-----BEGIN OPENSSH PRIVATE KEY-----\n", "Slack: xoxp-12345678-abc\n"]) {
    const result = body(leak);
    assert.deepEqual(codes(result), ["CONNECTOR_SECRET_PRESENT"], leak);
    assert.ok(!JSON.stringify(errorsOf(result)).includes(leak.trim().slice(0, 12)));
  }
});

// -------------------------------------------------------------------------------------------- pin

const FULL: Connector = {
  id: CONNECTOR_ID, title: "Full", auth: { kind: "github-app", permissions: { issues: "read" } }, domains: ["calendar.example.org", "feeds.example.org"],
  sources: [{
    name: "events", profile: "ics", target_kind: "Event", mode: "overlay",
    identity: { resource: "https://calendar.example.org/{feed}.ics", id: "{uid}" },
    fields: { title: { from: "summary" }, event_status: { from: "status", values: { CONFIRMED: "scheduled" }, unmapped: "keep" } },
    completeness: "complete",
  }],
  actions: [{ name: "create", method: "POST", host: "api.github.com", input: { title: { type: "string", required: true, values: ["a"] } }, confirm: "always" }],
  events: [{ name: "changed", signature: { scheme: "hmac-sha256", header: "x-signature-256" }, references: ["events"] }],
};

/** One mutation per accepted key of every closed block; the table must cover CONNECTOR_KEYS exactly. */
const MUTATIONS: Record<ConnectorBlock, Record<string, (c: any) => void>> = {
  auth: {
    kind: (c) => { c.auth.kind = "none"; },
    provider: (c) => { c.auth.provider = "github"; },
    permissions: (c) => { c.auth.permissions.issues = "write"; },
    scheme: (c) => { c.auth.scheme = "hmac-sha256"; },
  },
  source: {
    name: (c) => { c.sources[0].name = "events-2"; },
    profile: (c) => { c.sources[0].profile = "ics-event"; },
    target_kind: (c) => { c.sources[0].target_kind = "Place"; },
    mode: (c) => { c.sources[0].mode = "mirror"; },
    identity: (c) => { c.sources[0].identity = { resource: "https://calendar.example.org/x.ics", id: "{uid}" }; },
    fields: (c) => { c.sources[0].fields.end = { from: "dtend" }; },
    completeness: (c) => { c.sources[0].completeness = "partial"; },
  },
  identity: {
    resource: (c) => { c.sources[0].identity.resource = "https://feeds.example.org/{feed}.ics"; },
    id: (c) => { c.sources[0].identity.id = "{uid}#{recurrence}"; },
  },
  mapping: {
    from: (c) => { c.sources[0].fields.title.from = "name"; },
    values: (c) => { c.sources[0].fields.event_status.values.CANCELLED = "canceled"; },
    unmapped: (c) => { c.sources[0].fields.event_status.unmapped = "refuse"; },
  },
  action: {
    name: (c) => { c.actions[0].name = "update"; },
    method: (c) => { c.actions[0].method = "PUT"; },
    host: (c) => { c.actions[0].host = "calendar.example.org"; },
    input: (c) => { c.actions[0].input.body = { type: "text", required: false }; },
    confirm: (c) => { c.actions[0].confirm = "never"; },
  },
  input: {
    type: (c) => { c.actions[0].input.title.type = "text"; },
    required: (c) => { c.actions[0].input.title.required = false; },
    values: (c) => { c.actions[0].input.title.values = ["a", "b"]; },
  },
  event: {
    name: (c) => { c.events[0].name = "deleted"; },
    signature: (c) => { c.events[0].signature = { scheme: "hmac-sha256", header: "x-hub-signature-256" }; },
    references: (c) => { c.events[0].references = []; },
  },
  signature: {
    scheme: (c) => { c.events[0].signature.scheme = "hmac-sha512"; },
    header: (c) => { c.events[0].signature.header = "x-other"; },
  },
};

test("the pin digest changes when any accepted key of any closed block changes", () => {
  assert.deepEqual(Object.keys(MUTATIONS).sort(), Object.keys(CONNECTOR_KEYS).sort(), "a mutation table per closed block");
  const digest = connectorPinDigest(FULL);
  for (const [block, keys] of Object.entries(CONNECTOR_KEYS) as Array<[ConnectorBlock, readonly string[]]>) {
    assert.deepEqual(Object.keys(MUTATIONS[block]).sort(), [...keys].sort(), `every ${block} key has a mutation`);
    for (const key of keys) {
      const mutated = structuredClone(FULL);
      MUTATIONS[block][key]!(mutated);
      assert.notEqual(connectorPinDigest(mutated), digest, `${block}.${key} reaches the pin`);
    }
  }
  const domain = structuredClone(FULL);
  domain.domains.push("more.example.org");
  assert.notEqual(connectorPinDigest(domain), digest, "every domain is pinned");
});

test("the pin fills the parser's defaults itself, so a Connector built without the parser pins the same", () => {
  const bare = structuredClone(FULL) as any;
  delete bare.sources[0].mode;
  delete bare.sources[0].fields.event_status.unmapped;
  delete bare.actions[0].confirm;
  delete bare.actions[0].input.title.required;
  const filled = structuredClone(FULL);
  filled.actions[0]!.input.title!.required = false;
  const bareFilled = structuredClone(bare);
  bareFilled.actions[0].input.title.required = false;
  assert.equal(connectorPinDigest(bareFilled), connectorPinDigest(filled));
  delete bareFilled.actions[0].input;
  const noInput = structuredClone(filled);
  noInput.actions[0]!.input = {};
  assert.equal(connectorPinDigest(bareFilled), connectorPinDigest(noInput));
  const app = structuredClone(FULL);
  app.auth = { kind: "github-app" };
  const appFilled = structuredClone(FULL);
  appFilled.auth = { kind: "github-app", permissions: {} };
  assert.equal(connectorPinDigest(app), connectorPinDigest(appFilled));
  const refs = structuredClone(FULL) as any;
  delete refs.events[0].references;
  const refsFilled = structuredClone(FULL);
  refsFilled.events[0]!.references = [];
  assert.equal(connectorPinDigest(refs), connectorPinDigest(refsFilled));
});

test("the pin digest is blind to presentation and order, and equal across spellings of one declaration", () => {
  const digest = connectorPinDigest(parseExampleConnector());
  // A changed golden means the normalization changed: bump CONNECTOR_PIN_RULES with it.
  assert.equal(digest, "sha256:cc2005f38dc96671020ce6128388a61560bcd8aa7ec75c7b62ccf3bb180c79be");
  const variants: Array<(fm: Record<string, any>) => void> = [
    (fm) => { fm.title = "Renamed"; },
    (fm) => { fm.description = "Another sentence."; },
    (fm) => { fm.version = "2"; },
    (fm) => { fm.x_recipe = { id: "example", version: "1", of: 1 }; },
    (fm) => { fm.x_extension = "ignored"; },
    (fm) => { fm.tags = ["integration"]; },
    (fm) => { source(fm).fields.title = { from: "summary" }; },
    (fm) => { delete source(fm).fields.event_status.unmapped; },
    (fm) => { delete source(fm).mode; },
    (fm) => { const s = source(fm); fm.record_sources[0] = Object.fromEntries(Object.entries(s).reverse()); },
    (fm) => { fm.actions = []; },
    (fm) => { delete fm.actions; },
  ];
  for (const edit of variants) {
    const { frontmatter } = base();
    edit(frontmatter);
    const parsed = parse(frontmatter, { body: "Different prose.\n" });
    assert.ok(parsed.ok, JSON.stringify(errorsOf(parsed)));
    assert.equal(connectorPinDigest(parsed.connector), digest, edit.toString());
  }
  const order = structuredClone(FULL);
  order.domains.reverse();
  const second = structuredClone(order.sources[0]!);
  second.name = "archive";
  order.sources.push(second);
  order.events[0]!.references = ["events", "archive"];
  const reordered = structuredClone(order);
  reordered.sources.reverse();
  reordered.events[0]!.references.reverse();
  assert.equal(connectorPinDigest(reordered), connectorPinDigest(order), "domains, sources and references are order-free");
  const action = structuredClone(FULL);
  action.actions[0]!.input.title!.values = ["b", "a"];
  assert.notEqual(connectorPinDigest(action), connectorPinDigest(FULL), "an input's values keep their order");
});

test("a reach-widening change through the document changes the pin", () => {
  const digest = connectorPinDigest(parseExampleConnector());
  const edits: Array<(fm: Record<string, any>) => void> = [
    (fm) => { fm.domains.push("feeds.example.org"); },
    (fm) => { fm.auth = { kind: "token", provider: "github" }; },
    (fm) => { source(fm).identity.resource = "https://calendar.example.org/{feed}/all.ics"; },
    (fm) => { source(fm).fields.note = "description"; },
    (fm) => { source(fm).completeness = "partial"; },
    (fm) => { fm.events[0].signature.header = "x-hub-signature-256"; },
    (fm) => { fm.actions = [{ name: "create", method: "POST", host: "calendar.example.org" }]; },
  ];
  for (const edit of edits) {
    const { frontmatter } = base();
    edit(frontmatter);
    const parsed = parse(frontmatter);
    assert.ok(parsed.ok, JSON.stringify(errorsOf(parsed)));
    assert.notEqual(connectorPinDigest(parsed.connector), digest, edit.toString());
  }
});

// ---------------------------------------------------------------------------------------- mapping

const KIND = { fields: { required: ["title", "start", "event_status"], optional: ["end", "event_url"], values: {}, terminal: {}, descriptions: {} } };

test("an empty value never clears the title, even when the Kind does not list it as required", () => {
  const source = parseExampleConnector().sources[0]!;
  const loose = { fields: { required: ["start"], optional: ["end", "event_url", "event_status"], values: {}, terminal: {}, descriptions: {} } };
  for (const summary of [null, "", "   "]) {
    const mapped = mapRecord(source, { uid: "r1", summary, dtstart: "S", dtend: null }, loose);
    assert.ok(mapped.kind === "mapped");
    assert.ok(mapped.unobserved.includes("title") && !mapped.cleared.includes("title"), String(summary));
    assert.deepEqual(mapped.cleared, ["end"], "an optional field still clears");
    assert.deepEqual(mapped.diagnostics.filter((d) => d.field === "title").map((d) => d.code), ["VALUE_MISSING"]);
    const change = changeBetween({ title: "Kept", start: "S", end: "E" }, mapped, { external_id: "r1", change_kind: "changed" });
    assert.equal(change.after!.title, "Kept");
    assert.ok(!change.changed_fields.includes("title"));
  }
});

test("identity values that could collide, blank ones and over-long ones never render an id", () => {
  const { frontmatter } = base();
  source(frontmatter).identity.id = "{cal}#{uid}";
  const parsed = parse(frontmatter);
  assert.ok(parsed.ok);
  const src = parsed.connector.sources[0]!;
  const code = (record: Record<string, unknown>) => { const m = mapRecord(src, { summary: "x", ...record }, KIND); return m.kind === "refused" ? m.diagnostics[0]!.code : m.external_id; };
  assert.equal(code({ cal: "a", uid: "b" }), "a#b");
  assert.equal(code({ cal: "a#b", uid: "c" }), "IDENTITY_INVALID");
  assert.equal(code({ cal: "a", uid: "b#c" }), "IDENTITY_INVALID");
  assert.equal(code({ cal: "a", uid: "   " }), "IDENTITY_MISSING");
  assert.equal(code({ cal: "a", uid: "x".repeat(3000) }), "IDENTITY_INVALID");
  assert.equal(code({ cal: 7, uid: 8 }), "7#8", "a finite number renders as its decimal string");
  for (const [template, a, b] of [
    ["{cal}::{uid}", { cal: "x:", uid: "y" }, { cal: "x", uid: ":y" }],
    ["{cal}--{uid}", { cal: "x-", uid: "y" }, { cal: "x", uid: "-y" }],
    ["{cal}/x/{uid}", { cal: "p/x", uid: "q" }, { cal: "p", uid: "x/q" }],
    ["{cal}aba{uid}", { cal: "1ab", uid: "a2" }, { cal: "1", uid: "baa2" }],
  ] as const) {
    const fm = base().frontmatter;
    source(fm).identity.id = template;
    const p = parse(fm);
    assert.ok(p.ok, template);
    const s = p.connector.sources[0]!;
    const render = (record: Record<string, unknown>) => { const m = mapRecord(s, { summary: "x", ...record }, KIND); return m.kind === "refused" ? m.diagnostics[0]!.code : m.external_id; };
    assert.equal(render(a), "IDENTITY_INVALID", `${template} ${JSON.stringify(a)}`);
    assert.equal(render(b), "IDENTITY_INVALID", `${template} ${JSON.stringify(b)}`);
  }
  const single = parseExampleConnector().sources[0]!;
  const one = mapRecord(single, { uid: "a#b", summary: "x" }, KIND);
  assert.ok(one.kind === "mapped" && one.external_id === "a#b", "one placeholder cannot collide, so its value may hold any text");
  const invalid = mapRecord(single, { uid: "x".repeat(2049), summary: "x" }, KIND);
  assert.ok(invalid.kind === "refused" && invalid.present === false && invalid.diagnostics[0]!.code === "IDENTITY_INVALID");
  const findings = findingsFor([...invalid.diagnostics, ...invalid.diagnostics], { source: "events" });
  assert.deepEqual(findings.map((f) => [f.key, f.priority]), [["mapping:events:IDENTITY_INVALID", "normal"]]);
});

test("changeBetween carries unobserved values, removes cleared ones and changes only mapping keys", () => {
  const source = parseExampleConnector().sources[0]!;
  const mapped = mapRecord(source, { uid: "r1", summary: "B", dtend: null, status: "WITHDRAWN" }, KIND);
  assert.ok(mapped.kind === "mapped");
  assert.deepEqual([mapped.fields, mapped.unobserved.sort(), mapped.cleared], [{ title: "B" }, ["event_status", "event_url", "start"], ["end"]]);
  const previous = { title: "A", start: "S", end: "E", event_status: "scheduled", extra: "not mapped" };
  const change = changeBetween(previous, mapped, { external_id: "r1", change_kind: "changed" });
  assert.deepEqual(change.after, { title: "B", start: "S", event_status: "scheduled" });
  assert.deepEqual(change.changed_fields, ["end", "title"]);
  assert.deepEqual(change.before, previous);
  assert.match(change.content_digest, /^sha256:[0-9a-f]{64}$/);
  const again = changeBetween(change.after, mapped, { external_id: "r1", change_kind: "changed" });
  assert.deepEqual(again.changed_fields, []);
  assert.equal(again.content_digest, change.content_digest, "a carried value keeps the digest");
  const first = changeBetween(null, mapped, { external_id: "r1", change_kind: "new" });
  assert.deepEqual([first.before, first.after, first.changed_fields], [null, { title: "B" }, ["title"]]);
});

test("findingsFor is linear in records: one unknown value across 80,000 records is one finding, quickly", () => {
  const diagnostics: MappingDiagnostic[] = [];
  for (let i = 0; i < 80_000; i++) diagnostics.push({ code: "VALUE_UNMAPPED", field: "event_status", from: "status", native: "WITHDRAWN", external_id: `evt-${i}` });
  diagnostics.push({ ...diagnostics[0]! });
  const run = timed(() => findingsFor(diagnostics, { source: "events" }));
  assert.equal(run.value.length, 1);
  assert.match(run.value[0]!.summary!, /^.*: 80000 records \(evt-0, evt-1, evt-2, …\)$/);
  assert.ok(run.ms < 2000, `${run.ms}ms`);
});

test("findingsFor keys per source, field, code and value; facts hold no record ids or counts", () => {
  const d = (code: MappingDiagnostic["code"], field: string, native: unknown, id: string | null): MappingDiagnostic => ({ code, field, from: field, native, external_id: id });
  const findings = findingsFor([
    d("VALUE_UNMAPPED", "event_status", "WITHDRAWN", "a"),
    d("VALUE_UNMAPPED", "event_status", "WITHDRAWN", "b"),
    d("VALUE_UNMAPPED", "event_status", "POSTPONED", "a"),
    d("RECORD_REFUSED", "event_status", "WITHDRAWN", "c"),
    d("VALUE_MISSING", "start", null, "a"),
    d("VALUE_NOT_SCALAR", "title", ["x"], "a"),
    d("IDENTITY_MISSING", "identity", null, null),
    d("IDENTITY_MISSING", "identity", null, null),
  ], { source: "events" });
  assert.equal(findings.length, 6);
  const first = findings[0]!;
  assert.match(first.key, /^mapping:events:event_status:VALUE_UNMAPPED:[0-9a-f]{16}$/);
  assert.deepEqual(first.facts, { code: "VALUE_UNMAPPED", field: "event_status", native: "WITHDRAWN" });
  assert.equal(first.priority, "low");
  assert.equal(first.external_id, undefined, "never the record's id, so a change Signal is never retitled");
  assert.match(first.summary!, /2 records \(a, b\)/);
  assert.equal(findings.find((f) => f.facts && (f.facts as { code: string }).code === "RECORD_REFUSED")!.priority, "normal");
  assert.equal(findings.find((f) => f.key === "mapping:events:IDENTITY_MISSING")!.priority, "normal");
  const shaped = findingsFor([
    d("VALUE_NOT_SCALAR", "title", ["x0"], "a"),
    d("VALUE_NOT_SCALAR", "title", ["x1", "y"], "b"),
    d("VALUE_NOT_SCALAR", "title", [], "c"),
    d("VALUE_NOT_SCALAR", "title", { text: "x" }, "d"),
    d("VALUE_MISSING", "start", null, "a"),
    d("VALUE_MISSING", "start", "", "b"),
    d("VALUE_MISSING", "start", "  ", "c"),
  ], { source: "events" });
  assert.deepEqual(shaped.map((f) => [f.key, f.facts]), [
    ["mapping:events:title:VALUE_NOT_SCALAR:list", { code: "VALUE_NOT_SCALAR", field: "title", shape: "list" }],
    ["mapping:events:title:VALUE_NOT_SCALAR:mapping", { code: "VALUE_NOT_SCALAR", field: "title", shape: "mapping" }],
    ["mapping:events:start:VALUE_MISSING:empty", { code: "VALUE_MISSING", field: "start", shape: "empty" }],
  ], "distinct lists share one finding, and null, empty and blank share one");
  assert.match(shaped[0]!.summary!, /3 records/);
  const spellings = findingsFor([
    d("VALUE_UNMAPPED", "event_status", 7, "a"), d("VALUE_UNMAPPED", "event_status", "7", "b"),
    d("VALUE_UNMAPPED", "event_status", true, "a"), d("VALUE_UNMAPPED", "event_status", "true", "b"),
  ], { source: "events" });
  assert.equal(spellings.length, 2, "a number and its decimal string are one lookup, so one finding");
  const long = findingsFor([d("VALUE_UNMAPPED", "title", "x".repeat(200), "a")], { source: "events" })[0]!;
  assert.equal(((long.facts as { native: string }).native).length, 80);
});

// ------------------------------------------------------------------------------------ OKF fields

test("no top-level key a Connector adds is an OKF field, so the engine writes the document on both editions", async () => {
  // Core's own authorities: the standard and managed field predicates, the never-owned set, and
  // the v0.2 authoring validator itself, probed with values no standard field accepts in every shape.
  const probes: unknown[] = [42, "x", ["x"], [{}], {}, true];
  const okfOwns = (key: string): boolean =>
    isStandardDocumentSetField(key, "0.1") || isStandardDocumentSetField(key, "0.2") || isManagedDocumentMetadataField(key) || NEVER_OWNED.has(key)
    || probes.some((value) => {
      try {
        assertAuthoredOkfStandardFields({ type: "Connector", title: "Probe", [key]: value });
        return false;
      } catch {
        return true;
      }
    });
  for (const key of ["sources", "tags", "verified", "generated", "status", "stale_after", "usage_window", "resource", "timestamp"]) {
    assert.equal(okfOwns(key), true, `the probe recognizes OKF's '${key}'`);
  }
  for (const key of CONNECTOR_DOCUMENT_KEYS) assert.equal(okfOwns(key), false, `'${key}' is an OKF field`);
  // Every top-level key the example declares is OKF's type, title or description, or one of the keys above.
  for (const key of Object.keys(base().frontmatter)) {
    assert.ok(["type", "title", "description", ...CONNECTOR_DOCUMENT_KEYS].includes(key), `undeclared top-level key '${key}'`);
  }

  for (const okfVersion of ["0.1", "0.2"] as const) {
    const backend = new MemoryBackend();
    await backend.writeReserved("", "index.md", `---\nokf_version: '${okfVersion}'\n---\n# Connectors\n`);
    const { frontmatter, body } = base();
    const written = await mutateDocument({
      bundle: { root: `mem://okf-${okfVersion}`, backend },
      id: CONNECTOR_ID,
      mode: "create-only",
      registry: { kinds: new Map(), warnings: [] },
      strict: false,
      buildCandidate: () => ({ frontmatter: frontmatter as OkfDocument["frontmatter"], body }),
    });
    const read = await backend.read(CONNECTOR_ID);
    assert.equal(read.version, written.version, okfVersion);
    const reparsed = parseConnectorDoc(read.doc);
    assert.ok(reparsed.ok, `${okfVersion}: ${JSON.stringify(reparsed.ok ? [] : reparsed.errors)}`);
    assert.equal(connectorPinDigest(reparsed.connector), connectorPinDigest(parseExampleConnector()), okfVersion);
  }
});

test("the parser reads no top-level key beyond type, title, description and CONNECTOR_DOCUMENT_KEYS", () => {
  const touched = new Set<string>();
  const note = (key: string | symbol): void => { if (typeof key === "string") touched.add(key); };
  const { frontmatter, body } = base();
  const watched = new Proxy(frontmatter, {
    get: (target, key, receiver) => (note(key), Reflect.get(target, key, receiver)),
    has: (target, key) => (note(key), Reflect.has(target, key)),
    getOwnPropertyDescriptor: (target, key) => (note(key), Reflect.getOwnPropertyDescriptor(target, key)),
  });
  const parsed = parseConnectorDoc({ id: CONNECTOR_ID, frontmatter: watched, body } as OkfDocument);
  assert.ok(parsed.ok, JSON.stringify(parsed.ok ? [] : parsed.errors));
  const declared = new Set<string>(["type", "title", "description", ...CONNECTOR_DOCUMENT_KEYS]);
  assert.deepEqual([...touched].filter((key) => !declared.has(key)), []);
  assert.ok([...declared].every((key) => touched.has(key)), "every declared key is read");
});
