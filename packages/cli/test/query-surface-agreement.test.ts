/**
 * One valid-query contract, exercised through both public projections: the CLI `list` command and
 * the View bridge's `query` request. This intentional TEST-ONLY sibling import does not change the
 * runtime package graph; it is the agreement seam that prevents the two consumers from drifting.
 * Parsing errors remain surface-specific and are deliberately outside this table.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CONVENTION_TYPE,
  initBundle,
  writeDoc,
  type Bundle,
  type HeadResult,
  type QuerySelectionParams,
} from "@superbee/core";
import {
  BRIDGE_SERVICE_CAPABILITIES,
  BRIDGE_SERVICE_LIMITS,
  BridgeService,
  type BridgeQueryParams,
} from "@superbee/view-runtime";

import { list } from "../src/commands/list.js";

const T = "2026-07-18T00:00:00.000Z";

interface AgreementRow {
  name: string;
  params: QuerySelectionParams;
  ids: string[];
  count: number;
}

const AGREEMENT_ROWS: AgreementRow[] = [
  { name: "unfiltered, unlimited", params: { limit: 0 }, ids: ["tasks/a", "tasks/b", "tasks/c", "tasks/d"], count: 4 },
  { name: "scalar and array field membership", params: { field: "status=todo", limit: 0 }, ids: ["tasks/a", "tasks/b"], count: 2 },
  { name: "string coercion", params: { field: "priority=1", limit: 0 }, ids: ["tasks/a"], count: 1 },
  { name: "open uses declared terminal membership", params: { open: true, limit: 0 }, ids: ["tasks/a", "tasks/d"], count: 2 },
  { name: "field and open compose", params: { field: "status=todo", open: true, limit: 0 }, ids: ["tasks/a"], count: 1 },
  { name: "positive limit preserves total count", params: { limit: 2 }, ids: ["tasks/a", "tasks/b"], count: 4 },
];

async function makeBundle(): Promise<{ bundle: Bundle; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-query-agreement-"));
  const bundle: Bundle = { root: dir };
  await initBundle(dir);
  await writeDoc(bundle, {
    id: "conventions/task",
    frontmatter: {
      type: CONVENTION_TYPE,
      title: "Task",
      governs: "Task",
      fields: {
        required: ["title", "status"],
        optional: ["priority"],
        terminal: { status: ["done"] },
      },
      timestamp: T,
    },
    body: "",
  });
  for (const [id, status, priority] of [
    ["tasks/a", "todo", 1],
    ["tasks/b", ["todo", "done"], 2],
    ["tasks/c", "done", 3],
    ["tasks/d", "blocked", 4],
  ] as const) {
    await writeDoc(bundle, {
      id,
      frontmatter: { type: "Task", title: id, status, priority, timestamp: T },
      body: "",
    });
  }
  return { bundle, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function cliResult(bundle: Bundle, params: QuerySelectionParams): Promise<{ ids: string[]; count: number }> {
  const argv = ["--dir", bundle.root, "--type", "Task", "--fields", "status,priority", "--json"];
  if (params.field) argv.push("--field", params.field);
  if (params.open) argv.push("--open");
  if (params.limit !== undefined) argv.push("--limit", String(params.limit));
  let output = "";
  await list(argv, { stdout: (chunk) => void (output += chunk), autoPull: async () => {} });
  const parsed = JSON.parse(output) as { docs: Array<{ id: string }>; count: number };
  return { ids: parsed.docs.map((row) => row.id), count: parsed.count };
}

async function bridgeResult(
  bundle: Bundle,
  params: BridgeQueryParams,
): Promise<{ ids: string[]; count: number }> {
  const service = new BridgeService({
    bundle,
    launches: {
      resolve: async (launchId) => ({ launchId, capability: "bundle-read" }),
      revoke: () => {},
    },
    config: async () => ({ root: bundle.root, name: "agreement", mode: "dir" }),
    renderDocument: ({ body }) => ({ html: body, bounded: false }),
    host: { kind: "oss", capabilities: BRIDGE_SERVICE_CAPABILITIES, limits: BRIDGE_SERVICE_LIMITS },
  });
  const outcome = await service.handle(
    "agreement-launch",
    { bridge: "v0", id: "agreement", type: "query", params: { type: "Task", ...params } },
  );
  const result = (outcome.reply as { result: { rows: HeadResult[]; count: number } }).result;
  if (params.order !== "newest") {
    assert.deepEqual(result.rows.map((row) => row.id), result.rows.map((row) => row.id).sort());
  }
  return { ids: result.rows.map((row) => row.id), count: result.count };
}

test("CLI list and View bridge query agree row-for-row on valid filtering semantics", async (t) => {
  const { bundle, cleanup } = await makeBundle();
  try {
    for (const row of AGREEMENT_ROWS) {
      await t.test(row.name, async () => {
        const expected = { ids: row.ids, count: row.count };
        assert.deepEqual(await cliResult(bundle, row.params), expected, "CLI projection");
        assert.deepEqual(await bridgeResult(bundle, row.params), expected, "bridge projection");
      });
    }
  } finally {
    await cleanup();
  }
});

// Distinct, tied, missing and invalid clocks: `list` and `order: "newest"` share one comparator.
const NEWEST_CLOCKS: Array<[id: string, status: string, clock: string]> = [
  ["tasks/older", "todo", 'generated: {at: "2026-07-01T00:00:00Z"}'],
  ["tasks/alpha", "todo", 'generated: {at: "2026-07-18T00:00:00Z"}'],
  ["tasks/Zeta", "done", 'generated: {at: "2026-07-18T00:00:00.000Z"}'],
  ["tasks/a_b", "todo", 'timestamp: "2026-07-18T02:00:00+02:00"'],
  ["tasks/a-b", "done", 'generated: {at: "2026-07-18T00:00:00Z"}'],
  ["tasks/newest", "todo", 'generated: {at: "2026-07-19T00:00:00Z"}'],
  ["tasks/missing", "todo", ""],
  ["tasks/invalid", "done", 'timestamp: "not-a-clock"'],
];
const NEWEST_ORDER = [
  "tasks/newest", "tasks/Zeta", "tasks/a-b", "tasks/a_b", "tasks/alpha", "tasks/older", "tasks/invalid", "tasks/missing",
];
const NEWEST_ROWS: AgreementRow[] = [
  { name: "newest: unfiltered", params: { limit: 0 }, ids: NEWEST_ORDER, count: 8 },
  { name: "newest: limit keeps the newest rows and the total count", params: { limit: 3 }, ids: NEWEST_ORDER.slice(0, 3), count: 8 },
  { name: "newest: limit reaches into the same-millisecond tie", params: { limit: 4 }, ids: NEWEST_ORDER.slice(0, 4), count: 8 },
  {
    name: "newest: filters apply before ordering",
    params: { field: "status=todo", limit: 0 },
    ids: ["tasks/newest", "tasks/a_b", "tasks/alpha", "tasks/older", "tasks/missing"],
    count: 5,
  },
  { name: "newest: open and limit compose", params: { open: true, limit: 2 }, ids: ["tasks/newest", "tasks/a_b"], count: 5 },
];

test("CLI list order and View bridge order: \"newest\" agree row-for-row", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-query-newest-agreement-"));
  const bundle: Bundle = { root: dir };
  try {
    await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/task",
      frontmatter: {
        type: CONVENTION_TYPE,
        title: "Task",
        governs: "Task",
        fields: { required: ["title", "status"], optional: ["priority"], terminal: { status: ["done"] } },
      },
      body: "",
    });
    await mkdir(path.join(dir, "tasks"), { recursive: true });
    for (const [id, status, clock] of NEWEST_CLOCKS) {
      // Raw files keep the invalid clock that a governed write would refuse.
      await writeFile(path.join(dir, `${id}.md`), `---\ntype: Task\ntitle: ${id}\nstatus: ${status}\n${clock}\n---\n`);
    }
    for (const row of NEWEST_ROWS) {
      await t.test(row.name, async () => {
        const expected = { ids: row.ids, count: row.count };
        assert.deepEqual(await cliResult(bundle, row.params), expected, "CLI projection");
        assert.deepEqual(await bridgeResult(bundle, { ...row.params, order: "newest" }), expected, "bridge projection");
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
