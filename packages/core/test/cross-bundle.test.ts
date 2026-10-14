import assert from "node:assert/strict";
import test from "node:test";

import {
  NOT_AUTHORIZED_DETAIL,
  RECORD_REASONS,
  UNRESOLVED_REASONS,
  createLocalResolver,
  isRecordReason,
  resolveQualifiedLinks,
  type BundleBinding,
  type BundleResolver,
  type CrossBacklink,
  type PinCheck,
  type Resolution,
} from "../src/cross-bundle.js";
import { parseDependencies, type DependencyMap } from "../src/dependencies.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { parseQualifiedLinks, qualifiedHref, type QualifiedRef } from "../src/qualified-links.js";
import type { ConceptId, ReadResult } from "../src/types.js";

const COMMIT = "3f94940";

class CountingBackend extends MemoryBackend {
  readManyCalls: ConceptId[][] = [];
  readCalls = 0;
  override async readMany(ids: ConceptId[]): Promise<ReadResult[]> {
    this.readManyCalls.push([...ids]);
    return super.readMany(ids);
  }
  override async read(id: ConceptId): Promise<ReadResult> {
    this.readCalls++;
    return super.read(id);
  }
}

async function catalog(ids: string[]): Promise<CountingBackend> {
  const backend = new CountingBackend();
  for (const id of ids) await backend.write(id, { id, frontmatter: { type: "Beer", title: id }, body: "" });
  backend.readManyCalls = [];
  backend.readCalls = 0;
  return backend;
}

function deps(entries: Record<string, unknown>): DependencyMap {
  const parsed = parseDependencies({ id: "docs/dependencies", frontmatter: { type: "Bundle Dependencies", dependencies: entries }, body: "" });
  assert.deepEqual(parsed.problems, []);
  return parsed.dependencies;
}

const ref = (alias: string, id: string): QualifiedRef => ({ alias, id });

function unresolved(resolution: Resolution) {
  assert.equal(resolution.state, "unresolved");
  return resolution as Extract<Resolution, { state: "unresolved" }>;
}

test("RECORD_REASONS splits the six reasons into record and environment", () => {
  assert.deepEqual([...RECORD_REASONS].sort(), ["invalid_ref", "target_missing", "unknown_alias"]);
  assert.deepEqual(UNRESOLVED_REASONS.filter((reason) => !isRecordReason(reason)).sort(), ["bundle_unavailable", "not_authorized", "pin_mismatch"]);
  assert.equal(UNRESOLVED_REASONS.length, 6);
});

test("local resolver: resolved, target_missing and unknown_alias", async () => {
  const beers = await catalog(["beers/a"]);
  const resolver = createLocalResolver({
    dependencies: deps({ beers: { bundle_id: "hm-beer-catalog" } }),
    bindings: new Map([["beers", { backend: beers, label: "catalogs/beer", identity: "hm-beer-catalog" }]]),
  });
  assert.equal(resolver.kind, "local");
  const [hit, missing, unknown] = await resolver.resolve([ref("beers", "beers/a"), ref("beers", "beers/zz"), ref("wines", "w/1")]);
  assert.equal(hit!.state, "resolved");
  assert.ok(hit!.state === "resolved");
  assert.equal(hit.bundle_id, "hm-beer-catalog");
  assert.equal(hit.document.id, "beers/a");
  assert.match(hit.version, /^sha256:/);
  assert.equal("revision" in hit, false);
  assert.deepEqual(unresolved(missing!), {
    state: "unresolved", ref: ref("beers", "beers/zz"), href: "okf://beers/beers/zz.md",
    reason: "target_missing", bundle_id: "hm-beer-catalog", detail: "'beers/zz' is not in catalogs/beer",
  });
  const u = unresolved(unknown!);
  assert.equal(u.reason, "unknown_alias");
  assert.equal(u.bundle_id, undefined);
});

test("local resolver: bundle_unavailable when unbound, unidentified or a different bundle", async () => {
  const beers = await catalog(["beers/a"]);
  const dependencies = deps({ beers: { bundle_id: "hm-beer-catalog" } });
  const cases: Array<[string, Map<string, BundleBinding>, RegExp]> = [
    ["unbound", new Map(), /no copy of 'hm-beer-catalog' is bound/],
    ["no identity", new Map([["beers", { backend: beers, label: "x" }]]), /declares no bundle_id/],
    ["identity mismatch", new Map([["beers", { backend: beers, label: "x", identity: "hm-wine-catalog" }]]), /is 'hm-wine-catalog', not 'hm-beer-catalog'/],
  ];
  for (const [name, bindings, detail] of cases) {
    const [result] = await createLocalResolver({ dependencies, bindings }).resolve([ref("beers", "beers/a")]);
    const u = unresolved(result!);
    assert.equal(u.reason, "bundle_unavailable", name);
    assert.match(u.detail, detail, name);
    assert.equal(u.bundle_id, "hm-beer-catalog", name);
  }
  assert.deepEqual(beers.readManyCalls, [], "an unusable binding is never read");
});

test("local resolver: pin_mismatch from a failing PinCheck, a missing PinCheck and any digest pin", async () => {
  const beers = await catalog(["beers/a"]);
  const seen: string[] = [];
  const failing: PinCheck = async (pin) => {
    seen.push(pin.value);
    return { ok: false, detail: "subtree changed since 3f94940" };
  };
  const passing: PinCheck = async () => ({ ok: true });
  const commit = deps({ beers: { bundle_id: "hm-beer-catalog", pin: COMMIT } });
  const digest = deps({ beers: { bundle_id: "hm-beer-catalog", pin: `sha256:${"b".repeat(64)}` } });
  const bind = (pin?: PinCheck) => new Map([["beers", { backend: beers, label: "x", identity: "hm-beer-catalog", ...(pin ? { pin } : {}) }]]);

  const [failed, again] = await createLocalResolver({ dependencies: commit, bindings: bind(failing) }).resolve([ref("beers", "beers/a"), ref("beers", "beers/b")]);
  assert.equal(unresolved(failed!).reason, "pin_mismatch");
  assert.equal(unresolved(failed!).detail, "subtree changed since 3f94940");
  assert.equal(unresolved(again!).reason, "pin_mismatch");
  assert.deepEqual(seen, [COMMIT], "the pin is checked once per alias per resolve");

  const [noCheck] = await createLocalResolver({ dependencies: commit, bindings: bind() }).resolve([ref("beers", "beers/a")]);
  assert.equal(unresolved(noCheck!).reason, "pin_mismatch");

  const [digestPin] = await createLocalResolver({ dependencies: digest, bindings: bind(passing) }).resolve([ref("beers", "beers/a")]);
  assert.equal(unresolved(digestPin!).reason, "pin_mismatch");
  assert.equal(unresolved(digestPin!).detail, "digest pins are verified by a hosted resolver");

  const [ok] = await createLocalResolver({ dependencies: commit, bindings: bind(passing) }).resolve([ref("beers", "beers/a")]);
  assert.equal(ok!.state, "resolved");
  assert.deepEqual(beers.readManyCalls, [["beers/a"]], "only the satisfied pin reads");
});

test("local resolver: invalid_ref for a malformed ref, positional with the rest", async () => {
  const beers = await catalog(["beers/a"]);
  const resolver = createLocalResolver({
    dependencies: deps({ beers: { bundle_id: "hm-beer-catalog" } }),
    bindings: new Map([["beers", { backend: beers, label: "x", identity: "hm-beer-catalog" }]]),
  });
  const [bad, good] = await resolver.resolve([ref("beers", "../x"), ref("beers", "beers/a")]);
  assert.equal(unresolved(bad!).reason, "invalid_ref");
  assert.equal(unresolved(bad!).ref, null);
  assert.equal(good!.state, "resolved");
});

test("local resolver: one batched read per alias, duplicates collapsed", async () => {
  const beers = await catalog(["beers/a", "beers/b", "beers/c"]);
  const wines = await catalog(["w/1", "w/2"]);
  const resolver = createLocalResolver({
    dependencies: deps({ beers: { bundle_id: "hm-beer-catalog" }, wines: { bundle_id: "hm-wine-catalog" } }),
    bindings: new Map([
      ["beers", { backend: beers, label: "beer", identity: "hm-beer-catalog" }],
      ["wines", { backend: wines, label: "wine", identity: "hm-wine-catalog" }],
    ]),
  });
  const refs = [ref("beers", "beers/a"), ref("wines", "w/1"), ref("beers", "beers/b"), ref("beers", "beers/a"), ref("wines", "w/2"), ref("beers", "beers/c")];
  const results = await resolver.resolve(refs);
  assert.deepEqual(results.map((r) => r.state), refs.map(() => "resolved"));
  assert.deepEqual(results.map((r) => (r.state === "resolved" ? r.document.id : null)), refs.map((r) => r.id));
  assert.deepEqual(beers.readManyCalls, [["beers/a", "beers/b", "beers/c"]]);
  assert.deepEqual(wines.readManyCalls, [["w/1", "w/2"]]);
  assert.equal(beers.readCalls - 3, 0, "MemoryBackend.readMany reads each id once; no per-id fallback");
  assert.equal(wines.readCalls - 2, 0);
});

test("local resolver: a batch with a missing target still issues one readMany for the alias", async () => {
  const beers = await catalog(["beers/a"]);
  const resolver = createLocalResolver({
    dependencies: deps({ beers: { bundle_id: "hm-beer-catalog" } }),
    bindings: new Map([["beers", { backend: beers, label: "x", identity: "hm-beer-catalog" }]]),
  });
  const [a, gone] = await resolver.resolve([ref("beers", "beers/a"), ref("beers", "beers/gone")]);
  assert.equal(a!.state, "resolved");
  assert.equal(unresolved(gone!).reason, "target_missing");
  assert.equal(beers.readManyCalls.length, 1);
  // The documented fallback cost: MemoryBackend.readMany reads both ids (2) and fails on the
  // absent one, then readManyExisting reads each id once more (2).
  assert.equal(beers.readCalls, 4);
});

test("local resolver: a declared alias whose entry was rejected says so, still as unknown_alias", async () => {
  const parsed = parseDependencies({
    id: "docs/dependencies",
    frontmatter: { type: "Bundle Dependencies", dependencies: { beers: { bundle_id: "hm-beer-catalog", pin: "main" }, wines: { pin: COMMIT } } },
    body: "",
  });
  const resolver = createLocalResolver({ dependencies: parsed.dependencies, rejected: parsed.rejected, bindings: new Map() });
  const [beer, wine, other] = await resolver.resolve([ref("beers", "beers/a"), ref("wines", "w/1"), ref("ciders", "c/1")]);
  assert.equal(unresolved(beer!).reason, "unknown_alias");
  assert.equal(unresolved(beer!).detail, "alias 'beers' is declared but rejected (DEP_PIN)");
  assert.equal(unresolved(wine!).detail, "alias 'wines' is declared but rejected (DEP_BUNDLE_ID)");
  assert.equal(unresolved(other!).detail, "alias 'ciders' is not declared in docs/dependencies");
});

test("local resolver: backlinks() is always empty", async () => {
  const resolver = createLocalResolver({ dependencies: new Map(), bindings: new Map() });
  assert.deepEqual(await resolver.backlinks({ bundle_id: "hm-beer-catalog", id: "beers/a" }), []);
});

test("resolveQualifiedLinks: malformed hrefs are invalid_ref with the parser's detail; the rest go through one resolve", async () => {
  const beers = await catalog(["beers/a"]);
  const resolver = createLocalResolver({
    dependencies: deps({ beers: { bundle_id: "hm-beer-catalog" } }),
    bindings: new Map([["beers", { backend: beers, label: "x", identity: "hm-beer-catalog" }]]),
  });
  let calls = 0;
  const counted: BundleResolver = { ...resolver, resolve: (refs) => { calls++; return resolver.resolve(refs); } };
  const links = parseQualifiedLinks({
    id: "menus/m",
    frontmatter: {},
    body: "[pours](okf://beers/beers/a.md) [pours](okf://beers/../x.md) [pours](okf://wines/w.md)",
  });
  const rows = await resolveQualifiedLinks(counted, links);
  assert.equal(calls, 1);
  assert.deepEqual(rows.map((row) => row.resolution.state === "resolved" ? "resolved" : row.resolution.reason), ["resolved", "invalid_ref", "unknown_alias"]);
  assert.equal(rows[1]!.resolution.state === "unresolved" && rows[1]!.resolution.href, "okf://beers/../x.md");
  assert.equal(rows[1]!.resolution.state === "unresolved" && rows[1]!.resolution.detail, links[1]!.detail);
});

/**
 * A fake hosted resolver written to the interface's authorization invariants: grants are fixed at
 * construction, the grant check runs first, and `not_authorized` carries only the reader's own
 * declaration and a fixed detail.
 */
function fakeHostedResolver(
  dependencies: DependencyMap,
  grants: ReadonlySet<string>,
  host: ReadonlyMap<string, MemoryBackend>,
): BundleResolver {
  return {
    kind: "hosted",
    dependencies,
    async resolve(refs) {
      const out: Resolution[] = [];
      for (const r of refs) {
        const href = qualifiedHref(r);
        const entry = dependencies.get(r.alias);
        if (!entry) {
          out.push({ state: "unresolved", ref: r, href, reason: "unknown_alias", detail: "alias not declared" });
          continue;
        }
        if (!grants.has(entry.bundle_id)) {
          out.push({ state: "unresolved", ref: r, href, reason: "not_authorized", bundle_id: entry.bundle_id, detail: NOT_AUTHORIZED_DETAIL });
          continue;
        }
        const backend = host.get(entry.bundle_id);
        if (!backend) {
          out.push({ state: "unresolved", ref: r, href, reason: "bundle_unavailable", bundle_id: entry.bundle_id, detail: "not on host" });
          continue;
        }
        const read = (await backend.readMany([r.id]).catch(() => []))[0];
        out.push(read
          ? { state: "resolved", ref: r, bundle_id: entry.bundle_id, revision: "rev-7", document: read.doc, version: read.version }
          : { state: "unresolved", ref: r, href, reason: "target_missing", bundle_id: entry.bundle_id, detail: "missing" });
      }
      return out;
    },
    async backlinks(): Promise<CrossBacklink[]> {
      return [];
    },
  };
}

test("existence probe: not_authorized is deep-equal for a present and a missing target, and discloses no revision", async () => {
  const dependencies = deps({ beers: { bundle_id: "hm-beer-catalog" } });
  const present = new Map([["hm-beer-catalog", await catalog(["beers/secret"])]]);
  const emptyBundle = new Map([["hm-beer-catalog", await catalog([])]]);
  const noBundle = new Map<string, MemoryBackend>();
  const probe = ref("beers", "beers/secret");

  const answers: Resolution[] = [];
  for (const host of [present, emptyBundle, noBundle]) {
    const [answer] = await fakeHostedResolver(dependencies, new Set(), host).resolve([probe]);
    answers.push(answer!);
  }
  assert.deepEqual(answers[0], {
    state: "unresolved", ref: probe, href: "okf://beers/beers/secret.md",
    reason: "not_authorized", bundle_id: "hm-beer-catalog", detail: NOT_AUTHORIZED_DETAIL,
  });
  assert.deepEqual(answers[1], answers[0]);
  assert.deepEqual(answers[2], answers[0]);
  for (const answer of answers) assert.equal("revision" in answer, false);

  // The fake does disclose existence once granted, so the probe above is not vacuous.
  const [granted] = await fakeHostedResolver(dependencies, new Set(["hm-beer-catalog"]), present).resolve([probe]);
  assert.equal(granted!.state, "resolved");
});
