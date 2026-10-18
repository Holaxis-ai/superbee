/**
 * The static egress check over the profile module scope (the test profiles today, and every module
 * under `src/source-profiles` once it exists), over the engine and harness themselves, and against
 * planted modules that reach for the network around the guarded transport.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectSourceFiles, EGRESS_ALLOWED_GLOBALS, egressViolations } from "../../../scripts/source-egress-check.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../src");
const PROFILE_ROOTS = [path.join(here, "fixtures/source-engine/json-pages-profile.ts"), path.join(SRC, "source-profiles")].filter((p) => existsSync(p));
/** What a profile in the scope may import: its own scope, the engine's public entry and the connector module. */
const PROFILE_IMPORTS = [path.join(SRC, "source-profiles"), path.join(SRC, "source-engine/index.ts"), path.join(SRC, "connectors.ts")];

const resolveTs = (file: string, specifier: string): string => path.resolve(path.dirname(file), specifier).replace(/\.js$/, ".ts");
const allowProfileImport = (specifier: string, file: string): boolean => {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
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
  assert.deepEqual(egressViolations(files, { globals: ["AbortController", "structuredClone"], allowImport: insideSrc }), []);
});

const check = (text: string, name = "planted.ts"): string[] => egressViolations([{ path: name, text }]);

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

test("the egress check reads JavaScript modules too and names the allowlist it holds", () => {
  assert.ok(check(`export const go = () => fetch("x");`, "planted.mjs").some((v) => /global fetch/.test(v)));
  assert.ok(EGRESS_ALLOWED_GLOBALS.includes("URL") && !EGRESS_ALLOWED_GLOBALS.includes("fetch"));
  assert.deepEqual(egressViolations([{ path: "x.ts", text: `export const go = () => globalThis;` }], { globals: ["globalThis"] }).length, 1, "globalThis cannot be allowed");
});
