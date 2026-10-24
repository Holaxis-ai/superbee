import type { ViewLaunchAttempt, ViewLaunchFence } from "@superbee/core/view-launch-contract";

export interface DurableActivityState {
  fence: ViewLaunchFence;
  attempt: ViewLaunchAttempt;
  visibilityState: DocumentVisibilityState;
  suspendedLaunchId: string | null;
}

export function mayForwardDurableActivity(state: DurableActivityState): boolean {
  return (
    state.fence.isCurrent(state.attempt) &&
    state.visibilityState === "visible" &&
    state.suspendedLaunchId === null
  );
}
