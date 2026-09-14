import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, mkdir, readdir, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from './process.mjs';
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function npmCli() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    try { candidates.push(await realpath(path.join(dir, 'npm'))); } catch { /* continue */ }
  }
  for (const file of candidates.filter(Boolean)) { try { if ((await stat(file)).isFile() && /(?:npm-cli\.js|npm)$/.test(file)) return file; } catch { /* continue */ } }
  throw new Error('Cannot locate npm-cli.js; run via npm exec or install npm beside Node');
}
export async function install(spec, root, env, evidence) {
  assert.match(spec.sha256, /^[a-f0-9]{64}$/); assert.match(spec.source, /^[a-f0-9]{40}$/);
  assert.ok(['local-dev', 'npm-package'].includes(spec.channel));
  const tarball = await realpath(spec.path);
  assert.equal(digest(await readFile(tarball)), spec.sha256, 'artifact SHA-256 mismatch');
  const prefix = path.join(root, 'install'); await mkdir(prefix);
  const result = await run(process.execPath, [await npmCli(), 'install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball], { cwd: root, env, timeout: 60000 });
  evidence.install = result; assert.equal(result.code, 0, result.stderr); assert.equal(result.failure, null);
  const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  if (process.platform !== 'win32') await symlink(process.execPath,path.join(binDir,'node'));
  env.PATH = binDir + path.delimiter + env.PATH; env.npm_config_prefix = prefix;
  const modules = process.platform === 'win32' ? path.join(prefix,'node_modules') : path.join(prefix,'lib','node_modules');
  const names = (await readdir(modules)).filter((n) => n !== '.bin' && !n.startsWith('.'));
  const packages = [];
  for (const name of names) { if (name.startsWith('@')) for (const leaf of await readdir(path.join(modules, name))) packages.push(`${name}/${leaf}`); else packages.push(name); }
  assert.equal(packages.length, 1, 'Only a zero-runtime-dependency artifact is supported');
  const packageRoot = path.join(modules, packages[0]);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(Object.keys(manifest.dependencies || {}).length, 0, 'runtime dependencies require an explicit offline installation adapter');
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.superbee;
  assert.equal(typeof bin, 'string');
  const executable = await realpath(path.join(packageRoot, bin));
  assert.ok(executable.startsWith(packageRoot + path.sep), 'bin escapes installed package');
  const resultVersion = await run(process.execPath, [executable, 'version', '--json'], { cwd: root, env });
  evidence.version = resultVersion; assert.equal(resultVersion.code, 0); assert.equal(resultVersion.failure, null);
  const version = JSON.parse(resultVersion.stdout), identity = version.identity;
  assert.equal(identity.schema, 'superbee.build-identity.v1');
  assert.equal(identity.source.commit, spec.source); assert.equal(identity.source.dirty, false, 'artifact source must be clean');
  assert.equal(identity.artifact.channel, spec.channel);
  assert.equal(identity.artifact.sha256, `sha256:${digest(await readFile(executable))}`);
  assert.equal(identity.runtime.executable_path, executable); assert.equal(version.drift.version_mismatch, false);
  assert.deepEqual(identity.package, { name: manifest.name, version: manifest.version });
  assert.equal(resultVersion.stderr, '');
  const exports = manifest.exports; assert.ok(exports && typeof exports === 'object');
  evidence.exports = exports; evidence.exportProbes = {};
  for (const [name, target] of Object.entries(exports)) {
    const targets = typeof target === 'string' ? [target] : Object.values(target);
    for (const file of targets) {
      assert.equal(typeof file,'string'); const resolved = await realpath(path.join(packageRoot,file));
      assert.ok(resolved.startsWith(packageRoot+path.sep), 'export escapes installed package');
    }
    if (name === '.') continue; // The executable entry was tested by version, never imported for reflection.
    const file = typeof target === 'string' ? target : target.default;
    assert.equal(typeof file,'string');
    const probe = await run(process.execPath,['--input-type=module','-e',`const value = await import(${JSON.stringify(pathToFileURL(path.join(packageRoot,file)).href)}); console.log(JSON.stringify(Object.keys(value).sort()));`], {cwd:root,env});
    evidence.exportProbes[name]=probe; assert.equal(probe.code,0,probe.stderr); assert.equal(probe.failure,null); assert.equal(probe.stderr,'');
    assert.ok(Array.isArray(JSON.parse(probe.stdout)));
  }
  evidence.identity = version; evidence.tarball = { ...spec, path: tarball };
  return { executable, packageRoot, manifest, identity };
}
