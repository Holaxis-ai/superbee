import { readBundleTimeZone, type Bundle, type BundleTimeZone } from "@superbee/core";

export const DEFAULT_BUNDLE_SETTINGS_TIMEOUT_MS = 5_000;

/** Cancel a stalled settings read, with a wait bound for custom backends that ignore cancellation. */
export async function readViewBundleTimeZone(
  bundle: Bundle,
  timeoutMs = DEFAULT_BUNDLE_SETTINGS_TIMEOUT_MS,
): Promise<BundleTimeZone> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readBundleTimeZone(bundle, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Bundle settings read timed out; check bundle access and retry.");
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
