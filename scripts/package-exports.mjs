/**
 * Resolve a package `exports` target using Node's conditional-object order: the first matching
 * condition wins, while `default` always matches. Browser proofs use `browser` + `import`; the
 * installed-consumer proof separately exercises `node` + `import` and `node` + `require`.
 */
export function publicExportSpecifiers(manifest, packageName) {
  const exports = manifest.exports;
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) {
    throw new TypeError(`${packageName} package must declare an exports object`);
  }
  return Object.keys(exports)
    .sort()
    .map((entry) => {
      if (entry !== "." && !entry.startsWith("./")) throw new TypeError(`unsupported export key ${entry}`);
      return entry === "." ? packageName : `${packageName}/${entry.slice(2)}`;
    });
}

function resolveConditionalTarget(value, conditions) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      try {
        return resolveConditionalTarget(candidate, conditions);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
    throw new TypeError("no conditional export array target matches");
  }
  if (!value || typeof value !== "object") throw new TypeError("unsupported conditional export target");
  for (const [condition, target] of Object.entries(value)) {
    if (condition === "default" || conditions.has(condition)) return resolveConditionalTarget(target, conditions);
  }
  throw new TypeError("no conditional export target matches");
}

export function resolvePackageExportTargets(manifest, packageName, conditions) {
  const enabledConditions = new Set(conditions);
  const exports = manifest.exports;
  const specifiers = publicExportSpecifiers(manifest, packageName);
  return specifiers.map((specifier) => {
    const key = specifier === packageName ? "." : `./${specifier.slice(`${packageName}/`.length)}`;
    const target = resolveConditionalTarget(exports[key], enabledConditions);
    if (!target.startsWith("./")) throw new TypeError(`export ${key} resolves outside its package: ${target}`);
    return { key, specifier, target };
  });
}
