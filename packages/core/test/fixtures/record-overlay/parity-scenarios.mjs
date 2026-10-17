/**
 * Record-overlay parity scenarios: synthetic inputs (example.org providers, invented records) and
 * one runner that drives any engine binding through them and returns a JSON-safe transcript.
 *
 * `parity.json` beside this file is that transcript as produced by the reference record-bridge
 * implementation bound through the same `engine` interface, over the same core storage, with the
 * clock fixed. `record-overlay-parity.test.ts` binds `@superbee/core/record-overlay` and requires
 * a deep-equal transcript: the same plans, receipts, written bytes (every write's version token is
 * the content address of its serialized document), digests and decisions.
 *
 * Engine binding: { readPolicy(doc, ctx), plan({ ops, content, policy, changes, observedAt,
 * records, observation, sameBundle, correlate }), apply(plan, { ops, content, policy, actor }),
 * planFindings(input), decideChange(policy, change, opts), ownershipGuard(args),
 * canonicalJson(value), sha256(text), shortHash(...parts), findingDigest(finding) }. The binding
 * supplies its own text gate, interval and derived-field rules; every scenario keeps to inputs on
 * which the reference rules and record-overlay's test doubles agree (gate-neutral text, offset
 * datetimes, owned-field writes that always change substance).
 *
 * `core` supplies { MemoryBackend, mutateDocument, loadKinds, stringifyDoc } from the build the
 * engine itself writes through, so both sides share one storage and serialization.
 *
 * Regenerating `parity.json`: bind the reference implementation's policy, plan, apply, findings
 * and digest modules to the interface above, pass this package's built `dist` as `core`, and write
 * `JSON.stringify(await runParity({ core, engine }), null, 2)` plus a newline. The reference is
 * private, so its binding, revision and command are recorded with the change that introduced this
 * file rather than here. Any edit to the scenarios requires regenerating against the reference.
 */

export const FIXED_NOW = "2026-10-17T12:00:00.000Z";
export const ACTOR = "process:overlay-parity";
const EDITOR = "human:editor";
const PROVIDER = "https://calendar.example.org/feed.ics";
const SECRET_PROVIDER = "https://api.example.org/events.json?token=fixturetoken987&city=springfield";
const OTHER = "https://other.example.org/feed.ics";
const FEED = "source-feeds/synthetic-library";
const UID = (n) => `evt-${n}@calendar.example.org`;
const DIGEST = (n) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

// --------------------------------------------------------------------------------- conventions

const eventConvention = {
  type: "Convention", title: "Event", governs: "Event", path: "events/",
  fields: {
    required: ["title", "start"],
    optional: ["end", "event_status", "event_url", "venue_text", "cost_text", "updated_at", "note"],
    values: { event_status: ["scheduled", "canceled", "postponed"] },
    types: { start: "datetime", end: "datetime", event_url: "https-url", updated_at: "datetime" },
  },
};
const signalConvention = (progress) => ({
  type: "Convention", title: "Signal", governs: "Signal", path: "signals/",
  links: { "from feed": "Source Feed", "about event": "Event", "about place": "Place" },
  claim: { owner_field: "assignee", state_field: "progress_status" },
  fields: {
    required: ["title", progress, "change_kind", "observed_at"],
    optional: ["provider", "external_id", "diff_summary", "priority", "assignee", "expires_at", "content_digest", "about_doc"],
    values: { [progress]: ["todo", "in_progress", "done", "dismissed"], priority: ["low", "normal", "urgent"] },
  },
});
const sourceFeedConvention = {
  type: "Convention", title: "Source Feed", governs: "Source Feed", path: "source-feeds/",
  fields: {
    required: ["title", "feed_kind", "url", "owned_fields"],
    optional: ["target_kind", "auto_apply", "needs_review", "missing_threshold", "completeness", "exclude_pattern", "wall_time_zone", "rights_note"],
  },
};
const placeConvention = {
  type: "Convention", title: "Place", governs: "Place", path: "places/",
  fields: { required: ["title"], optional: ["address"] },
};

const feedFrontmatter = (over = {}) => ({
  type: "Source Feed", title: "Synthetic library calendar (fictional)", feed_kind: "ics", url: PROVIDER, target_kind: "Event",
  owned_fields: ["start", "end", "event_status", "event_url", "venue_text"],
  auto_apply: ["changed", "canceled"], needs_review: ["new", "canceled", "disappeared"], rights_note: "Facts and links only.",
  ...over,
});

const event = (n, fm, provider = PROVIDER) => ({
  type: "Event", event_status: "scheduled", ...fm,
  sources: [{ resource: provider, id: UID(n), title: "feed record" }],
});
const EDITOR_BODY = "Editor-written description. Not feed-owned.\n";
const signal = (progress, fm, body) => ({
  frontmatter: { type: "Signal", [progress]: "todo", priority: "low", provider: PROVIDER, ...fm },
  body,
});
const observationBody = (lines) => `[from feed](../source-feeds/synthetic-library.md)\n\n# Observations\n\n${lines.join("\n")}\n`;

// --------------------------------------------------------------------------------- scenarios

const STORY = { title: "Story Time", start: "2026-10-10T10:00:00-04:00", end: "2026-10-10T11:00:00-04:00", event_status: "scheduled" };
const MARKET = { title: "Harvest Market", start: "2026-10-11T09:00:00-04:00", end: "2026-10-11T13:00:00-04:00", event_status: "scheduled" };
const CLEANUP = { title: "Trail Cleanup", start: "2026-10-24T09:00:00-04:00", end: "2026-10-24T12:00:00-04:00", event_status: "scheduled", venue_text: "North Trailhead" };
const change = (n, kind, before, after, digest, extra = {}) => ({
  external_id: typeof n === "number" || /^\d+$/.test(n) ? UID(n) : n,
  change_kind: kind,
  changed_fields: kind === "new" ? Object.keys(after ?? {}) : kind === "disappeared" ? [] : Object.keys({ ...before, ...after }).filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])),
  before, after, content_digest: digest, ...extra,
});

/**
 * Each scenario: `edition` of every bundle, `separate` ops and content bundles, `feed` frontmatter
 * overrides, `docs` seeded in the content bundle and `opsDocs` in the ops bundle (an editor's
 * writes), `changes`, `observedAt`, optional `records`, `observation`, `correlate`, `plan` (a
 * hand-built plan instead of the planner's) and `between(ctx)` (an editor write between plan and apply).
 */
export const SCENARIOS = [
  {
    name: "new record raises one low Signal with the feed link and adoption hint",
    changes: [change("006", "new", null, { title: "Pumpkin Carving", start: "2026-10-25T14:00:00-04:00", end: "2026-10-25T16:00:00-04:00", event_status: "scheduled" }, DIGEST(1))],
  },
  {
    name: "owned fields apply with updated_at; an editor-owned change raises a typed about link",
    docs: { "events/story-time": [event("001", { ...STORY, title: "Story Time (editor title)", venue_text: "Community Room" }), EDITOR_BODY], "events/harvest-market": [event("002", MARKET), EDITOR_BODY] },
    changes: [
      change("001", "changed", STORY, { ...STORY, start: "2026-10-10T11:00:00-04:00", end: "2026-10-10T12:00:00-04:00" }, DIGEST(2)),
      change("002", "changed", MARKET, { ...MARKET, title: "Harvest Market and Craft Fair" }, DIGEST(3)),
    ],
  },
  {
    name: "a cancellation of an overlaid record applies the owned status and raises an urgent Signal",
    docs: { "events/trail-cleanup": [event("005", CLEANUP), EDITOR_BODY] },
    changes: [change("005", "canceled", CLEANUP, { ...CLEANUP, event_status: "canceled" }, DIGEST(4))],
  },
  {
    name: "an editor's edit of an owned field is a conflict and the document keeps it",
    docs: { "events/story-time": [event("001", { ...STORY, start: "2026-10-10T11:15:00-04:00" }), EDITOR_BODY] },
    changes: [change("001", "changed", STORY, { ...STORY, start: "2026-10-10T11:30:00-04:00" }, DIGEST(5))],
  },
  {
    name: "an absent document field against a feed null is a conflict, not a write",
    docs: { "events/story-time": [event("001", { title: STORY.title, start: STORY.start, event_status: "scheduled" }), EDITOR_BODY] },
    changes: [change("001", "changed", { ...STORY, end: null }, { ...STORY, end: "2026-10-10T12:00:00-04:00" }, DIGEST(6))],
  },
  {
    name: "a replayed change dedupes against a closed Signal's observation log",
    opsDocs: { "signals/synthetic-library-replayed": signal("superbee_progress_status", { superbee_progress_status: "done", title: "New: Story Time", change_kind: "new", observed_at: "2026-10-03T12:00:00Z", external_id: UID("001"), diff_summary: "new record" },
      observationBody([`- 2026-10-03T12:00:00Z · new · ${DIGEST(7)} · new record`])) },
    changes: [change("001", "new", null, { ...STORY, venue_text: "Room B" }, DIGEST(7))],
  },
  {
    name: "a change with an open unclaimed Signal collapses into it; a claimed one raises a new Signal",
    opsDocs: {
      "signals/synthetic-library-open": signal("superbee_progress_status", { title: "New: Pumpkin Carving", change_kind: "new", observed_at: "2026-10-03T12:00:00Z", external_id: UID("006"), diff_summary: "new record" },
        observationBody([`- 2026-10-03T12:00:00Z · new · ${DIGEST(8)} · new record`])),
      "signals/synthetic-library-claimed": signal("superbee_progress_status", { superbee_progress_status: "in_progress", assignee: "agent/claimant", title: "New: Fall Fair", change_kind: "new", observed_at: "2026-10-03T12:00:00Z", external_id: UID("007"), diff_summary: "new record" },
        observationBody([`- 2026-10-03T12:00:00Z · new · ${DIGEST(9)} · new record`])),
    },
    changes: [
      change("006", "changed", { title: "Pumpkin Carving", start: "2026-10-25T14:00:00-04:00" }, { title: "Pumpkin Carving Night", start: "2026-10-25T15:00:00-04:00" }, DIGEST("a")),
      change("007", "canceled", { title: "Fall Fair", event_status: "scheduled" }, { title: "Fall Fair", event_status: "canceled" }, DIGEST("b")),
    ],
  },
  {
    name: "two documents claiming one identity are refused as ambiguous with one normal Signal",
    docs: { "events/a-story": [event("001", STORY), EDITOR_BODY], "events/b-story": [event("001", STORY), EDITOR_BODY] },
    changes: [change("001", "changed", STORY, { ...STORY, start: "2026-10-10T11:00:00-04:00" }, DIGEST("c"))],
  },
  {
    name: "one document carrying the identity twice is ambiguous with that document twice",
    docs: { "events/doubled": [{ ...event("001", STORY), sources: [{ resource: PROVIDER, id: UID("001") }, { resource: OTHER, id: "x" }, { resource: PROVIDER, id: UID("001"), title: "again" }] }, EDITOR_BODY] },
    changes: [change("001", "changed", STORY, { ...STORY, start: "2026-10-10T11:00:00-04:00" }, DIGEST("d"))],
  },
  {
    name: "disappearances: ended retires quietly, before its start is raised, without a first miss is raised",
    feed: { completeness: "complete", missing_threshold: 2, wall_time_zone: "America/New_York" },
    observedAt: "2026-10-05T12:00:00Z",
    changes: [
      change("ended@x.example", "disappeared", { title: "Afternoon Matinee", start: "2026-10-03T14:00:00-04:00", end: "2026-10-03T16:00:00-04:00" }, null, DIGEST("e"), { missing_count: 2, first_missing_at: "2026-10-04T12:00:00Z" }),
      change("no-end@x.example", "disappeared", { title: "Silent Disco", start: "2026-10-03T20:00:00-04:00" }, null, DIGEST("f"), { missing_count: 2, first_missing_at: "2026-10-04T12:00:00Z" }),
      change("future@x.example", "disappeared", { title: "Fall Fair", start: "2026-10-20T10:00:00-04:00", end: "2026-10-20T15:00:00-04:00" }, null, DIGEST(0), { missing_count: 2, first_missing_at: "2026-10-04T12:00:00Z" }),
      change("unknown@x.example", "disappeared", { title: "Old Store Entry", start: "2026-10-02T10:00:00-04:00" }, null, DIGEST(1), { missing_count: 2 }),
    ],
  },
  {
    name: "an ended record with an open Signal tells it so; a superseded record joins its successor",
    feed: { completeness: "complete", missing_threshold: 2 },
    observedAt: "2026-10-05T12:00:00Z",
    opsDocs: {
      "signals/synthetic-library-evening": signal("superbee_progress_status", { title: "New: Evening Concert", change_kind: "new", observed_at: "2026-10-02T16:00:00Z", external_id: "evening@x.example", diff_summary: "new record" },
        observationBody([`- 2026-10-02T16:00:00Z · new · ${DIGEST(2)} · new record`])),
      "signals/synthetic-library-old-hours": signal("superbee_progress_status", { title: "New: Old Hours", change_kind: "new", observed_at: "2026-10-02T16:00:00Z", external_id: "hours-v1@x.example", diff_summary: "new record", priority: "normal" },
        observationBody([`- 2026-10-02T16:00:00Z · new · ${DIGEST(3)} · new record`])),
    },
    changes: [
      change("evening@x.example", "disappeared", { title: "Evening Concert", start: "2026-10-03T19:00:00-04:00", end: "2026-10-03T21:00:00-04:00" }, null, DIGEST(2), { missing_count: 2, first_missing_at: "2026-10-04T12:00:00Z" }),
      change("hours-v2@x.example", "new", null, { title: "New Hours" }, DIGEST(4), { collapse_with: ["hours-v1@x.example"] }),
      change("hours-v3@x.example", "new", null, { title: "Newer Hours" }, DIGEST(5), { collapse_with: ["hours-v1@x.example"] }),
      change("hours-v1@x.example", "disappeared", { title: "Old Hours" }, null, DIGEST(3), { missing_count: 2 }),
    ],
  },
  {
    name: "an excluded record is record-only",
    feed: { exclude_pattern: "\\bclosed\\b" },
    changes: [change("closed@x.example", "new", null, { title: "Library Closed", start: "2026-11-26T00:00:00-05:00" }, DIGEST(6))],
  },
  {
    name: "a correlation hint raises the priority and names the related document",
    docs: { "places/corner-cafe": [{ type: "Place", title: "Corner Cafe", address: "5 Example St" }, ""], "places/other-shop": [{ type: "Place", title: "Other Shop", address: "9 Example St" }, ""] },
    correlate: true,
    changes: [change("lic-1@x.example", "new", null, { title: "Corner Cafe LLC", address: "5 Example St" }, DIGEST(7))],
  },
  {
    name: "an owned-field removal deletes the field; a change's own priority is honoured",
    docs: { "events/trail-cleanup": [event("005", CLEANUP), EDITOR_BODY] },
    changes: [
      change("005", "changed", CLEANUP, { title: CLEANUP.title, start: CLEANUP.start, end: CLEANUP.end, event_status: "scheduled" }, DIGEST(8)),
      change("009", "canceled", { title: "Book Swap", event_status: "scheduled" }, { title: "Book Swap", event_status: "canceled" }, DIGEST(9), { signal_priority: "urgent" }),
    ],
  },
  {
    name: "a concurrent editor write between plan and apply loses the CAS",
    docs: { "events/trail-cleanup": [event("005", CLEANUP), EDITOR_BODY] },
    changes: [change("005", "canceled", CLEANUP, { ...CLEANUP, event_status: "canceled" }, DIGEST("a"))],
    between: { id: "events/trail-cleanup", patch: { cost_text: "Free" } },
  },
  {
    name: "a forged step that writes a non-owned field is refused",
    docs: { "events/harvest-market": [event("002", MARKET), EDITOR_BODY] },
    changes: [],
    plan: (heads) => ({
      feed: FEED, provider: PROVIDER, observed_at: "2026-10-03T14:00:00Z", refusals: [],
      steps: [{ op: "apply-owned-fields", target: "events/harvest-market", expected_version: heads["events/harvest-market"], external_id: UID("002"), change_kind: "changed", fields: { title: { from: MARKET.title, to: "Hijacked" } } }],
    }),
  },
  {
    name: "separate ops and content bundles name the overlay without a typed link",
    separate: true,
    docs: { "events/harvest-market": [event("002", MARKET), EDITOR_BODY] },
    changes: [change("002", "changed", MARKET, { ...MARKET, title: "Harvest Market and Craft Fair", start: "2026-10-11T10:00:00-04:00" }, DIGEST("b"))],
  },
  {
    name: "a core type refusal with another Kind finding is held and value-free",
    docs: { "events/typed": [event("010", { title: "Typed", start: "2026-10-10T10:00:00-04:00", end: "2026-10-10T11:00:00-04:00", event_url: "https://calendar.example.org/e/1" }), "Editor text.\n"] },
    changes: [change("010", "changed",
      { start: "2026-10-10T10:00:00-04:00", end: "2026-10-10T11:00:00-04:00", event_url: "https://calendar.example.org/e/1", event_status: "scheduled" },
      { end: "2026-10-10T11:00:00-04:00", event_url: "http://calendar.example.org/e/1?token=secret456", event_status: "scheduled" }, DIGEST("c"))],
  },
  {
    name: "a provider URL carrying a token is redacted in every Signal",
    feed: { url: SECRET_PROVIDER },
    docs: { "events/story-time": [event("001", STORY, SECRET_PROVIDER), EDITOR_BODY] },
    changes: [
      change("001", "canceled", STORY, { ...STORY, event_status: "canceled" }, DIGEST("d")),
      change("011", "new", null, { title: "Lantern Walk", start: "2026-10-30T19:00:00-04:00" }, DIGEST("e")),
    ],
  },
  {
    name: "an OKF v0.1 ops bundle claims Signals through status",
    edition: "0.1",
    docs: { "events/story-time": [event("001", STORY), EDITOR_BODY] },
    opsDocs: {
      "signals/synthetic-library-open": signal("status", { title: "New: Pumpkin Carving", change_kind: "new", observed_at: "2026-10-03T12:00:00Z", external_id: UID("006"), diff_summary: "new record" },
        observationBody([`- 2026-10-03T12:00:00Z · new · ${DIGEST(8)} · new record`])),
    },
    changes: [
      change("001", "changed", STORY, { ...STORY, start: "2026-10-10T11:00:00-04:00" }, DIGEST("f")),
      change("006", "changed", { title: "Pumpkin Carving" }, { title: "Pumpkin Carving Night" }, DIGEST(0)),
      change("012", "new", null, { title: "Leaf Pickup", start: "2026-11-02T08:00:00-05:00" }, DIGEST(1)),
    ],
  },
];

/** Findings planned and applied with an empty owned set, as a tool-raised review does. */
const FINDINGS_OBSERVED_AT = "2026-10-11T02:00:00Z";
const finding = (key, facts, over = {}) => ({ key, title: `Check ${key}`, summary: `Status check for ${key}`, facts, ...over });
export const FINDINGS = {
  provider: "process:status-review",
  slug: "status-review",
  findings: [
    finding("places/corner-cafe", { listed: "open", observed: "closed" }, { priority: "urgent", about_doc: "places/corner-cafe" }),
    finding("places/dismissed", { listed: "open", observed: "closed" }),
    finding("places/updated", { listed: "open", observed: "moved" }, { priority: "normal" }),
    finding("places/expired", { listed: "open", observed: "closed" }, { expires_at: "2026-11-10T02:00:00Z" }),
    finding("places/sourced", { observed: "closed" }, { sources: [{ resource: SECRET_PROVIDER, id: "row-1", title: "row" }], related: ["places/a", "places/b"] }),
    finding("places/corner-cafe", { listed: "open", observed: "closed" }),
    { key: "", title: "no key" },
  ],
  // Existing Signals, keyed by the finding whose digest or external id they carry.
  seed: (digest) => ({
    "signals/status-review-dismissed": { frontmatter: { type: "Signal", superbee_progress_status: "dismissed", title: "Check places/dismissed", change_kind: "status-check", observed_at: "2026-10-04T02:00:00Z", provider: "process:status-review", external_id: "places/dismissed", diff_summary: "s", priority: "normal", content_digest: digest(finding("places/dismissed", { listed: "open", observed: "closed" })) }, body: "# Observations\n\n- old\n" },
    "signals/status-review-updated": { frontmatter: { type: "Signal", superbee_progress_status: "todo", title: "Check places/updated", change_kind: "status-check", observed_at: "2026-10-04T02:00:00Z", provider: "process:status-review", external_id: "places/updated", diff_summary: "s", priority: "low", content_digest: DIGEST(2) }, body: "# Observations\n\n- old\n" },
    "signals/status-review-expired": { frontmatter: { type: "Signal", superbee_progress_status: "dismissed", title: "Check places/expired", change_kind: "status-check", observed_at: "2026-10-04T02:00:00Z", provider: "process:status-review", external_id: "places/expired", diff_summary: "s", priority: "normal", expires_at: "2026-10-10T02:00:00Z", content_digest: digest(finding("places/expired", { listed: "open", observed: "closed" })) }, body: "# Observations\n\n- old\n" },
  }),
};

// --------------------------------------------------------------------------------- direct rows

/** Inputs whose canonical form the three-value rule and the guard depend on. */
const CANON_INPUTS = {
  "nested maps with unsorted keys": { b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } },
  "non-ASCII keys": { "é": 1, "e": 2, "日本": 3, "Z": 4 },
  "array holding undefined": [1, undefined, 3],
  "member holding undefined": { a: 1, b: undefined },
  "NaN and Infinity": { n: NaN, i: Infinity, m: -Infinity },
  "a Date": new Date("2026-10-17T00:00:00Z"),
  "a Date member": { at: new Date("2026-10-17T00:00:00Z") },
  "a function member": { f: () => 1, a: 1 },
  "top-level undefined": undefined,
  "top-level null": null,
  "negative zero": -0,
  "a string": "Ünïcödé 🐝",
  "an empty map": {},
};

const SHA_INPUTS = ["", "abc", "Ünïcödé 🐝", "\ud800 lone surrogate", "\u0000", "x".repeat(1000)];
const SHORT_HASH_INPUTS = [
  [FEED, UID("001"), DIGEST(1)],
  [FEED, UID("001"), DIGEST(1), "disappeared"],
  [1, 2, 3],
  [undefined, null, true],
  [{}, ["a", "b"]],
  ["a\u0000b", "c"],
  [],
];
const FINDING_DIGEST_INPUTS = [
  { key: "k", facts: { b: 2, a: 1 } },
  { key: "k", facts: { a: 1, b: 2 } },
  { key: "k" },
  { key: "k", facts: { at: new Date("2026-10-17T00:00:00Z"), other: new Date("2027-01-01T00:00:00Z") } },
  { key: "k", facts: { n: NaN, f: () => 1, u: undefined, list: [undefined, 1] } },
  { key: "ключ", facts: { "名前": "Café", nested: { z: [1, { y: null }] } } },
  { key: "k", facts: null },
];

const DECISION_POLICY = { url: "https://p.example/f.ics", target_kind: "Event", owned_fields: ["start", "event_status"], auto_apply: ["changed", "canceled"], needs_review: ["new", "canceled", "disappeared"] };
const A = { title: "A", start: "2026-10-10T10:00:00-04:00", event_status: "scheduled" };
const DECISIONS = [
  ["owned applies, editor-owned named", { external_id: "a", change_kind: "changed", changed_fields: ["start", "title"], before: { ...A }, after: { ...A, title: "A2", start: "S2" } }, { overlay: { frontmatter: { ...A } } }],
  ["diverged is a conflict", { external_id: "a", change_kind: "changed", changed_fields: ["start", "title"], before: { ...A }, after: { ...A, title: "A2", start: "S2" } }, { overlay: { frontmatter: { ...A, start: "EDITED" } } }],
  ["converged writes nothing", { external_id: "a", change_kind: "changed", changed_fields: ["start"], before: { ...A }, after: { ...A, start: "S2" } }, { overlay: { frontmatter: { ...A, start: "S2" } } }],
  ["no overlay is record-only", { external_id: "a", change_kind: "changed", changed_fields: ["start"], before: { ...A }, after: { ...A, start: "S2" } }, {}],
  ["editor-owned change the document already says", { external_id: "a", change_kind: "changed", changed_fields: ["event_types"], before: { ...A }, after: { ...A, event_types: ["school-closed"] } }, { overlay: { frontmatter: { ...A, event_types: ["school-closed"] } } }],
  ["editor-owned change the document differs on", { external_id: "a", change_kind: "changed", changed_fields: ["event_types"], before: { ...A }, after: { ...A, event_types: ["school-closed"] } }, { overlay: { frontmatter: { ...A, event_types: ["civic"] } } }],
  ["cancel of an overlaid record is urgent", { external_id: "a", change_kind: "canceled", changed_fields: ["event_status"], before: A, after: { ...A, event_status: "canceled" } }, { overlay: { frontmatter: A } }],
  ["cancel without an overlay is normal", { external_id: "a", change_kind: "canceled", changed_fields: ["event_status"], before: A, after: { ...A, event_status: "canceled" } }, {}],
  ["cancel of a featured record is urgent", { external_id: "a", change_kind: "canceled", changed_fields: ["event_status"], before: A, after: { ...A, event_status: "canceled" } }, { featured: true }],
  ["new is low", { external_id: "n", change_kind: "new", changed_fields: ["title"], before: null, after: A }, {}],
  ["absent document value against a feed null conflicts", { external_id: "a", change_kind: "changed", changed_fields: ["start"], before: { ...A, start: null }, after: { ...A, start: "S2" } }, { overlay: { frontmatter: { title: "A", event_status: "scheduled" } } }],
  ["document null against a feed null writes", { external_id: "a", change_kind: "changed", changed_fields: ["start"], before: { ...A, start: null }, after: { ...A, start: "S2" } }, { overlay: { frontmatter: { ...A, start: null } } }],
  ["owned change without auto-apply needs judgment", { external_id: "a", change_kind: "page-changed", changed_fields: ["start"], before: { ...A }, after: { ...A, start: "S2" } }, { overlay: { frontmatter: { ...A } } }],
];

const GUARD_ARGS = { ownedFields: ["start"], provider: PROVIDER, externalId: "rec-1" };
const guardDoc = (frontmatter, body = "") => ({ id: "events/x", frontmatter: { type: "Event", start: "x", ...frontmatter }, body });
const IDENTITY = [{ resource: OTHER, id: "x" }, { resource: PROVIDER, id: "rec-1", title: "t" }];
const GUARDS = [
  ["identity among other entries passes", GUARD_ARGS, guardDoc({ sources: IDENTITY }), guardDoc({ sources: IDENTITY })],
  ["another resource with the id is lost", GUARD_ARGS, guardDoc({ sources: [{ resource: OTHER, id: "rec-1" }] }), guardDoc({ sources: [{ resource: OTHER, id: "rec-1" }] })],
  ["the provider with another id is lost", GUARD_ARGS, guardDoc({ sources: [{ resource: PROVIDER, id: "rec-2" }] }), guardDoc({ sources: [{ resource: PROVIDER, id: "rec-2" }] })],
  ["a provider citation without an id is lost", GUARD_ARGS, guardDoc({ sources: [{ resource: PROVIDER }] }), guardDoc({ sources: [{ resource: PROVIDER }] })],
  ["malformed entries are lost", GUARD_ARGS, guardDoc({ sources: [null, "rec-1"] }), guardDoc({ sources: [null, "rec-1"] })],
  ["a mapping instead of a list is lost", GUARD_ARGS, guardDoc({ sources: { resource: PROVIDER, id: "rec-1" } }), guardDoc({ sources: { resource: PROVIDER, id: "rec-1" } })],
  ["no sources is lost", GUARD_ARGS, guardDoc({}), guardDoc({})],
  ["an owned change passes", GUARD_ARGS, guardDoc({ sources: IDENTITY }), guardDoc({ sources: IDENTITY, start: "y" })],
  ["a non-owned scalar is refused", GUARD_ARGS, guardDoc({ sources: IDENTITY, title: "T" }), guardDoc({ sources: IDENTITY, title: "Hijacked" })],
  ["a non-owned key from absent to null is refused", GUARD_ARGS, guardDoc({ sources: IDENTITY }), guardDoc({ sources: IDENTITY, note: null })],
  ["a body change is refused", GUARD_ARGS, guardDoc({ sources: IDENTITY }, "a\n"), guardDoc({ sources: IDENTITY }, "b\n")],
  ["a status write is refused", GUARD_ARGS, guardDoc({ sources: IDENTITY }), guardDoc({ sources: IDENTITY, status: "archived" })],
  ["a moved owned field is a conflict", { ...GUARD_ARGS, expectedFrom: { start: "planned" } }, guardDoc({ sources: IDENTITY }), guardDoc({ sources: IDENTITY, start: "y" })],
  ["a missing document is lost", GUARD_ARGS, undefined, guardDoc({ sources: IDENTITY })],
];

// --------------------------------------------------------------------------------- runner

/** A JSON-safe copy; `undefined` members vanish exactly as they do in a serialized plan. */
const json = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
/** A plan or receipt without the caller-owned `schema` stamp. */
const unstamped = (value) => { const out = json(value); if (out && typeof out === "object") delete out.schema; return out; };
const outcome = (fn) => {
  try { fn(); return "ok"; }
  catch (error) { return { code: error.code ?? null, message: error.message, details: json(error.details ?? {}) }; }
};

function fixClock() {
  const RealDate = globalThis.Date;
  const fixed = RealDate.parse(FIXED_NOW);
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
    static now() { return fixed; }
  }
  globalThis.Date = FixedDate;
  return () => { globalThis.Date = RealDate; };
}

function recordingBackend(core) {
  return class RecordingBackend extends core.MemoryBackend {
    constructor() { super(); this.recording = false; this.writes = []; this.deletes = []; }
    async write(id, doc, options) {
      const version = await super.write(id, doc, options);
      if (this.recording) this.writes.push({ id, version, text: core.stringifyDoc(doc.frontmatter, doc.body ?? "") });
      return version;
    }
    async delete(id, options) {
      if (this.recording) this.deletes.push(id);
      return super.delete(id, options);
    }
  };
}

async function makeBundle(core, Backend, name, edition) {
  const backend = new Backend();
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n# ${name}\n`);
  return { root: `mem://${name}`, backend };
}

async function seed(core, bundle, id, frontmatter, body, registry) {
  const result = await core.mutateDocument({
    bundle, id, mode: "patch", onAbsent: "create", registry: registry ?? { kinds: new Map(), warnings: [] }, strict: false, actor: EDITOR,
    buildCandidate: () => ({ frontmatter: structuredClone(frontmatter), body }),
  });
  return result.version;
}

async function setup(core, Backend, scenario, index) {
  const edition = scenario.edition ?? "0.2";
  const progress = edition === "0.1" ? "status" : "superbee_progress_status";
  const content = await makeBundle(core, Backend, `overlay-parity-${index}-content`, edition);
  const ops = scenario.separate ? await makeBundle(core, Backend, `overlay-parity-${index}-ops`, edition) : content;
  const conventions = { "conventions/event": eventConvention, "conventions/place": placeConvention };
  const opsConventions = { "conventions/signal": signalConvention(progress), "conventions/source-feed": sourceFeedConvention };
  for (const [id, fm] of Object.entries(conventions)) await seed(core, content, id, fm, `# ${fm.title}\n`);
  for (const [id, fm] of Object.entries(opsConventions)) await seed(core, ops, id, fm, `# ${fm.title}\n`);
  const contentRegistry = await core.loadKinds(content);
  const opsRegistry = ops === content ? contentRegistry : await core.loadKinds(ops);
  const feed = feedFrontmatter(scenario.feed);
  await seed(core, ops, FEED, feed, "Synthetic feed used by tests.\n", opsRegistry);
  const heads = {};
  for (const [id, [fm, body]] of Object.entries(scenario.docs ?? {})) heads[id] = await seed(core, content, id, fm, body, contentRegistry);
  for (const [id, { frontmatter, body }] of Object.entries(scenario.opsDocs ?? {})) heads[id] = await seed(core, ops, id, frontmatter, body, opsRegistry);
  return {
    heads,
    feed,
    content: { bundle: content, registry: contentRegistry, okfVersion: edition },
    ops: { bundle: ops, registry: opsRegistry, okfVersion: edition },
  };
}

const correlateByAddress = {
  kind: "Place",
  match: (fields, frontmatter) => (fields.address && fields.address === frontmatter.address ? { reason: "same street address", priority: "urgent" } : null),
};

async function runScenario(core, Backend, engine, scenario, index) {
  const ctx = await setup(core, Backend, scenario, index);
  const policy = engine.readPolicy({ id: FEED, frontmatter: ctx.feed }, { targetKind: ctx.content.registry.kinds.get("Event") });
  const observedAt = scenario.observedAt ?? "2026-10-03T14:00:00Z";
  const plan = scenario.plan
    ? scenario.plan(ctx.heads)
    : await engine.plan({
      ops: ctx.ops, content: ctx.content, policy, changes: scenario.changes, observedAt, records: scenario.records ?? {},
      observation: scenario.observation ?? {}, sameBundle: ctx.ops.bundle === ctx.content.bundle,
      ...(scenario.correlate ? { correlate: correlateByAddress } : {}),
    });
  if (scenario.between) {
    const { id, patch } = scenario.between;
    await core.mutateDocument({ bundle: ctx.content.bundle, id, mode: "patch", registry: ctx.content.registry, strict: true, actor: EDITOR,
      buildCandidate: (e) => ({ frontmatter: { ...e.frontmatter, ...patch }, body: e.body }) });
  }
  const backends = [...new Set([ctx.content.bundle.backend, ctx.ops.bundle.backend])];
  for (const b of backends) b.recording = true;
  const receipt = await engine.apply(plan, { ops: ctx.ops, content: ctx.content, policy, actor: ACTOR });
  for (const b of backends) b.recording = false;
  return {
    name: scenario.name,
    seeded: json(ctx.heads),
    plan: unstamped(plan),
    receipt: unstamped(receipt),
    writes: backends.flatMap((b) => b.writes),
    deletes: backends.flatMap((b) => b.deletes),
  };
}

async function runFindings(core, Backend, engine) {
  const content = await makeBundle(core, Backend, "overlay-parity-findings", "0.2");
  await seed(core, content, "conventions/signal", signalConvention("superbee_progress_status"), "# Signal\n");
  await seed(core, content, "conventions/source-feed", sourceFeedConvention, "# Source Feed\n");
  const registry = await core.loadKinds(content);
  const heads = {};
  for (const [id, { frontmatter, body }] of Object.entries(FINDINGS.seed(engine.findingDigest))) heads[id] = await seed(core, content, id, frontmatter, body, registry);
  const ops = { bundle: content, registry, okfVersion: "0.2" };
  const steps = await engine.planFindings({ ops, provider: FINDINGS.provider, slug: FINDINGS.slug, findings: FINDINGS.findings, observedAt: FINDINGS_OBSERVED_AT });
  const plan = { feed: null, provider: FINDINGS.provider, observed_at: FINDINGS_OBSERVED_AT, steps, refusals: [] };
  content.backend.recording = true;
  const receipt = await engine.apply(plan, { ops, content: ops, policy: { owned_fields: [], provider: FINDINGS.provider }, actor: ACTOR });
  content.backend.recording = false;
  return { seeded: json(heads), steps: json(steps), receipt: unstamped(receipt), writes: content.backend.writes, deletes: content.backend.deletes };
}

/** Drive `engine` through every scenario and direct row; the result is the parity transcript. */
export async function runParity({ core, engine }) {
  const restore = fixClock();
  try {
    const Backend = recordingBackend(core);
    const policy = engine.readPolicy({ id: "source-feeds/x", frontmatter: DECISION_POLICY }, {});
    const canon = {};
    for (const [name, value] of Object.entries(CANON_INPUTS)) {
      const out = engine.canonicalJson(value);
      canon[name] = out === undefined ? { undefined: true } : { text: out };
    }
    const transcript = {
      fixed_now: FIXED_NOW,
      canon,
      sha256: SHA_INPUTS.map((input) => engine.sha256(input)),
      short_hash: SHORT_HASH_INPUTS.map((parts) => engine.shortHash(...parts)),
      finding_digest: FINDING_DIGEST_INPUTS.map((f) => engine.findingDigest(f)),
      decisions: DECISIONS.map(([name, change, opts]) => ({ name, decision: json(engine.decideChange(policy, change, opts)) })),
      guards: GUARDS.map(([name, args, existing, candidate]) => ({ name, outcome: outcome(() => engine.ownershipGuard(args)(existing, candidate)) })),
      scenarios: [],
      findings: null,
    };
    for (const [index, scenario] of SCENARIOS.entries()) transcript.scenarios.push(await runScenario(core, Backend, engine, scenario, index));
    transcript.findings = await runFindings(core, Backend, engine);
    return transcript;
  } finally {
    restore();
  }
}
