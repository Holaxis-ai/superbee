import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Resolve executable authority through filesystem identity, including symlinked entrypoints.
 * A failed resolution is unsafe to treat as an import, so it always aborts the caller.
 */
export async function isMainModule(importMetaUrl, options = {}) {
  const argv1 = Object.hasOwn(options, "argv1") ? options.argv1 : process.argv[1];
  const realpathImpl = options.realpathImpl ?? realpath;
  if (argv1 === undefined) return false;
  if (typeof argv1 !== "string" || argv1.length === 0) {
    throw new Error("entrypoint authority requires process.argv[1] to be a non-empty path");
  }

  try {
    const [invocationPath, modulePath] = await Promise.all([
      realpathImpl(argv1),
      realpathImpl(fileURLToPath(importMetaUrl)),
    ]);
    return invocationPath === modulePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`entrypoint authority could not resolve real paths: ${message}`, { cause: error });
  }
}
