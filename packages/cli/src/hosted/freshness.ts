// How current a hosted checkout is: when its last pull succeeded and when a background pull last
// tried. Kept beside the binding in private state (`hosted-checkouts/<id>/freshness.json`), never
// in the folder. Only `sync`, an automatic pull on a read, and the session-start pull write it.
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { readUserStateFile, writeUserStateFileAtomic0600 } from "../user-state.js";
import { checkoutDir } from "./binding.js";

/** A read pulls first once the last pull is older than this. */
export const HOSTED_AUTOPULL_STALE_MS = 5 * 60_000;
/** The whole network budget of a pull that rides on a read. */
export const HOSTED_AUTOPULL_BUDGET_MS = 2_000;
/** Past this age a read warns that the checkout may be out of date. */
export const HOSTED_STALE_WARNING_MS = 30 * 60_000;

const FRESHNESS_FILE = "freshness.json";
const MAX_BYTES = 4 * 1024;

export interface CheckoutFreshness {
  /** The last pull that completed, ISO 8601. */
  readonly pulled_at: string | null;
  /** The last automatic pull that started, whether or not it completed. */
  readonly attempt_at: string | null;
}

const EMPTY: CheckoutFreshness = { pulled_at: null, attempt_at: null };

export async function readFreshness(home: string, checkoutId: string): Promise<CheckoutFreshness> {
  const file = join(checkoutDir(home, checkoutId), FRESHNESS_FILE);
  try {
    await lstat(file);
    const value = JSON.parse(await readUserStateFile(home, file, MAX_BYTES)) as Partial<CheckoutFreshness> | null;
    return {
      pulled_at: typeof value?.pulled_at === "string" ? value.pulled_at : null,
      attempt_at: typeof value?.attempt_at === "string" ? value.attempt_at : null,
    };
  } catch {
    return EMPTY;
  }
}

async function update(home: string, checkoutId: string, change: Partial<CheckoutFreshness>): Promise<void> {
  const next = { ...(await readFreshness(home, checkoutId)), ...change };
  await writeUserStateFileAtomic0600(home, checkoutDir(home, checkoutId), FRESHNESS_FILE, `${JSON.stringify(next)}\n`);
}

/** Record a completed pull. */
export async function recordPulled(home: string, checkoutId: string, now: Date = new Date()): Promise<void> {
  await update(home, checkoutId, { pulled_at: now.toISOString() });
}

/** Record that an automatic pull is starting, before any request, so a failing one backs off. */
export async function recordPullAttempt(home: string, checkoutId: string, now: Date = new Date()): Promise<void> {
  await update(home, checkoutId, { attempt_at: now.toISOString() });
}

/** Milliseconds since `iso`, or null when there is no usable time. */
export function ageMs(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, now.getTime() - at) : null;
}

/** A fetch that gives up at `deadline` (epoch ms), so a pull on a read never outlives its budget. */
export function fetchWithDeadline(inner: typeof fetch, deadline: number): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const remaining = Math.max(0, deadline - Date.now());
    const timeout = AbortSignal.timeout(Math.max(1, remaining));
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return inner(input, { ...init, signal });
  }) as typeof fetch;
}

/** "42m" / "3h" / "2d": a person-readable age. */
export function describeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
