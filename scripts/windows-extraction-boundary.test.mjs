import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import { buildCliBundle } from "../packages/superbee/scripts/build-bundle.mjs";

const root = path.resolve(import.meta.dirname, "..");
const windowsPackage =
  /(?:^|\/)@superbee\/windows-cli(?:\/|$)|(?:^|\/)superbee-windows-cli(?:\/|$)/;
const windowsAdapter = "packages/superbee/src/windows/";

function fromGraph(owner, input) {
  return path.relative(root, path.resolve(root, "packages", owner, input)).split(path.sep).join("/");
}

function assertMaintainedGraph(meta, owner) {
  assert.ok(Object.keys(meta.inputs).length > 10, "proof requires a complete bundled dependency graph");
  const adapters = [];
  for (const [input, details] of Object.entries(meta.inputs)) {
    assert.doesNotMatch(input, windowsPackage, "separate Windows package must not enter maintained graph");
    if (fromGraph(owner, input).startsWith(windowsAdapter)) adapters.push(input);
    for (const edge of details.imports) {
      assert.doesNotMatch(edge.path, windowsPackage, "separate Windows dependency must not enter maintained graph");
    }
  }
  if (owner === "superbee") {
    assert.ok(adapters.length > 0, "first-party executable must bundle its native Windows adapter");
  } else {
    assert.deepEqual(adapters, [], "shared CLI must not bundle first-party host policy");
  }
}

function assertNoWindowsHostImplementation(source, filename) {
  const runtime = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const tree = ts.createSourceFile(
    filename,
    runtime,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const forbiddenHostNames = new Set([
    "LOCALAPPDATA",
    "APPDATA",
    "PATHEXT",
    "ComSpec",
    "COMSPEC",
    "windowsHide",
    "windowsVerbatimArguments",
  ]);
  function visit(node) {
    // Inspect executable syntax only: comments and portable path-data validation are not host policy.
    if (ts.isStringLiteral(node) || ts.isIdentifier(node)) {
      assert.ok(
        !forbiddenHostNames.has(node.text),
        `${filename}: Windows host primitive ${node.text} belongs in the adapter`,
      );
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "win32") {
      assert.fail(
        `${filename}: Windows path implementation belongs in the adapter`,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}

test("only the first-party executable graph owns the Windows adapter", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-host-graph-"));
  try {
    const result = await buildCliBundle(path.join(scratch, "superbee.mjs"), {
      artifactChannel: "local-dev",
      functionalVersionFloor: "1.0.0",
      updatePolicy: { enabled: false },
      metafile: true,
    });
    const reusable = JSON.parse(
      await readFile(path.join(root, "out/cli-runtime-metafile.json"), "utf8"),
    );
    for (const [owner, meta] of [["superbee", result.metafile], ["cli", reusable]]) {
      assertMaintainedGraph(meta, owner);
      const poisoned = structuredClone(meta);
      poisoned.inputs[
        "node_modules/@superbee/windows-cli/dist/filesystem.mjs"
      ] = { bytes: 1, imports: [] };
      assert.throws(() => assertMaintainedGraph(poisoned, owner), /Windows package/);
    }
    const leaked = structuredClone(reusable);
    leaked.inputs["../superbee/src/windows/host.ts"] = { bytes: 1, imports: [] };
    assert.throws(() => assertMaintainedGraph(leaked, "cli"), /must not bundle/);

    const sources = new Set(
      [["superbee", result.metafile], ["cli", reusable]].flatMap(([owner, meta]) =>
        Object.keys(meta.inputs).map((input) => fromGraph(owner, input))),
    );
    for (const relative of sources) {
      if (!/^packages\/(core|board-git|cli)\/src\//.test(relative) || relative.includes("/generated/")) continue;
      assertNoWindowsHostImplementation(await readFile(path.join(root, relative), "utf8"), relative);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("host-boundary proof rejects renamed files retaining Windows primitives", () => {
  for (const source of [
    "const root = process.env.LOCALAPPDATA;",
    'const root = process.env["LOCALAPPDATA"];',
    "const parts = path.win32.parse(value);",
    "spawn(cmd, [], {windowsHide:true});",
  ])
    assert.throws(
      () => assertNoWindowsHostImplementation(source, "neutral.ts"),
      /Windows/,
    );
  assert.doesNotThrow(() =>
    assertNoWindowsHostImplementation(
      "interface AdapterOptions {windowsVerbatimArguments?: boolean}",
      "types.ts",
    ),
  );
  assert.doesNotThrow(() =>
    assertNoWindowsHostImplementation(
      "// LOCALAPPDATA\nconst valid = /^[a-z]:/i.test(input);",
      "validation.ts",
    ),
  );
});

test("native Windows installs the sole first-party package and bin", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "packages/superbee/package.json"), "utf8"));
  assert.equal(pkg.name, "superbee");
  assert.deepEqual(pkg.os, ["darwin", "linux", "win32"]);
  assert.deepEqual(pkg.bin, { superbee: "dist/superbee.mjs" });
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages["packages/superbee"].os, pkg.os);
  for (const dependency of Object.keys(lock.packages)) {
    assert.doesNotMatch(dependency, windowsPackage, "the lock must not carry a separate Windows distribution");
  }
});
