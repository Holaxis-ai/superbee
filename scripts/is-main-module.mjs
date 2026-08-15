import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolve executable authority through filesystem identity, including symlinked entrypoints.
 * A failed resolution is unsafe to treat as an import, so it always aborts the caller.
 */
function authorityError(kind, error) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`entrypoint authority could not resolve ${kind} path: ${message}`, { cause: error });
}

function resolveInvocationPath(argv1, realpathImpl) {
  if (typeof argv1 !== "string" || argv1.length === 0) {
    throw new Error("entrypoint authority requires process.argv[1] to be a non-empty path");
  }
  try {
    return realpathImpl(argv1);
  } catch (error) {
    throw authorityError("invocation", error);
  }
}

function resolveModulePath(importMetaUrl, realpathImpl) {
  const modulePath = fileURLToPath(importMetaUrl);
  try {
    return realpathImpl(modulePath);
  } catch (error) {
    throw authorityError("module", error);
  }
}

export function createIsMainModule({ getArgv1 = () => process.argv[1], realpathImpl = realpathSync } = {}) {
  const missingEntrypoint = Symbol("missing-entrypoint");
  let cachedInvocationPath;
  let hasCachedInvocationPath = false;

  return function isMainModule(importMetaUrl, options = {}) {
    const resolveRealpath = options.realpathImpl ?? realpathImpl;
    const hasInvocationOverride = Object.hasOwn(options, "argv1");
    const hasRealpathOverride = Object.hasOwn(options, "realpathImpl");
    const invocationPath = hasInvocationOverride
      ? resolveInvocationPath(options.argv1, resolveRealpath)
      : hasRealpathOverride
        ? (() => {
            const argv1 = getArgv1();
            if (argv1 === undefined) return missingEntrypoint;
            return resolveInvocationPath(argv1, resolveRealpath);
          })()
        : (() => {
            if (!hasCachedInvocationPath) {
              const argv1 = getArgv1();
              cachedInvocationPath = argv1 === undefined ? missingEntrypoint : resolveInvocationPath(argv1, resolveRealpath);
              hasCachedInvocationPath = true;
            }
            return cachedInvocationPath;
          })();
    if (invocationPath === missingEntrypoint) return false;
    const modulePath = resolveModulePath(importMetaUrl, resolveRealpath);
    return invocationPath === modulePath;
  };
}

export const isMainModule = createIsMainModule();
