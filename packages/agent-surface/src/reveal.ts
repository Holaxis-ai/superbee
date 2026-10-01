import { SurfaceContextError } from "./context.js";

export type RevealMode = "off" | "suggestions" | "follow";
export const FOLLOW_MS = 6_000;
export const OFFER_MS = 60_000;
export type RevealNavigationContext = { signal: AbortSignal };
export type RevealSurface<Target> = {
  mode: () => RevealMode;
  quiet?: () => boolean;
  offer?: (target: Target, consumed: () => void) => { dispose(): void } | undefined;
  /** Recheck signal after awaited admission/draft guards and before committing navigation. */
  navigate?: (target: Target, context: RevealNavigationContext) => Promise<boolean>;
};
export type RevealResult<Target> =
  | { ok: true; navigated: true; target: Target }
  | { ok: true; offered: true; target: Target; expiresAt: number }
  | { ok: false; error: { code: string } };

/** The host validates input and resolves targets; this owner applies presentation policy. */
export function createRevealPolicy<Input, Target>(options: {
  surface: RevealSurface<Target>;
  resolve: (input: Input) => { target: Target; signal?: AbortSignal };
  screenSignal: () => AbortSignal;
  lifetime: AbortSignal;
  clock?: {
    now: () => number;
    schedule: (callback: () => void, milliseconds: number) => () => void;
  };
}) {
  const { surface, lifetime } = options;
  const clock = options.clock ?? {
    now: Date.now,
    schedule(callback: () => void, milliseconds: number) {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    },
  };
  let pending: { expiresAt: number; dispose: () => void } | undefined;
  let disposed = false;
  const disposal = new AbortController();
  let lastFollowAt = Number.NEGATIVE_INFINITY;
  let lastMode: RevealMode | undefined;
  const clear = () => {
    const record = pending;
    pending = undefined;
    record?.dispose();
  };
  lifetime.addEventListener("abort", clear, { once: true });
  async function execute(input: Input, invocation?: { signal?: AbortSignal }): Promise<RevealResult<Target>> {
    const hostSignal = invocation?.signal ?? lifetime;
    const refusal = (code: string): RevealResult<Target> => ({ ok: false, error: { code } });
    try {
      if (disposed || lifetime.aborted || hostSignal.aborted) return refusal("unavailable");
      const mode = surface.mode();
      if (lastMode !== undefined && lastMode !== mode) {
        clear();
        lastFollowAt = Number.NEGATIVE_INFINITY;
      }
      lastMode = mode;
      if (mode === "off") return refusal("agent_navigation_off");
      const resolved = options.resolve(input);
      if (resolved.signal?.aborted) return refusal("context_changed");
      if (pending && pending.expiresAt > clock.now()) return refusal("offer_pending");
      clear();
      const target = resolved.target;
      if (mode === "follow" && surface.navigate && (surface.quiet === undefined || surface.quiet())) {
        if (clock.now() - lastFollowAt < FOLLOW_MS) return refusal("follow_pending");
        if (resolved.signal?.aborted) return refusal("context_changed");
        // Stamp attempts so slow or failed navigation cannot outrun the cadence.
        lastFollowAt = clock.now();
        const navigationSignal = AbortSignal.any([
          lifetime, hostSignal, options.screenSignal(), disposal.signal,
          ...(resolved.signal ? [resolved.signal] : []),
        ]);
        const navigated = await surface.navigate(target, { signal: navigationSignal });
        // Successful navigation intentionally changes the old screen revision.
        if (disposed || lifetime.aborted || hostSignal.aborted) return refusal("unavailable");
        return navigated ? { ok: true, navigated: true, target } : refusal("unavailable");
      }
      if (!surface.offer) return refusal("unsupported_host");
      if (resolved.signal?.aborted) return refusal("context_changed");
      const screenSignal = options.screenSignal();
      let consumed = false;
      let record: typeof pending;
      const consume = () => {
        consumed = true;
        if (record && pending === record) clear();
      };
      const offer = surface.offer(target, consume);
      if (!offer) return refusal("unsupported_host");
      if (consumed || disposed || lifetime.aborted || hostSignal.aborted || screenSignal.aborted) {
        offer.dispose();
        return refusal(screenSignal.aborted ? "context_changed" : "unavailable");
      }
      let cancelTimer = () => {};
      record = {
        expiresAt: clock.now() + OFFER_MS,
        dispose() {
          cancelTimer();
          screenSignal.removeEventListener("abort", consume);
          hostSignal.removeEventListener("abort", consume);
          offer.dispose();
        },
      };
      pending = record;
      cancelTimer = clock.schedule(consume, OFFER_MS);
      screenSignal.addEventListener("abort", consume, { once: true });
      hostSignal.addEventListener("abort", consume, { once: true });
      return { ok: true, offered: true, target, expiresAt: record.expiresAt };
    } catch (error) {
      return refusal(error instanceof SurfaceContextError ? error.code : "unavailable");
    }
  }
  return {
    execute,
    dispose() {
      disposed = true;
      disposal.abort();
      lifetime.removeEventListener("abort", clear);
      clear();
    },
  };
}
