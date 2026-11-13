// What every EGRESS surface does when its caller-supplied target lands INSIDE the open bundle.
//
// The private-state crossing table (`private-state-bundle-boundary.test.ts`) owns the other
// containment question — "may this target be written at all?" — and stops at the private-state
// root. NOTHING owned this one, and that is exactly how `--rendered-out` shipped able to overwrite
// a bundle's own concept docs and reserved `index.md` silently, at exit 0, with all eleven CI lanes
// green: its two siblings on the SAME leaf both guard the case, one by refusing and one by warning,
// and no table compared them. Per `docs/boundary-finding-routing`, a finding in this class becomes a
// ROW here, never a one-off assertion beside the fix.
//
// Rows are checked against the DECLARED egress surface set, so a new egress flag cannot be added
// without deciding — in this table, visibly — what it does to an in-bundle target.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { HOME_LEAF, PUBLIC_LEAVES, type CliLeafSpec } from "../src/command-spec.js";
import { runCli, scratch } from "./support/private-state-fixtures.js";
import { makeTwoCloneTopology } from "../../board-git/test/git-harness.js";

const ALL_LEAVES: readonly CliLeafSpec[] = [...PUBLIC_LEAVES, HOME_LEAF];

/** The shapes an in-bundle target can take, distinguished by what the NEXT bundle walk does to it. */
type TargetShape =
  /** A `.md` path the walk parses as a concept doc — re-ingestion, or clobbering the source doc. */
  | "in-bundle-doc-md"
  /** A reserved OKF filename (§3.1) the walk never re-parses — clobbering it destroys bundle metadata. */
  | "in-bundle-reserved-md"
  /** Any non-`.md` in-bundle path: the walk never looks at it, so writing it is inert. */
  | "in-bundle-inert"
  /** Lexically outside, but a symlink ancestor makes the write land on a bundle document. */
  | "outside-alias-into-bundle-doc"
  /** A dangling outside file symlink whose eventual write creates a new in-bundle document. */
  | "outside-dangling-alias-into-bundle-doc"
  /** Lexically inside, but the bundle walk skips the symlink and the write lands outside. */
  | "in-bundle-alias-outside-doc"
  /** The control: outside the bundle entirely, where every surface must simply write. */
  | "outside-bundle";

/** What the surface owes that shape. `warn` and `refuse` are both acceptable answers; `silent` is not. */
type Expected = "refuse" | "warn" | "silent-ok";

interface EgressRow {
  readonly leaf: string;
  readonly flag: string;
  /** A COMPLETE VALID invocation (F6): a row that exits 2 on argument parsing proves nothing. */
  readonly argv?: (target: string) => string[];
  readonly expect?: Readonly<Record<TargetShape, Expected>>;
  readonly fixture?: "local" | "board" | "qualified";
  readonly operation?: "export" | "inspect";
  readonly skip?: string;
}

const EGRESS_ROWS: readonly EgressRow[] = [
  ...(["export", "inspect"] as const).map((operation): EgressRow => ({
    leaf: "qualified",
    flag: "--out",
    operation,
    fixture: "qualified",
    argv: (target) => ["qualified", operation, "--dir", "bundle", "--out", target,
      ...(operation === "inspect" ? ["--input", "artifact.json", "--actor", "openai/codex"] : [])],
    expect: {
      "in-bundle-doc-md": "refuse",
      "in-bundle-reserved-md": "refuse",
      "in-bundle-inert": "silent-ok",
      "outside-alias-into-bundle-doc": "refuse",
      "outside-dangling-alias-into-bundle-doc": "refuse",
      "in-bundle-alias-outside-doc": "silent-ok",
      "outside-bundle": "silent-ok",
    },
  })),
  {leaf:"viewRead",flag:"--out",skip:"Requires a hosted checkout and its host; hosted-view-content.test.ts proves an in-bundle .md target is refused (the shared assertSafeNonDocumentOutTarget, as --rendered-out) and an existing target is never overwritten"},
  {leaf:"opRun",flag:"--export-html",skip:"Requires a reviewed registered capability plus accepted machine binding; local-operation.test.ts exercises all seven in-bundle/alias shapes and the ordinary-output control with that complete fixture"},
  {leaf:"opRun",flag:"--export-output",skip:"Requires a reviewed registered capability plus accepted machine binding; local-operation.test.ts exercises all seven in-bundle/alias shapes and the ordinary-output control with that complete fixture"},
  {
    leaf: "docRead",
    flag: "--out",
    argv: (t) => ["doc", "read", "concepts/a", "--out", t, "--dir", "bundle", "--json"],
    // Raw bytes ARE a whole OKF document, so an in-bundle copy is conceivable and only warned.
    expect: {
      "in-bundle-doc-md": "warn",
      "in-bundle-reserved-md": "warn",
      "in-bundle-inert": "silent-ok",
      "outside-alias-into-bundle-doc": "warn",
      "outside-dangling-alias-into-bundle-doc": "warn",
      "in-bundle-alias-outside-doc": "silent-ok",
      "outside-bundle": "silent-ok",
    },
  },
  {
    leaf: "docRead",
    flag: "--body-out",
    argv: (t) => ["doc", "read", "concepts/a", "--body-out", t, "--dir", "bundle", "--json"],
    // Body-only markdown has NO frontmatter: an in-bundle `.md` copy corrupts the bundle either way.
    expect: {
      "in-bundle-doc-md": "refuse",
      "in-bundle-reserved-md": "refuse",
      "in-bundle-inert": "silent-ok",
      "outside-alias-into-bundle-doc": "refuse",
      "outside-dangling-alias-into-bundle-doc": "refuse",
      "in-bundle-alias-outside-doc": "silent-ok",
      "outside-bundle": "silent-ok",
    },
  },
  {
    leaf: "docRead",
    flag: "--rendered-out",
    argv: (t) => ["doc", "read", "concepts/a", "--rendered-out", t, "--dir", "bundle", "--json"],
    // Strictly stronger than --body-out's case: rendered HTML at a `.md` path is neither a concept
    // doc nor a reserved file. The refusal subsumes --out's warning — every shape the warning would
    // describe ends in `.md` and is refused here, and the inert shape needs no warning.
    expect: {
      "in-bundle-doc-md": "refuse",
      "in-bundle-reserved-md": "refuse",
      "in-bundle-inert": "silent-ok",
      "outside-alias-into-bundle-doc": "refuse",
      "outside-dangling-alias-into-bundle-doc": "refuse",
      "in-bundle-alias-outside-doc": "silent-ok",
      "outside-bundle": "silent-ok",
    },
  },
  {
    leaf: "pull",
    flag: "--out",
    argv: (t) => ["pull", "--doc-key", "concepts/a.md", "--out", t, "--dir", "bundle", "--json"],
    // Shares `inBundlePollutionWarning` with `doc read --out`, and owes the same answers.
    expect: {
      "in-bundle-doc-md": "warn",
      "in-bundle-reserved-md": "warn",
      "in-bundle-inert": "silent-ok",
      "outside-alias-into-bundle-doc": "warn",
      "outside-dangling-alias-into-bundle-doc": "warn",
      "in-bundle-alias-outside-doc": "silent-ok",
      "outside-bundle": "silent-ok",
    },
  },
  {
    leaf: "sync",
    flag: "--out",
    argv: (t) => ["sync", "--show-incoming", "tasks/seed-one", "--out", t, "--dir", ".", "--json"],
    // Incoming bytes are a whole OKF document, like doc read --out. Preserve deliberate recovery
    // copies but make a teammate-version overwrite loud; inert and outside paths remain quiet.
    expect: {
      "in-bundle-doc-md": "warn",
      "in-bundle-reserved-md": "warn",
      "in-bundle-inert": "silent-ok",
      "outside-alias-into-bundle-doc": "warn",
      "outside-dangling-alias-into-bundle-doc": "warn",
      "in-bundle-alias-outside-doc": "silent-ok",
      "outside-bundle": "silent-ok",
    },
    fixture: "board",
  },
  {
    leaf: "sync",
    flag: "--body-out",
    argv: (t) => ["sync", "--show-incoming", "tasks/seed-one", "--body-out", t, "--dir", ".", "--json"],
    // The parsed incoming body has no OKF frontmatter, so it owes the same refusal as doc read's
    // body channel rather than the whole-document raw channel's warning.
    expect: {
      "in-bundle-doc-md": "refuse",
      "in-bundle-reserved-md": "refuse",
      "in-bundle-inert": "silent-ok",
      "outside-alias-into-bundle-doc": "refuse",
      "outside-dangling-alias-into-bundle-doc": "refuse",
      "in-bundle-alias-outside-doc": "silent-ok",
      "outside-bundle": "silent-ok",
    },
    fixture: "board",
  },
];

/** Every declared egress surface must appear above — the guard against a silent new crossing point. */
test("in-bundle egress table covers every DECLARED egress surface", () => {
  const declared = ALL_LEAVES.flatMap((leaf) =>
    leaf.pathFlags.filter((f) => f.role === "egress").map((f) => `${leaf.id} --${f.flag}`),
  );
  const covered = new Set(EGRESS_ROWS.map((row) => `${row.leaf} ${row.flag}`));
  const missing = declared.filter((key) => !covered.has(key));
  assert.deepEqual(
    missing,
    [],
    `undeclared in-bundle egress behavior: ${missing.join(", ")} — add a row (or a skip WITH a reason)`,
  );
  for (const row of EGRESS_ROWS) {
    assert.ok(
      declared.includes(`${row.leaf} ${row.flag}`),
      `${row.leaf} ${row.flag}: row has no matching declared egress flag in the registry`,
    );
  }
});

interface Fixture {
  readonly project: string;
  readonly home: string;
  readonly bundle: string;
  readonly docPath: string;
  cleanup(): void | Promise<void>;
}

function fixture(): Fixture {
  const project = scratch("superbee-in-bundle-egress-");
  const home = scratch("superbee-in-bundle-egress-home-");
  const bundle = path.join(project, "bundle");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(path.join(bundle, "index.md"), "---\nokf_version: '0.2'\n---\n# fixture\n");
  mkdirSync(path.join(bundle, "concepts"), { recursive: true });
  writeFileSync(
    path.join(bundle, "concepts", "a.md"),
    "---\ntype: Concept\ntitle: A\ntimestamp: 2026-08-02T00:00:00.000Z\n---\n# Hi\n\nBody.\n",
  );
  return {
    project,
    home,
    bundle,
    docPath: "concepts/a.md",
    cleanup: () => {
      rmSync(project, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function qualifiedFixture(): Fixture {
  const fx = fixture();
  rmSync(fx.bundle, { recursive: true, force: true });
  const initialized = runCli(["qualified", "init", "--dir", "bundle", "--actor", "openai/codex"], { cwd: fx.project, home: fx.home });
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
  writeFileSync(path.join(fx.project, "artifact.json"), JSON.stringify({
    format: "superbee-recipe/v2",
    identity: { authority: "github.com", repository_id: "100", recipe_id: "decisions" },
    release: "1.0.0", commit: "a".repeat(40), owner_id: "100",
    kinds: [{ kind_id: "decision", doc: { id: "conventions/decision", frontmatter: { type: "Convention", governs: "Decision" }, body: "" } }],
  }));
  // A fresh .md target proves semantic refusal, not merely exclusive-create EEXIST.
  return { ...fx, docPath: "new-record.md" };
}

async function boardFixture(): Promise<Fixture> {
  const topology = await makeTwoCloneTopology();
  const home = scratch("superbee-in-bundle-egress-board-home-");
  return {
    project: topology.b.root,
    home,
    bundle: topology.b.board,
    docPath: "tasks/seed-two.md",
    cleanup: async () => {
      rmSync(home, { recursive: true, force: true });
      await topology.cleanup();
    },
  };
}

/** The target for one shape, plus the bytes that must survive a refusal. */
function targetFor(fx: Fixture, shape: TargetShape): { target: string; guarded?: string } {
  const bundleFromProject = path.relative(fx.project, fx.bundle);
  switch (shape) {
    // The SOURCE doc itself: the worst case, because a silent write destroys the very document read.
    case "in-bundle-doc-md":
      return { target: path.join(bundleFromProject, fx.docPath), guarded: path.join(fx.bundle, fx.docPath) };
    case "in-bundle-reserved-md":
      return { target: path.join(bundleFromProject, "index.md"), guarded: path.join(fx.bundle, "index.md") };
    case "in-bundle-inert":
      return { target: path.join(bundleFromProject, "exported.html") };
    case "outside-alias-into-bundle-doc": {
      const alias = path.join(fx.project, "outside-alias");
      symlinkSync(fx.bundle, alias, "dir");
      return { target: path.join("outside-alias", fx.docPath), guarded: path.join(fx.bundle, fx.docPath) };
    }
    case "outside-dangling-alias-into-bundle-doc": {
      const alias = path.join(fx.project, "outside-dangling.md");
      symlinkSync(path.join(fx.bundle, "new-import.md"), alias);
      return { target: "outside-dangling.md", guarded: path.join(fx.bundle, "new-import.md") };
    }
    case "in-bundle-alias-outside-doc": {
      const outside = path.join(fx.project, "outside-target");
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, path.join(fx.bundle, "alias-out"), "dir");
      return { target: path.join(bundleFromProject, "alias-out", "exported.md") };
    }
    case "outside-bundle":
      return { target: "exported.out" };
  }
}

const SHAPES: readonly TargetShape[] = [
  "in-bundle-doc-md",
  "in-bundle-reserved-md",
  "in-bundle-inert",
  "outside-alias-into-bundle-doc",
  "outside-dangling-alias-into-bundle-doc",
  "in-bundle-alias-outside-doc",
  "outside-bundle",
];

for (const row of EGRESS_ROWS) {
  const key = `${row.leaf}${row.operation ? ` ${row.operation}` : ""} ${row.flag}`;
  test(`${key}: classifies every in-bundle target shape`, row.skip===undefined?{}:{skip:row.skip}, async () => {
    for (const shape of SHAPES) {
      const fx = row.fixture === "board" ? await boardFixture() : row.fixture === "qualified" ? qualifiedFixture() : fixture();
      try {
        const { target, guarded } = targetFor(fx, shape);
        const before = guarded && existsSync(guarded) ? readFileSync(guarded, "utf8") : undefined;
        const run = runCli(row.argv!(target), { cwd: fx.project, home: fx.home });
        const label = `${key} / ${shape}: ${run.stdout}${run.stderr}`;
        const expected = row.expect![shape];

        if (expected === "refuse") {
          assert.equal(run.status, 2, label);
          assert.match(run.stdout, /code: USAGE/, label);
          // The refusal is only worth anything if the bytes are still there.
          if (before === undefined) {
            assert.equal(existsSync(guarded!), false, `${key} / ${shape}: refused BUT created the target`);
          } else {
            assert.equal(readFileSync(guarded!, "utf8"), before, `${key} / ${shape}: refused BUT wrote anyway`);
          }
          continue;
        }

        assert.equal(run.status, 0, label);
        // Rows run under --json, so a receipt is JSON while an error envelope is always TOON. Read the
        // warning off the PARSED receipt: a substring probe would silently match neither shape.
        const receipt = JSON.parse(run.stdout) as Record<string, unknown>;
        const warned = receipt.warning !== undefined;
        if (expected === "warn") {
          assert.ok(warned, `${key} / ${shape}: wrote an in-bundle target with NO warning`);
          continue;
        }
        // silent-ok: inert or outside the bundle — a warning here would be noise, not safety.
        assert.equal(warned, false, `${key} / ${shape}: warned about a target that is not at risk`);
      } finally {
        await fx.cleanup();
      }
    }
  });
}


test("qualified inspect discovers the enclosing bundle for output admission without --dir", () => {
  const fx = qualifiedFixture();
  try {
    const result = runCli(["qualified", "inspect", "--input", "../artifact.json", "--actor", "openai/codex", "--out", "new-record.md"], { cwd: fx.bundle, home: fx.home });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /code: USAGE/);
    assert.equal(existsSync(path.join(fx.bundle, "new-record.md")), false);
  } finally {
    fx.cleanup();
  }
});
