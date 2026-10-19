/**
 * A synthetic keyless ticket board for the source engine and harness tests: a `Ticket` Kind, a
 * connector whose source runs the `json-pages` test profile, a Source Feed, three overlay
 * documents, and one scripted scenario per required scenario (plus page-number and POST variants).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseConnectorDoc, type Connector } from "../../../src/connectors.js";
import { parseMarkdown } from "../../../src/frontmatter.js";
import type { ScriptedExchange, SourceFixture, SourceScenario } from "../../../src/source-harness/index.js";
import type { OkfDocument } from "../../../src/types.js";
import { jsonPagesProfile, type JsonPagesSpec } from "./json-pages-profile.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_FEEDS = path.resolve(here, "../../../../../examples/recipes/source-feeds/conventions");

export const HOST = "tickets.example.org";
export const FEED_ID = "source-feeds/board";
export const FEED_URL = `https://${HOST}/boards/main`;
export const ITEMS = `https://${HOST}/boards/main/items`;
export const CONNECTOR_ID = "connectors/tickets";

export const CONNECTOR_MD = `---
type: Connector
title: Ticket board (synthetic)
auth:
  kind: none
domains:
  - ${HOST}
record_sources:
  - name: tickets
    profile: json-pages
    target_kind: Ticket
    mode: overlay
    identity:
      resource: "https://${HOST}/boards/{board}"
      id: "{id}"
    fields:
      title: title
      state:
        from: status
        values: { OPEN: open, DONE: closed }
        unmapped: keep
      priority:
        from: priority
        values: { low: low, high: high }
      url: html_url
    completeness: complete
---
# Ticket board

A synthetic paged JSON board for the source engine tests.
`;

export function ticketConnector(markdown = CONNECTOR_MD): Connector {
  const { frontmatter, body } = parseMarkdown(markdown);
  const parsed = parseConnectorDoc({ id: CONNECTOR_ID, frontmatter, body });
  assert.ok(parsed.ok, parsed.ok ? "" : JSON.stringify(parsed.errors));
  return parsed.connector;
}

const conventionDoc = (file: string, id: string): OkfDocument => {
  const { frontmatter, body } = parseMarkdown(readFileSync(path.join(SOURCE_FEEDS, file), "utf8"));
  return { id, frontmatter, body };
};

export const TICKET_CONVENTION: OkfDocument = {
  id: "conventions/ticket",
  body: "# Ticket\n",
  frontmatter: {
    type: "Convention", title: "Ticket", governs: "Ticket", path: "tickets/",
    fields: { required: ["title", "state"], optional: ["priority", "note", "url"], values: { state: ["open", "closed"], priority: ["low", "high"] } },
  },
};

export const FEED_FRONTMATTER = {
  type: "Source Feed", title: "Main board (synthetic)", connector: CONNECTOR_ID, source: "tickets", url: FEED_URL,
  owned_fields: ["title", "state", "priority"], auto_apply: ["new", "changed"], needs_review: ["disappeared"], missing_threshold: 2,
};

const overlay = (id: string, title: string, extra: Record<string, unknown> = {}): OkfDocument => ({
  id: `tickets/${id}`,
  body: "Editor notes.\n",
  frontmatter: { type: "Ticket", title, state: "open", priority: "low", ...extra, sources: [{ resource: FEED_URL, id }] },
});

export function ticketDocuments(): OkfDocument[] {
  return [
    TICKET_CONVENTION,
    conventionDoc("signal.md", "conventions/signal"),
    conventionDoc("source-feed.md", "conventions/source-feed"),
    { id: FEED_ID, body: "Synthetic feed.\n", frontmatter: { ...FEED_FRONTMATTER } },
    overlay("t1", "First"),
    overlay("t2", "Second"),
    overlay("t3", "Third"),
  ];
}

export const SPEC: JsonPagesSpec = { host: HOST, path: "/boards/{board}/items", paging: "cursor", complete: true, method: "GET" };

export function ticketFixture(): SourceFixture {
  return { connector: ticketConnector(), profile: jsonPagesProfile, spec: SPEC, documents: ticketDocuments(), feed: FEED_ID };
}

export const ticket = (id: string, title: string, status = "OPEN", extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, title, status, priority: "low", html_url: `https://${HOST}/t/${id}`, ...extra,
});
const T1 = ticket("t1", "First");
const T2 = ticket("t2", "Second");
const T3 = ticket("t3", "Third");

const page = (url: string, items: unknown[], next?: Record<string, unknown>): ScriptedExchange => ({
  request: { url },
  response: { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ items, ...next }) },
});
const after = (token: string): string => `${ITEMS}?after=${encodeURIComponent(token)}`;
const numbered = (n: number): string => `${ITEMS}?page=${n}`;
const status = (url: string, code: number, headers: Record<string, string> = {}): ScriptedExchange => ({ request: { url }, response: { status: code, headers, body: "" } });
const hang = (url: string): ScriptedExchange => ({ request: { url }, response: { hang: true } });
/** A first observation of all three tickets, as one page. */
const baseline = (): ScriptedExchange => page(ITEMS, [T1, T2, T3]);

export const HOSTILE = "x&page=9/../@evil.example.net\"y";

export const SCENARIOS: SourceScenario[] = [
  { name: "errors.auth", runs: [{ exchanges: [status(ITEMS, 401)] }] },
  {
    name: "errors.rate-limit",
    runs: [{ exchanges: [page(ITEMS, [T1], { next: "c1" }), status(after("c1"), 429, { "Retry-After": "120" })] }],
  },
  { name: "errors.server", runs: [{ exchanges: [status(ITEMS, 503)] }] },
  {
    name: "errors.malformed",
    runs: [
      { exchanges: [{ request: { url: ITEMS }, response: { status: 200, headers: { "content-type": "text/html" }, body: "<html>not json</html>" } }] },
      { budget: { maxBytes: 64 }, exchanges: [page(ITEMS, [T1, T2, T3])] },
    ],
  },
  {
    name: "page.incomplete",
    runs: [{ mode: "complete", exchanges: [page(ITEMS, [T1], { next: "c1" }), hang(after("c1"))] }],
  },
  {
    name: "cursor.resume",
    runs: [
      { exchanges: [page(ITEMS, [T1, T2], { next: "c1" }), status(after("c1"), 503)] },
      // Run 2 asks only for what the stored cursor admits; T2 overlaps and yields no change.
      { exchanges: [page(after("c1"), [T2, T3])] },
    ],
  },
  {
    name: "cursor.resume.page-number",
    spec: { ...SPEC, paging: "page-number" },
    runs: [
      { exchanges: [page(numbered(1), [T1, T2], { has_more: true }), status(numbered(2), 503)] },
      // Page numbers do not survive a pass: the resumed pass starts again at page 1.
      { exchanges: [page(numbered(1), [T1, T2], { has_more: true }), page(numbered(2), [T3], { has_more: false })] },
    ],
  },
  {
    name: "cursor.hostile",
    runs: [
      // A hostile token is one query value, encoded whole.
      { exchanges: [page(ITEMS, [T1], { next: HOSTILE }), page(after(HOSTILE), [T2])] },
      // A provider `next_url` to another host, or carrying userinfo, is refused by the hop guard.
      { mode: "complete", exchanges: [page(ITEMS, [T1], { next_url: "https://evil.example.net/steal" })] },
      { mode: "complete", exchanges: [page(ITEMS, [T1], { next_url: `https://${HOST}@evil.example.net/steal` })] },
    ],
  },
  {
    name: "complete.disappear",
    runs: [
      { mode: "complete", exchanges: [baseline()] },
      { mode: "complete", exchanges: [page(ITEMS, [T1, T2])] },
      // A partial pass and a resumed pass without T3 do not count toward its disappearance.
      { mode: "complete", exchanges: [page(ITEMS, [T1], { next: "c1" }), hang(after("c1"))] },
      { exchanges: [page(after("c1"), [T2])] },
      { mode: "complete", exchanges: [page(ITEMS, [T1, T2])] },
    ],
  },
  {
    name: "fields.owned-conflict",
    runs: [
      { exchanges: [baseline()] },
      { edits: [{ id: "tickets/t1", set: { title: "Editor's title" } }], exchanges: [page(ITEMS, [ticket("t1", "Provider's title"), T2, T3])] },
    ],
  },
  {
    name: "fields.unmapped",
    runs: [{ exchanges: [baseline()] }, { exchanges: [page(ITEMS, [T1, ticket("t2", "Second", "BLOCKED"), T3])] }],
  },
  {
    name: "fields.null",
    runs: [
      { exchanges: [baseline()] },
      { exchanges: [page(ITEMS, [ticket("t1", "First", "OPEN", { priority: null }), T2, ticket("t3", "", "OPEN", { priority: "high" })])] },
    ],
  },
  {
    name: "identity.missing",
    runs: [{ exchanges: [page(ITEMS, [T1, { title: "No id", status: "OPEN" }, T3])] }],
  },
  {
    name: "hosts.redirect",
    runs: [{ exchanges: [{ request: { url: ITEMS }, response: { status: 302, headers: { location: "https://cdn.example.net/items.json" }, body: "" } }] }],
  },
  { name: "hosts.undeclared", spec: { ...SPEC, host: "elsewhere.example.net" }, runs: [{ exchanges: [] }] },
  { name: "hosts.undeclared.post", spec: { ...SPEC, method: "POST" }, runs: [{ exchanges: [] }] },
];
