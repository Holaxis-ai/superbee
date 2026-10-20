import assert from "node:assert/strict";
import test from "node:test";
import { projectDomainModelV0 as project, type DomainModelV0 } from "../src/domain-model.js";
// @ts-expect-error the oracle is deliberately unmodified JavaScript
import { projectDomainModelV0 as original } from "./fixtures/domain-model-v0/original.mjs";

function projectDomainModelV0(input: any): DomainModelV0 {
  let expected;
  try { expected = original(input); } catch (error) {
    assert.ok(error instanceof TypeError);
    assert.throws(() => project(input), { name: error.name, message: error.message });
    throw error;
  }
  const actual = project(input);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  return actual;
}

function kind(governs: string, extra: any = {}): any {
  return { id: `conventions/${governs}`, title: governs, governs,
    fields: { required: ["title"], optional: [], values: {}, terminal: {}, descriptions: {} }, ...extra };
}
function registry(...kinds: any[]): any { return { kinds: new Map(kinds.map((kind) => [kind.governs, kind])), warnings: [] }; }

test("empty scope is an honest empty read model", () => {
  assert.deepEqual(projectDomainModelV0(registry()), {
    schemaVersion: 0, kinds: [], relationships: [], registryWarnings: [], diagnostics: [],
  });
});

test("preserves canonical metadata and raw field coordinates without inventing constraints", () => {
  const input = kind("Task", {
    description: "An accountable action", path: "tasks/", sections: ["Why", "Result"],
    freshnessHorizon: "1d", browseCollapsed: false,
    claim: { ownerField: "owner", stateField: "superbee_progress_status" },
    fields: {
      required: ["title", "both"], optional: ["both", "owner"],
      values: { superbee_progress_status: ["todo", "done"], enumOnly: ["x"] },
      terminal: { terminalOnly: ["y"] }, descriptions: { descriptionOnly: "guidance" },
      valueDescriptions: { superbee_progress_status: { todo: "Not started", done: "Finished" } },
    },
  });
  const model = projectDomainModelV0(registry(input));
  assert.deepEqual(model.kinds[0], input);
  assert.equal("progress_status" in model.kinds[0].fields.values, false);
  assert.equal("cardinality" in model, false);
});

test("retains both relationship declarations and expectations with accurate source paths", () => {
  const model = projectDomainModelV0(registry(
    kind("Roadmap", { links: { contains: "Task" }, linkDescriptions: { contains: "Work included" } }),
    kind("Task", { expectsInbound: { contains: "Roadmap" } }),
  ));
  assert.equal(model.relationships.length, 2);
  assert.deepEqual(model.relationships.map((edge) => [edge.kind, edge.fromKind, edge.toKind]), [
    ["outbound", "Roadmap", "Task"], ["inbound-expectation", "Roadmap", "Task"],
  ]);
  assert.deepEqual(model.relationships[1].path, ["expects_inbound", "contains"]);
  assert.equal(model.relationships[0].description, "Work included");
  assert.equal(model.relationships[1].description, undefined);
  assert.deepEqual(model.diagnostics, []);
});

test("external endpoints are informational and incoming-only expectations survive", () => {
  const model = projectDomainModelV0(registry(kind("Automation", {
    links: { "owned by": "Principal" }, expectsInbound: { runs: "Deployment" },
  })));
  assert.equal(model.relationships[0].toId, null);
  assert.equal(model.relationships[1].fromId, null);
  assert.deepEqual(model.diagnostics.map((d) => [d.code, d.severity, d.endpoint, d.kind]), [
    ["KIND_OUTSIDE_SCOPE", "info", "to", "Principal"],
    ["KIND_OUTSIDE_SCOPE", "info", "from", "Deployment"],
  ]);
});

test("canonical warnings retain metadata and order without inferred source identities", () => {
  const input = registry();
  input.warnings.push({ code: "KIND_RESERVED_FIELD", message: "Kept with warning", field: "fields", severity: "warning", details: { extra: [1, true, null] } });
  const model = projectDomainModelV0(input);
  assert.deepEqual(model.registryWarnings, input.warnings);
  assert.equal("declaredBy" in model.registryWarnings[0], false);
  input.warnings[0].details.extra.push(2);
  assert.equal(model.registryWarnings[0].details.extra.length, 3);
});

test("stable JSON ignores Map and dictionary insertion order, but preserves authored array order", () => {
  const a = kind("A", { links: { z: "B", a: "A" }, sections: ["Second", "First"] });
  const b = kind("B");
  const first = projectDomainModelV0(registry(b, a));
  const reordered = { ...a, links: { a: "A", z: "B" } };
  assert.equal(JSON.stringify(first), JSON.stringify(projectDomainModelV0(registry(reordered, b))));
  assert.deepEqual(first.kinds[0].sections, ["Second", "First"]);
});

test("optional undefined warning fields are absent JSON properties, not invalid canonical input", () => {
  const warning = { code: "DISCOVERY", message: "Could not inspect one source", field: undefined, severity: "warning" };
  const model = projectDomainModelV0({ kinds: new Map(), warnings: [warning] });
  assert.deepEqual(model.registryWarnings, [JSON.parse(JSON.stringify(warning))]);
  assert.equal(Object.hasOwn(model.registryWarnings[0], "field"), false);
  assert.equal(Object.hasOwn(warning, "field"), true);
  assert.throws(() => projectDomainModelV0({ kinds: new Map(), warnings: [{ ...warning, field: 42 }] }), /string/);
});

test("numeric relationship labels also use code-unit ordering", () => {
  const model = projectDomainModelV0(registry(kind("A", { links: { "2": "A", "10": "A", a: "A" } })));
  assert.deepEqual(model.relationships.map((edge) => edge.label), ["10", "2", "a"]);
});

test("prototype-sensitive names and punctuation are data, not lookup or ID syntax", () => {
  const links = JSON.parse('{"__proto__":"constructor","x.y[0]":"__proto__"}');
  const model = projectDomainModelV0(registry(kind("__proto__", { links }), kind("constructor")));
  assert.equal(Object.hasOwn(model.kinds[0].links, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(model.kinds[0].links), Object.prototype);
  assert.equal(model.diagnostics.length, 0);
  assert.deepEqual(model.relationships[1].path, ["links", "x.y[0]"]);
  assert.deepEqual(JSON.parse(model.relationships[1].id), ["outbound", "conventions/__proto__", "x.y[0]"]);
});

test("model is deeply frozen and does not retain mutable input references", () => {
  const original = kind("A", { links: { self: "A" }, sections: ["Purpose"] });
  const model = projectDomainModelV0(registry(original));
  original.fields.required.push("later");
  original.links.self = "Changed";
  assert.deepEqual(model.kinds[0].fields.required, ["title"]);
  assert.equal(model.relationships[0].toKind, "A");
  function check(value: any) {
    if (value && typeof value === "object") {
      assert.ok(Object.isFrozen(value));
      Object.values(value).forEach(check);
    }
  }
  check(model);
  assert.throws(() => model.kinds[0].sections.push("mutation"), TypeError);
});

test("structural errors fail rather than manufacturing canonical definitions", () => {
  for (const input of [null, {}, { kinds: [], warnings: [] }, { kinds: new Map(), warnings: null }]) {
    assert.throws(() => projectDomainModelV0(input), TypeError);
  }
  assert.throws(() => projectDomainModelV0({ kinds: new Map([["different", kind("A")]]), warnings: [] }), /Map key/);
  assert.throws(() => projectDomainModelV0(registry(kind("A"), kind("B", { id: "conventions/A" }))), /unique/);
  assert.throws(() => projectDomainModelV0(registry(kind("A", { links: { bad: 3 } }))), /string/);
  assert.throws(() => projectDomainModelV0(registry(kind("A", { browseCollapsed: "yes" }))), /boolean/);
  const cycle: any = { code: "x", message: "x" }; cycle.self = cycle;
  assert.throws(() => projectDomainModelV0({ kinds: new Map(), warnings: [cycle] }), /acyclic/);
});

// Compare complete serialized output and failure messages with the pinned pre-move owner.
test("typed declarations retain the v0 byte shape without adapter enrichment", () => {
  const inputs = [registry(), registry(kind("A", { links: { "2": "B", "10": "A" }, freshnessHorizon: "2h", fields: { required: [], optional: [], values: {}, terminal: {}, descriptions: {}, types: { count: "integer" } } }), kind("B"))];
  const warned = registry(kind("__proto__"));
  warned.warnings.push({ code: "FUTURE", message: "kept", extra: { z: [1, null], a: true } });
  inputs.push(warned);
  for (const input of inputs) assert.equal(JSON.stringify(projectDomainModelV0(input)), JSON.stringify(original(input)));
  for (const input of [null, {}, { kinds: [], warnings: [] }, registry(kind("A", { links: { bad: 3 } }))]) {
    const failure = (project: any) => { try { project(input); } catch (error) { assert.ok(error instanceof TypeError); return error.message; } assert.fail("expected TypeError"); };
    assert.equal(failure(projectDomainModelV0), failure(original));
  }
});
