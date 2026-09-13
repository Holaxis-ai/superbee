import { checkPackageVersions } from './package-version-policy.mjs';

const start = performance.now();
const errors = checkPackageVersions();
const invalidUsage = process.argv.length !== 2;
if (invalidUsage) errors.push('Usage: node scripts/package-version-preflight.mjs (no arguments; checks this repository)');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = invalidUsage ? 2 : 1;
} else {
  console.log(`Package version source preflight passed (${Math.round(performance.now() - start)} ms; no install/build/registry access).`);
}
