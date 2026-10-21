// Choose the tag GitHub's generated release notes start from. Left to guess, GitHub picks an old
// release for a stable tag cut on a release/<version> branch (v0.4.3 notes started at v0.1.4).
// A stable release starts at the previous stable tag; a prerelease at the previous tag of any kind.
import { readFileSync } from 'node:fs';
import { assertStrictSemver, compareStrictSemver, parseStrictSemver } from './strict-semver.mjs';
import { isMainModule } from './is-main-module.mjs';

export function notesStartTag(version, tags) {
  assertStrictSemver(version, 'release version');
  const stable = parseStrictSemver(version).prerelease === null;
  let best = null;
  for (const tag of tags) {
    if (!/^v/.test(tag)) continue;
    const candidate = tag.slice(1);
    const parsed = parseStrictSemver(candidate);
    if (!parsed || (stable && parsed.prerelease !== null)) continue;
    if (compareStrictSemver(candidate, version) >= 0) continue;
    if (best === null || compareStrictSemver(candidate, best) > 0) best = candidate;
  }
  return best === null ? null : `v${best}`;
}

// Usage: release-notes-start-tag.mjs <version> < tag-names (one per line). Prints the tag, or
// nothing when no earlier release tag exists.
if (isMainModule(import.meta.url)) {
  const tags = readFileSync(0, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  const start = notesStartTag(process.argv[2], tags);
  if (start) process.stdout.write(`${start}\n`);
}
