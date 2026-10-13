import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const invalid = () => new Error("Dependency preflight requires complete reviewed registry lock entries and workspace manifests; restore dependency inputs before installing.");

function canonical(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw invalid(); }
  if (parsed.origin !== "https://registry.npmjs.org" || parsed.username || parsed.password || parsed.search || parsed.hash) throw invalid();
}

function identity(name, entry) {
  if (!NAME.test(name) || !VERSION.test(entry?.version ?? "")) throw invalid();
  if (entry.resolved || entry.integrity) {
    if (typeof entry.resolved !== "string" || typeof entry.integrity !== "string" || !entry.integrity) throw invalid();
    canonical(entry.resolved);
  } else if (entry.metadataOnly !== true) throw invalid();
  return { name, version: entry.version, tarball: entry.resolved, integrity: entry.integrity, ...(entry.metadataOnly ? { metadataOnly: true } : {}) };
}

export function lockedRegistryPackages(lock, manifests, { scopes, replacements = [], allowMetadataOnly = [] } = {}) {
  if (!lock?.packages || !Array.isArray(manifests) || !manifests.length) throw invalid();
  const workspaces = new Map(manifests.map(({ directory, manifest }) => [directory, manifest]));
  const directNames = new Set();
  const selected = new Map();
  const add = (name, entry) => {
    const pkg = identity(name, entry && { ...entry, metadataOnly: allowMetadataOnly.includes(name) && !entry.resolved && !entry.integrity });
    const previous = selected.get(`${name}@${pkg.version}`);
    if (previous && JSON.stringify(previous) !== JSON.stringify(pkg)) throw invalid();
    selected.set(`${name}@${pkg.version}`, pkg);
  };
  for (const { directory, manifest } of manifests) {
    if (typeof directory !== "string" || directory.includes("..") || directory.startsWith("/") || !manifest) throw invalid();
    const direct = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
    for (const name of Object.keys(direct)) {
      if (!NAME.test(name)) throw invalid();
      directNames.add(name);
      const parts = directory ? directory.split("/") : [];
      let entry;
      while (true) {
        entry = lock.packages[[...parts, "node_modules", name].join("/")];
        if (entry || !parts.length) break;
        parts.pop();
      }
      if (entry?.link) {
        if (workspaces.get(entry.resolved)?.name !== name) throw invalid();
      } else add(name, entry);
    }
  }
  const selectedScopes = new Set(scopes ?? [...directNames].filter((name) => name.startsWith("@")).map((name) => name.split("/")[0]));
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.includes("node_modules/") || entry?.link) continue;
    const name = entry.name ?? key.split("node_modules/").at(-1);
    if (selectedScopes.has(name.split("/")[0])) add(name, entry);
  }
  for (const replacement of replacements) {
    const pkg = identity(replacement.name, { version: replacement.version, resolved: replacement.tarball, integrity: replacement.integrity, metadataOnly: replacement.metadataOnly });
    for (const [key, existing] of selected) if (existing.name === pkg.name) selected.delete(key);
    selected.set(`${pkg.name}@${pkg.version}`, pkg);
  }
  return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

async function npmView(bin, args, cwd) {
  return (await exec(bin, args, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout;
}

export async function dependencyPreflight({ packages, cwd, run = npmView, concurrency = 3 }) {
  if (!Array.isArray(packages) || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 3) throw invalid();
  const exact = packages.map((pkg) => identity(pkg.name, { version: pkg.version, resolved: pkg.tarball, integrity: pkg.integrity, metadataOnly: pkg.metadataOnly }));
  let index = 0, failure;
  const worker = async () => {
    while (!failure && index < exact.length) {
      const pkg = exact[index++], id = `${pkg.name}@${pkg.version}`;
      try {
        const dist = JSON.parse(await run("npm", ["view", id, "dist", "--json", "--prefer-online", "--fetch-retries=0", "--fetch-timeout=15000", "--registry=https://registry.npmjs.org"], cwd));
        canonical(dist.tarball);
        if ((pkg.tarball && dist.tarball !== pkg.tarball) || (pkg.integrity && dist.integrity !== pkg.integrity)) throw invalid();
      } catch {
        failure ??= new Error(`Dependency metadata access or identity failed for ${id}. Dependency files were not changed. Check access for this exact package using the existing npm setup, then retry. Preflight does not configure credentials; clean npm ci remains required.`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, exact.length) }, worker));
  if (failure) throw failure;
  return { status: "accessible", packages: exact.length, metadataOnly: exact.filter((pkg) => pkg.metadataOnly).map((pkg) => `${pkg.name}@${pkg.version}`), scope: "exact selected locked registry identities; clean npm ci remains required" };
}
