import test from "node:test";
import assert from "node:assert/strict";

import { FRONTMATTER_LIMITS, loadBoundedYaml } from "../src/bounded-yaml.js";
import { FrontmatterLimitError, MalformedDocumentError } from "../src/frontmatter-contract.js";
import { parseFrontmatter, parseMarkdown, stringifyDoc } from "../src/frontmatter.js";
import { parseLeadingFrontmatter } from "../src/portable-frontmatter.js";
import type { Frontmatter } from "../src/types.js";

/** `levels` levels of nine aliases each; the source stays small. */
function nestedAliases(levels: number): string {
  const lines = ["a0: &a0 [x,x,x,x,x,x,x,x,x]"];
  for (let i = 1; i <= levels; i++) lines.push(`a${i}: &a${i} [${Array(9).fill(`*a${i - 1}`).join(",")}]`);
  return lines.join("\n");
}

const loadSites: Array<[string, (yamlSource: string) => Record<string, unknown>]> = [
  ["parseMarkdown", (source) => parseMarkdown(`---\n${source}\n---\nbody\n`, "notes/a").frontmatter as Record<string, unknown>],
  ["parseFrontmatter", (source) => parseFrontmatter(source, "notes/a") as Record<string, unknown>],
  ["parseLeadingFrontmatter", (source) => parseLeadingFrontmatter(`---\n${source}\n---\n`, "notes/a") as Record<string, unknown>],
];

function refusedWith(code: string) {
  return (error: unknown): boolean =>
    error instanceof MalformedDocumentError && error.code === code && error.context === "notes/a";
}

function within<T>(limitMs: number, label: string, run: () => T): T {
  const started = performance.now();
  const value = run();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < limitMs, `${label}: ${elapsed}ms`);
  return value;
}

test("frontmatter whose YAML aliases expand past the node cap is refused quickly at every load site", () => {
  const source = nestedAliases(9);
  assert.ok(source.length < 500);
  for (const [name, load] of loadSites) {
    within(1000, name, () => assert.throws(() => load(source), refusedWith("FRONTMATTER_ALIAS_LIMIT"), name));
  }
  within(1000, "json schema", () => assert.throws(
    () => loadBoundedYaml(source, { schema: "json" }),
    (error: unknown) => error instanceof FrontmatterLimitError && error.code === "FRONTMATTER_ALIAS_LIMIT",
  ));
});

test("frontmatter with more alias references than the alias cap is refused", () => {
  const source = `base: &b { k: v }\nlist: [${Array(FRONTMATTER_LIMITS.aliases + 1).fill("*b").join(",")}]`;
  for (const [name, load] of loadSites) {
    within(1000, name, () => assert.throws(() => load(source), refusedWith("FRONTMATTER_ALIAS_LIMIT"), name));
  }
});

test("frontmatter whose YAML aliases nest past the depth cap is refused", () => {
  const lines = ["l0: &l0 [x]"];
  for (let i = 1; i <= FRONTMATTER_LIMITS.depth; i++) lines.push(`l${i}: &l${i} [*l${i - 1}]`);
  for (const [name, load] of loadSites) {
    within(1000, name, () => assert.throws(() => load(lines.join("\n")), refusedWith("FRONTMATTER_TOO_DEEP"), name));
  }
});

test("frontmatter with a few YAML aliases, a merge key and a cycle still parses", () => {
  const source = [
    "base: &b { k: v }",
    "copy: *b",
    "child:\n  <<: *b\n  extra: 1",
    "small: &s [1, 2]",
    "pair: [*s, *s]",
    "loop: &l\n  - *l",
    "title: &t Hello",
    "again: *t",
    nestedAliases(3),
  ].join("\n");
  for (const [name, load] of loadSites) {
    const value = load(source);
    assert.deepEqual(value.copy, { k: "v" }, name);
    assert.deepEqual(value.child, { k: "v", extra: 1 }, name);
    assert.equal(value.again, "Hello", name);
    const loop = value.loop as unknown[];
    assert.equal(loop[0], loop, name);
    assert.equal((value.a3 as unknown[]).length, 9, name);
  }
});

test("frontmatter the serializer writes with shared and circular values reads back", () => {
  const shared = { value: "shared" };
  const cycle: Record<string, unknown> = { value: "cycle" };
  cycle.self = cycle;
  const written = stringifyDoc({ type: "Note", first: shared, second: shared, cycle } as unknown as Frontmatter, "body\n");
  assert.match(written, /&ref_/);
  const { frontmatter } = parseMarkdown(written, "notes/a");
  assert.equal(frontmatter.first, frontmatter.second);
  const readCycle = frontmatter.cycle as Record<string, unknown>;
  assert.equal(readCycle.self, readCycle);
});

test("an alias with no anchor stays an ordinary malformed frontmatter error", () => {
  for (const [name, load] of loadSites) {
    assert.throws(() => load("title: *missing"), refusedWith("FRONTMATTER_MALFORMED"), name);
  }
});

test("frontmatter longer than the source cap is refused before parsing", () => {
  const source = `title: "${"a".repeat(FRONTMATTER_LIMITS.sourceChars)}"`;
  for (const [name, load] of loadSites) {
    within(1000, name, () => assert.throws(() => load(source), refusedWith("FRONTMATTER_TOO_LARGE"), name));
  }
  const atCap = `t: ${"a".repeat(FRONTMATTER_LIMITS.sourceChars - 3)}`;
  assert.equal(atCap.length, FRONTMATTER_LIMITS.sourceChars);
  assert.equal(parseFrontmatter(atCap).t, "a".repeat(FRONTMATTER_LIMITS.sourceChars - 3));
});

test("frontmatter nested deeper than the depth cap is refused", () => {
  const deep = `x: ${"[".repeat(FRONTMATTER_LIMITS.depth)}${"]".repeat(FRONTMATTER_LIMITS.depth)}`;
  for (const [name, load] of loadSites) {
    assert.throws(() => load(deep), refusedWith("FRONTMATTER_TOO_DEEP"), name);
  }
  const shallow = `x: ${"[".repeat(16)}1${"]".repeat(16)}`;
  for (const [, load] of loadSites) load(shallow);
});

test("quoted and plain strings containing & and * parse unchanged", () => {
  const source = [
    `title: "R&D *draft* &amp; *ptr"`,
    `note: 'a & b * c &anchor *alias'`,
    `plain: x&y*z`,
    `list: ["&one", '*two', a&b]`,
    `block: |\n  &literal\n  *text`,
  ].join("\n");
  const expected = {
    title: "R&D *draft* &amp; *ptr",
    note: "a & b * c &anchor *alias",
    plain: "x&y*z",
    list: ["&one", "*two", "a&b"],
    block: "&literal\n*text\n",
  };
  for (const [name, load] of loadSites) assert.deepEqual(load(source), expected, name);
});

test("syntax errors keep the FRONTMATTER_MALFORMED code", () => {
  for (const [name, load] of loadSites) {
    assert.throws(() => load("tags: [a, b"), refusedWith("FRONTMATTER_MALFORMED"), name);
  }
});
