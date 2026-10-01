// The CLI's fake of `bundles.create.v1` (`support/fake-hosted-create.ts`) against the golden
// exchanges captured from the real hosted gateway (core's `test/fixtures/hosted-bundle-create-v1/`).
// For every exchange the fake is driven into the same situation and sent the captured request; it
// must answer with the same status, the same grammar headers and a body of the same shape: the
// same keys at every level and the same value types, and the same values wherever a value selects
// an outcome (every boolean, and the discriminators: operation, error code, write state, access).
// Only values that name the fixture's own data (ids, messages, the plan hash) may differ: the fake
// names its own plan hash, so a staged request after begin carries the fake's in place of the
// golden one.
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

/** The plan hash the golden staged exchanges carry, and the one this fake named for the same manifest. */
const GOLDEN_PLAN = /sha256:0d755da3fe1995970b83e99b74cd74d9cc484197ac00cb5017d932dbaec8f374/g;
const plans = new WeakMap<FakeCreateHost, string>();

async function send(host: FakeCreateHost, name: string): Promise<Response> {
  const { request, route } = createFixture(name);
  const plan = plans.get(host);
  const ours = (text: string) => (plan ? text.replace(GOLDEN_PLAN, plan) : text);
  // Every header the host was sent but the length, which fetch derives from the body.
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([header]) => header !== "content-length").map(([header, value]) => [header, ours(value)]));
  const raw = request.headers["content-type"] === "application/octet-stream";
  const answer = await host.fetch(`${HOST}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    body: raw ? new TextEncoder().encode(request.body) : ours(request.body),
  });
  if (route === "/sync/v1/bundle-create-begin" && answer.status === 200) {
    const planHash = (JSON.parse(await answer.clone().text()) as { data?: { planHash?: string } }).data?.planHash;
    if (planHash) plans.set(host, planHash);
  }
  return answer;
}

/** How to drive the fake into each captured situation: its options, then the exchanges sent (or steps taken) first. */
const SITUATIONS: Readonly<Record<string, { options?: FakeCreateHostOptions; before?: (string | ((host: FakeCreateHost) => void))[]; failNext?: boolean }>> = Object.freeze({
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
  "bundle-create-begin-200-staging": {},
  "bundle-create-begin-200-request-conflict": { before: ["bundle-create-begin-200-staging"] },
  "bundle-create-stage-200-staging": { before: ["bundle-create-begin-200-staging"] },
  "bundle-create-stage-200-validation-failed": { before: ["bundle-create-begin-200-staging"] },
  "bundle-create-stage-200-staged-manifest-missing": { before: ["bundle-create-begin-200-staging"] },
  "bundle-create-blob-200-ok": { before: ["bundle-create-begin-200-staging"] },
  // Reserved and written but for the blob, which the host then finds gone.
  "bundle-create-commit-200-importing": {
    before: ["bundle-create-begin-200-staging", "bundle-create-stage-200-staging", "bundle-create-blob-200-ok", (host) => (host.commitSteps = 1), "bundle-create-commit-200-importing", (host) => host.dropStagedBlobs()],
  },
  "bundle-create-commit-200-created": { before: ["bundle-create-begin-200-staging", "bundle-create-stage-200-staging", "bundle-create-blob-200-ok"] },
});

test("every captured bundles.create.v1 exchange is driven here", () => {
  assert.deepEqual(index.exchanges.map((row) => row.name).sort(), Object.keys(SITUATIONS).sort());
});

for (const { name } of index.exchanges) {
  test(`the fake answers ${name} as the host does`, async () => {
    const situation = SITUATIONS[name]!;
    const host = new FakeCreateHost({ tenants: ["tenant:a", "tenant:b"], ...situation.options });
    if (situation.failNext) host.failNextCreate = true;
    for (const earlier of situation.before ?? []) {
      if (typeof earlier === "function") earlier(host);
      else await send(host, earlier);
    }
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
