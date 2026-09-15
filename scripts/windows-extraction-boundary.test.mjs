import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import { buildCliBundle } from "../packages/superbee/scripts/build-bundle.mjs";

const root = path.resolve(import.meta.dirname, "..");
const windowsPackage =
  /(?:^|\/)@superbee\/windows-cli(?:\/|$)|(?:^|\/)superbee-windows-cli(?:\/|$)/;
const windowsImplementationFile =
  /(?:^|\/)windows-(?:host|filesystem|board|private-state|cli)(?:\.|\/)/;

function assertMaintainedGraph(meta) {
  assert.ok(
    Object.keys(meta.inputs).length > 10,
    "proof requires a complete bundled dependency graph",
  );
  for (const [input, details] of Object.entries(meta.inputs)) {
    assert.doesNotMatch(
      input,
      windowsPackage,
      "Windows package must not enter maintained graph",
    );
    assert.doesNotMatch(
      input,
      windowsImplementationFile,
      "Windows implementation must not enter maintained graph",
    );
    for (const edge of details.imports) {
      assert.doesNotMatch(
        edge.path,
        windowsPackage,
        "Windows dependency must not enter maintained graph",
      );
    }
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

test("maintained executable and shared CLI dependency graphs exclude the Windows implementation", async () => {
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
    for (const meta of [result.metafile, reusable]) {
      assertMaintainedGraph(meta);
      const poisoned = structuredClone(meta);
      poisoned.inputs[
        "node_modules/@superbee/windows-cli/dist/filesystem.mjs"
      ] = { bytes: 1, imports: [] };
      assert.throws(() => assertMaintainedGraph(poisoned), /Windows package/);
    }
    for (const input of Object.keys(result.metafile.inputs)) {
      const absolute = path.resolve(root, "packages/superbee", input);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (
        !/^packages\/(core|board-git|cli)\/src\//.test(relative) ||
        relative.includes("/generated/")
      )
        continue;
      assertNoWindowsHostImplementation(
        await readFile(absolute, "utf8"),
        relative,
      );
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

test("Windows installation and CI responsibility are absent from maintained distribution", async () => {
  const pkg = JSON.parse(
    await readFile(path.join(root, "packages/superbee/package.json"), "utf8"),
  );
  assert.deepEqual(pkg.os, ["darwin", "linux"]);
  const workflows = await readdir(path.join(root, ".github/workflows"));
  assert.ok(!workflows.includes("windows-installed-package.yml"));
  assert.ok(!workflows.includes("windows-support-probe.yml"));
  for (const file of workflows.filter((name) => /\.ya?ml$/.test(name))) {
    const workflow = await readFile(
      path.join(root, ".github/workflows", file),
      "utf8",
    );
    assert.doesNotMatch(
      workflow,
      /^\s*runs-on:\s*windows-/m,
      `${file}: Windows native CI belongs to its distribution`,
    );
  }
});
