import assert from "node:assert/strict";
import test from "node:test";

import {
  BUNDLE_NAME_DOC_ID,
  BUNDLE_NAME_DOC_TYPE,
  DEPENDENCIES_DOC_ID,
  DEPENDENCIES_DOC_TYPE,
  declaredBundleId,
  isHostedBundleId,
  isNonPortableDependencyPath,
  parseDependencies,
  type DependencyProblemCode,
} from "../src/dependencies.js";
import type { OkfDocument } from "../src/types.js";

const COMMIT = "3f94940";
const DIGEST = `sha256:${"a".repeat(64)}`;

function depsDoc(dependencies: unknown, type: unknown = DEPENDENCIES_DOC_TYPE): OkfDocument {
  return { id: DEPENDENCIES_DOC_ID, frontmatter: { type, dependencies }, body: "" };
}

function codes(dependencies: unknown, selfBundleId?: string): DependencyProblemCode[] {
  return parseDependencies(depsDoc(dependencies), selfBundleId === undefined ? {} : { selfBundleId }).problems.map((p) => p.code);
}

test("parseDependencies: a full entry parses with every optional field", () => {
  const { dependencies, problems } = parseDependencies(depsDoc({
    beers: { bundle_id: "hm-beer-catalog", source: "git@github.com:x/y.git", pin: COMMIT, path: "../../catalogs/beer/.superbee" },
    listings: { bundle_id: "listings", pin: DIGEST },
  }));
  assert.deepEqual(problems, []);
  assert.deepEqual([...dependencies.entries()], [
    ["beers", {
      alias: "beers", bundle_id: "hm-beer-catalog", source: "git@github.com:x/y.git",
      pin: { kind: "commit", value: COMMIT }, path: "../../catalogs/beer/.superbee",
    }],
    ["listings", { alias: "listings", bundle_id: "listings", pin: { kind: "digest", value: DIGEST } }],
  ]);
});

test("parseDependencies never throws and fails closed on the document itself", () => {
  assert.deepEqual(parseDependencies(undefined), { dependencies: new Map(), problems: [] });
  const wrongType = parseDependencies(depsDoc({ beers: { bundle_id: "hm-beer-catalog" } }, "Doc"));
  assert.deepEqual(wrongType.problems.map((p) => p.code), ["DEP_TYPE"]);
  assert.equal(wrongType.dependencies.size, 0);
  for (const shape of [["beers"], "beers", 3]) {
    const parsed = parseDependencies(depsDoc(shape));
    assert.deepEqual(parsed.problems.map((p) => p.code), ["DEP_SHAPE"]);
    assert.equal(parsed.dependencies.size, 0);
  }
});

/** Every code fires, with what happens to the entry. */
const CODE_ROWS: Array<{ code: DependencyProblemCode; deps: Record<string, unknown>; kept: boolean; self?: string }> = [
  { code: "DEP_SHAPE", deps: { beers: "hm-beer-catalog" }, kept: false },
  { code: "DEP_ALIAS", deps: { Beers: { bundle_id: "hm-beer-catalog" } }, kept: false },
  { code: "DEP_BUNDLE_ID", deps: { beers: { source: "x" } }, kept: false },
  { code: "DEP_BUNDLE_ID", deps: { beers: { bundle_id: "Not An Id" } }, kept: false },
  { code: "DEP_PIN", deps: { beers: { bundle_id: "hm-beer-catalog", pin: "main" } }, kept: false },
  { code: "DEP_PIN", deps: { beers: { bundle_id: "hm-beer-catalog", pin: 1234567 } }, kept: false },
  { code: "DEP_PIN", deps: { beers: { bundle_id: "hm-beer-catalog", pin: "sha256:abc" } }, kept: false },
  { code: "DEP_SELF", deps: { beers: { bundle_id: "hm-fairport" } }, kept: false, self: "hm-fairport" },
  { code: "DEP_PATH_ABSOLUTE", deps: { beers: { bundle_id: "hm-beer-catalog", path: "/srv/beer" } }, kept: true },
  { code: "DEP_UNKNOWN_KEY", deps: { beers: { bundle_id: "hm-beer-catalog", color: "amber" } }, kept: true },
  { code: "DEP_RESERVED_KEY", deps: { beers: { bundle_id: "hm-beer-catalog", use: "x" } }, kept: true },
  { code: "DEP_RESERVED_KEY", deps: { beers: { bundle_id: "hm-beer-catalog", version: "1" } }, kept: true },
  { code: "DEP_RESERVED_KEY", deps: { beers: { bundle_id: "hm-beer-catalog", channel: "next" } }, kept: true },
];

for (const row of CODE_ROWS) {
  test(`parseDependencies: ${row.code} fires for ${JSON.stringify(row.deps)}`, () => {
    const parsed = parseDependencies(depsDoc(row.deps), row.self === undefined ? {} : { selfBundleId: row.self });
    assert.deepEqual(parsed.problems.map((p) => p.code), [row.code]);
    assert.ok(parsed.problems[0]!.detail.length > 0);
    assert.equal(parsed.dependencies.size, row.kept ? 1 : 0);
  });
}

test("parseDependencies: DEP_DUPLICATE_BUNDLE keeps the first alias and drops the second", () => {
  const parsed = parseDependencies(depsDoc({
    beers: { bundle_id: "hm-beer-catalog" },
    brews: { bundle_id: "hm-beer-catalog" },
  }));
  assert.deepEqual(parsed.problems, [{ code: "DEP_DUPLICATE_BUNDLE", alias: "brews", detail: "bundle_id 'hm-beer-catalog' is already declared as 'beers'" }]);
  assert.deepEqual([...parsed.dependencies.keys()], ["beers"]);
});

test("parseDependencies: a path absolute under POSIX or Windows rules is DEP_PATH_ABSOLUTE and is not kept", () => {
  for (const p of ["/srv/beer", "\\srv\\beer", "\\\\server\\share\\beer", "C:\\beer", "C:/beer", "c:beer", "..\\beer"]) {
    assert.equal(isNonPortableDependencyPath(p), true, p);
    const parsed = parseDependencies(depsDoc({ beers: { bundle_id: "hm-beer-catalog", path: p } }));
    assert.deepEqual(parsed.problems.map((x) => x.code), ["DEP_PATH_ABSOLUTE"], p);
    assert.equal(parsed.dependencies.get("beers")!.path, undefined, p);
  }
  for (const p of ["../../catalogs/beer/.superbee", "beer", "./beer"]) {
    assert.equal(isNonPortableDependencyPath(p), false, p);
  }
});

test("parseDependencies: an alias such as 'constructor' is an ordinary key", () => {
  const parsed = parseDependencies(depsDoc({ constructor: { bundle_id: "ctor" } }));
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.dependencies.get("constructor")!.bundle_id, "ctor");
  assert.equal(parsed.dependencies.get("toString"), undefined);
});

test("several problems on one declaration are all reported", () => {
  assert.deepEqual(codes({
    beers: { bundle_id: "hm-beer-catalog", extra: 1 },
    Bad: { bundle_id: "x" },
    self: { bundle_id: "me" },
  }, "me"), ["DEP_UNKNOWN_KEY", "DEP_ALIAS", "DEP_SELF"]);
});

test("declaredBundleId reads bundle_id only from docs/bundle under the marker type", () => {
  const doc = (frontmatter: Record<string, unknown>, id = BUNDLE_NAME_DOC_ID): OkfDocument => ({ id, frontmatter, body: "" });
  assert.equal(declaredBundleId(doc({ type: BUNDLE_NAME_DOC_TYPE, bundle_id: "hm-fairport" })), "hm-fairport");
  assert.equal(declaredBundleId(doc({ type: "Doc", bundle_id: "hm-fairport" })), undefined);
  assert.equal(declaredBundleId(doc({ type: BUNDLE_NAME_DOC_TYPE, bundle_id: "HM Fairport" })), undefined);
  assert.equal(declaredBundleId(doc({ type: BUNDLE_NAME_DOC_TYPE })), undefined);
  assert.equal(declaredBundleId(doc({ type: BUNDLE_NAME_DOC_TYPE, bundle_id: "hm-fairport" }, "docs/other")), undefined);
  assert.equal(declaredBundleId(null), undefined);
});

test("isHostedBundleId keeps the hosted grammar", () => {
  for (const id of ["hm-beer-catalog", "a", "a.b_c-d", "a".repeat(128)]) assert.equal(isHostedBundleId(id), true, id);
  for (const id of ["-a", "A", "a-", "a--b", "1a", "", "a".repeat(129), "a b"]) assert.equal(isHostedBundleId(id), false, id);
});
