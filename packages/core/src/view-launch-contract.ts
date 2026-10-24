/** In-process continuity only: an attempt grants no View, session or execution authority. */
export interface ViewLaunchAttempt {
  readonly generation: number;
  readonly selectionKey: string;
}

export interface ViewLaunchFence {
  begin(selectionKey: string): ViewLaunchAttempt;
  current(): ViewLaunchAttempt | null;
  isCurrent(attempt: ViewLaunchAttempt): boolean;
  retire(attempt: ViewLaunchAttempt): boolean;
}

export type ViewLaunchFailureReason =
  | "context-required" | "expired" | "changed"
  | "denied" | "unavailable" | "delivery-failed";

export function createViewLaunchFence(): ViewLaunchFence {
  let generation = 0;
  let current: ViewLaunchAttempt | null = null;
  return {
    begin(selectionKey) {
      // Exhaustion invalidates the old attempt rather than reusing an imprecise generation.
      current = null;
      if (generation === Number.MAX_SAFE_INTEGER) throw new RangeError("View launch generation exhausted");
      current = Object.freeze({ generation: ++generation, selectionKey });
      return current;
    },
    current: () => current,
    isCurrent: attempt => current !== null && current === attempt,
    retire(attempt) {
      if (current === null || current !== attempt) return false;
      current = null;
      return true;
    },
  };
}
