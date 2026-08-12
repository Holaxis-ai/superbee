// `artifact create` pins (designs/artifact-runtime Unit 1): one command owns derive-id → promote →
// record; collision-safe ids; --supersedes flips the prior + writes the supersedes link; works with
// NO Artifact convention declared (product kind, convention-independent). The partial-failure
// contract (review #150): a record-create failure NAMES the orphaned blob; a re-run after an orphan
// picks a fresh id (never bricks); --supersedes is validated upfront (an existing artifacts/ Artifact).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeBlob, writeDoc } from "@superbee/core";

import { artifact, slugifyTitle, firstFreeId } from "../src/commands/artifact.js";
import { openBundle } from "../src/bundle.js";

async function makeBundle(): Promise<{ dir: string; html: string; cleanup: () => Promise<void> }> {
  const top = await mkdtemp(path.join(tmpdir(), "aslite-artifact-"));
  const dir = path.join(top, "b");
  await initBundle(dir); // seeds context-notes only — deliberately NO Artifact convention
  const html = path.join(top, "report.html");
  await writeFile(html, "<!doctype html><h1>hi</h1>");
  return { dir, html, cleanup: () => rm(top, { recursive: true, force: true }) };
}

// Declare an Artifact convention requiring a field the command never sets, so a strict create is
// rejected AFTER the blob is promoted — the orphan case.
async function declareRejectingArtifactConvention(dir: string): Promise<void> {
  await mkdir(path.join(dir, "conventions"), { recursive: true });
  await writeFile(
    path.join(dir, "conventions", "artifact.md"),
    "---\ntype: Convention\ngoverns: Artifact\nfields:\n  required:\n    - reviewer\n---\n# Artifact\nRequires a reviewer.\n",
  );
}

async function runJson(argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await artifact([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

test("slugifyTitle: lowercase, hyphen-joined, bounded, never empty", () => {
  assert.equal(slugifyTitle("Q3 Analysis!"), "q3-analysis");
  assert.equal(slugifyTitle("  Weird__Title -- v2  "), "weird-title-v2");
  assert.equal(slugifyTitle("!!!"), "artifact"); // no alnum → fallback
  assert.equal(slugifyTitle("x".repeat(200)).length, 60);
});

test("firstFreeId: base, then -2, -3 against taken ids", () => {
  assert.equal(firstFreeId("report", new Set()), "artifacts/report");
  assert.equal(firstFreeId("report", new Set(["artifacts/report"])), "artifacts/report-2");
  assert.equal(firstFreeId("report", new Set(["artifacts/report", "artifacts/report-2"])), "artifacts/report-3");
});

test("create: one command promotes the blob + writes the record (no Artifact convention needed)", async () => {
  const { dir, html, cleanup } = await makeBundle();
  try {
    const receipt = await runJson(["create", html, "--title", "Q3 Analysis!", "--dir", dir, "--actor", "tester"]);
    assert.equal(receipt.artifact, "created");
    assert.equal(receipt.id, "artifacts/q3-analysis"); // slug from title
    assert.equal(receipt.entry, "artifacts/q3-analysis.html");
    assert.equal(receipt.status, "active");
    assert.match(String(receipt.entry_version), /^sha256:/);
    // The in-shell viewer ships in Unit 2: the receipt must NOT advertise a ?view=artifact route yet,
    // and the help points at the byte-pull workaround.
    assert.equal(receipt.open, undefined);
    assert.ok(
      (receipt.help as string[]).some((h) => h.includes("pull --doc-key artifacts/q3-analysis.html")),
      "help offers the byte-pull workaround",
    );

    // Both the record and the blob exist on disk under artifacts/.
    assert.ok(existsSync(path.join(dir, "artifacts", "q3-analysis.md")), "record written");
    assert.ok(existsSync(path.join(dir, "artifacts", "q3-analysis.html")), "blob written");
    const record = await readFile(path.join(dir, "artifacts", "q3-analysis.md"), "utf8");
    assert.match(record, /type: Artifact/);
    assert.match(record, /status: active/);
    assert.match(record, /entry: artifacts\/q3-analysis\.html/);
    assert.match(record, /entry_version:/);
  } finally {
    await cleanup();
  }
});

test("create: a second same-title artifact gets a collision-safe id", async () => {
  const { dir, html, cleanup } = await makeBundle();
  try {
    const first = await runJson(["create", html, "--title", "Report", "--dir", dir, "--actor", "t"]);
    const second = await runJson(["create", html, "--title", "Report", "--dir", dir, "--actor", "t"]);
    assert.equal(first.id, "artifacts/report");
    assert.equal(second.id, "artifacts/report-2");
  } finally {
    await cleanup();
  }
});

test("create --supersedes: flips the prior to superseded and links this one 'supersedes' it", async () => {
  const { dir, html, cleanup } = await makeBundle();
  try {
    await runJson(["create", html, "--title", "Report", "--dir", dir, "--actor", "t"]);
    const v2 = await runJson(["create", html, "--title", "Report v2", "--supersedes", "artifacts/report", "--dir", dir, "--actor", "t"]);
    assert.equal(v2.id, "artifacts/report-v2");
    assert.equal(v2.supersedes, "artifacts/report");

    const prior = await readFile(path.join(dir, "artifacts", "report.md"), "utf8");
    assert.match(prior, /status: superseded/);
    const nu = await readFile(path.join(dir, "artifacts", "report-v2.md"), "utf8");
    // The supersedes edge is a same-directory relative body link carrying the declared verb.
    assert.match(nu, /\[supersedes\]\(report\.md\)/);
  } finally {
    await cleanup();
  }
});

test("create --supersedes resolves path-style .md input before the exact storage seam", async () => {
  const { dir, html, cleanup } = await makeBundle();
  try {
    await writeDoc({ root: dir }, {
      id: "artifacts/prior",
      frontmatter: { type: "Artifact", status: "active" },
      body: "",
    });
    const receipt = await runJson([
      "create", html, "--title", "Next", "--supersedes", "artifacts/prior.md", "--dir", dir, "--actor", "t",
    ]);
    assert.equal(receipt.supersedes, "artifacts/prior");
    assert.match(await readFile(path.join(dir, "artifacts", "prior.md"), "utf8"), /status: superseded/);
    assert.match(await readFile(path.join(dir, "artifacts", "next.md"), "utf8"), /\[supersedes\]\(prior\.md\)/);
  } finally {
    await cleanup();
  }
});

test("create --supersedes: a cross-dir / missing / non-Artifact target is rejected upfront (no write)", async () => {
  const { dir, html, cleanup } = await makeBundle();
  try {
    // A non-artifacts/ id: rejected before any write, so nothing is created.
    await assert.rejects(
      runJson(["create", html, "--title", "X", "--supersedes", "docs/old-note", "--dir", dir, "--actor", "t"]),
      /must be an artifacts\/ id/,
    );
    // An artifacts/ id that doesn't exist.
    await assert.rejects(
      runJson(["create", html, "--title", "X", "--supersedes", "artifacts/ghost", "--dir", dir, "--actor", "t"]),
      /does not exist/,
    );
    assert.ok(!existsSync(path.join(dir, "artifacts")), "no artifacts/ created on a rejected supersede");

    // An existing artifacts/ doc that is NOT type:Artifact must not be flipped.
    const bundle = await openBundle(dir, undefined);
    await writeDoc(bundle, { id: "artifacts/plain", frontmatter: { type: "Doc", title: "Plain" }, body: "" });
    await assert.rejects(
      runJson(["create", html, "--title", "Y", "--supersedes", "artifacts/plain", "--dir", dir, "--actor", "t"]),
      /not Artifact/,
    );
  } finally {
    await cleanup();
  }
});

test("create: a record-create failure NAMES the orphaned blob (strict-convention rejection)", async () => {
  const { dir, html, cleanup } = await makeBundle();
  try {
    await declareRejectingArtifactConvention(dir);
    await assert.rejects(
      runJson(["create", html, "--title", "Report", "--dir", dir, "--actor", "t"]),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /artifacts\/report\.html/, "names the orphaned blob");
        assert.match(msg, /orphaned/, "says the bytes are orphaned");
        assert.match(msg, /delete --doc-key artifacts\/report\.html/, "points at recovery");
        return true;
      },
    );
    // The blob really is orphaned on disk (no record beside it).
    assert.ok(existsSync(path.join(dir, "artifacts", "report.html")), "blob written before the record failed");
    assert.ok(!existsSync(path.join(dir, "artifacts", "report.md")), "no record");
  } finally {
    await cleanup();
  }
});

test("create: an orphaned blob does not brick a later create — it picks a fresh id", async () => {
  const { dir, html, cleanup } = await makeBundle();
  try {
    // Simulate a prior failed run: a promoted blob with no record beside it.
    const bundle = await openBundle(dir, undefined);
    await writeBlob(bundle, "artifacts/report.html", Buffer.from("orphan"), "text/html", { expectedVersion: null });

    // A create titled "Report" must NOT collide on the stray blob's expect-absent write — it advances.
    const receipt = await runJson(["create", html, "--title", "Report", "--dir", dir, "--actor", "t"]);
    assert.equal(receipt.id, "artifacts/report-2");
    assert.equal(receipt.entry, "artifacts/report-2.html");
    assert.ok(existsSync(path.join(dir, "artifacts", "report-2.md")), "fresh record written");
  } finally {
    await cleanup();
  }
});

test("create: --title is required; a missing file is a USAGE error; neither leaves a partial write", async () => {
  const { dir, html, cleanup } = await makeBundle();
  try {
    await assert.rejects(runJson(["create", html, "--dir", dir, "--actor", "t"]), /requires --title/);
    await assert.rejects(runJson(["create", path.join(dir, "nope.html"), "--title", "X", "--dir", dir, "--actor", "t"]), /no such file/);
    assert.ok(!existsSync(path.join(dir, "artifacts")), "no artifacts/ dir created on a rejected call");
  } finally {
    await cleanup();
  }
});
