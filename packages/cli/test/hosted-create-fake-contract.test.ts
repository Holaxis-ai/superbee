// The CLI's fake of `bundles.create.v1` (`support/fake-hosted-create.ts`) against the golden
// exchanges captured from the real hosted gateway (core's `test/fixtures/hosted-bundle-create-v1/`).
// For every exchange the fake is driven into the same situation and sent the captured request; it
// must answer with the same status, the same grammar headers and a body of the same shape: the
// same keys at every level and the same value types, and the same values wherever a value selects
// an outcome (every boolean, and the discriminators: operation, error code, write state, access).
// Only values that name the fixture's own data (ids, messages) may differ.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CREATE_FIXTURES, createFixture, FakeCreateHost, type FakeCreateHostOptions } from "./support/fake-hosted-create.js";
import { HOST, TOKEN } from "./support/fake-hosted-sync.js";

const DISCRIMINATORS: ReadonlySet<string> = new Set(["operationId", "code", "writeState", "access", "verified", "retryable"]);

function shape(value: unknown, key?: string): unknown {
  if (value === null) return "null";
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && key !== undefined && DISCRIMINATORS.has(key)) return `=${value}`;
  if (Array.isArray(value)) return ["array", ...[...new Set(value.map((item) => JSON.stringify(shape(item))))].sort()];
  if (typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((name) => [name, shape((value as Record<string, unknown>)[name], name)]));
  return typeof value;
}

const index = JSON.parse(readFileSync(path.join(CREATE_FIXTURES, "index.json"), "utf8")) as { exchanges: { name: string }[] };

async function send(host: FakeCreateHost, name: string): Promise<Response> {
  const { request } = createFixture(name);
  return host.fetch(`${HOST}/sync/v1/bundle-create`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(request.headers["x-superbee-write-request"] ? { "x-superbee-write-request": request.headers["x-superbee-write-request"] } : {}) },
    body: request.body,
  });
}

/** How to drive the fake into each captured situation: its options, then the exchanges sent first. */
const SITUATIONS: Readonly<Record<string, { options?: FakeCreateHostOptions; before?: string[]; failNext?: boolean }>> = Object.freeze({
  "bundle-create-200-created": {},
  "bundle-create-200-replay": { before: ["bundle-create-200-created"] },
  "bundle-create-200-request-conflict": { before: ["bundle-create-200-created"] },
  "bundle-create-200-bundle-exists": { before: ["bundle-create-200-created"] },
  "bundle-create-200-history": {},
  "bundle-create-200-document-id-collision": {},
  "bundle-create-400-invalid-input": {},
  "bundle-create-200-workspace-not-found": { options: { tenants: ["tenant:a", "tenant:b"] } },
  "bundle-create-429-limit": { options: { limit: 0 } },
  "bundle-create-200-unavailable": { options: { unavailable: true } },
  "bundle-create-503-write-outcome-unknown": { failNext: true },
  "bundle-create-200-resumed": { failNext: true, before: ["bundle-create-503-write-outcome-unknown"] },
});

test("every captured bundles.create.v1 exchange is driven here", () => {
  assert.deepEqual(index.exchanges.map((row) => row.name).sort(), Object.keys(SITUATIONS).sort());
});

for (const { name } of index.exchanges) {
  test(`the fake answers ${name} as the host does`, async () => {
    const situation = SITUATIONS[name]!;
    const host = new FakeCreateHost({ tenants: ["tenant:a", "tenant:b"], ...situation.options });
    if (situation.failNext) host.failNextCreate = true;
    for (const earlier of situation.before ?? []) await send(host, earlier);
    const golden = createFixture(name).response;
    const answer = await send(host, name);
    assert.equal(answer.status, golden.status, name);
    for (const header of ["content-type", "x-superbee-write-settled"]) {
      assert.equal(answer.headers.has(header), header in golden.headers, `${name}: ${header}`);
    }
    if (golden.headers["x-superbee-write-settled"]) {
      assert.equal(answer.headers.get("x-superbee-write-settled"), createFixture(name).request.headers["x-superbee-write-request"]);
    }
    assert.deepEqual(shape(JSON.parse(await answer.text())), shape(JSON.parse(golden.body)), name);
  });
}
