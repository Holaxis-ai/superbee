/**
 * CLI surface for kind conventions: `new`, `kinds`, `doc write`'s warn-by-default validation
 * (`--strict` upgrade), and `status`'s kind-fed freshness horizon sweep.
 *
 * Runs command functions in-process (no subprocess) against a real temp filesystem bundle,
 * mirroring `link.test.ts`'s pattern. The `--remote` parity test additionally boots a real
 * `@superbee/server` `serve()` instance, mirroring `remote.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeDoc, readDoc, CONVENTION_TYPE, type Bundle } from "@superbee/core";
import { serve, type ServerHandle } from "@superbee/server";

import { newCommand } from "../src/commands/new.js";
import { kinds } from "../src/commands/kinds.js";
import { doc } from "../src/commands/doc.js";
import { list } from "../src/commands/list.js";
import { status } from "../src/commands/status.js";
import { CliError } from "../src/errors.js";
import { commandReference } from "../src/reference.js";
import { buildHomeView } from "../src/commands/home.js";
import { applyRecipe } from "../src/recipes.js";
import { CONTEXT_NOTES_RECIPE } from "../src/recipe-source.js";
import { shellArg } from "../src/invocation.js";
import { testInvocation } from "./support/command-prefix.js";
import { renderedPattern } from "./support/rendered-command.js";

const T = "2026-07-01T00:00:00.000Z";

// A body carrying all four headings a hand-authored Context Note can emit (Summary/Decisions/Open
// Questions/Pointers). The seeded Context Note kind declares only `sections: [Summary]` — the
// alert-fatigue guard for minimal notes — which this body trivially satisfies. Used by
// `doc write` tests below that write a "Context Note"-typed doc directly and want to isolate a
// DIFFERENT violation (missing title/timestamp) from the seed's section lint.
const FULL_SECTIONS_BODY =
  "# Summary\n\nHi.\n\n# Decisions\n\n- Did X\n\n# Open Questions\n\n- Why not Y?\n\n" +
  "# Pointers\n\n- [A](../concepts/a.md)\n";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-kinds-test-"));
}

/** A fresh bundle with the Context Note kind applied (mirrors `init`'s default `context-notes` recipe). */
async function makeSeededBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await tempDir();
  await initBundle(dir, { okfVersion: "0.1" });
  await applyRecipe({ root: dir }, CONTEXT_NOTES_RECIPE);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Run a command function, capturing its `--json` stdout and parsing the envelope. */
async function runJson(
  cmd: (argv: string[], deps: { stdout: (s: string) => void }) => Promise<void>,
  argv: string[],
): Promise<Record<string, unknown>> {
  let out = "";
  await cmd([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

test("kindsPointer: interpolated with the CALLER's resolved invocation, not a hardcoded bin name (F6 regression)", () => {
  // reference.ts stays pure (no invocation.ts import): commandReference() takes the resolved
  // invocation prefix as a plain argument. A caller passing a DIFFERENT prefix (e.g. the
  // npx-fallback form an off-PATH install would resolve to) must see it reflected verbatim.
  const npxForm = commandReference(testInvocation("npx -y @holaxis/aslite"));
  assert.equal(npxForm.kinds, "kinds are declared per-bundle — run `npx -y @holaxis/aslite kinds` to list them");

  const bareForm = commandReference(testInvocation("agentstate-lite"));
  assert.equal(bareForm.kinds, "kinds are declared per-bundle — run `agentstate-lite kinds` to list them");

  // buildHomeView (home.ts) threads deps.invocation() through to commandReference() the same way.
  // (The 2-arg call omits the 3rd `summary` param — optional, so this stays the no-bundle path.)
  const home = buildHomeView({ binPath: () => "/bin/agentstate-lite", invocation: () => testInvocation("npx -y @holaxis/aslite") });
  assert.equal(home.kinds, "kinds are declared per-bundle — run `npx -y @holaxis/aslite kinds` to list them");
});

test("kinds: on a seeded bundle, lists the Context Note kind with its declared shape + horizon", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    const result = await runJson(kinds, ["--dir", dir]);
    assert.equal(result.count, 1);
    const rows = result.kinds as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.governs, "Context Note");
    assert.deepEqual(rows[0]!.required, ["title", "timestamp"]);
    assert.deepEqual(rows[0]!.optional, ["description", "tags"]);
    assert.equal(rows[0]!.path, "context-notes/");
    assert.equal(rows[0]!.horizon, "24h");
    assert.equal(rows[0]!.horizon_ms, 24 * 3_600_000);
  } finally {
    await cleanup();
  }
});

test("kinds: conditionally projects kind, field, and enum-value descriptions", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    await writeDoc({ root: dir }, {
      id: "conventions/described",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Described",
        description: "A kind with agent-readable guidance.",
        fields: {
          required: ["title"],
          optional: ["status"],
          values: { status: ["draft", "done"] },
          descriptions: { title: "A concise summary.", status: "Current state." },
          value_descriptions: { status: { draft: "Still open to revision." } },
        },
        timestamp: T,
      },
      body: "",
    });
    const result = await runJson(kinds, ["--dir", dir]);
    const rows = result.kinds as Array<Record<string, unknown>>;
    const described = rows.find((row) => row.governs === "Described");
    assert.ok(described);
    assert.equal(described.description, "A kind with agent-readable guidance.");
    assert.deepEqual(described.optional, ["progress_status"]);
    assert.deepEqual(described.values, { progress_status: ["draft", "done"] });
    assert.deepEqual(described.descriptions, { title: "A concise summary.", progress_status: "Current state." });
    assert.deepEqual(described.value_descriptions, { progress_status: { draft: "Still open to revision." } });
    assert.equal(described.logical_fields, undefined);
    let help = "";
    await newCommand(["Described", "--help", "--dir", dir], { stdout: (chunk) => (help += chunk) });
    assert.match(help, /--progress_status <v>  optional/);
    assert.doesNotMatch(help, /stored as|'status'|--status/);
    const note = rows.find((row) => row.governs === "Context Note");
    assert.ok(note);
    assert.ok(!("description" in note));
    assert.ok(!("descriptions" in note));
    assert.ok(!("value_descriptions" in note));
  } finally {
    await cleanup();
  }
});

test("kinds and new help keep current workflow storage behind the logical authoring schema", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await writeDoc({ root: dir }, {
      id: "conventions/task",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Task",
        fields: {
          required: ["title", "superbee_progress_status"],
          optional: [],
          values: { superbee_progress_status: ["todo", "done"] },
          descriptions: { superbee_progress_status: "Current workflow state." },
          value_descriptions: { superbee_progress_status: { todo: "Not complete." } },
          terminal: { superbee_progress_status: ["done"] },
        },
      },
      body: "",
    });
    const result = await runJson(kinds, ["--dir", dir]);
    const task = (result.kinds as Array<Record<string, unknown>>).find((row) => row.governs === "Task");
    assert.ok(task);
    assert.deepEqual(task.required, ["title", "progress_status"]);
    assert.deepEqual(task.values, { progress_status: ["todo", "done"] });
    assert.deepEqual(task.descriptions, { progress_status: "Current workflow state." });
    assert.deepEqual(task.value_descriptions, { progress_status: { todo: "Not complete." } });
    assert.deepEqual(task.terminal, { progress_status: ["done"] });
    assert.doesNotMatch(JSON.stringify(task), /superbee_progress_status|stored_as/);

    let help = "";
    await newCommand(["Task", "--help", "--dir", dir], { stdout: (chunk) => (help += chunk) });
    assert.match(help, /--progress_status <v>  required/);
    assert.doesNotMatch(help, /superbee_progress_status|stored as/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kinds: projects links and link_descriptions; rows without them carry neither key", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    await writeDoc({ root: dir }, {
      id: "conventions/roadmap-item",
      frontmatter: {
        type: CONVENTION_TYPE,
        title: "Roadmap Item",
        governs: "Roadmap Item",
        path: "roadmap-items/",
        fields: { required: ["title", "status"], optional: [], values: { status: ["queued", "active", "done"] } },
        links: { contains: "Task" },
        link_descriptions: { contains: "Tasks governed by this roadmap commitment." },
        timestamp: T,
      },
      body: "A kind declaring its typed-edge vocabulary.",
    });
    const result = await runJson(kinds, ["--dir", dir]);
    const rows = result.kinds as Array<Record<string, unknown>>;
    const roadmap = rows.find((r) => r.governs === "Roadmap Item");
    assert.ok(roadmap, "expected the Roadmap Item kind row");
    assert.deepEqual(roadmap!.links, { contains: "Task" });
    assert.deepEqual(roadmap!.link_descriptions, { contains: "Tasks governed by this roadmap commitment." });
    // The seeded Context Note kind declares no links — its row must not carry the key at all.
    const note = rows.find((r) => r.governs === "Context Note");
    assert.ok(note);
    assert.ok(!("links" in note!), "a kind without a links declaration gets no links key");
    assert.ok(!("link_descriptions" in note!), "a kind without relationship guidance gets no link_descriptions key");
  } finally {
    await cleanup();
  }
});

test("kinds: projects a convention's 'expects_inbound' declaration (inbound-link expectation); rows without one carry no expects_inbound key", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    await writeDoc({ root: dir }, {
      id: "conventions/task",
      frontmatter: {
        type: CONVENTION_TYPE,
        title: "Task",
        governs: "Task",
        path: "tasks/",
        fields: { required: ["title", "status"], optional: [], values: { status: ["queued", "active", "done"] } },
        expects_inbound: { contains: "Roadmap Item" },
        timestamp: T,
      },
      body: "A kind declaring an inbound-link expectation.",
    });
    const result = await runJson(kinds, ["--dir", dir]);
    const rows = result.kinds as Array<Record<string, unknown>>;
    const task = rows.find((r) => r.governs === "Task");
    assert.ok(task, "expected the Task kind row");
    assert.deepEqual(task!.expects_inbound, { contains: "Roadmap Item" });
    // The seeded Context Note kind declares no expects_inbound — its row must not carry the key at all.
    const note = rows.find((r) => r.governs === "Context Note");
    assert.ok(note);
    assert.ok(!("expects_inbound" in note!), "a kind without an expects_inbound declaration gets no expects_inbound key");
  } finally {
    await cleanup();
  }
});

test("kinds: projects a convention's 'fields.terminal' declaration; rows without one carry no terminal key", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    await writeDoc({ root: dir }, {
      id: "conventions/ticket",
      frontmatter: {
        type: CONVENTION_TYPE,
        title: "Ticket",
        governs: "Ticket",
        path: "tickets/",
        fields: {
          required: ["title", "stage"],
          optional: [],
          values: { stage: ["open", "in_review", "resolved", "archived"] },
          terminal: { stage: ["resolved", "archived"] },
        },
        timestamp: T,
      },
      body: "A kind declaring which stage values are terminal.",
    });
    const result = await runJson(kinds, ["--dir", dir]);
    const rows = result.kinds as Array<Record<string, unknown>>;
    const ticket = rows.find((r) => r.governs === "Ticket");
    assert.ok(ticket, "expected the Ticket kind row");
    assert.deepEqual(ticket!.terminal, { stage: ["resolved", "archived"] });
    // The seeded Context Note kind declares no terminal set — its row must not carry the key at all.
    const note = rows.find((r) => r.governs === "Context Note");
    assert.ok(note);
    assert.ok(!("terminal" in note!), "a kind without a terminal declaration gets no terminal key");
  } finally {
    await cleanup();
  }
});

test("new: point-of-use link teaching is GENERIC — per-kind help shows both directions; the create receipt hints complete link-add commands; no declarations = no hints", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-kinds-test-"));
  try {
    const bundle = await initBundle(dir);
    // A deliberately NON-work-management vocabulary: Incident "affects" -> Service proves no
    // Task/Roadmap-Item knowledge is hardcoded anywhere in the teaching path.
    await writeDoc(bundle, {
      id: "conventions/service",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Service",
        path: "services/",
        fields: { required: ["title"], optional: [] },
        links: { "runs on": "Service" },
        link_descriptions: { "runs on": "The runtime service this service is deployed on." },
        expects_inbound: { affects: "Incident" },
        timestamp: T,
      },
      body: "",
    });
    await writeDoc(bundle, {
      id: "conventions/incident",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Incident",
        path: "incidents/",
        fields: { required: ["title"], optional: [] },
        links: { affects: "Service" },
        link_descriptions: { affects: "The service whose reliability or operation is impacted." },
        timestamp: T,
      },
      body: "",
    });

    // Moment 1 — per-kind help: outbound ("runs on" -> Service) AND the reverse lookup (Incident
    // "affects" -> Service). The self-declaration appears outbound only, never echoed inbound.
    let helpOut = "";
    await newCommand(["Service", "--help", "--dir", dir], { stdout: (s) => (helpOut += s) });
    assert.match(
      helpOut,
      /this kind may link:\s+"runs on" → Service — The runtime service this service is deployed on\./,
    );
    assert.match(
      helpOut,
      /other kinds link here:\s+Incident "affects" → Service — The service whose reliability or operation is impacted\./,
    );
    assert.ok(!/other kinds link here:\s+Service/.test(helpOut), "self-declaration must not echo inbound");

    // The inbound prose above comes from Incident's outbound declaration. It is never copied onto
    // Service or sourced from Service's expects_inbound lint declaration.
    const discovery = await runJson(kinds, ["--dir", dir]);
    const service = (discovery.kinds as Array<Record<string, unknown>>).find((row) => row.governs === "Service");
    assert.deepEqual(service!.link_descriptions, {
      "runs on": "The runtime service this service is deployed on.",
    });

    // Moment 2 — the create receipt: complete, placeholder-parameterized link-add commands in
    // BOTH directions, derived purely from the registry.
    const receipt = await runJson(newCommand, ["Service", "api", "--title", "API", "--dir", dir]);
    const hints = receipt.help as string[];
    assert.ok(!hints.some((h) => /reliability|runtime service/.test(h)), "creation receipts stay compact");
    assert.ok(
      hints.some((h) => /link from a Incident:/.test(h) && new RegExp(`link add ${renderedPattern("incidents/<incident>")} services/api --text ${renderedPattern("affects")}`).test(h)),
      `expected the inbound alignment hint, got: ${JSON.stringify(hints)}`,
    );
    assert.ok(
      hints.some((h) => /link to a Service:/.test(h) && new RegExp(`link add services/api ${renderedPattern("services/<service>")} --text ${renderedPattern("runs on")}`).test(h)),
      `expected the outbound hint, got: ${JSON.stringify(hints)}`,
    );

    // A kind with NO declared links (in either direction) gets ONLY the doc-read hint, and its
    // per-kind help carries no Links block — declarations absent means teaching absent.
    await writeDoc(bundle, {
      id: "conventions/memo",
      frontmatter: { type: CONVENTION_TYPE, governs: "Memo", fields: { required: ["title"], optional: [] }, timestamp: T },
      body: "",
    });
    const memoReceipt = await runJson(newCommand, ["Memo", "m1", "--title", "M", "--dir", dir]);
    assert.equal((memoReceipt.help as string[]).length, 1);
    let memoHelp = "";
    await newCommand(["Memo", "--help", "--dir", dir], { stdout: (s) => (memoHelp += s) });
    assert.ok(!/Links \(typed edges/.test(memoHelp));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kinds: on a conventions-free bundle, an empty registry with a help hint (no crash, no I/O error)", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir); // no recipe applied — a bare bundle
    const result = await runJson(kinds, ["--dir", dir]);
    assert.equal(result.count, 0);
    assert.deepEqual(result.kinds, []);
    assert.ok(Array.isArray(result.help));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new: unknown kind is a USAGE error (exit 2) that enumerates declared kinds", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    await assert.rejects(
      () => newCommand(["Bogus Kind", "x", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /unknown kind 'Bogus Kind'/);
        assert.match(err.message, /Context Note/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("new: a control flag (--dir/--remote) with no value (final argv token) is a clean USAGE, not a RUNTIME openBundle crash", async () => {
  // Phase-1 discovery runs `strict:false`, which returns boolean `true` (not undefined, no throw) for
  // a configured value flag given no value as the LAST token. `--dir`/`--remote` open the bundle
  // BEFORE the authoritative Phase-2 strict parse, so an unguarded boolean would reach openBundle and
  // crash it ('paths[0] must be of type string', RUNTIME/exit 1) instead of the clean USAGE Phase 2
  // gives. The guard fires before any bundle access, so no seeded bundle is needed.
  for (const flag of ["--dir", "--remote"]) {
    await assert.rejects(
      () => newCommand(["Task", "x", flag]),
      (err: unknown) => {
        assert.ok(err instanceof CliError, `${flag}: expected CliError, got ${String(err)}`);
        assert.equal(err.code, "USAGE", `${flag}: code`);
        assert.equal(err.exitCode, 2, `${flag}: exitCode`);
        assert.ok(err.message.includes(`${flag} requires a value`), `${flag}: message was "${err.message}"`);
        return true;
      },
    );
  }
});

test('new "<Kind>" --help shows deterministic described field rows, not the generic usage', async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    await writeDoc({ root: dir }, {
      id: "conventions/described",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Described",
        description: "A guided record.",
        path: "described/",
        fields: {
          required: ["title", "actor", "title"],
          optional: ["status", "link", "title", "status"],
          values: { status: ["draft", "done"] },
          descriptions: { title: "A concise summary.", status: "Current state.", actor: "Filtered control." },
        },
        sections: ["Summary"],
        timestamp: T,
      },
      body: "",
    });
    let out = "";
    await newCommand(["Described", "--help", "--dir", dir], { stdout: (s) => (out += s) });
    assert.match(out, /create a Described instance/);
    assert.ok(out.indexOf("Description:  A guided record.") < out.indexOf("Fields (declared"));
    assert.match(out, /--title <v>  required — A concise summary\./);
    assert.match(out, /--progress_status <v>  optional; allowed: draft \| done — Current state\./);
    assert.equal((out.match(/--title <v>/g) ?? []).length, 1);
    assert.equal((out.match(/--progress_status <v>/g) ?? []).length, 1);
    assert.doesNotMatch(out, /--actor <v>/);
    assert.doesNotMatch(out, /--link <v>/);
    assert.match(out, /Required body headings \(level 1; exact Markdown\):\n  # Summary/);
    assert.match(out, /described\//); // the kind's declared path prefix
    // `new --help` with NO kind still shows the GENERIC reference (not a kind schema).
    let generic = "";
    await newCommand(["--help"], { stdout: (s) => (generic += s) });
    assert.match(generic, /create a new instance of a bundle-declared kind/);
    assert.match(
      generic,
      /superbee doc write <id> --type <Type>.*generic document whose type has no governing\s+Kind/s,
      "generic new help routes ungoverned authoring through doc write",
    );
    assert.doesNotMatch(generic, /create a Described instance/);
  } finally {
    await cleanup();
  }
});

test('new "Claim" --help explains the real lifecycle values while undescribed enum values stay compact', async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    await writeDoc({ root: dir }, {
      id: "conventions/claim",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Claim",
        description: "A falsifiable assertion whose reliability matters to downstream work.",
        path: "claims/",
        fields: {
          required: ["title", "status", "reason"],
          optional: ["confidence"],
          values: {
            status: ["active", "challenged", "locked", "deprecated"],
            confidence: ["low", "high"],
          },
          value_descriptions: {
            status: {
              active: "Supported,\n but still open | revision (provisional): evidence-led — not final.",
              locked: "Verified (required): downstream | reliance — permitted.",
            },
          },
        },
        timestamp: T,
      },
      body: "",
    });

    let out = "";
    await newCommand(["Claim", "--help", "--dir", dir], { stdout: (chunk) => (out += chunk) });
    assert.match(out, /--progress_status <v>  required\n    allowed values:/);
    assert.match(
      out,
      /- value: "active"\n        description: "Supported, but still open \| revision \(provisional\): evidence-led — not final\."/,
    );
    assert.match(out, /- value: "challenged"\n      - value: "locked"/);
    assert.match(
      out,
      /- value: "locked"\n        description: "Verified \(required\): downstream \| reliance — permitted\."/,
    );
    assert.match(out, /- value: "deprecated"/);
    assert.match(out, /--confidence <v>  optional; allowed: low \| high\n/);
    assert.doesNotMatch(out, /allowed: active \| challenged/);

    const discovery = await runJson(kinds, ["--dir", dir]);
    const claim = (discovery.kinds as Array<Record<string, unknown>>).find((row) => row.governs === "Claim");
    assert.deepEqual(claim?.value_descriptions, {
      progress_status: {
        active: "Supported,\n but still open | revision (provisional): evidence-led — not final.",
        locked: "Verified (required): downstream | reliance — permitted.",
      },
    });
  } finally {
    await cleanup();
  }
});

test('new help treats prototype-looking field and link names as declarations/guidance only when explicitly own', async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    await writeDoc({ root: dir }, {
      id: "conventions/inherited-special-fields",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Inherited Special Fields",
        fields: { required: ["toString"], optional: ["__proto__"] },
        timestamp: T,
      },
      body: "",
    });
    let inherited = "";
    await newCommand(["Inherited Special Fields", "--help", "--dir", dir], {
      stdout: (chunk) => (inherited += chunk),
    });
    assert.match(inherited, /--toString <v>  required\n/);
    assert.match(inherited, /--__proto__ <v>  optional\n/);
    assert.doesNotMatch(inherited, /function toString|allowed values|; allowed:/);

    await writeDoc({ root: dir }, {
      id: "conventions/own-special-fields",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Own Special Fields",
        fields: {
          required: ["toString"],
          optional: ["__proto__"],
          values: Object.fromEntries([
            ["toString", ["plain"]],
            ["__proto__", ["special"]],
          ]),
          descriptions: Object.fromEntries([["toString", "An explicit\n special field."]]),
          value_descriptions: Object.fromEntries([
            ["toString", { plain: "An explicit | value (not syntax): safe — association." }],
          ]),
        },
        timestamp: T,
      },
      body: "",
    });
    let own = "";
    await newCommand(["Own Special Fields", "--help", "--dir", dir], { stdout: (chunk) => (own += chunk) });
    assert.match(own, /--toString <v>  required — An explicit special field\.\n    allowed values:/);
    assert.match(
      own,
      /- value: "plain"\n        description: "An explicit \| value \(not syntax\): safe — association\."/,
    );
    assert.match(own, /--__proto__ <v>  optional; allowed: special\n/);

    await writeDoc({ root: dir }, {
      id: "conventions/help-target",
      frontmatter: { type: CONVENTION_TYPE, governs: "Help Target", fields: {}, timestamp: T },
      body: "",
    });
    await writeDoc({ root: dir }, {
      id: "conventions/help-source",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Help Source",
        fields: {},
        links: Object.fromEntries([
          ["toString", "Help Target"],
          ["constructor", "Help Target"],
          ["described", "Help Target"],
        ]),
        link_descriptions: Object.fromEntries([
          ["constructor", "  Explicit\n constructor guidance.  "],
          ["described", "Ordinary guidance."],
        ]),
        timestamp: T,
      },
      body: "",
    });
    let linkHelp = "";
    await newCommand(["Help Target", "--help", "--dir", dir], { stdout: (chunk) => (linkHelp += chunk) });
    assert.match(linkHelp, /Help Source "toString" → Help Target\n/);
    assert.doesNotMatch(linkHelp, /Help Source "toString" → Help Target —/);
    assert.doesNotMatch(linkHelp, /function toString|\[native code\]/);
    assert.match(linkHelp, /Help Source "constructor" → Help Target — Explicit constructor guidance\./);

    let outboundHelp = "";
    await newCommand(["Help Source", "--help", "--dir", dir], { stdout: (chunk) => (outboundHelp += chunk) });
    assert.match(outboundHelp, /this kind may link:     "toString" → Help Target\n/);
    assert.doesNotMatch(outboundHelp, /this kind may link:     "toString" → Help Target —/);
    assert.match(outboundHelp, /this kind may link:     "constructor" → Help Target — Explicit constructor guidance\./);
  } finally {
    await cleanup();
  }
});

test("new surfaces the auto-applied path prefix in its receipt — no silent id rewrite (maturity)", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    const result = await runJson(newCommand, ["Context Note", "bare-note", "--title", "T", "--dir", dir]);
    assert.equal(result.id, "context-notes/bare-note");
    assert.match(result.note as string, /prefixed/);
    assert.match(result.note as string, /bare-note/);
  } finally {
    await cleanup();
  }
});

test("new --body creates a complete governed Context Note in one command", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    const authored = "# Summary\n\nWhat this session did and what comes next.\n";
    const result = await runJson(newCommand, [
      "Context Note",
      "x",
      "--title",
      "T",
      "--body",
      authored,
      "--dir",
      dir,
      "--json",
    ]);
    assert.equal(result.id, "context-notes/x");
    assert.equal((await readDoc({ root: dir }, "context-notes/x")).body, authored);
  } finally {
    await cleanup();
  }
});

test("new body sources are exclusive and an explicit empty body never falls back to scaffolding", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    const bodyFile = path.join(dir, "note.md");
    await writeFile(bodyFile, "# Summary\n\nFrom a file.\n", "utf8");
    await assert.rejects(
      () => newCommand([
        "Context Note",
        "ambiguous",
        "--title",
        "T",
        "--body",
        "# Summary\n\nInline.\n",
        "--body-file",
        bodyFile,
        "--dir",
        dir,
      ]),
      (err: unknown) =>
        err instanceof CliError &&
        err.code === "USAGE" &&
        /mutually exclusive/.test(err.message),
    );
    await assert.rejects(() => readDoc({ root: dir }, "context-notes/ambiguous"));

    await assert.rejects(
      () => newCommand(["Context Note", "empty", "--title", "T", "--body", "", "--dir", dir]),
      (err: unknown) =>
        err instanceof CliError &&
        err.code === "USAGE" &&
        /Summary/.test(err.message),
    );
    await assert.rejects(() => readDoc({ root: dir }, "context-notes/empty"));
  } finally {
    await cleanup();
  }
});

test("new --no-prefix uses the id VERBATIM, skipping the kind's declared path prefix (maturity: escape hatch)", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    const result = await runJson(newCommand, ["Context Note", "literal/id", "--no-prefix", "--title", "T", "--dir", dir]);
    assert.equal(result.id, "literal/id"); // NOT context-notes/literal/id
    assert.equal(result.note, undefined); // no prefix applied → no prefix note
    // Without --no-prefix the same id IS prefixed (control).
    const prefixed = await runJson(newCommand, ["Context Note", "other/id", "--title", "T", "--dir", dir]);
    assert.equal(prefixed.id, "context-notes/other/id");
  } finally {
    await cleanup();
  }
});

test("new: missing required field is rejected by VALIDATION, not by machinery (USAGE, exit 2, cites the field)", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    await assert.rejects(
      () => newCommand(["Context Note", "missing-title", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /does not satisfy the 'Context Note' kind/);
        assert.match(err.message, /title/);
        assert.ok(err.help?.endsWith(`superbee new ${shellArg("Context Note")} --help --dir ${shellArg(dir)}`));
        return true;
      },
    );
    // Nothing was written.
    await assert.rejects(() => readDoc({ root: dir }, "context-notes/missing-title"));
  } finally {
    await cleanup();
  }
});

test("new: a conforming instance writes through the ordinary engine path, honoring the kind's path prefix", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    const result = await runJson(newCommand, ["Context Note", "my-note", "--title", "Hello", "--dir", dir]);
    assert.equal(result.new, "written");
    assert.equal(result.kind, "Context Note");
    assert.equal(result.id, "context-notes/my-note"); // path prefix prepended
    assert.equal(result.type, "Context Note");
    assert.ok(result.timestamp); // auto-filled

    const doc = await readDoc({ root: dir }, "context-notes/my-note");
    assert.equal(doc.frontmatter.title, "Hello");

    // Supplying an id that ALREADY carries the prefix is not double-prefixed.
    const again = await runJson(newCommand, [
      "Context Note",
      "context-notes/already-prefixed",
      "--title",
      "X",
      "--dir",
      dir,
    ]);
    assert.equal(again.id, "context-notes/already-prefixed");
  } finally {
    await cleanup();
  }
});

test("new: create-only — a SECOND 'new' at the same id is rejected (ALREADY_EXISTS, exit 5), never silently overwrites (round-review finding)", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    const first = await runJson(newCommand, ["Context Note", "guarded", "--title", "Original Title", "--dir", dir]);
    assert.equal(first.new, "written");
    assert.equal(first.id, "context-notes/guarded");

    await assert.rejects(
      () => newCommand(["Context Note", "guarded", "--title", "Clobbering Title", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "ALREADY_EXISTS");
        assert.equal(err.exitCode, 5);
        assert.match(err.message, /already exists/);
        assert.match(err.message, /doc update/);
        return true;
      },
    );

    // Nothing was touched — the original title survives untouched.
    const after = await readDoc({ root: dir }, "context-notes/guarded");
    assert.equal(after.frontmatter.title, "Original Title");
  } finally {
    await cleanup();
  }
});

test("new: an unrecognized --<field> flag for the kind is a USAGE error naming the declared fields", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    await assert.rejects(
      () => newCommand(["Context Note", "x", "--title", "T", "--bogus-field", "v", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /unknown field\(s\).*bogus-field/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("new: a stray extra positional is a USAGE error naming the count (F3 regression — was silently absorbed)", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    await assert.rejects(
      () => newCommand(["Context Note", "x", "extra-positional", "--title", "T", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /positionals/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("new: --<field>=<value> is accepted identically to --<field> <value> (F5 regression)", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    const result = await runJson(newCommand, ["Context Note", "eq-form", "--title=Equals Form", "--dir", dir]);
    assert.equal(result.new, "written");
    assert.equal(result.id, "context-notes/eq-form");
    const saved = await readDoc({ root: dir }, "context-notes/eq-form");
    assert.equal(saved.frontmatter.title, "Equals Form");
  } finally {
    await cleanup();
  }
});

test("new: a kind declaring the reserved field name 'type' cannot have --type override the governed type — it is an unknown field, never a silent overwrite (F2 regression, CLI integration)", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/hijack",
      frontmatter: {
        type: CONVENTION_TYPE,
        title: "Hijack",
        governs: "Hijack",
        fields: { required: ["title", "type"], optional: [] },
        timestamp: T,
      },
      body: "Tries to declare 'type' as an own field.",
    });
    await assert.rejects(
      () => newCommand(["Hijack", "x", "--title", "T", "--type", "Something Else", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /unknown field\(s\).*type/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new --body-file: a formerly-valid colliding domain field is centrally reserved and warns at point of use", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/artifact",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Artifact",
        path: "artifacts/",
        fields: { required: ["title"], optional: ["body-file"] },
        timestamp: T,
      },
      body: "A convention written before body-file became a CLI byte channel.",
    });
    const bodyFile = path.join(dir, "artifact-body.md");
    await writeFile(bodyFile, "# Summary\n\nAuthored body.\n", "utf8");

    const receipt = await runJson(newCommand, [
      "Artifact",
      "a",
      "--title",
      "A",
      "--body-file",
      bodyFile,
      "--dir",
      dir,
    ]);
    const saved = await readDoc(bundle, "artifacts/a");
    assert.equal(saved.body, "# Summary\n\nAuthored body.\n");
    assert.equal(Object.hasOwn(saved.frontmatter, "body-file"), false);
    const warnings = receipt.warnings as Array<Record<string, unknown>>;
    assert.equal(warnings[0]!.code, "KIND_RESERVED_FIELD");
    assert.match(String(warnings[0]!.message), /body-file/);
    assert.match(String(warnings[0]!.message), /rename those domain fields/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new --body: a formerly-valid colliding domain field is centrally reserved and warns at point of use", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/artifact",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Artifact",
        path: "artifacts/",
        fields: { required: ["title"], optional: ["body"] },
        timestamp: T,
      },
      body: "A convention written before body became a CLI Markdown channel.",
    });

    let help = "";
    await newCommand(["Artifact", "--help", "--dir", dir], { stdout: (s) => (help += s) });
    assert.equal((help.match(/  --body <markdown>/g) ?? []).length, 1);
    assert.doesNotMatch(help, /--body <v>/);

    const receipt = await runJson(newCommand, [
      "Artifact",
      "a",
      "--title",
      "A",
      "--body",
      "# Summary\n\nAuthored body.\n",
      "--dir",
      dir,
    ]);
    const saved = await readDoc(bundle, "artifacts/a");
    assert.equal(saved.body, "# Summary\n\nAuthored body.\n");
    assert.equal(Object.hasOwn(saved.frontmatter, "body"), false);
    const warnings = receipt.warnings as Array<Record<string, unknown>>;
    assert.equal(warnings[0]!.code, "KIND_RESERVED_FIELD");
    assert.match(String(warnings[0]!.message), /body/);
    assert.match(String(warnings[0]!.message), /rename those domain fields/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new: a kind with declared 'sections' scaffolds them as empty body headings", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/roadmap-item",
      frontmatter: {
        type: CONVENTION_TYPE,
        title: "Roadmap Item",
        governs: "Roadmap Item",
        path: "roadmap/",
        fields: { required: ["title", "status"], optional: [], values: { status: ["planned", "active", "done"] } },
        sections: ["Why", "Done when"],
        timestamp: T,
      },
      body: "Roadmap items.",
    });

    await newCommand(["Roadmap Item", "r1", "--title", "R1", "--status", "planned", "--dir", dir], {
      stdout: () => {},
    });
    const saved = await readDoc(bundle, "roadmap/r1");
    assert.match(saved.body, /^# Why/m);
    assert.match(saved.body, /^# Done when/m);

    // A disallowed enum value is a validation rejection.
    await assert.rejects(
      () => newCommand(["Roadmap Item", "r2", "--title", "R2", "--status", "cancelled", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /cancelled/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new --body-file: supplied Markdown replaces scaffolding and is strictly validated before creation", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/review",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Review",
        path: "reviews/",
        fields: { required: ["title"] },
        sections: ["Context", "Decision"],
        timestamp: T,
      },
      body: "A review request.",
    });

    const incomplete = path.join(dir, "incomplete.md");
    await writeFile(incomplete, "# Context\n\nOnly one required section.\n", "utf8");
    await assert.rejects(
      () => newCommand(["Review", "incomplete", "--title", "Incomplete", "--body-file", incomplete, "--dir", dir]),
      (err: unknown) => err instanceof CliError && err.code === "USAGE" && err.message.includes("Decision"),
    );
    await assert.rejects(() => readDoc(bundle, "reviews/incomplete"));

    const complete = path.join(dir, "complete.md");
    const authored = "# Context\n\nWhy this matters.\n\n# Decision\n\nApprove or revise.\n";
    await writeFile(complete, authored, "utf8");
    const receipt = await runJson(newCommand, ["Review", "complete", "--title", "Complete", "--body-file", complete, "--dir", dir]);
    assert.equal((await readDoc(bundle, "reviews/complete")).body, authored);
    assert.equal(typeof receipt.version, "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── parser-migration coverage: `new` retired its hand-rolled parser onto a two-phase `parseArgs` ──

test("new --actor '' (blank): USAGE (exit 2)", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    await assert.rejects(
      () => newCommand(["Context Note", "x", "--title", "T", "--actor", "", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /empty value/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("new --actor <name>: writes AND persists the actor into the instance's frontmatter (strict mode stays green)", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    const result = await runJson(newCommand, ["Context Note", "actor-note", "--title", "T", "--actor", "alice", "--dir", dir]);
    assert.equal(result.new, "written");
    const saved = await readDoc({ root: dir }, "context-notes/actor-note");
    assert.equal(saved.frontmatter.title, "T");
    assert.equal(saved.frontmatter.actor, "alice", "the per-doc attribution sync's enrichment reads");
  } finally {
    await cleanup();
  }
});

test("new WITHOUT --actor: no actor frontmatter field appears (absent stays absent)", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    const result = await runJson(newCommand, ["Context Note", "plain-note", "--title", "T", "--dir", dir]);
    assert.equal(result.new, "written");
    const saved = await readDoc({ root: dir }, "context-notes/plain-note");
    assert.ok(!("actor" in saved.frontmatter), "no actor key must be persisted when --actor was not given");
  } finally {
    await cleanup();
  }
});

test("new: a glued flag token names the token, not \"N positionals\" (parser-migration regression)", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    // A shell-quoting mistake landing `--title todo` as ONE argv element used to be silently absorbed
    // by the hand-rolled parser's positional bucket and reported as a misdirecting "got 3
    // positionals" — the strict re-parse now surfaces it as an unknown-field error NAMING the token.
    await assert.rejects(
      () => newCommand(["Context Note", "x", "--title todo", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /title todo/);
        assert.doesNotMatch(err.message, /positionals/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("new: a repeated --<field> becomes an array", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/taggable",
      frontmatter: {
        type: CONVENTION_TYPE,
        title: "Taggable",
        governs: "Taggable",
        fields: { required: ["title"], optional: ["tag"] },
        timestamp: T,
      },
      body: "A kind with a repeatable optional field.",
    });

    await newCommand(["Taggable", "x", "--title", "T", "--tag", "a", "--tag", "b", "--dir", dir], {
      stdout: () => {},
    });
    const saved = await readDoc(bundle, "x");
    assert.deepEqual(saved.frontmatter.tag, ["a", "b"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new: prototype-looking declared fields persist as exact own properties and remain normally required", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    const cases = [
      { field: "__proto__", args: ["--__proto__", "proto-value"], expected: "proto-value", values: ["proto-value"] },
      { field: "constructor", args: ["--constructor=ctor-value"], expected: "ctor-value", values: ["ctor-value"] },
      { field: "toString", args: ["--toString", "first", "--toString", "second"], expected: ["first", "second"] },
    ];
    for (const entry of cases) {
      const kindName = `Special ${entry.field}`;
      const values = entry.values ? Object.fromEntries([[entry.field, entry.values]]) : {};
      await writeDoc(bundle, {
        id: `conventions/special-${entry.field.replaceAll("_", "dash")}`,
        frontmatter: {
          type: CONVENTION_TYPE,
          governs: kindName,
          fields: { required: [entry.field], values },
          timestamp: T,
        },
        body: "",
      });
      const presentId = `present-${entry.field.replaceAll("_", "dash")}`;
      const missingId = `missing-${entry.field.replaceAll("_", "dash")}`;
      await newCommand([kindName, presentId, ...entry.args, "--dir", dir], { stdout: () => {} });
      const saved = await readDoc(bundle, presentId);
      assert.equal(Object.prototype.hasOwnProperty.call(saved.frontmatter, entry.field), true);
      assert.deepEqual((saved.frontmatter as Record<string, unknown>)[entry.field], entry.expected);
      assert.equal(Object.getPrototypeOf(saved.frontmatter), Object.prototype);
      await assert.rejects(
        () => newCommand([kindName, missingId, "--dir", dir], { stdout: () => {} }),
        (err: unknown) => err instanceof CliError && err.code === "USAGE" && err.message.includes(entry.field),
      );
      await assert.rejects(() => readDoc(bundle, missingId));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doc write: warn-by-default when a kind governs --type (exit 0, warnings[] attached, doc still written)", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    let out = "";
    // FULL_SECTIONS_BODY carries all four seeded sections, isolating the missing-title violation
    // from the (unrelated) section lint the seed's `sections:` declaration now also runs.
    await doc(
      ["write", "context-notes/bad", "--type", "Context Note", "--body", FULL_SECTIONS_BODY, "--dir", dir, "--json"],
      { stdout: (s) => (out += s) },
    );
    const result = JSON.parse(out) as Record<string, unknown>;
    assert.equal(result.doc, "written");
    const warnings = result.warnings as Array<Record<string, unknown>>;
    // Exactly the missing-title warning: core defaults a timestamp-less candidate before
    // validation, so validation sees the value that will actually be persisted.
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.field, "title");

    // The doc WAS written despite the warnings (warn-by-default is non-blocking).
    const saved = await readDoc({ root: dir }, "context-notes/bad");
    assert.equal(saved.frontmatter.type, "Context Note");
  } finally {
    await cleanup();
  }
});

test("doc write: a timestamp-less write of a governed type produces NO warnings key at all (F1 regression — the phantom KIND_FIELD_MISSING 'timestamp' warning)", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    // --title supplied, --timestamp NOT supplied. Context Note requires title+timestamp; the
    // engine always stamps a timestamp regardless, so a doc lacking ONLY --timestamp is fully
    // conforming once written and must carry no warnings at all — not even a title-shaped one.
    // FULL_SECTIONS_BODY satisfies the seed's `sections:` declaration so it too contributes no
    // warnings, keeping this test isolated to the F1 timestamp regression it targets.
    let out = "";
    await doc(
      [
        "write",
        "context-notes/fine",
        "--type",
        "Context Note",
        "--title",
        "Fine",
        "--body",
        FULL_SECTIONS_BODY,
        "--dir",
        dir,
        "--json",
      ],
      { stdout: (s) => (out += s) },
    );
    const result = JSON.parse(out) as Record<string, unknown>;
    assert.equal(result.doc, "written");
    assert.equal("warnings" in result, false, `expected no warnings key, got ${JSON.stringify(result.warnings)}`);
    assert.ok(typeof result.timestamp === "string" && result.timestamp.length > 0);

    // The --strict variant of the identical write must SUCCEED (exit 0), not reject — this is
    // exactly the case F1 caused to wrongly fail under --strict.
    let strictOut = "";
    await doc(
      [
        "write",
        "context-notes/fine-strict",
        "--type",
        "Context Note",
        "--title",
        "Fine",
        "--body",
        FULL_SECTIONS_BODY,
        "--strict",
        "--dir",
        dir,
        "--json",
      ],
      { stdout: (s) => (strictOut += s) },
    );
    const strictResult = JSON.parse(strictOut) as Record<string, unknown>;
    assert.equal(strictResult.doc, "written");
    assert.equal("warnings" in strictResult, false);
  } finally {
    await cleanup();
  }
});

test("doc write --strict: upgrades a non-empty warning set to a USAGE error (exit 2), does NOT write", async () => {
  const { dir, cleanup } = await makeSeededBundle();
  try {
    await assert.rejects(
      () =>
        doc(["write", "context-notes/rejected", "--type", "Context Note", "--body", "x", "--strict", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
    await assert.rejects(() => readDoc({ root: dir }, "context-notes/rejected"));
  } finally {
    await cleanup();
  }
});

test("doc write: a conventions-free bundle (no governing kind) writes with no warnings key at all", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    let out = "";
    await doc(["write", "concepts/x", "--type", "Concept", "--body", "hi", "--dir", dir, "--json"], {
      stdout: (s) => (out += s),
    });
    const result = JSON.parse(out) as Record<string, unknown>;
    assert.equal(result.doc, "written");
    assert.equal("warnings" in result, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The CLI-level "kind horizon feeds freshness" coupling (formerly pinned here via `note read`'s
// `--max-age-ms` wiring) is covered generically now: `status`'s freshness sweep proves the SAME
// kind-fed-horizon coupling both WITH and WITHOUT the recipe applied (`recipes.test.ts`), and the
// underlying `freshness()`+`maxAgeMs` override behavior itself is covered directly at the engine
// level (`core/test/pure.test.ts`'s "freshness: empty / fresh / stale-by-age / stale-by-dependency").
// No CLI command exposes a per-doc explicit `--max-age-ms` override anymore — that is an accepted,
// intentional regression (see STATUS.md / plans/delete-note.md), not a coverage gap.

test("list --fields fields on a Convention row: pins the nested-object TOON rendering (Improvement 7)", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/roadmap-item",
      frontmatter: {
        type: CONVENTION_TYPE,
        title: "Roadmap Item",
        governs: "Roadmap Item",
        fields: { required: ["title", "status"], optional: [], values: { status: ["planned", "active", "done"] } },
        timestamp: T,
      },
      body: "Roadmap items.",
    });
    const result = await runJson(list, ["--type", CONVENTION_TYPE, "--fields", "fields", "--dir", dir]);
    assert.equal(result.count, 1);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    // Pin the shape: --json round-trips a plain nested object unmodified through the row.
    assert.deepEqual(rows[0]!.fields, {
      required: ["title", "status"],
      optional: [],
      values: { status: ["planned", "active", "done"] },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--remote: new + kinds against a served bundle, parity with the same operations run locally", async () => {
  const localDir = await tempDir();
  const remoteDir = await tempDir();
  try {
    await initBundle(localDir);
    await applyRecipe({ root: localDir }, CONTEXT_NOTES_RECIPE);
    await initBundle(remoteDir);
    await applyRecipe({ root: remoteDir }, CONTEXT_NOTES_RECIPE);
    const handle: ServerHandle = await serve({ bundle: { root: remoteDir }, port: 0 });
    const url = `http://${handle.host}:${handle.port}`;
    try {
      const localKinds = await runJson(kinds, ["--dir", localDir]);
      const remoteKinds = await runJson(kinds, ["--remote", url, "--bundle", "bnd_00000000000000000000000000000000"]);
      assert.deepEqual(remoteKinds, localKinds);

      const localNew = await runJson(newCommand, ["Context Note", "n1", "--title", "N1", "--dir", localDir]);
      const remoteNew = await runJson(newCommand, ["Context Note", "n1", "--title", "N1", "--remote", url, "--bundle", "bnd_00000000000000000000000000000000"]);
      assert.equal(remoteNew.id, localNew.id);
      assert.equal(remoteNew.kind, localNew.kind);
      await assert.rejects(
        () => newCommand(["Context Note", "missing", "--remote", url, "--bundle", "bnd_00000000000000000000000000000000"]),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.ok(
            err.help?.endsWith(
              `superbee new ${shellArg("Context Note")} --help --remote ${shellArg(url)} --bundle ${shellArg("bnd_00000000000000000000000000000000")}`,
            ),
          );
          return true;
        },
      );
    } finally {
      await handle.close();
    }
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  }
});

test("seed round-trip (usability F2): init seeds 'sections: [Summary]' into 'kinds', and BOTH a summary-only and a fully-populated Context Note doc (written via the GENERIC 'doc write' path) pass 'status' with zero kind/registry warnings (alert-fatigue guard)", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await applyRecipe({ root: dir }, CONTEXT_NOTES_RECIPE);

    // init -> kinds shows the seeded sections (the seed exercises the 'sections' feature for
    // real). ONLY Summary is declared — the one section the context-notes recipe scaffolds and
    // every instance carries — so the minimal-note workflow below stays lint-free.
    const kindsResult = await runJson(kinds, ["--dir", dir]);
    const rows = kindsResult.kinds as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.governs, "Context Note");
    assert.deepEqual(rows[0]!.sections, ["Summary"]);
    assert.deepEqual(rows[0]!.required_headings, ["# Summary"]);

    // The PRIMARY-PATH pin: a summary-only Context Note (no Decisions/Open Questions/Pointers,
    // the most common legitimate shape — written via the generic 'doc write', not a bespoke
    // command) must produce ZERO kind warnings in status — the seed must never lint the minimal
    // workflow (orchestrator decision on the F2 follow-up).
    await doc(
      [
        "write",
        "context-notes/minimal",
        "--type",
        "Context Note",
        "--title",
        "minimal",
        "--body",
        "# Summary\n\nJust a summary.",
        "--dir",
        dir,
      ],
      { stdout: () => {} },
    );
    const afterMinimal = await runJson(status, ["--dir", dir]);
    assert.equal(afterMinimal.kind_warnings, 0, "a summary-only Context Note must not trip the seeded section lint");
    assert.equal(afterMinimal.registry_warnings, 0);

    // A real link target so the fully-populated doc's pointer link resolves (keeps the status
    // report free of an unrelated unresolved-link finding — not what this test pins).
    const bundle: Bundle = { root: dir };
    await writeDoc(bundle, { id: "concepts/a", frontmatter: { type: "Concept", timestamp: T }, body: "A concept." });

    // And the fully-populated shape (all four headings present) also passes, trivially
    // satisfying the declared [Summary].
    await doc(
      [
        "write",
        "context-notes/full",
        "--type",
        "Context Note",
        "--title",
        "full",
        "--body",
        "# Summary\n\nAll sections present.\n\n# Decisions\n\n- Do X\n\n# Open Questions\n\n- Why not Y?\n\n# Pointers\n\n- [A](../concepts/a.md)\n",
        "--dir",
        dir,
      ],
      { stdout: () => {} },
    );

    // status -> still zero kind-conformance warnings and zero registry warnings (the seed
    // itself is well-formed).
    const statusResult = await runJson(status, ["--dir", dir]);
    assert.equal(statusResult.kind_warnings, 0);
    assert.equal(statusResult.registry_warnings, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new: a kind DECLARING `actor` as required is satisfiable through the --actor control flag, and rejects without it (actor-attribution review, issue 2)", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };
    await writeDoc(bundle, {
      id: "conventions/memo",
      frontmatter: { type: CONVENTION_TYPE, governs: "Memo", fields: { required: ["title", "actor"], optional: [] }, timestamp: T },
      body: "",
    });

    // WITH --actor: validates green and the written doc carries the field.
    const receipt = await runJson(newCommand, ["Memo", "m1", "--title", "M", "--actor", "alice", "--dir", dir]);
    const written = await readDoc(bundle, receipt.id as string);
    assert.equal(written.frontmatter.actor, "alice");
    assert.equal(receipt.warnings, undefined, "no kind warnings when the required actor arrives via the control flag");

    // WITHOUT --actor: the required field is genuinely missing — strict `new` rejects it.
    await assert.rejects(
      () => runJson(newCommand, ["Memo", "m2", "--title", "M", "--dir", dir]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /actor/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
