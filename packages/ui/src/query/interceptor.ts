/**
 * One terminal interceptor state for failures that must stop all polling: remote authentication
 * rejection (401), rate limiting (429), or the shell's expired local session (403). A 401 requires
 * restarting the remote UI with valid credentials; a shell 403 requires reopening the URL printed
 * by the current `ui` process.
 *
 * The sandboxed View-bytes route's 403 is separate: iframe navigation does not pass through this
 * fetch interceptor. The SSE reconnect probe writes here only when the ordinary session-gated
 * `/__ui/config` endpoint returns 403, never when nonce minting rejects a malformed View entry.
 *
 * The module-level store is exposed through `useSyncExternalStore`. Once tripped it remains
 * terminal until a fresh page load, preventing dead credentials from poll-looping into 429s.
 */
import { useSyncExternalStore } from "react";

export type InterceptorStatus = "ok" | "unauthorized" | "rate_limited" | "session_expired";

let status: InterceptorStatus = "ok";
const listeners = new Set<() => void>();

export function getInterceptorStatus(): InterceptorStatus {
  return status;
}

/** Set the interceptor status. Once tripped (non-"ok"), it stays tripped for the session — recovery is a fresh page load after the operator follows the terminal recovery instructions, never an automatic reset. */
export function setInterceptorStatus(next: InterceptorStatus): void {
  if (next === status) return;
  if (status !== "ok") return; // terminal — never downgrades back to "ok" or flips between tripped states
  status = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useInterceptorStatus(): InterceptorStatus {
  return useSyncExternalStore(subscribe, getInterceptorStatus);
}

/** Test-only reset (there is no in-app way to un-trip the interceptor by design). */
export function __resetInterceptorForTests(): void {
  status = "ok";
}
