import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);

test('packed Markdown renderer is a CLI-free browser and static library', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'superbee-markdown-consumer-'));
  const npm = (args, cwd = root) => {
    assert.ok(process.env.npm_execpath, 'run through npm run test:scripts');
    return exec(process.execPath, [process.env.npm_execpath, ...args], { cwd, maxBuffer: 10 * 1024 * 1024 });
  };
  try {
    const artifacts = path.join(scratch, 'artifacts');
    await mkdir(artifacts);
    const tarballs = [];
    for (const name of ['core', 'markdown-renderer']) {
      const result = await npm(['pack', '-w', `@superbee/${name}`, '--json', '--pack-destination', artifacts]);
      const [receipt] = JSON.parse(result.stdout);
      assert.ok(receipt.files.some(f => f.path === 'dist/index.d.ts'));
      tarballs.push(path.join(artifacts, receipt.filename));
    }
    await writeFile(path.join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await npm(['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs,
      'react@19', 'react-dom@19', '@types/react@19', '@types/react-dom@19', 'typescript@5.9.2'], scratch);
    const manifest = JSON.parse(await readFile(path.join(scratch, 'node_modules/@superbee/markdown-renderer/package.json'), 'utf8'));
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.publishConfig.access, 'restricted');
    assert.equal(manifest.peerDependencies['@superbee/core'], '^0.1.3');
    const lock = JSON.parse(await readFile(path.join(scratch, 'package-lock.json'), 'utf8'));
    for (const pkg of Object.keys(lock.packages))
      assert.ok(!/(?:^|\/)node_modules\/(?:superbee|@superbee\/(?:server|ui-server|publication))$/.test(pkg), `unexpected dependency ${pkg}`);

    const entry = path.join(scratch, 'consumer.ts');
    await writeFile(entry, `import { renderMarkdown, type RenderOptions } from '@superbee/markdown-renderer';
const options: RenderOptions = { fromId: 'tasks/a', onNavigateDoc: () => {},
  hrefForDoc: id => '/bundles/one/documents/' + encodeURIComponent(id) };
export const rendered = renderMarkdown('See [target](../docs/b.md).', options);
`);
    const result = await build({ absWorkingDir: scratch, entryPoints: [entry], bundle: true,
      platform: 'browser', format: 'esm', write: false, metafile: true });
    assert.ok(result.outputFiles[0].text.length > 0);
    for (const input of Object.keys(result.metafile.inputs)) {
      assert.ok(!input.includes(root), `workspace source leaked: ${input}`);
      assert.ok(!input.startsWith('node:'), `Node builtin leaked: ${input}`);
    }
    await exec(process.execPath, [path.join(scratch, 'node_modules/typescript/bin/tsc'), '--noEmit',
      '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', entry],
    { cwd: scratch });
    const probe = path.join(scratch, 'static.mjs');
    await writeFile(probe, `import assert from 'node:assert/strict';
import { renderMarkdownToStaticHtml } from '@superbee/markdown-renderer/static';
const result = renderMarkdownToStaticHtml('# Hello\\n\\n<script>alert(1)</script>', { fromId: 'docs/a' });
assert.match(result.html, /<h1>Hello<\\/h1>/);
assert.ok(!result.html.includes('<script>'));
assert.equal(result.bounded, false);
`);
    await exec(process.execPath, [probe], { cwd: scratch });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
