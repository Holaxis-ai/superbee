import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = ['core', 'server', 'markdown-renderer'];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$(?![\s\S])/;

// This is the renderer's intentionally bounded policy, not a general semver engine:
// stable caret alternatives and exact versions; prereleases require an exact opt-in.
export function peerAdmits(version, range) {
  const target = versionPattern.exec(version);
  if (!target || typeof range !== 'string') return false;
  const alternatives = range.split('||').map(value => value.trim());
  const parsed = alternatives.map(value => {
    const caret = value.startsWith('^');
    const match = versionPattern.exec(caret ? value.slice(1) : value);
    if (!match || (caret && match[4])) throw new Error('supported peer policy: exact versions or stable ^major.minor.patch alternatives joined by ||');
    return { value, caret, match };
  });
  return parsed.some(({ value, caret, match }) => {
    if (!caret) return version === value;
    if (target[4]) return false;
    const current = target.slice(1, 4).map(BigInt);
    const minimum = match.slice(1, 4).map(BigInt);
    const firstNonzero = minimum.findIndex(number => number !== 0n);
    const upperIndex = firstNonzero < 0 ? 2 : firstNonzero;
    for (let index = 0; index < upperIndex; index += 1)
      if (current[index] !== minimum[index]) return false;
    if (current[upperIndex] !== minimum[upperIndex]) return false;
    for (let index = upperIndex + 1; index < 3; index += 1) {
      if (current[index] !== minimum[index]) return current[index] > minimum[index];
    }
    return true;
  });
}

export function checkPackageVersions(directory = root) {
  const errors = [];
  const read = file => {
    try {
      const value = JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected object');
      return value;
    }
    catch (error) { errors.push(`${file}: expected readable JSON source (${error.code ?? error.name})`); return {}; }
  };
  const equal = (file, field, actual, expected, source) => {
    if (!isDeepStrictEqual(actual, expected)) errors.push(`${file} ${field}: found ${JSON.stringify(actual) ?? 'missing'}; expected ${JSON.stringify(expected)} from ${source}`);
  };
  const manifests = Object.fromEntries(names.map(name => [name, read(`packages/${name}/package.json`)]));
  const lock = read('package-lock.json');
  equal('package-lock.json', 'lockfileVersion', lock.lockfileVersion, 3, 'repository npm lockfile format');
  for (const name of names) {
    const file = `packages/${name}/package.json`;
    const manifest = manifests[name];
    equal(file, 'name', manifest.name, `@superbee/${name}`, 'scoped workspace identity');
    if (manifest.private === true) errors.push(`${file} private: expected publishable package from scoped runtime-library policy`);
    equal(file, 'publishConfig.access', manifest.publishConfig?.access, name === 'markdown-renderer' ? 'restricted' : 'public', 'scoped runtime-library publish policy');
    equal(file, 'publishConfig.registry', manifest.publishConfig?.registry, 'https://registry.npmjs.org/', 'scoped runtime-library publish policy');
    if (typeof manifest.version !== 'string' || !versionPattern.test(manifest.version)) errors.push(`${file} version: expected major.minor.patch or prerelease version source`);
    const locked = lock.packages?.[`packages/${name}`];
    if (!locked) errors.push(`package-lock.json packages/${name}: missing workspace record; expected metadata from ${file}`);
    for (const field of ['name', 'version', 'dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies'])
      equal('package-lock.json', `packages/${name}.${field}`, locked?.[field], manifest[field], file);
    const link = lock.packages?.[`node_modules/@superbee/${name}`];
    equal('package-lock.json', `node_modules/@superbee/${name}.link`, link?.link, true, file);
    equal('package-lock.json', `node_modules/@superbee/${name}.resolved`, link?.resolved, `packages/${name}`, file);
  }
  const core = manifests.core.version;
  equal('packages/server/package.json', 'version', manifests.server.version, core, 'packages/core/package.json version');
  equal('packages/server/package.json', 'dependencies.@superbee/core', manifests.server.dependencies?.['@superbee/core'], core, 'packages/core/package.json version (exact synchronized dependency)');
  const peer = manifests['markdown-renderer'].peerDependencies?.['@superbee/core'];
  try {
    if (!peerAdmits(core, peer)) errors.push(`packages/markdown-renderer/package.json peerDependencies.@superbee/core: ${JSON.stringify(peer) ?? 'missing'} must admit ${JSON.stringify(core)} from packages/core/package.json version; prereleases need exact opt-in`);
  } catch (error) { errors.push(`packages/markdown-renderer/package.json peerDependencies.@superbee/core: ${error.message}; source packages/markdown-renderer/package.json peer policy`); }
  return errors;
}
