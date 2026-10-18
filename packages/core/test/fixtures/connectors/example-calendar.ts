/**
 * The generic example connector: a keyless iCalendar source over a small `Event` Kind. The recipe
 * files carry the Kind only (connector carriage through recipes arrives later), so the connector
 * document is parsed with `parseConnectorDoc` on its own. `toNormalized` stands in for the `ics`
 * profile and is the only test-only mapping code.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseConnectorDoc, type Connector } from "../../../src/connectors.js";
import { parseMarkdown } from "../../../src/frontmatter.js";
import type { RecipeFile } from "../../../src/recipes.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const CONNECTOR_ID = "connectors/example-calendar";

export const EVENT_CONVENTION_MD = `---
type: Convention
title: Event
governs: Event
path: events/
fields:
  required: [title, start, event_status]
  optional: [end, event_url, note, revision]
  values:
    event_status: [scheduled, canceled, postponed]
  types:
    start: datetime
    end: datetime
    event_url: https-url
---
# Event

A dated happening. The test Kind of the example connector.
`;

/** The example recipe: the Event Kind only. */
export const RECIPE_FILES: RecipeFile[] = [
  {
    path: "recipe.md",
    bytes: `---\ntype: Recipe\nid: example-calendar\ntitle: Example calendar\nversion: "1"\nsummary: The Event Kind of the example connector.\ncontent_policy: definitions-only\n---\n# Example calendar\n`,
  },
  { path: "conventions/event.md", bytes: EVENT_CONVENTION_MD },
];

export const CONNECTOR_MD = `---
type: Connector
title: Example calendar (synthetic)
description: A keyless iCalendar source for the record-overlay test Kind.
version: "1"
auth:
  kind: none
domains:
  - calendar.example.org
record_sources:
  - name: events
    profile: ics
    target_kind: Event
    mode: overlay
    identity:
      resource: "https://calendar.example.org/{feed}.ics"
      id: "{uid}"
    fields:
      title: summary
      start: dtstart
      end: dtend
      event_url: url
      event_status:
        from: status
        values: { CONFIRMED: scheduled, TENTATIVE: scheduled, CANCELLED: canceled }
        unmapped: keep
    completeness: complete
actions: []
events:
  - name: changed
    signature: { scheme: hmac-sha256, header: x-signature-256 }
    references: [events]
---
# Example calendar

A synthetic calendar feed over the test \`Event\` Kind. It exists to exercise the parser, the pin
digest and the record-overlay fixture; no real provider publishes it.
`;

/** The same declaration whose status table refuses an unknown native. */
export const STRICT_CONNECTOR_MD = CONNECTOR_MD.replace("unmapped: keep", "unmapped: refuse");

/** Parse a connector document through the one parser, failing the test on any refusal. */
export function parseExampleConnector(markdown = CONNECTOR_MD, id = CONNECTOR_ID): Connector {
  const { frontmatter, body } = parseMarkdown(markdown);
  const parsed = parseConnectorDoc({ id, frontmatter, body });
  assert.ok(parsed.ok, parsed.ok ? "" : JSON.stringify(parsed.errors));
  return parsed.connector;
}

/** iCalendar basic UTC form (`20261010T140000Z`) as an ISO instant. */
const instant = (value: string | undefined): string | undefined => {
  const m = value === undefined ? null : /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : value;
};

export type Vevent = Record<string, string | undefined>;

/** The `ics` profile stand-in: one VEVENT as a normalized record (absent properties stay absent). */
export function toNormalized(vevent: Vevent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown): void => { if (value !== undefined) out[key] = value; };
  put("uid", vevent.UID);
  put("summary", vevent.SUMMARY);
  put("dtstart", instant(vevent.DTSTART));
  put("dtend", instant(vevent.DTEND));
  put("url", vevent.URL);
  put("status", vevent.STATUS);
  put("last_modified", instant(vevent["LAST-MODIFIED"]));
  return out;
}

export interface Observation {
  observed_at: string;
  records: Array<Record<string, unknown>>;
}

export function readObservations(): Observation[] {
  const raw = JSON.parse(readFileSync(path.join(here, "example-calendar-records.json"), "utf8")) as { observations: Array<{ observed_at: string; vevents: Vevent[] }> };
  return raw.observations.map((o) => ({ observed_at: o.observed_at, records: o.vevents.map(toNormalized) }));
}
