import { createHash, randomBytes } from "node:crypto";
import { assertSafeConceptId } from "@superbee/core";

export const BROWSER_LAUNCH_PATH = "/__ui/browser-launch";
export const BROWSER_LAUNCH_MAX_BODY_BYTES = 4096;
const TICKET_TTL_MS = 60_000;
const MAX_TICKETS = 32;

export type BrowserLaunchTarget =
  | { kind: "launcher" }
  | { kind: "document" | "registered-view"; id: string };

/** Only host-owned route variants can be destinations; no caller-supplied URI is accepted. */
export function parseBrowserLaunchTarget(value: unknown): BrowserLaunchTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.kind === "launcher" && Object.keys(data).length === 1) return { kind: "launcher" };
  if ((data.kind !== "document" && data.kind !== "registered-view") ||
      Object.keys(data).length !== 2 || !Object.hasOwn(data, "kind") || !Object.hasOwn(data, "id") ||
      typeof data.id !== "string") return null;
  try { assertSafeConceptId(data.id); } catch { return null; }
  return { kind: data.kind, id: data.id };
}

export function browserLaunchDestination(target: BrowserLaunchTarget): string {
  if (target.kind === "launcher") return "/";
  const params = new URLSearchParams({ view: target.kind === "document" ? "doc" : "page", id: target.id });
  return `/?${params}`;
}

/** Process-local enrollment capabilities, separate from the reusable browser and management secrets. */
export class BrowserLaunchTickets {
  private readonly tickets = new Map<string, { destination: string; expiresAt: number }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  mint(target: BrowserLaunchTarget): { ticket: string; expiresAt: number; destination: string } | null {
    const now = this.now();
    for (const [key, value] of this.tickets) if (now >= value.expiresAt) this.tickets.delete(key);
    if (this.tickets.size >= MAX_TICKETS) return null;
    const ticket = randomBytes(32).toString("base64url");
    const value = { destination: browserLaunchDestination(target), expiresAt: now + TICKET_TTL_MS };
    this.tickets.set(ticket, value);
    return { ticket, ...value };
  }

  consume(ticket: string): string | null {
    const value = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return value && this.now() < value.expiresAt ? value.destination : null;
  }

  clear(): void { this.tickets.clear(); }
}

// The fragment is erased before any asynchronous work. A failed/ambiguous exchange never retries.
const BOOTSTRAP_SCRIPT = `"use strict";
const ticket = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const status = document.getElementById("status");
async function launch() {
  if (window.top !== window || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error();
  const response = await fetch(location.pathname, {
    method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { "content-type": "application/json", "x-requested-with": "superbee-browser-launch" },
    body: JSON.stringify({ ticket })
  });
  if (!response.ok) throw new Error();
  const result = await response.json();
  if (typeof result.destination !== "string" || !/^\\/(?:\\?|$)/.test(result.destination)) throw new Error();
  location.replace(result.destination);
}
launch().catch(() => { status.textContent = "This private browser handoff is unavailable or expired. Request a fresh one with superbee view open."; });`;
const SCRIPT_HASH = createHash("sha256").update(BOOTSTRAP_SCRIPT).digest("base64");

export function browserLaunchHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}

export function browserLaunchDocument(): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Open Superbee View</title><p id="status">Opening the selected local Superbee context…</p><script>${BOOTSTRAP_SCRIPT}</script>`, {
    headers: { ...browserLaunchHeaders(), "content-type": "text/html; charset=utf-8" },
  });
}
