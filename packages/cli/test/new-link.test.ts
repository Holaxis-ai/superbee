/**
 * `new --link "<type>=<target-id>"` — one-step create+link (board task `tasks/new-link-flag`).
 *
 * Ergonomics only: `--link` rides the EXACT SAME mutation `link add` uses (`addLink`, exported
 * from `commands/link.ts`) after the doc write succeeds. Pins: single/repeatable use, the
 * undeclared-link-type warning (teach, never block), a dangling target (allowed, same as `link
 * add`), malformed-value USAGE rejection (nothing written), the receipt shape, a post-creation
 * link failure (doc stays created, the failing entry is named, non-zero exit), the existing
 * create-only/ALREADY_EXISTS behavior composing unaffected, and --remote parity.
 *
 * Runs command functions in-process (no subprocess) against a real temp filesystem bundle,
 * mirroring `kinds.test.ts`'s pattern.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  initBundle,
  writeDoc,
  readDoc,
  readDocVersioned,
  docVersions,
  MemoryBackend,
  CONVENTION_TYPE,
  type ConceptId,
  type Bundle,
  type OkfDocument,
  type ReadResult,
  type Version,
  type WriteOptions,
} from "@superbee/core";
import { serve, type ServerHandle } from "@superbee/server";

import { newCommand } from "../src/commands/new.js";
import { CliError } from "../src/errors.js";
import { renderedPattern } from "./support/rendered-command.js";

const T = "2026-07-01T00:00:00.000Z";

async function withActorEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(process.env, "AGENTSTATE_LITE_ACTOR");
  const previous = process.env.AGENTSTATE_LITE_ACTOR;
  if (value === undefined) delete process.env.AGENTSTATE_LITE_ACTOR;
  else process.env.AGENTSTATE_LITE_ACTOR = value;
  try {
    return await run();
  } finally {
    if (had) process.env.AGENTSTATE_LITE_ACTOR = previous;
    else delete process.env.AGENTSTATE_LITE_ACTOR;
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-new-link-test-"));
}

/** A bundle declaring one "Task" kind with a two-entry outbound link vocabulary. */
async function makeTaskBundle(): Promise<{ dir: string; bundle: Bundle; cleanup: () => Promise<void> }> {
  const dir = await tempDir();
  const bundle: Bundle = { root: dir };
  await initBundle(dir);
  await writeDoc(bundle, {
    id: "conventions/task",
    frontmatter: {
      type: CONVENTION_TYPE,
      title: "Task",
      governs: "Task",
      path: "tasks/",
      fields: { required: ["title"], optional: [] },
      links: { "depends on": "Task", blocks: "Task" },
      timestamp: T,
    },
    body: "A unit of work.",
  });
  return { dir, bundle, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A hard-case backend: the link write lands, then only the advisory registry read fails. */
class PostWriteLintFailureBackend extends MemoryBackend {
  private failConventionReads = false;

  override async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    const version = await super.write(id, doc, options);
    if (id === "tasks/review" && doc.body.includes("[depends on]")) this.failConventionReads = true;
    return version;
  }

  override async read(id: ConceptId): Promise<ReadResult> {
    if (this.failConventionReads && id === "conventions/task") {
      throw new Error("injected post-write lint read failure");
    }
    return super.read(id);
  }
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

test("new --link: a single declared-type link is added through the SAME machinery link add uses", async () => {
  const { dir, bundle, cleanup } = await makeTaskBundle();
  try {
    await runJson(newCommand, ["Task", "t1", "--title", "T1", "--dir", dir]);
    const result = await runJson(newCommand, [
      "Task",
      "t2",
      "--title",
      "T2",
      "--link",
      "depends on=tasks/t1",
      "--dir",
      dir,
    ]);
    assert.equal(result.id, "tasks/t2");
    const links = result.links as Array<Record<string, unknown>>;
    assert.equal(links.length, 1);
    assert.equal(links[0]!.type, "depends on");
    assert.equal(links[0]!.target, "tasks/t1");
    assert.equal(links[0]!.changed, true);
    assert.ok(typeof links[0]!.href === "string" && (links[0]!.href as string).length > 0);
    assert.equal(links[0]!.warnings, undefined, "a declared, conforming type must carry no warnings");
    assert.equal(links[0]!.error, undefined);

    // The link actually landed in the doc's body, via the identical `link add` write path.
    const written = await readDoc(bundle, "tasks/t2");
    assert.match(written.body, /\[depends on\]\(t1\.md\)/);
    const finalHead = await readDocVersioned(bundle, "tasks/t2");
    assert.equal(
      result.version,
      finalHead.version,
      "the new receipt must report the post-link head, not the intermediate create version",
    );
  } finally {
    await cleanup();
  }
});

test("new --body-file + --link: local authoring enters through one command and returns the final stored head", async () => {
  const { dir, bundle, cleanup } = await makeTaskBundle();
  try {
    await runJson(newCommand, ["Task", "source", "--title", "Source", "--dir", dir]);
    const bodyFile = path.join(dir, "review-body.md");
    await writeFile(bodyFile, "# Context\n\nA substantial body authored in a local file.\n", "utf8");

    const result = await runJson(newCommand, [
      "Task",
      "review",
      "--title",
      "Review",
      "--body-file",
      bodyFile,
      "--link",
      "depends on=tasks/source",
      "--dir",
      dir,
    ]);

    const finalHead = await readDocVersioned(bundle, "tasks/review");
    assert.match(finalHead.doc.body, /^# Context\n\nA substantial body authored in a local file\./);
    assert.match(finalHead.doc.body, /\[depends on\]\(source\.md\)/);
    assert.equal(result.version, finalHead.version);
    assert.deepEqual(
      (result.links as Array<Record<string, unknown>>).map((link) => [link.type, link.changed]),
      [["depends on", true]],
    );
  } finally {
    await cleanup();
  }
});

test("new --link: a post-write advisory-lint failure preserves success and the truthful final version", async () => {
  const backend = new PostWriteLintFailureBackend();
  const bundle: Bundle = { root: "mem://new-link-lint-failure", backend };
  await writeDoc(bundle, {
    id: "conventions/task",
    frontmatter: {
      type: CONVENTION_TYPE,
      governs: "Task",
      path: "tasks/",
      fields: { required: ["title"], optional: [] },
      links: { "depends on": "Task" },
      timestamp: T,
    },
    body: "A task.",
  });
  const handle = await serve({ bundle, port: 0 });
  const url = `http://${handle.host}:${handle.port}`;
  try {
    await runJson(newCommand, ["Task", "source", "--title", "Source", "--remote", url, "--bundle", "bnd_00000000000000000000000000000000"]);
    const result = await runJson(newCommand, [
      "Task",
      "review",
      "--title",
      "Review",
      "--link",
      "depends on=tasks/source",
      "--remote",
      url, "--bundle", "bnd_00000000000000000000000000000000",
    ]);

    const finalHead = await readDocVersioned(bundle, "tasks/review");
    assert.equal(result.version, finalHead.version);
    assert.match(finalHead.doc.body, /\[depends on\]\(source\.md\)/);
    const warnings = ((result.links as Array<Record<string, unknown>>)[0]!.warnings ?? []) as Array<
      Record<string, unknown>
    >;
    assert.equal(warnings[0]!.code, "LINK_LINT_UNAVAILABLE");
    assert.match(String(warnings[0]!.message), /link was written/);
  } finally {
    await handle.close();
  }
});

test("new --body-file: unreadable input fails before creation", async () => {
  const { dir, bundle, cleanup } = await makeTaskBundle();
  try {
    const missing = path.join(dir, "missing-body.md");
    await assert.rejects(
      () => newCommand(["Task", "never-created", "--title", "No", "--body-file", missing, "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /could not read --body-file/);
        return true;
      },
    );
    await assert.rejects(() => readDoc(bundle, "tasks/never-created"));
  } finally {
    await cleanup();
  }
});

test("new --link: one resolved actor consistently attributes both create and link writes over remote", async () => {
  const bundle: Bundle = { root: "mem://new-link-actor", backend: new MemoryBackend() };
  await writeDoc(bundle, {
    id: "conventions/task",
    frontmatter: {
      type: CONVENTION_TYPE,
      title: "Task",
      governs: "Task",
      path: "tasks/",
      fields: { required: ["title"], optional: [] },
      links: { "depends on": "Task" },
      timestamp: T,
    },
    body: "A unit of work.",
  });
  const handle: ServerHandle = await serve({ bundle, port: 0 });
  const url = `http://${handle.host}:${handle.port}`;
  try {
    await withActorEnv(" env-new ", async () => {
      await runJson(newCommand, ["Task", "t1", "--title", "T1", "--remote", url, "--bundle", "bnd_00000000000000000000000000000000"]);
      await runJson(newCommand, [
        "Task",
        "t2",
        "--title",
        "T2",
        "--link",
        "depends on=tasks/t1",
        "--remote",
        url, "--bundle", "bnd_00000000000000000000000000000000",
      ]);
      await runJson(newCommand, [
        "Task",
        "t3",
        "--title",
        "T3",
        "--link",
        "depends on=tasks/t1",
        "--actor",
        "flag-new",
        "--remote",
        url, "--bundle", "bnd_00000000000000000000000000000000",
      ]);
    });
    assert.equal((await readDoc(bundle, "tasks/t2")).frontmatter.actor, "env-new");
    assert.deepEqual((await docVersions(bundle, "tasks/t2")).map((v) => v.actor), ["env-new", "env-new"]);
    assert.equal((await readDoc(bundle, "tasks/t3")).frontmatter.actor, "flag-new");
    assert.deepEqual((await docVersions(bundle, "tasks/t3")).map((v) => v.actor), ["flag-new", "flag-new"]);
  } finally {
    await handle.close();
  }
});

test("new --link: repeatable — two --link flags both land, each reported in the receipt's links array", async () => {
  const { dir, cleanup } = await makeTaskBundle();
  try {
    await runJson(newCommand, ["Task", "t1", "--title", "T1", "--dir", dir]);
    await runJson(newCommand, ["Task", "t2", "--title", "T2", "--dir", dir]);
    const result = await runJson(newCommand, [
      "Task",
      "t3",
      "--title",
      "T3",
      "--link",
      "depends on=tasks/t1",
      "--link",
      "blocks=tasks/t2",
      "--dir",
      dir,
    ]);
    const links = result.links as Array<Record<string, unknown>>;
    assert.equal(links.length, 2);
    assert.deepEqual(
      links.map((l) => [l.type, l.target, l.changed]),
      [
        ["depends on", "tasks/t1", true],
        ["blocks", "tasks/t2", true],
      ],
    );
  } finally {
    await cleanup();
  }
});

test("new --link: different types to the same target both land while an exact repeat is a no-op", async () => {
  const { dir, bundle, cleanup } = await makeTaskBundle();
  try {
    await runJson(newCommand, ["Task", "t1", "--title", "T1", "--dir", dir]);
    const result = await runJson(newCommand, [
      "Task",
      "t2",
      "--title",
      "T2",
      "--link",
      "depends on=tasks/t1",
      "--link",
      "blocks=tasks/t1",
      "--link",
      "depends on=./tasks/t1",
      "--dir",
      dir,
    ]);

    const links = result.links as Array<Record<string, unknown>>;
    assert.deepEqual(
      links.map((link) => [link.type, link.target, link.changed]),
      [
        ["depends on", "tasks/t1", true],
        ["blocks", "tasks/t1", true],
        ["depends on", "./tasks/t1", false],
      ],
    );

    const written = await readDoc(bundle, "tasks/t2");
    assert.equal((written.body.match(/\[depends on\]\(t1\.md\)/g) ?? []).length, 1);
    assert.equal((written.body.match(/\[blocks\]\(t1\.md\)/g) ?? []).length, 1);
  } finally {
    await cleanup();
  }
});

test("new --link: a type NOT in the kind's declared link vocabulary warns (teach) but still adds the link", async () => {
  const { dir, cleanup } = await makeTaskBundle();
  try {
    await runJson(newCommand, ["Task", "t1", "--title", "T1", "--dir", dir]);
    const result = await runJson(newCommand, [
      "Task",
      "t2",
      "--title",
      "T2",
      "--link",
      "randomtype=tasks/t1",
      "--dir",
      dir,
    ]);
    const links = result.links as Array<Record<string, unknown>>;
    assert.equal(links.length, 1);
    assert.equal(links[0]!.changed, true, "an undeclared type still WRITES the link — warn, never block");
    const warnings = links[0]!.warnings as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(warnings) && warnings.length > 0);
    assert.equal(warnings[0]!.code, "LINK_TYPE_UNDECLARED_FOR_KIND");
    assert.match(warnings[0]!.message as string, /'randomtype' is not declared in the 'Task' kind's link vocabulary/);
    assert.match(warnings[0]!.message as string, /depends on/);
    assert.match(warnings[0]!.message as string, /blocks/);
  } finally {
    await cleanup();
  }
});

test("new --link: inherited names are undeclared while explicit own special-looking link types work", async () => {
  const dir = await tempDir();
  const bundle: Bundle = { root: dir };
  try {
    await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/special-links",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Special Links",
        fields: { required: ["title"] },
        links: Object.fromEntries([
          ["declared", "Special Links"],
          ["__proto__", "Special Links"],
        ]),
        timestamp: T,
      },
      body: "",
    });

    const inherited = await runJson(newCommand, [
      "Special Links",
      "inherited",
      "--title",
      "Inherited",
      "--link",
      "constructor=missing-target",
      "--dir",
      dir,
    ]);
    const inheritedWarnings = ((inherited.links as Array<Record<string, unknown>>)[0]!.warnings ?? []) as Array<Record<string, unknown>>;
    assert.equal(inheritedWarnings[0]?.code, "LINK_TYPE_UNDECLARED_FOR_KIND");

    // The target must EXIST here — otherwise a dangling target attaches its own LINK_TARGET_ABSENT
    // warning (link-add-target-honesty unit), which is orthogonal to what THIS assertion checks
    // (that an exactly-declared type, even a prototype-property-shaped one, never warns as
    // undeclared).
    await writeDoc(bundle, { id: "missing-target", frontmatter: { type: "Special Links", title: "MT", timestamp: T }, body: "" });
    const explicit = await runJson(newCommand, [
      "Special Links",
      "explicit",
      "--title",
      "Explicit",
      "--link",
      "__proto__=missing-target",
      "--dir",
      dir,
    ]);
    assert.equal((explicit.links as Array<Record<string, unknown>>)[0]!.warnings, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new --link: a dangling target (no document there yet) is allowed, same as `link add` today", async () => {
  const { dir, bundle, cleanup } = await makeTaskBundle();
  try {
    const result = await runJson(newCommand, [
      "Task",
      "t1",
      "--title",
      "T1",
      "--link",
      "depends on=tasks/not-created-yet",
      "--dir",
      dir,
    ]);
    const links = result.links as Array<Record<string, unknown>>;
    assert.equal(links.length, 1);
    assert.equal(links[0]!.changed, true, "a dangling target must not block or fail the link write");
    assert.equal(links[0]!.error, undefined);
    // No target doc was created as a side effect — it genuinely doesn't exist yet.
    await assert.rejects(() => readDoc(bundle, "tasks/not-created-yet"));
  } finally {
    await cleanup();
  }
});

test("new --link: a malformed value (missing '=', empty type, empty target) is a USAGE error (exit 2) — nothing is written", async () => {
  const { dir, bundle, cleanup } = await makeTaskBundle();
  try {
    const cases = ["no-equals-sign", "=tasks/t1", "depends on="];
    for (const [i, bad] of cases.entries()) {
      const id = `bad-${i}`;
      await assert.rejects(
        () => newCommand(["Task", id, "--title", "T", "--link", bad, "--dir", dir, "--json"], { stdout: () => {} }),
        (err: unknown) => {
          assert.ok(err instanceof CliError, `case '${bad}': expected CliError, got ${String(err)}`);
          assert.equal(err.code, "USAGE", `case '${bad}': code`);
          assert.equal(err.exitCode, 2, `case '${bad}': exitCode`);
          assert.match(err.message, /<type>=<target-id>/, `case '${bad}': message names the expected form`);
          return true;
        },
      );
      // Fail-fast: a malformed --link value is checked BEFORE any write — the doc must not exist.
      await assert.rejects(() => readDoc(bundle, `tasks/${id}`));
    }
  } finally {
    await cleanup();
  }
});

test("new --link: a link that FAILS after the doc was already created — the doc exists, the receipt names the failure, and the command exits non-zero (no fake atomicity)", async () => {
  const { dir, bundle, cleanup } = await makeTaskBundle();
  try {
    let out = "";
    await assert.rejects(
      () =>
        newCommand(
          ["Task", "t1", "--title", "T1", "--link", "depends on=index", "--dir", dir, "--json"],
          { stdout: (s) => (out += s) },
        ),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        // 'index' names a reserved OKF file — the SAME rejection `link add` gives — surfaced as USAGE.
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /t1' was created, but 1 of 1 --link entry failed/);
        return true;
      },
    );
    // The receipt was still emitted to stdout (no silent partial success) BEFORE the throw.
    const receipt = JSON.parse(out) as Record<string, unknown>;
    assert.equal(receipt.new, "written");
    assert.equal(receipt.id, "tasks/t1");
    const links = receipt.links as Array<Record<string, unknown>>;
    assert.equal(links.length, 1);
    assert.equal(links[0]!.type, "depends on");
    assert.equal(links[0]!.target, "index");
    assert.equal(links[0]!.changed, undefined);
    const linkErr = links[0]!.error as Record<string, unknown>;
    assert.equal(linkErr.code, "USAGE");
    assert.match(linkErr.message as string, /reserved OKF file/);

    // The doc itself was NOT rolled back — it genuinely exists.
    const written = await readDoc(bundle, "tasks/t1");
    assert.equal(written.frontmatter.title, "T1");
  } finally {
    await cleanup();
  }
});

test("new --link: receipt shape — a success entry carries exactly {type, target, changed, href}, no stray keys", async () => {
  const { dir, bundle, cleanup } = await makeTaskBundle();
  try {
    // The target must EXIST for this receipt to be genuinely warning-free — a dangling target now
    // attaches a LINK_TARGET_ABSENT warning (link-add-target-honesty unit), which is exactly the
    // "stray key" this test would otherwise (correctly) start flagging. That behavior has its own
    // dedicated coverage below; this test isolates the plain success-shape claim.
    await writeDoc(bundle, { id: "tasks/nope", frontmatter: { type: "Task", title: "Nope", timestamp: T }, body: "" });
    const result = await runJson(newCommand, [
      "Task",
      "t1",
      "--title",
      "T1",
      "--link",
      "depends on=tasks/nope",
      "--dir",
      dir,
    ]);
    const links = result.links as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(links[0]!).sort(), ["changed", "href", "target", "type"]);
  } finally {
    await cleanup();
  }
});

test("new --link: a dangling target's LINK_TARGET_ABSENT warning rides the SAME warnings[] the type-conformance lint uses — the receipt shape gains exactly that one key", async () => {
  const { dir, cleanup } = await makeTaskBundle();
  try {
    const result = await runJson(newCommand, [
      "Task",
      "t1",
      "--title",
      "T1",
      "--link",
      "depends on=tasks/nope",
      "--dir",
      dir,
    ]);
    const links = result.links as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(links[0]!).sort(), ["changed", "href", "target", "type", "warnings"]);
    const warnings = links[0]!.warnings as Array<Record<string, unknown>>;
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, "LINK_TARGET_ABSENT");
  } finally {
    await cleanup();
  }
});

test("new --link: an already-satisfied outbound type is dropped from the receipt's own follow-up link-add hints", async () => {
  const { dir, cleanup } = await makeTaskBundle();
  try {
    await runJson(newCommand, ["Task", "t1", "--title", "T1", "--dir", dir]);
    const result = await runJson(newCommand, [
      "Task",
      "t2",
      "--title",
      "T2",
      "--link",
      "depends on=tasks/t1",
      "--dir",
      dir,
    ]);
    const hints = result.help as string[];
    assert.ok(
      !hints.some((h) => new RegExp(`--text ${renderedPattern("depends on")}`).test(h)),
      `the 'depends on' hint should be dropped since --link already satisfied it, got: ${JSON.stringify(hints)}`,
    );
    assert.ok(
      hints.some((h) => new RegExp(`--text ${renderedPattern("blocks")}`).test(h)),
      `the UNSATISFIED 'blocks' hint should still be offered, got: ${JSON.stringify(hints)}`,
    );
  } finally {
    await cleanup();
  }
});

test("new --link: re-running the exact same new+--link on an id that already exists is STILL create-only ALREADY_EXISTS (exit 5) — no duplicate link processing", async () => {
  const { dir, bundle, cleanup } = await makeTaskBundle();
  try {
    await runJson(newCommand, ["Task", "t1", "--title", "T1", "--dir", dir]);
    const first = await runJson(newCommand, [
      "Task",
      "t2",
      "--title",
      "T2",
      "--link",
      "depends on=tasks/t1",
      "--dir",
      dir,
    ]);
    assert.equal((first.links as unknown[]).length, 1);

    await assert.rejects(
      () =>
        newCommand(
          ["Task", "t2", "--title", "T2", "--link", "depends on=tasks/t1", "--dir", dir, "--json"],
          { stdout: () => {} },
        ),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "ALREADY_EXISTS");
        assert.equal(err.exitCode, 5);
        return true;
      },
    );
    // The doc's body carries exactly ONE copy of the link — the rejected re-run never reached
    // link processing at all (create-only fails before any --link is touched).
    const written = await readDoc(bundle, "tasks/t2");
    const matches = written.body.match(/\[depends on\]/g) ?? [];
    assert.equal(matches.length, 1);
  } finally {
    await cleanup();
  }
});

test("--remote: new --link against a served bundle, parity with the same operation run locally", async () => {
  const localDir = await tempDir();
  const remoteDir = await tempDir();
  try {
    const localBundle: Bundle = { root: localDir };
    const remoteBundle: Bundle = { root: remoteDir };
    await initBundle(localDir);
    await initBundle(remoteDir);
    const taskConvention = {
      type: CONVENTION_TYPE,
      title: "Task",
      governs: "Task",
      path: "tasks/",
      fields: { required: ["title"], optional: [] },
      links: { "depends on": "Task" },
      timestamp: T,
    };
    await writeDoc(localBundle, { id: "conventions/task", frontmatter: taskConvention, body: "A unit of work." });
    await writeDoc(remoteBundle, { id: "conventions/task", frontmatter: taskConvention, body: "A unit of work." });

    const handle: ServerHandle = await serve({ bundle: remoteBundle, port: 0 });
    const url = `http://${handle.host}:${handle.port}`;
    try {
      await runJson(newCommand, ["Task", "t1", "--title", "T1", "--dir", localDir]);
      await runJson(newCommand, ["Task", "t1", "--title", "T1", "--remote", url, "--bundle", "bnd_00000000000000000000000000000000"]);

      const localResult = await runJson(newCommand, [
        "Task",
        "t2",
        "--title",
        "T2",
        "--link",
        "depends on=tasks/t1",
        "--dir",
        localDir,
      ]);
      const remoteResult = await runJson(newCommand, [
        "Task",
        "t2",
        "--title",
        "T2",
        "--link",
        "depends on=tasks/t1",
        "--remote",
        url, "--bundle", "bnd_00000000000000000000000000000000",
      ]);
      assert.equal(remoteResult.id, localResult.id);
      assert.deepEqual(remoteResult.links, localResult.links);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  }
});
