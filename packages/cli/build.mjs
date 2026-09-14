import { build } from "esbuild";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { workspaceAliases, runtimeBanner } from "./scripts/bundle-options.mjs";
import { prepareCliBundleInputs } from "./scripts/prepare-bundle-inputs.mjs";
const root = dirname(fileURLToPath(import.meta.url));
await rm(resolve(root, "dist"), { recursive: true, force: true });
await prepareCliBundleInputs();
await build({ absWorkingDir: root, entryPoints: [resolve(root, "src/index.ts")], outfile: resolve(root, "dist/index.mjs"), bundle: true, platform: "node", format: "esm", target: "node20", alias: workspaceAliases, banner: runtimeBanner,
  // A reusable library has no baked distribution policy or identity. Fold their absence into the
  // artifact so a host's same-named globals cannot override its explicit source identity.
  define: {
    __SUPERBEE_BUILD_IDENTITY__: "undefined",
    __SUPERBEE_FUNCTIONAL_VERSION_FLOOR__: "undefined",
    __SUPERBEE_UPDATE_POLICY__: "undefined",
  },
});
// The facade has explicit closed signatures. Generate declarations from these signatures instead
// of publishing declarations for internal engine, transport, and command implementations.
await mkdir(resolve(root, "dist"), { recursive: true });
for (const name of ["index", "public-types"]) {
  const source = await readFile(resolve(root, `src/${name}.ts`), "utf8");
  const result = ts.transpileDeclaration(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext }, fileName: `${name}.ts` });
  if (result.diagnostics?.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, { getCanonicalFileName: p => p, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
  await writeFile(resolve(root, `dist/${name}.d.ts`), result.outputText);
}
