/**
 * The static egress check over the profile module scope (the test profiles today, and every module
 * under `src/source-profiles` once it exists), over the engine and harness themselves, and against
 * planted modules that reach for the network around the guarded transport.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectSourceFiles, EGRESS_ALLOWED_GLOBALS, EGRESS_ALLOWED_IMPORTS, egressViolations } from "../../../scripts/source-egress-check.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../src");
const PROFILE_ROOTS = [path.join(here, "fixtures/source-engine/json-pages-profile.ts"), path.join(SRC, "source-profiles")].filter((p) => existsSync(p));
/** What a profile in the scope may import: its own scope, the engine's public entry and the connector module. */
const PROFILE_IMPORTS = [path.join(SRC, "source-profiles"), path.join(SRC, "source-engine/index.ts"), path.join(SRC, "connectors.ts")];

const resolveTs = (file: string, specifier: string): string => path.resolve(path.dirname(file), specifier).replace(/\.js$/, ".ts");
const allowProfileImport = (specifier: string, file: string): boolean => {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return EGRESS_ALLOWED_IMPORTS.includes(specifier);
  const target = resolveTs(file, specifier);
  return PROFILE_IMPORTS.some((allowed) => target === allowed || target.startsWith(`${allowed}${path.sep}`))
    || path.dirname(target) === path.dirname(file);
};

test("the profile module scope names only allowed globals and imports", () => {
  const files = collectSourceFiles(PROFILE_ROOTS);
  assert.ok(files.some((file: { path: string }) => file.path.endsWith("json-pages-profile.ts")), "the scope is not empty");
  assert.deepEqual(egressViolations(files, { allowImport: allowProfileImport }), []);
});

test("the engine and harness reach no network global and import only core modules", () => {
  const files = collectSourceFiles([path.join(SRC, "source-engine"), path.join(SRC, "source-harness")]);
  assert.ok(files.length >= 9);
  const insideSrc = (specifier: string, file: string): boolean => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
    const target = path.resolve(path.dirname(file), specifier);
    return target.startsWith(`${SRC}${path.sep}`);
  };
  // Engine code owns its timers and checks plain objects across realms; profile code may do neither.
  assert.deepEqual(egressViolations(files, {
    globals: ["AbortController", "structuredClone", "setTimeout", "clearTimeout", "queueMicrotask", "WeakMap"],
    allowImport: insideSrc,
    allowKeys: ["getPrototypeOf", "assign"],
  }), []);
});

const check = (text: string, name = "planted.ts"): string[] => egressViolations([{ path: name, text }]);

test("the engine's weak callback registry does not admit weak collections in profile scope", () => {
  const text = "const callbacks = new WeakMap<object, object>(); export const read = (key: object) => callbacks.get(key);";
  assert.deepEqual(egressViolations([{ path: "engine.ts", text }], { globals: ["WeakMap"] }), []);
  assert.ok(check(text).some(v => /names the global WeakMap/.test(v)));
});


for (const [name, text, expected] of [
  ["an ambient fetch", `export const p = { observe: async () => fetch("https://collector.example.net") };`, /names the global fetch/],
  ["self.fetch", `export const go = () => self.fetch("https://collector.example.net");`, /names the global self/],
  ["a computed global access", `const name = "fe" + "tch";\nexport const go = () => (globalThis as any)[name]("https://collector.example.net");`, /names the global globalThis/],
  ["globalThis destructured", `const { fetch: f } = globalThis;\nexport const go = () => f("x");`, /names the global globalThis/],
  ["a declared fetch posing as local", `declare const fetch: (url: string) => Promise<unknown>;\nexport const go = () => fetch("x");`, /names the global fetch/],
  ["WebSocket", `export const go = () => new WebSocket("wss://collector.example.net");`, /names the global WebSocket/],
  ["require", `export const go = () => require("node:https");`, /names the global require/],
  ["dynamic import()", `export const go = async () => (await import("node:https")).request;`, /dynamic import\(\)/],
  ["eval", `export const go = () => eval("1");`, /names the global eval/],
  ["Function", `export const go = () => new Function("return 1")();`, /names the global Function/],
  ["the constructor of a function", `export const go = () => [].map.constructor("return 1")();`, /reads constructor/],
  ["constructor named as a string", `export const go = (o: object) => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(o), "constructor");`, /names constructor/],
  ["a static import of a network module", `import { request } from "node:https";\nexport const go = () => request;`, /imports "node:https"/],
  ["an unused static import", `import "undici";\nexport const go = 1;`, /imports "undici"/],
  ["a re-export from a package", `export { fetch } from "undici";`, /imports "undici"/],
  ["a timer", `export const go = () => setTimeout(() => {}, 1);`, /names the global setTimeout/],
  ["replacing a built-in method", `URL.prototype.toString = () => "https://collector.example.net";`, /assigns to the global URL/],
  ["a member write on an allowed global", `JSON.parse = (text: string) => text;`, /assigns to the global JSON/],
  ["a compound assignment to a global", `export const go = () => { Math.PI += 1; };`, /assigns to the global Math/],
  ["an update of a global", `export const go = () => { (Number as any).x++; };`, /updates the global Number/],
  ["a delete from a global", `export const go = () => delete (Array as any).from;`, /deletes from the global Array/],
  ["a destructuring write into a global", `export const go = (o: any) => { ({ a: (Set as any).x } = o); };`, /assigns to the global Set/],
  ["a for-of write into a global", `export const go = (xs: string[]) => { for ((Map as any).k of xs) void 0; };`, /assigns to the global Map/],
  ["setPrototypeOf", `export const go = (o: object) => Object.setPrototypeOf(o, null);`, /reads setPrototypeOf/],
  ["defineProperty", `export const go = (o: object) => Object.defineProperty(o, "x", {});`, /reads defineProperty/],
  ["__defineGetter__ by name", `export const go = (o: any) => o["__defineGetter__"]("x", () => 1);`, /names __defineGetter__/],
  ["this in a function", `export function go(this: any) { return this; }`, /uses this outside a class body/],
  ["this at the top of a module", `export const self = this;`, /uses this outside a class body/],
  ["this in an object literal method", `export const p = { go() { return this; } };`, /uses this outside a class body/],
  ["Object.assign", `export const go = (a: object, b: object) => Object.assign(a, b);`, /reads assign/],
  ["getOwnPropertyDescriptor", `export const go = (o: object) => Object.getOwnPropertyDescriptor(o, "x");`, /reads getOwnPropertyDescriptor$/],
  ["getOwnPropertyNames", `export const go = () => Object.getOwnPropertyNames(Set);`, /reads getOwnPropertyNames/],
  ["a destructured refused key", `const { prototype: p } = Map;\nexport const go = () => p;`, /names prototype/],
] as const) {
  test(`the egress check refuses ${name}`, () => {
    const violations = check(text);
    assert.ok(violations.some((v) => expected.test(v)), JSON.stringify(violations));
  });
}

test("the egress check resolves bindings: a local named fetch, a property, a type and an allowed import pass", () => {
  assert.deepEqual(check([
    `import type { IncomingMessage } from "node:http";`,
    `import { observeSource } from "@superbee/core/source-engine";`,
    `const fetch = (url: string): string => url;`,
    `const holder = { fetch: 1, self: 2 };`,
    `type Shape = Record<string, Response | IncomingMessage>;`,
    `export function go(input: Shape, arg = holder.fetch): string {`,
    `  const url = new URL("https://tickets.example.org/x");`,
    `  url.searchParams.set("a", encodeURIComponent(JSON.stringify(input)));`,
    `  void observeSource; void arguments;`,
    `  return fetch(url.href) + String(arg) + Math.max(1, Number("2")) + String(holder.self);`,
    `}`,
  ].join("\n")), []);
});

test("the egress check allows this in a class body and writes to local bindings", () => {
  assert.deepEqual(check([
    `class Pager { n = 0; next() { this.n += 1; return this.n; } }`,
    `export const go = () => { const state = { n: 1 }; state.n++; delete (state as any).n; let x = 1; x += 1; return new Pager().next() + x; };`,
  ].join("\n")), []);
});

test("the egress check refuses a CommonJS module", () => {
  assert.ok(check(`module.exports = 1;`, "planted.cjs").some((v) => /CommonJS module is refused/.test(v)));
});

test("by default a relative import must stay inside the scanned roots", () => {
  const root = path.join(here, "fixtures/source-engine");
  const files = [{ path: path.join(root, "planted.ts"), text: `import { a } from "./helper.js";\nimport { b } from "../../src/hosted-client/index.js";\nexport const go = () => [a, b];` }];
  const violations = egressViolations(files, { roots: [root] });
  assert.deepEqual(violations.map((v) => v.replace(/^.*?: /, "")), ['imports "../../src/hosted-client/index.js"']);
  assert.equal(egressViolations(files).length, 2, "with no roots, only scanned modules may be imported");
});

test("the egress check reads JavaScript modules too and names the allowlist it holds", () => {
  assert.ok(check(`export const go = () => fetch("x");`, "planted.mjs").some((v) => /global fetch/.test(v)));
  assert.ok(EGRESS_ALLOWED_GLOBALS.includes("URL") && !EGRESS_ALLOWED_GLOBALS.includes("fetch"));
  assert.deepEqual(egressViolations([{ path: "x.ts", text: `export const go = () => globalThis;` }], { globals: ["globalThis"] }).length, 1, "globalThis cannot be allowed");
});

test("a symlink loop inside a root ends the walk, each directory scanned once", () => {
  const base = mkdtempSync(path.join(tmpdir(), "egress-loop-"));
  try {
    mkdirSync(path.join(base, "a"));
    writeFileSync(path.join(base, "a", "p.ts"), "export const go = () => fetch(\"x\");\n");
    symlinkSync(base, path.join(base, "a", "up"));
    const files = collectSourceFiles([base]);
    assert.deepEqual(files.map((file: { path: string }) => path.relative(base, file.path)), [path.join("a", "p.ts")]);
    assert.ok(egressViolations(files, { roots: [base] }).some((v: string) => /global fetch/.test(v)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an import attribute is not a global, and the CLI fails a root with no module", () => {
  assert.deepEqual(egressViolations([{ path: path.join(here, "fixtures/source-engine/p.ts"), text: `import data from "./data.json" with { type: "json" };\nexport const go = () => data;` }], { roots: [path.join(here, "fixtures/source-engine")] }), []);
  const empty = mkdtempSync(path.join(tmpdir(), "egress-empty-"));
  try {
    assert.throws(() => execFileSync(process.execPath, [path.resolve(here, "../../../scripts/source-egress-check.mjs"), empty], { stdio: "pipe" }), (error: { status?: number }) => error.status === 1);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a relative import is judged by its real path, so a link inside a root cannot admit a file outside it", () => {
  const base = mkdtempSync(path.join(tmpdir(), "egress-real-"));
  try {
    const root = path.join(base, "profiles");
    mkdirSync(root);
    mkdirSync(path.join(base, "outside"));
    writeFileSync(path.join(base, "outside", "native.wasm"), "");
    symlinkSync(path.join(base, "outside", "native.wasm"), path.join(root, "native.wasm"));
    writeFileSync(path.join(root, "profile.ts"), `import "./native.wasm";\nexport const go = 1;\n`);
    const violations = egressViolations(collectSourceFiles([root]), { roots: [root] });
    assert.ok(violations.some((v: string) => /imports "\.\/native\.wasm"/.test(v)), JSON.stringify(violations));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the walk follows a symlinked directory and scans the modules behind it", () => {
  const base = mkdtempSync(path.join(tmpdir(), "egress-link-"));
  try {
    const root = path.join(base, "profiles");
    mkdirSync(root);
    mkdirSync(path.join(base, "outside"));
    writeFileSync(path.join(base, "outside", "net.mjs"), "export const f = () => fetch(\"x\");\n");
    symlinkSync(path.join(base, "outside"), path.join(root, "linked"));
    const files = collectSourceFiles([root]);
    assert.deepEqual(files.map((file: { path: string }) => path.relative(root, file.path)), [path.join("linked", "net.mjs")]);
    assert.ok(egressViolations(files, { roots: [root] }).some((v: string) => /global fetch/.test(v)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
