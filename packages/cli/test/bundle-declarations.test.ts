/**
 * `bundle id set` and `deps add|remove|list`: the dedicated writers for the two documents no Kind
 * governs, `docs/bundle` (bundle_id) and `docs/dependencies`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  declaredBundleId,
  initBundle,
  mutationActorFromFrontmatter,
  parseDependencies,
  readDoc,
  VersionConflict,
  writeDoc,
  type Bundle,
} from "@superbee/core";

import { bundleCommand } from "../src/commands/bundle.js";
import { deps, depsAddRerun } from "../src/commands/deps.js";
import { link } from "../src/commands/link.js";
import { status } from "../src/commands/status.js";
import { declarationErrorHooks } from "../src/declaration-writes.js";
import { CliError } from "../src/errors.js";

const noPull = async (): Promise<void> => {};

interface Fixture {
  root: string;
  bundle: Bundle;
  cleanup: () => Promise<void>;
}

async function fixture(okfVersion: "0.1" | "0.2" = "0.1"): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "superbee-decl-")));
  const bundle = await initBundle(path.join(root, "town", ".superbee"), { okfVersion });
  return { root, bundle, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function run(fn: (argv: string[], deps: { stdout: (s: string) => void }) => Promise<void>, argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await fn([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

const bundleId = (fx: Fixture, ...args: string[]) => run(bundleCommand, ["id", "set", ...args, "--dir", fx.bundle.root]);
const depsAdd = (fx: Fixture, ...args: string[]) => run(deps, ["add", ...args, "--dir", fx.bundle.root]);
const depsRemove = (fx: Fixture, ...args: string[]) => run(deps, ["remove", ...args, "--dir", fx.bundle.root]);
const depsList = (fx: Fixture, ...args: string[]) =>
  (async () => {
    let out = "";
    await deps(["list", ...args, "--dir", fx.bundle.root, "--json"], { stdout: (s) => (out += s), autoPull: noPull });
    return JSON.parse(out) as Record<string, unknown>;
  })();

async function rejectsWith(fn: () => Promise<unknown>, code: string, reason?: string): Promise<CliError> {
  let caught: CliError | undefined;
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof CliError, String(err));
    assert.equal(err.code, code, err.message);
    if (reason !== undefined) assert.equal(err.details?.reason, reason, err.message);
    caught = err;
    return true;
  });
  return caught!;
}

async function depsDoc(fx: Fixture) {
  return readDoc(fx.bundle, "docs/dependencies");
}

// ── bundle id set ─────────────────────────────────────────────────────────────────────────────

test("bundle id set creates docs/bundle when missing, under the marker type core reads", async () => {
  const fx = await fixture();
  try {
    const receipt = await bundleId(fx, "hm-town");
    assert.equal(receipt.bundle_id, "hm-town");
    assert.equal(receipt.result, "created");
    assert.equal(receipt.changed, true);
    assert.equal(receipt.previous, null);
    assert.equal(typeof receipt.version, "string");
    const doc = await readDoc(fx.bundle, "docs/bundle");
    assert.equal(doc.frontmatter.type, "Bundle Name");
    assert.equal(declaredBundleId(doc), "hm-town");
  } finally {
    await fx.cleanup();
  }
});

test("bundle id set on an existing docs/bundle changes only bundle_id; the same id again is a no-op", async () => {
  const fx = await fixture();
  try {
    await writeDoc(fx.bundle, {
      id: "docs/bundle",
      frontmatter: { type: "Bundle Name", title: "Fairport", name: "Here & Main", custom_key: { nested: ["a", "b"] } },
      body: "Our town.\n",
    });
    const receipt = await bundleId(fx, "hm-fairport");
    assert.equal(receipt.result, "updated");
    const doc = await readDoc(fx.bundle, "docs/bundle");
    assert.equal(doc.frontmatter.title, "Fairport");
    assert.equal(doc.frontmatter.name, "Here & Main");
    assert.deepEqual(doc.frontmatter.custom_key, { nested: ["a", "b"] });
    assert.equal(doc.body.trim(), "Our town.");
    assert.equal(declaredBundleId(doc), "hm-fairport");

    const again = await bundleId(fx, "hm-fairport");
    assert.equal(again.result, "unchanged");
    assert.equal(again.changed, false);
    assert.equal(again.version, receipt.version);
  } finally {
    await fx.cleanup();
  }
});

test("bundle id set refuses a different existing id without --force, and replaces it with --force", async () => {
  const fx = await fixture();
  try {
    await bundleId(fx, "hm-old");
    const err = await rejectsWith(() => bundleId(fx, "hm-new"), "CONFLICT", "BUNDLE_ID_DIFFERS");
    assert.equal(err.details?.current, "hm-old");
    assert.equal(declaredBundleId(await readDoc(fx.bundle, "docs/bundle")), "hm-old");
    const forced = await bundleId(fx, "hm-new", "--force");
    assert.equal(forced.result, "updated");
    assert.equal(forced.previous, "hm-old");
    assert.equal(declaredBundleId(await readDoc(fx.bundle, "docs/bundle")), "hm-new");
  } finally {
    await fx.cleanup();
  }
});

test("bundle id set refuses an id outside the bundle-id grammar and a docs/bundle of another type", async () => {
  const fx = await fixture();
  try {
    for (const bad of ["Upper-Case", "9starts-with-digit", "trailing-", "has space", "a".repeat(129), ""]) {
      await rejectsWith(() => bundleId(fx, bad), "USAGE", "BUNDLE_ID");
    }
    await assert.rejects(() => readDoc(fx.bundle, "docs/bundle"));
    await writeDoc(fx.bundle, { id: "docs/bundle", frontmatter: { type: "Note", title: "About this bundle" }, body: "" });
    await rejectsWith(() => bundleId(fx, "hm-town"), "CONFLICT", "BUNDLE_DOC_TYPE");
    assert.equal((await readDoc(fx.bundle, "docs/bundle")).frontmatter.bundle_id, undefined);
  } finally {
    await fx.cleanup();
  }
});

test("bundle id set attributes the write and honors --expected-version", async () => {
  const fx = await fixture();
  try {
    const first = await bundleId(fx, "hm-town", "--actor", "human:mike");
    assert.equal(mutationActorFromFrontmatter((await readDoc(fx.bundle, "docs/bundle")).frontmatter), "human:mike");
    const stale = await rejectsWith(() => bundleId(fx, "hm-other", "--force", "--expected-version", "not-the-version"), "STALE_HEAD");
    assert.equal(stale.details?.actual, first.version);
    assert.equal(declaredBundleId(await readDoc(fx.bundle, "docs/bundle")), "hm-town");
    const ok = await bundleId(fx, "hm-other", "--force", "--expected-version", String(first.version));
    assert.equal(ok.changed, true);
    await rejectsWith(() => bundleId(fx, "hm-third", "--force", "--expected-version", " "), "USAGE");
  } finally {
    await fx.cleanup();
  }
});

// ── deps add ──────────────────────────────────────────────────────────────────────────────────

test("deps add creates docs/dependencies when missing, and core parses the entry back", async () => {
  const fx = await fixture();
  try {
    const receipt = await depsAdd(fx, "beers", "--bundle-id", "hm-beer", "--source", "hosted:example.test/hm-beer", "--pin", "1234567", "--path", "../../catalogs/beer/.superbee");
    assert.deepEqual(
      { dependency: receipt.dependency, alias: receipt.alias, bundle_id: receipt.bundle_id, pin: receipt.pin, path: receipt.path, created: receipt.created, changed: receipt.changed },
      { dependency: "added", alias: "beers", bundle_id: "hm-beer", pin: "1234567", path: "../../catalogs/beer/.superbee", created: true, changed: true },
    );
    const doc = await depsDoc(fx);
    assert.equal(doc.frontmatter.type, "Bundle Dependencies");
    const parsed = parseDependencies(doc);
    assert.deepEqual(parsed.problems, []);
    // A numeric-looking pin stays a string through YAML, so the parser still accepts it.
    assert.deepEqual(parsed.dependencies.get("beers"), {
      alias: "beers",
      bundle_id: "hm-beer",
      source: "hosted:example.test/hm-beer",
      pin: { kind: "commit", value: "1234567" },
      path: "../../catalogs/beer/.superbee",
    });
    const raw = await readFile(path.join(fx.bundle.root, "docs", "dependencies.md"), "utf8");
    assert.match(raw, /pin: ['"]1234567['"]/);
  } finally {
    await fx.cleanup();
  }
});

test("deps add updates an existing document and round-trips every key it does not own", async () => {
  const fx = await fixture();
  try {
    await writeDoc(fx.bundle, {
      id: "docs/dependencies",
      frontmatter: {
        type: "Bundle Dependencies",
        title: "Our dependencies",
        future_top_level: { mirrors: ["a", "b"] },
        dependencies: { parks: { bundle_id: "hm-parks", note: "kept", tags_like: ["x", "y"] } },
      },
      body: "Why we depend on these.\n",
    });
    const receipt = await depsAdd(fx, "beers", "--bundle-id", "hm-beer");
    assert.equal(receipt.dependency, "added");
    assert.equal(receipt.created, false);
    const doc = await depsDoc(fx);
    assert.equal(doc.frontmatter.title, "Our dependencies");
    assert.deepEqual(doc.frontmatter.future_top_level, { mirrors: ["a", "b"] });
    assert.deepEqual(doc.frontmatter.dependencies, {
      parks: { bundle_id: "hm-parks", note: "kept", tags_like: ["x", "y"] },
      beers: { bundle_id: "hm-beer" },
    });
    assert.equal(doc.body.trim(), "Why we depend on these.");

    // --replace sets exactly the given fields and keeps the entry's unknown keys.
    const replaced = await depsAdd(fx, "parks", "--bundle-id", "hm-parks-2", "--replace");
    assert.equal(replaced.dependency, "replaced");
    assert.deepEqual((await depsDoc(fx)).frontmatter.dependencies, {
      parks: { bundle_id: "hm-parks-2", note: "kept", tags_like: ["x", "y"] },
      beers: { bundle_id: "hm-beer" },
    });
    // Its unknown keys were already reported before this write, so --replace does not warn again.
    assert.equal(replaced.warnings, undefined);

    const same = await depsAdd(fx, "beers", "--bundle-id", "hm-beer");
    assert.equal(same.dependency, "unchanged");
    assert.equal(same.changed, false);
  } finally {
    await fx.cleanup();
  }
});

test("deps add refuses every input the dependency parser would drop (USAGE), writing nothing", async () => {
  const fx = await fixture();
  try {
    const cases: [string[], string][] = [
      [["Beers", "--bundle-id", "hm-beer"], "DEP_ALIAS"],
      [["1beers", "--bundle-id", "hm-beer"], "DEP_ALIAS"],
      [["beers", "--bundle-id", "HM-Beer"], "DEP_BUNDLE_ID"],
      [["beers", "--bundle-id", ""], "DEP_BUNDLE_ID"],
      [["beers", "--bundle-id", "hm-beer", "--pin", "ABCDEF1"], "DEP_PIN"],
      [["beers", "--bundle-id", "hm-beer", "--pin", "abc12"], "DEP_PIN"],
      [["beers", "--bundle-id", "hm-beer", "--pin", "sha256:short"], "DEP_PIN"],
      [["beers", "--bundle-id", "hm-beer", "--path", "/srv/bundles/beer"], "DEP_PATH_ABSOLUTE"],
      [["beers", "--bundle-id", "hm-beer", "--path", "D:\\bundles\\beer"], "DEP_PATH_ABSOLUTE"],
      [["beers", "--bundle-id", "hm-beer", "--path", "E:/catalogs/beer"], "DEP_PATH_ABSOLUTE"],
      [["beers", "--bundle-id", "hm-beer", "--path", "\\\\server\\share"], "DEP_PATH_ABSOLUTE"],
      [["beers", "--bundle-id", "hm-beer", "--path", "..\\sibling"], "DEP_PATH_ABSOLUTE"],
      [["beers", "--bundle-id", "hm-beer", "--path", " "], "DEP_SHAPE"],
      [["beers", "--bundle-id", "hm-beer", "--source", ""], "DEP_SHAPE"],
    ];
    for (const [args, reason] of cases) {
      await rejectsWith(() => depsAdd(fx, ...args), "USAGE", reason);
    }
    await rejectsWith(() => depsAdd(fx, "beers"), "USAGE");
    await assert.rejects(() => depsDoc(fx), "no refusal may create the document");
  } finally {
    await fx.cleanup();
  }
});

test("deps add refuses what the bundle's own state forbids (CONFLICT): self, duplicate id, existing alias, reserved key, foreign doc", async () => {
  const fx = await fixture();
  try {
    await bundleId(fx, "hm-town");
    await rejectsWith(() => depsAdd(fx, "me", "--bundle-id", "hm-town"), "CONFLICT", "DEP_SELF");
    await depsAdd(fx, "beers", "--bundle-id", "hm-beer");
    await rejectsWith(() => depsAdd(fx, "ales", "--bundle-id", "hm-beer"), "CONFLICT", "DEP_DUPLICATE_BUNDLE");
    const exists = await rejectsWith(() => depsAdd(fx, "beers", "--bundle-id", "hm-ale"), "CONFLICT", "DEP_ALIAS_EXISTS");
    assert.deepEqual(exists.details?.current, { bundle_id: "hm-beer" });
    assert.deepEqual((await depsDoc(fx)).frontmatter.dependencies, { beers: { bundle_id: "hm-beer" } });

    const doc = await depsDoc(fx);
    await writeDoc(fx.bundle, {
      ...doc,
      frontmatter: { ...doc.frontmatter, dependencies: { beers: { bundle_id: "hm-beer", version: "1" } } },
    });
    await rejectsWith(() => depsAdd(fx, "beers", "--bundle-id", "hm-ale", "--replace"), "CONFLICT", "DEP_RESERVED_KEY");
    // A pre-existing defect on another alias never blocks an unrelated declaration.
    const unrelated = await depsAdd(fx, "parks", "--bundle-id", "hm-parks");
    assert.equal(unrelated.dependency, "added");
  } finally {
    await fx.cleanup();
  }

  const foreign = await fixture();
  try {
    await writeDoc(foreign.bundle, { id: "docs/dependencies", frontmatter: { type: "Note", title: "Notes on deps" }, body: "" });
    await rejectsWith(() => depsAdd(foreign, "beers", "--bundle-id", "hm-beer"), "CONFLICT", "DEP_TYPE");
    await writeDoc(foreign.bundle, { id: "docs/dependencies", frontmatter: { type: "Bundle Dependencies", dependencies: ["beers"] }, body: "" });
    await rejectsWith(() => depsAdd(foreign, "beers", "--bundle-id", "hm-beer"), "CONFLICT", "DEP_SHAPE");
  } finally {
    await foreign.cleanup();
  }
});

test("deps add attributes through SUPERBEE_ACTOR (v0.2) and refuses a stale --expected-version", async () => {
  const fx = await fixture("0.2");
  const saved = process.env.SUPERBEE_ACTOR;
  try {
    process.env.SUPERBEE_ACTOR = "process:deps-test";
    const first = await depsAdd(fx, "beers", "--bundle-id", "hm-beer");
    assert.equal(mutationActorFromFrontmatter((await depsDoc(fx)).frontmatter), "process:deps-test");

    const second = await depsAdd(fx, "parks", "--bundle-id", "hm-parks", "--actor", "human:mike", "--expected-version", String(first.version));
    assert.equal(second.changed, true);
    assert.equal(mutationActorFromFrontmatter((await depsDoc(fx)).frontmatter), "human:mike");

    await rejectsWith(() => depsAdd(fx, "ales", "--bundle-id", "hm-ales", "--expected-version", String(first.version)), "STALE_HEAD");
    await rejectsWith(() => depsRemove(fx, "beers", "--expected-version", String(first.version)), "STALE_HEAD");
    assert.deepEqual([...parseDependencies(await depsDoc(fx)).dependencies.keys()], ["beers", "parks"]);
    // A v0.2 bundle accepts only an OKF actor.
    await rejectsWith(() => depsAdd(fx, "ales", "--bundle-id", "hm-ales", "--actor", "not an okf actor"), "USAGE");
  } finally {
    if (saved === undefined) delete process.env.SUPERBEE_ACTOR;
    else process.env.SUPERBEE_ACTOR = saved;
    await fx.cleanup();
  }
});

// ── deps remove / list ────────────────────────────────────────────────────────────────────────

test("deps remove drops one entry and keeps the rest; an undeclared alias or a missing document is a no-op", async () => {
  const fx = await fixture();
  try {
    const none = await depsRemove(fx, "beers");
    assert.deepEqual({ dependency: none.dependency, removed: none.removed, changed: none.changed }, { dependency: "absent", removed: false, changed: false });

    await writeDoc(fx.bundle, {
      id: "docs/dependencies",
      frontmatter: { type: "Bundle Dependencies", keep_me: [1, 2], dependencies: { beers: { bundle_id: "hm-beer" }, parks: { bundle_id: "hm-parks", extra: ["z"] } } },
      body: "",
    });
    const removed = await depsRemove(fx, "beers", "--actor", "human:mike");
    assert.deepEqual({ dependency: removed.dependency, removed: removed.removed, changed: removed.changed }, { dependency: "removed", removed: true, changed: true });
    const doc = await depsDoc(fx);
    assert.deepEqual(doc.frontmatter.dependencies, { parks: { bundle_id: "hm-parks", extra: ["z"] } });
    assert.deepEqual(doc.frontmatter.keep_me, [1, 2]);
    assert.equal(mutationActorFromFrontmatter(doc.frontmatter), "human:mike");

    const again = await depsRemove(fx, "beers");
    assert.equal(again.dependency, "absent");
    assert.equal(again.changed, false);
  } finally {
    await fx.cleanup();
  }
});

test("deps list reports rows, problems, counts and the cap", async () => {
  const fx = await fixture();
  try {
    const empty = await depsList(fx);
    assert.deepEqual({ exists: empty.exists, count: empty.count, dependencies: empty.dependencies }, { exists: false, count: 0, dependencies: [] });

    await depsAdd(fx, "beers", "--bundle-id", "hm-beer", "--path", "../beer");
    await depsAdd(fx, "parks", "--bundle-id", "hm-parks");
    const doc = await depsDoc(fx);
    const declared = doc.frontmatter.dependencies as Record<string, unknown>;
    await writeDoc(fx.bundle, { ...doc, frontmatter: { ...doc.frontmatter, dependencies: { ...declared, Bad: { bundle_id: "hm-bad" } } } });

    const listed = await depsList(fx, "--limit", "1");
    assert.equal(listed.count, 2);
    assert.equal(listed.shown, 1);
    assert.deepEqual(listed.dependencies, [{ alias: "beers", bundle_id: "hm-beer", source: null, pin: null, path: "../beer" }]);
    assert.deepEqual(listed.problems, [{ code: "DEP_ALIAS", alias: "Bad", detail: "alias must match ^[a-z][a-z0-9-]{0,62}$" }]);
    assert.ok((listed.help as string[]).some((h) => h.endsWith("deps list --limit 0")));
  } finally {
    await fx.cleanup();
  }
});

// ── The whole flow, through CLI commands only ─────────────────────────────────────────────────

test("flow: bundle id set on the target, deps add on the referrer, link add --bundle, then status --with resolves", async () => {
  const fx = await fixture();
  const beer = await initBundle(path.join(fx.root, "catalogs", "beer", ".superbee"), { okfVersion: "0.1" });
  try {
    await writeDoc(beer, { id: "beers/little-whale", frontmatter: { type: "Beer", title: "Little Whale" }, body: "" });
    await writeDoc(fx.bundle, { id: "menus/whale", frontmatter: { type: "Menu Item", title: "Whale on tap" }, body: "" });

    let out = "";
    await bundleCommand(["id", "set", "hm-beer", "--dir", beer.root, "--actor", "human:mike"], { stdout: (s) => (out += s) });
    assert.match(out, /^bundle_id: hm-beer\ndoc: docs\/bundle\nresult: created\n/);

    await depsAdd(fx, "beers", "--bundle-id", "hm-beer", "--path", "../../catalogs/beer/.superbee", "--actor", "human:mike");
    await run(link, ["add", "menus/whale", "beers/little-whale", "--bundle", "beers", "--dir", fx.bundle.root]);

    let report = "";
    await status(["--dir", fx.bundle.root, "--json", "--with", `beers=${beer.root}`], { stdout: (s) => (report += s), autoPull: noPull });
    const parsed = JSON.parse(report) as Record<string, unknown>;
    assert.equal(parsed.cross_bundle_links, 1);
    assert.equal(parsed.cross_bundle_unresolved, 0);
    assert.equal(parsed.cross_bundle_unchecked, 0);
    assert.equal(parsed.dependency_problems, undefined);
    const rows = (parsed.dependencies as { rows: Record<string, unknown>[] }).rows;
    assert.deepEqual(rows.map((r) => [r.alias, r.bundle_id, r.state]), [["beers", "hm-beer", "ok"]]);
  } finally {
    await fx.cleanup();
  }
});

// ── Review fixes ──────────────────────────────────────────────────────────────────────────────

test("STALE_HEAD without --expected-version says retries were exhausted and never names a version the caller did not pass", () => {
  const conflict = new VersionConflict("docs/dependencies", "sha256:aaaa", "sha256:bbbb");
  const retry = "superbee deps add beers --bundle-id hm-beer";
  const exhausted = declarationErrorHooks("docs/dependencies", { expectedVersion: undefined, retry }).staleHead!(conflict);
  assert.equal(exhausted.code, "STALE_HEAD");
  assert.match(exhausted.message, /retries exhausted; re-run the command/);
  assert.doesNotMatch(exhausted.message, /--expected-version/);
  assert.equal(exhausted.help, retry);

  const premise = declarationErrorHooks("docs/dependencies", { expectedVersion: "sha256:aaaa", retry }).staleHead!(conflict);
  assert.match(premise.message, /has moved since --expected-version sha256:aaaa was read \(current: sha256:bbbb\)/);
});

test("concurrent deps add runs without --expected-version converge, and no failure blames an unpassed version", async () => {
  const fx = await fixture();
  try {
    const aliases = Array.from({ length: 12 }, (_, i) => `dep-${i}`);
    const outcomes = await Promise.allSettled(aliases.map((alias, i) => depsAdd(fx, alias, "--bundle-id", `hm-dep-${i}`)));
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") continue;
      const err = outcome.reason as CliError;
      assert.equal(err.code, "STALE_HEAD", String(err));
      assert.doesNotMatch(err.message, /--expected-version/);
    }
    const stored = parseDependencies(await depsDoc(fx)).dependencies;
    const landed = outcomes.flatMap((o, i) => (o.status === "fulfilled" ? [aliases[i]!] : []));
    assert.ok(landed.length > 0);
    for (const alias of landed) assert.ok(stored.has(alias), `${alias} reported added but is missing`);
  } finally {
    await fx.cleanup();
  }
});

test("deps add and deps remove trim the alias the same way", async () => {
  const fx = await fixture();
  try {
    const added = await depsAdd(fx, " beers ", "--bundle-id", "hm-beer");
    assert.equal(added.alias, "beers");
    assert.deepEqual([...parseDependencies(await depsDoc(fx)).dependencies.keys()], ["beers"]);
    const removed = await depsRemove(fx, " beers ");
    assert.equal(removed.removed, true);
    await rejectsWith(() => depsAdd(fx, "  ", "--bundle-id", "hm-beer"), "USAGE", "DEP_ALIAS");
  } finally {
    await fx.cleanup();
  }
});

test("the exhausted-retry re-run command for deps add carries every flag the caller gave, shell-quoted", () => {
  const { retry } = depsAddRerun("p2", {
    "bundle-id": "par.n2",
    source: "git@example.test:town/parks.git",
    pin: "abcdef1",
    path: "../parks dir/.superbee",
    replace: true,
    actor: "human:mike",
    dir: "/tmp/town bundle",
  });
  assert.ok(
    retry.endsWith(
      " deps add p2 --bundle-id par.n2 --source git@example.test:town/parks.git --pin abcdef1" +
        " --path '../parks dir/.superbee' --replace --actor human:mike --dir '/tmp/town bundle'",
    ),
    retry,
  );
  const hook = declarationErrorHooks("docs/dependencies", { expectedVersion: undefined, retry }).staleHead!(
    new VersionConflict("docs/dependencies", "sha256:aaaa", "sha256:bbbb"),
  );
  assert.equal(hook.help, retry);
});

test("DEP_ALIAS_EXISTS help keeps --pin and --path in its --replace command", async () => {
  const fx = await fixture();
  try {
    await depsAdd(fx, "beers", "--bundle-id", "hm-beer");
    const err = await rejectsWith(() => depsAdd(fx, "beers", "--bundle-id", "hm-ale", "--pin", "abcdef1", "--path", "../ale"), "CONFLICT", "DEP_ALIAS_EXISTS");
    assert.match(String(err.help), / deps add beers --bundle-id hm-ale --pin abcdef1 --path \.\.\/ale --replace --dir /);
  } finally {
    await fx.cleanup();
  }
});
