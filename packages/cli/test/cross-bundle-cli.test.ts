/**
 * Cross-bundle links in the CLI: `status --with/--with-deps`, `link add --bundle`, `link show`'s
 * qualified table, the path/label rule, the subtree commit pin, and byte-identity for a bundle with
 * no dependencies.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initBundle, writeDoc, type Bundle } from "@superbee/core";

import { status } from "../src/commands/status.js";
import { link } from "../src/commands/link.js";
import { addCatalogEntry } from "../src/catalog.js";
import { isWithPathValue, parseWithFlags, resolveBundleBindings } from "../src/bundle-bindings.js";
import { CliError } from "../src/errors.js";
import { loadKinds, parseDependencies } from "@superbee/core";
import { recipe } from "../src/commands/recipe.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_BUNDLE = path.resolve(here, "../../../examples/sample-bundle");
const noPull = async (): Promise<void> => {};

interface Fixture {
  root: string;
  home: string;
  town: Bundle;
  beer: Bundle;
  cleanup: () => Promise<void>;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const BEER_PATH = "../../catalogs/beer/.superbee";

async function dependencies(town: Bundle, entries: Record<string, unknown>): Promise<void> {
  await writeDoc(town, {
    id: "docs/dependencies",
    frontmatter: { type: "Bundle Dependencies", title: "Dependencies", dependencies: entries },
    body: "",
  });
}

/** One git repository holding a town bundle and a beer catalog bundle, committed once. */
async function makeRepo(options: { git?: boolean; deps?: Record<string, unknown>; menuBody?: string } = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "superbee-xbundle-")));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const town = await initBundle(path.join(root, "town", ".superbee"), { okfVersion: "0.1" });
  const beer = await initBundle(path.join(root, "catalogs", "beer", ".superbee"), { okfVersion: "0.1" });
  await writeDoc(beer, { id: "docs/bundle", frontmatter: { type: "Bundle Name", title: "Beer", bundle_id: "hm-beer" }, body: "" });
  await writeDoc(beer, { id: "beers/little-whale", frontmatter: { type: "Beer", title: "Little Whale" }, body: "" });
  await dependencies(town, options.deps ?? { beers: { bundle_id: "hm-beer", path: BEER_PATH } });
  await writeDoc(town, {
    id: "menus/whale",
    frontmatter: { type: "Menu Item", title: "Whale on tap" },
    body: options.menuBody ?? "[pours](okf://beers/beers/little-whale.md)\n",
  });
  if (options.git !== false) {
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
  }
  return { root, home, town, beer, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function statusJson(fx: Fixture, extra: string[] = []): Promise<Record<string, unknown>> {
  let out = "";
  await status(["--dir", fx.town.root, "--json", ...extra], { stdout: (s) => (out += s), autoPull: noPull, home: fx.home });
  return JSON.parse(out) as Record<string, unknown>;
}

function rows(report: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const block = report[key] as { rows: Record<string, unknown>[] } | undefined;
  return block?.rows ?? [];
}

async function rejectsWith(fn: () => Promise<unknown>, code: string, match?: RegExp): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof CliError, String(err));
    assert.equal(err.code, code);
    if (match) assert.match(err.message, match);
    return true;
  });
}

// ── Byte-identity for a bundle with no dependencies and no okf: hrefs ─────────────────────────

test("golden: link show on examples/sample-bundle is byte-identical to the pre-change output (TOON and JSON)", async () => {
  let toon = "";
  await link(["show", "concepts/link-graph", "--dir", SAMPLE_BUNDLE], { stdout: (s) => (toon += s), autoPull: noPull });
  assert.equal(
    toon,
    "id: concepts/link-graph\nexists: true\noutbound_count: 3\noutbound[3]{to,text,href}:\n" +
      "  concepts/okf-alignment,OKF Alignment,./okf-alignment.md\n" +
      "  references/okf-spec,Open Knowledge Format v0.1 (Draft),../references/okf-spec.md\n" +
      "  references/okf-spec,Open Knowledge Format v0.1 (Draft),../references/okf-spec.md\n" +
      "backlink_count: 1\nbacklinks[1]{from,text}:\n  concepts/okf-alignment,The Link Graph\n",
  );
  let json = "";
  await link(["show", "concepts/link-graph", "--dir", SAMPLE_BUNDLE, "--json"], { stdout: (s) => (json += s), autoPull: noPull });
  assert.equal(
    json,
    '{"id":"concepts/link-graph","exists":true,"outbound_count":3,"outbound":[' +
      '{"to":"concepts/okf-alignment","text":"OKF Alignment","href":"./okf-alignment.md"},' +
      '{"to":"references/okf-spec","text":"Open Knowledge Format v0.1 (Draft)","href":"../references/okf-spec.md"},' +
      '{"to":"references/okf-spec","text":"Open Knowledge Format v0.1 (Draft)","href":"../references/okf-spec.md"}],' +
      '"backlink_count":1,"backlinks":[{"from":"concepts/okf-alignment","text":"The Link Graph"}]}\n',
  );
});

test("golden: status on a bundle with no dependencies carries no cross-bundle key (pins in status.test.ts cover the bytes)", async () => {
  let out = "";
  await status(["--dir", SAMPLE_BUNDLE, "--json"], { stdout: (s) => (out += s), autoPull: noPull });
  assert.ok(!/cross_bundle|dependenc/.test(out), out);
});

// ── No foreign reads without flags ────────────────────────────────────────────────────────────

test("status without --with reads nothing foreign: an unreadable sibling bundle still exits 0, links are unchecked", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs POSIX permissions as a non-root user");
  const fx = await makeRepo();
  const beerDir = path.join(fx.root, "catalogs", "beer");
  try {
    await chmod(beerDir, 0o000);
    const report = await statusJson(fx);
    assert.equal(report.cross_bundle_links, 1);
    assert.equal(report.cross_bundle_unresolved, 0);
    assert.equal(report.cross_bundle_unchecked, 1);
    assert.deepEqual(rows(report, "dependencies"), [
      { alias: "beers", bundle_id: "hm-beer", state: "unbound", bound: null, pin: null },
    ]);
    assert.equal(report.unresolved_links, 0);
  } finally {
    await chmod(beerDir, 0o755);
    await fx.cleanup();
  }
});

// ── Resolution and each reason ───────────────────────────────────────────────────────────────

test("status --with-deps binds the declared path, prints it, and resolves the link", async () => {
  const fx = await makeRepo();
  try {
    const report = await statusJson(fx, ["--with-deps"]);
    assert.equal(report.cross_bundle_links, 1);
    assert.equal(report.cross_bundle_unresolved, 0);
    assert.equal(report.cross_bundle_unchecked, 0);
    assert.deepEqual(rows(report, "dependencies"), [
      { alias: "beers", bundle_id: "hm-beer", state: "ok", bound: fx.beer.root, pin: null },
    ]);
    assert.equal(report.cross_bundle_unresolved_rows, undefined);
  } finally {
    await fx.cleanup();
  }
});

test("each local reason appears in cross_bundle_unresolved_rows; a malformed okf: href is counted once", async () => {
  const other = await initBundle(await mkdtemp(path.join(tmpdir(), "superbee-xbundle-other-")), { okfVersion: "0.1" });
  await writeDoc(other, { id: "docs/bundle", frontmatter: { type: "Bundle Name", title: "Other", bundle_id: "not-beer" }, body: "" });
  const fx = await makeRepo({
    deps: {
      beers: { bundle_id: "hm-beer", path: BEER_PATH },
      wrong: { bundle_id: "hm-wrong" },
      pinned: { bundle_id: "hm-beer-pinned", pin: "sha256:" + "0".repeat(64) },
    },
    menuBody: [
      "[pours](okf://beers/beers/little-whale.md)",
      "[pours](okf://beers/beers/missing.md)",
      "[pours](okf://nobody/beers/x.md)",
      "[pours](okf://Beers/x.md)",
      "[n](okf:beers/y.md)",
      "[pours](okf://wrong/beers/x.md)",
      "[pours](okf://pinned/beers/x.md)",
      "",
    ].join("\n"),
  });
  try {
    const pinnedCopy = await initBundle(path.join(fx.root, "pinned"), { okfVersion: "0.1" });
    await writeDoc(pinnedCopy, { id: "docs/bundle", frontmatter: { type: "Bundle Name", title: "P", bundle_id: "hm-beer-pinned" }, body: "" });
    const report = await statusJson(fx, ["--with-deps", "--with", `wrong=${other.root}`, "--with", `pinned=${pinnedCopy.root}`]);
    const reasons = rows(report, "cross_bundle_unresolved_rows").map((r) => [r.href, r.reason]);
    assert.deepEqual(reasons, [
      ["okf://beers/beers/missing.md", "target_missing"],
      ["okf://nobody/beers/x.md", "unknown_alias"],
      ["okf://Beers/x.md", "invalid_ref"],
      ["okf:beers/y.md", "invalid_ref"],
      ["okf://wrong/beers/x.md", "bundle_unavailable"],
      ["okf://pinned/beers/x.md", "pin_mismatch"],
    ]);
    assert.equal(report.cross_bundle_links, 7);
    assert.equal(report.cross_bundle_unresolved, 6);
    // The `okf:beers/y.md` typo is not also a local unresolved link.
    assert.equal(report.unresolved_links, 0);
    assert.equal(report.link_type_violations, 0);
    const deps = Object.fromEntries(rows(report, "dependencies").map((r) => [r.alias, r.state]));
    assert.deepEqual(deps, { beers: "ok", wrong: "bundle_unavailable", pinned: "pin_mismatch" });
  } finally {
    await fx.cleanup();
    await rm(other.root, { recursive: true, force: true });
  }
});

// ── --with-deps reach and declaration defects ─────────────────────────────────────────────────

test("--with-deps never binds a declared path outside the repository; absolute POSIX and Windows paths are rejected", async () => {
  const outside = await initBundle(await mkdtemp(path.join(tmpdir(), "superbee-xbundle-outside-")), { okfVersion: "0.1" });
  const fx = await makeRepo();
  try {
    // `far` climbs out of the repository from the town's real root.
    await dependencies(fx.town, {
      beers: { bundle_id: "hm-beer", path: BEER_PATH },
      far: { bundle_id: "hm-far", path: path.relative(fx.town.root, outside.root).split(path.sep).join("/") },
      posix: { bundle_id: "hm-posix", path: "/etc/beer" },
      windows: { bundle_id: "hm-windows", path: "C:\\beer" },
      drive: { bundle_id: "hm-drive", path: "C:/beer" },
    });
    const report = await statusJson(fx, ["--with-deps"]);
    const problems = rows(report, "dependency_problems").map((r) => [r.code, r.alias]);
    assert.deepEqual(problems.sort(), [
      ["BIND_OUTSIDE_REPO", "far"],
      ["DEP_PATH_ABSOLUTE", "drive"],
      ["DEP_PATH_ABSOLUTE", "posix"],
      ["DEP_PATH_ABSOLUTE", "windows"],
    ].sort());
    const far = rows(report, "dependency_problems").find((r) => r.alias === "far")!;
    assert.equal(far.detail, "path outside repository");
    const states = Object.fromEntries(rows(report, "dependencies").map((r) => [r.alias, [r.state, r.bound]]));
    assert.deepEqual(states.far, ["unbound", null]);
    assert.deepEqual(states.beers, ["ok", fx.beer.root]);
  } finally {
    await fx.cleanup();
    await rm(outside.root, { recursive: true, force: true });
  }
});

test("--with-deps outside any git repository is a USAGE error pointing at --with", async () => {
  const fx = await makeRepo({ git: false });
  try {
    await rejectsWith(() => statusJson(fx, ["--with-deps"]), "USAGE", /git repository/);
  } finally {
    await fx.cleanup();
  }
});

// ── Path or label ────────────────────────────────────────────────────────────────────────────

test("a --with value is a path when it has a separator, a leading . or ~, or a drive; otherwise a label", () => {
  for (const value of ["./x", "x/y", "x\\y", ".", "..", "~", "~/beer", ".beer", "C:", "C:\\beer", "d:/beer"]) {
    assert.equal(isWithPathValue(value), true, value);
  }
  for (const value of ["beers", "beer-catalog", "catalogs", "b.c"]) {
    assert.equal(isWithPathValue(value), false, value);
  }
  assert.deepEqual([...parseWithFlags(["beers=./x"])], [["beers", "./x"]]);
  assert.throws(() => parseWithFlags(["beers"]), CliError);
  assert.throws(() => parseWithFlags(["Ales=./z"]), CliError);
  assert.throws(() => parseWithFlags(["beers=./x", "beers=./y"]), CliError);
});

test("a bare --with value resolves as a catalog label; one that is also a directory here is refused as ambiguous", async () => {
  const fx = await makeRepo();
  try {
    await addCatalogEntry("beers", fx.beer.root, { home: fx.home });
    const { dependencies: deps } = parseDependencies({
      id: "docs/dependencies",
      frontmatter: { type: "Bundle Dependencies", dependencies: { beers: { bundle_id: "hm-beer" } } },
      body: "",
    });
    const elsewhere = path.join(fx.root, "elsewhere");
    await mkdir(elsewhere);
    const bound = await resolveBundleBindings({
      referringRoot: fx.town.root, dependencies: deps, withValues: ["beers=beers"], withDeps: false, cwd: elsewhere, home: fx.home,
    });
    assert.equal(bound.bound.get("beers")?.root, fx.beer.root);
    assert.equal(bound.bindings.get("beers")?.identity, "hm-beer");

    const ambiguous = path.join(fx.root, "ambiguous");
    await mkdir(path.join(ambiguous, "beers"), { recursive: true });
    await rejectsWith(
      () => resolveBundleBindings({ referringRoot: fx.town.root, dependencies: deps, withValues: ["beers=beers"], withDeps: false, cwd: ambiguous, home: fx.home }),
      "USAGE",
      /ambiguous/,
    );
    // The path spelling of the same directory is never a label.
    const asPath = await resolveBundleBindings({
      referringRoot: fx.town.root, dependencies: deps, withValues: [`beers=./${path.relative(elsewhere, fx.beer.root)}`], withDeps: false, cwd: elsewhere, home: fx.home,
    });
    assert.equal(asPath.bound.get("beers")?.root, fx.beer.root);
    await rejectsWith(
      () => resolveBundleBindings({ referringRoot: fx.town.root, dependencies: deps, withValues: ["nope=./x"], withDeps: false, cwd: elsewhere, home: fx.home }),
      "USAGE",
      /does not declare/,
    );
  } finally {
    await fx.cleanup();
  }
});

// ── Subtree commit pins: two bundles in one repository ────────────────────────────────────────

test("commit pin: a commit touching only the other bundle keeps it; a commit or an uncommitted edit in the pinned subtree is pin_mismatch", async () => {
  const fx = await makeRepo();
  try {
    const pin = git(fx.root, "rev-parse", "HEAD");
    await dependencies(fx.town, { beers: { bundle_id: "hm-beer", path: BEER_PATH, pin } });
    await writeDoc(fx.town, { id: "menus/other", frontmatter: { type: "Menu Item", title: "Other" }, body: "" });
    git(fx.root, "add", "-A");
    git(fx.root, "commit", "-q", "-m", "town only");

    let report = await statusJson(fx, ["--with-deps"]);
    assert.equal(rows(report, "dependencies")[0]!.state, "ok");
    assert.equal(report.cross_bundle_unresolved, 0);

    // An uncommitted edit inside the pinned subtree.
    const beerDoc = path.join(fx.beer.root, "beers", "little-whale.md");
    const original = await readFile(beerDoc, "utf8");
    await writeFile(beerDoc, original + "\nedited\n");
    report = await statusJson(fx, ["--with-deps"]);
    assert.equal(rows(report, "dependencies")[0]!.state, "pin_mismatch");
    assert.deepEqual(rows(report, "cross_bundle_unresolved_rows").map((r) => r.reason), ["pin_mismatch"]);
    assert.match(String(rows(report, "cross_bundle_unresolved_rows")[0]!.detail), /uncommitted/);

    // The same edit, committed.
    git(fx.root, "add", "-A");
    git(fx.root, "commit", "-q", "-m", "beer edit");
    report = await statusJson(fx, ["--with-deps"]);
    assert.equal(rows(report, "dependencies")[0]!.state, "pin_mismatch");
    assert.match(String(rows(report, "cross_bundle_unresolved_rows")[0]!.detail), /differs from pin/);
  } finally {
    await fx.cleanup();
  }
});

// ── Link types with qualified targets ─────────────────────────────────────────────────────────

async function menuKind(town: Bundle): Promise<void> {
  await writeDoc(town, {
    id: "conventions/menu-item",
    frontmatter: {
      type: "Convention",
      title: "Menu Item",
      governs: "Menu Item",
      fields: { required: ["title"], optional: [] },
      links: { pours: "beers:Beer" },
    },
    body: "",
  });
}

test("link types: a qualified edge under its alias conforms; another alias and a local link under beers:Beer are violations", async () => {
  const fx = await makeRepo({
    menuBody: "[pours](okf://beers/beers/little-whale.md)\n[pours](okf://elsewhere/beers/x.md)\n[pours](../menus/local.md)\n",
  });
  try {
    await menuKind(fx.town);
    await writeDoc(fx.town, { id: "menus/local", frontmatter: { type: "Beer", title: "Local" }, body: "" });
    const report = await statusJson(fx);
    assert.deepEqual(rows(report, "cross_bundle_link_type_violations_rows"), [
      { from: "menus/whale", href: "../menus/local.md", text: "pours", expected: "Menu Item -> beers:Beer" },
      { from: "menus/whale", href: "okf://elsewhere/beers/x.md", text: "pours", expected: "Menu Item -> beers:Beer" },
    ]);
    assert.equal(report.link_type_violations, 0);
  } finally {
    await fx.cleanup();
  }
});

test("recipe evolve adds links: {pours: \"beers:Beer\"} to an installed Menu Item convention", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "superbee-xbundle-recipe-")));
  const bundleDir = path.join(root, "bundle");
  const recipeDir = path.join(root, "recipe");
  const conventionPath = path.join(recipeDir, "conventions", "menu-item.md");
  const manifest = (version: string) =>
    `---\ntype: Recipe\nid: menus\ntitle: Menus\nversion: "${version}"\nsummary: Menu items.\n---\n`;
  const convention = (withLinks: boolean) =>
    "---\ntype: Convention\ntitle: Menu Item\ngoverns: Menu Item\npath: menus/\nfields:\n  required: [title]\n  optional: []\n" +
    (withLinks ? "links:\n  pours: \"beers:Beer\"\n" : "") +
    "---\n# Menu Item\n";
  const run = async (argv: string[]): Promise<Record<string, unknown>> => {
    let out = "";
    await recipe([...argv, "--json"], { stdout: (s: string) => (out += s) });
    return JSON.parse(out) as Record<string, unknown>;
  };
  try {
    await initBundle(bundleDir);
    await mkdir(path.dirname(conventionPath), { recursive: true });
    await writeFile(path.join(recipeDir, "recipe.md"), manifest("1"), "utf8");
    await writeFile(conventionPath, convention(false), "utf8");
    await run(["add", recipeDir, "--dir", bundleDir]);
    await writeFile(path.join(recipeDir, "recipe.md"), manifest("2"), "utf8");
    await writeFile(conventionPath, convention(true), "utf8");
    const plan = await run(["evolve", recipeDir, "--dir", bundleDir]);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers ?? plan));
    const applied = await run(["evolve", recipeDir, "--dir", bundleDir, "--apply", String(plan.plan_token)]);
    assert.equal(applied.changed, true);
    const kind = (await loadKinds({ root: bundleDir })).kinds.get("Menu Item");
    assert.deepEqual(kind?.links, { pours: "beers:Beer" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── link add --bundle and link show ───────────────────────────────────────────────────────────

async function runLink(argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await link([...argv, "--json"], { stdout: (s) => (out += s), autoPull: noPull });
  return JSON.parse(out) as Record<string, unknown>;
}

test("link add --bundle writes an okf:// link idempotently, warns on an undeclared alias, refuses a malformed target", async () => {
  const fx = await makeRepo({ menuBody: "" });
  try {
    const added = await runLink(["add", "menus/whale", "beers/little-whale", "--bundle", "beers", "--text", "pours", "--dir", fx.town.root]);
    assert.equal(added.changed, true);
    assert.equal(added.href, "okf://beers/beers/little-whale.md");
    assert.equal(added.warnings, undefined);
    const body = await readFile(path.join(fx.town.root, "menus", "whale.md"), "utf8");
    assert.match(body, /\[pours\]\(okf:\/\/beers\/beers\/little-whale\.md\)/);

    const again = await runLink(["add", "menus/whale", "okf://beers/beers/little-whale.md", "--text", "pours", "--dir", fx.town.root]);
    assert.equal(again.changed, false);

    const undeclared = await runLink(["add", "menus/whale", "x/y", "--bundle", "ghost", "--dir", fx.town.root]);
    assert.deepEqual((undeclared.warnings as { code: string }[]).map((w) => w.code), ["LINK_ALIAS_UNDECLARED"]);

    await rejectsWith(() => runLink(["add", "menus/whale", "../x", "--bundle", "beers", "--dir", fx.town.root]), "USAGE");
    await rejectsWith(() => runLink(["add", "menus/whale", "x", "--bundle", "Beers", "--dir", fx.town.root]), "USAGE");
    await rejectsWith(() => runLink(["add", "menus/whale", "okf://beers/index.md", "--dir", fx.town.root]), "USAGE");
  } finally {
    await fx.cleanup();
  }
});

test("link add --bundle warns LINK_TYPE_VIOLATION when the declared target names another alias", async () => {
  const fx = await makeRepo({ menuBody: "" });
  try {
    await menuKind(fx.town);
    await dependencies(fx.town, { beers: { bundle_id: "hm-beer" }, wines: { bundle_id: "hm-wine" } });
    const added = await runLink(["add", "menus/whale", "w/x", "--bundle", "wines", "--text", "pours", "--dir", fx.town.root]);
    assert.deepEqual((added.warnings as { code: string }[]).map((w) => w.code), ["LINK_TYPE_VIOLATION"]);
  } finally {
    await fx.cleanup();
  }
});

test("link show lists qualified links in their own table; outbound_count stays local; --with adds state and reason", async () => {
  const fx = await makeRepo({
    menuBody: "[pours](okf://beers/beers/little-whale.md)\n[pours](okf://beers/beers/gone.md)\n[local](../menus/whale.md)\n",
  });
  try {
    const plain = await runLink(["show", "menus/whale", "--dir", fx.town.root]);
    assert.equal(plain.outbound_count, 1);
    assert.equal(plain.qualified_outbound_count, 2);
    assert.deepEqual(plain.qualified_outbound, [
      { text: "pours", bundle: "beers", href: "okf://beers/beers/little-whale.md" },
      { text: "pours", bundle: "beers", href: "okf://beers/beers/gone.md" },
    ]);
    const bound = await runLink(["show", "menus/whale", "--with-deps", "--dir", fx.town.root]);
    assert.deepEqual(
      (bound.qualified_outbound as Record<string, unknown>[]).map((r) => [r.state, r.reason]),
      [["resolved", null], ["unresolved", "target_missing"]],
    );
  } finally {
    await fx.cleanup();
  }
});

// ── Review fixes: pin dirty check independent of git config, GIT_MISSING, link list, link show home ──

async function pinnedRepo(): Promise<Fixture> {
  const fx = await makeRepo();
  const pin = git(fx.root, "rev-parse", "HEAD");
  await dependencies(fx.town, { beers: { bundle_id: "hm-beer", path: BEER_PATH, pin } });
  git(fx.root, "add", "-A");
  git(fx.root, "commit", "-q", "-m", "pin");
  return fx;
}

test("commit pin: an untracked file in the pinned subtree is pin_mismatch even with status.showUntrackedFiles=no", async () => {
  const fx = await pinnedRepo();
  try {
    assert.equal(rows(await statusJson(fx, ["--with-deps"]), "dependencies")[0]!.state, "ok");
    git(fx.root, "config", "status.showUntrackedFiles", "no");
    await writeFile(path.join(fx.beer.root, "beers", "new.md"), "---\ntype: Beer\ntitle: New\n---\n");
    assert.equal(git(fx.root, "status", "--porcelain"), "", "the user's config hides the untracked file");
    const report = await statusJson(fx, ["--with-deps"]);
    assert.equal(rows(report, "dependencies")[0]!.state, "pin_mismatch");
    assert.deepEqual(rows(report, "cross_bundle_unresolved_rows").map((r) => r.reason), ["pin_mismatch"]);
  } finally {
    await fx.cleanup();
  }
});

test("commit pin: a gitignored .md file in the pinned subtree is pin_mismatch", async () => {
  const fx = await pinnedRepo();
  try {
    await writeFile(path.join(fx.root, ".gitignore"), "secret.md\n");
    git(fx.root, "add", ".gitignore");
    git(fx.root, "commit", "-q", "-m", "ignore");
    assert.equal(rows(await statusJson(fx, ["--with-deps"]), "dependencies")[0]!.state, "ok");
    await writeFile(path.join(fx.beer.root, "beers", "secret.md"), "---\ntype: Beer\ntitle: Hidden\n---\n");
    assert.equal(git(fx.root, "status", "--porcelain"), "", "the file is ignored");
    const report = await statusJson(fx, ["--with-deps"]);
    assert.equal(rows(report, "dependencies")[0]!.state, "pin_mismatch");
  } finally {
    await fx.cleanup();
  }
});

test("without git, the pin check and --with-deps fail closed with GIT_MISSING", async () => {
  const fx = await pinnedRepo();
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = path.join(fx.root, "no-such-bin");
    const deps = await statusJson(fx, ["--with-deps"]);
    assert.deepEqual(rows(deps, "dependency_problems").map((r) => [r.code, r.alias]), [["GIT_MISSING", "beers"]]);
    assert.match(String(rows(deps, "dependency_problems")[0]!.detail), /GIT_MISSING/);
    assert.equal(rows(deps, "dependencies")[0]!.state, "unbound");

    const pinned = await statusJson(fx, ["--with", `beers=${fx.beer.root}`]);
    assert.equal(rows(pinned, "dependencies")[0]!.state, "pin_mismatch");
    assert.match(String(rows(pinned, "cross_bundle_unresolved_rows")[0]!.detail), /^GIT_MISSING/);
  } finally {
    process.env.PATH = savedPath;
    await fx.cleanup();
  }
});

test("link list and link show never show a malformed okf: href as a local edge", async () => {
  const fx = await makeRepo({ menuBody: "[pours](okf:beers/whale.md)\n[local](../menus/whale.md)\n" });
  try {
    const listed = await runLink(["list", "--dir", fx.town.root]);
    assert.deepEqual(listed.edges, [{ from: "menus/whale", to: "menus/whale", text: "local" }]);
    assert.equal(listed.count, 1);
    const shown = await runLink(["show", "menus/whale", "--dir", fx.town.root]);
    assert.equal(shown.outbound_count, 1);
    assert.deepEqual(shown.qualified_outbound, [{ text: "pours", bundle: null, href: "okf:beers/whale.md" }]);
  } finally {
    await fx.cleanup();
  }
});

test("link show --with resolves a catalog label from the home it is given", async () => {
  const fx = await makeRepo();
  try {
    await addCatalogEntry("beer-catalog", fx.beer.root, { home: fx.home });
    let out = "";
    await link(["show", "menus/whale", "--with", "beers=beer-catalog", "--dir", fx.town.root, "--json"], {
      stdout: (s) => (out += s),
      autoPull: noPull,
      home: fx.home,
    });
    const shown = JSON.parse(out) as Record<string, unknown>;
    assert.deepEqual((shown.qualified_outbound as Record<string, unknown>[]).map((r) => r.state), ["resolved"]);
  } finally {
    await fx.cleanup();
  }
});
