import { build } from "esbuild";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { workspaceAliases, runtimeBanner } from "./scripts/bundle-options.mjs";
import { prepareCliBundleInputs } from "./scripts/prepare-bundle-inputs.mjs";
import { captureSourceState, embeddedEngineRecord } from "./scripts/embedded-engine.mjs";
const root = dirname(fileURLToPath(import.meta.url));
// Source facts describe the tree the bundler reads, so capture them before this build writes.
const sourceState = captureSourceState();
await rm(resolve(root, "dist"), { recursive: true, force: true });
await prepareCliBundleInputs();
const runtimeBuild = await build({ metafile:true, absWorkingDir: root, entryPoints: [resolve(root, "src/index.ts")], outfile: resolve(root, "dist/index.mjs"), bundle: true, platform: "node", format: "esm", target: "node20", alias: workspaceAliases, banner: runtimeBanner,
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
for (const name of ["index", "public-types", "runtime-types", "host-command-error", "resources"]) {
  let source = await readFile(resolve(root, `src/${name}.ts`), "utf8");
  if(name==="index")source=source.replace('export { createCliRuntime, createPosixCliRuntime } from \'./runtime.js\';', 'import type { CliRuntime, CliRuntimeOptions, CliDistribution } from "./runtime-types.js";\nexport declare function createCliRuntime(options:CliRuntimeOptions):CliRuntime;\nexport declare function createPosixCliRuntime(distribution:CliDistribution):CliRuntime;');
  const result = ts.transpileDeclaration(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext }, fileName: `${name}.ts` });
  if (result.diagnostics?.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, { getCanonicalFileName: p => p, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
  await writeFile(resolve(root, `dist/${name}.d.ts`), result.outputText);
}

await writeFile(resolve(root, "dist/embedded-engine.json"), JSON.stringify(embeddedEngineRecord({ metafile: runtimeBuild.metafile, ...sourceState }), null, 2) + "\n");

await mkdir(resolve(root,'../../out'),{recursive:true});
await writeFile(resolve(root,'../../out/cli-runtime-metafile.json'),JSON.stringify(runtimeBuild.metafile,null,2)+'\n');
const inventoryBuild=await build({entryPoints:[resolve(root,'src/distribution-resources.ts')],bundle:true,format:'esm',platform:'node',write:false});
const {DISTRIBUTION_RESOURCES}=await import('data:text/javascript;base64,'+Buffer.from(inventoryBuild.outputFiles[0].text).toString('base64'));
const references=await Promise.all(DISTRIBUTION_RESOURCES.map(async row=>({path:'references/'+row.dest,content:await readFile(resolve(root,'../..',row.src),'utf8')})));
await build({entryPoints:[resolve(root,'src/resources.ts')],outfile:resolve(root,'dist/resources.mjs'),bundle:true,format:'esm',platform:'node',target:'node20',define:{__SUPERBEE_DISTRIBUTION_REFERENCES__:JSON.stringify(references)}});
