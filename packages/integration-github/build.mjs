import {execFileSync} from 'node:child_process';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const directory = fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(directory, '../..');
await rm(path.join(directory, 'dist'), {recursive:true, force:true});
await rm(path.join(directory, 'recipes'), {recursive:true, force:true});
await mkdir(path.join(directory, 'dist'), {recursive:true});
const recipes = {};
for (const name of ['source-feeds', 'work-items']) {
  const source = path.join(root, 'examples/recipes', name);
  const rows = [];
  async function walk(relative = '') {
    for (const entry of (await readdir(path.join(source, relative), {withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const bytes = await readFile(path.join(source,file),'utf8');
        rows.push({path:file,bytes});
        const target = path.join(directory,'recipes',name,file);
        await mkdir(path.dirname(target),{recursive:true});
        await writeFile(target,bytes);
      } else throw new Error(`Nonregular recipe input: ${file}`);
    }
  }
  await walk(); recipes[name] = rows;
}
await writeFile(path.join(directory,'dist/recipes.mjs'),`// Generated from examples/recipes; edit those canonical inputs.\nconst recipes = ${JSON.stringify(recipes)};\nexport const RECIPE_IDS = Object.freeze(Object.keys(recipes));\nexport function recipeFiles(id) {\n  if (!Object.hasOwn(recipes,id)) throw new Error('Unknown GitHub integration recipe');\n  return recipes[id].map(row => ({...row}));\n}\n`);
await writeFile(path.join(directory,'dist/recipes.d.ts'),'import type {RecipeFile} from "@superbee/core/recipes";\nexport declare const RECIPE_IDS: readonly string[];\nexport declare function recipeFiles(id: string): RecipeFile[];\n');
execFileSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'--project',path.join(directory,'tsconfig.json'),'--emitDeclarationOnly'],{stdio:'inherit'});
await build({entryPoints:[path.join(directory,'src/profile.ts')],outfile:path.join(directory,'dist/profile.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022',sourcemap:false});
