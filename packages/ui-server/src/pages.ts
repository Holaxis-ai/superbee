// The PAGE-BYTES privilege tier of the loopback UI server (tasks/ui-pages-spike): a bundle page is a
// self-contained HTML blob promoted into the store under `pages/…`. It runs in a SANDBOXED,
// OPAQUE-ORIGIN frame (`sandbox="allow-scripts"`, no `allow-same-origin`). Active HTML is code,
// not inert content: before a data-bearing View is mounted, the trusted shell requires a local
// approval keyed to its exact bytes and declared authority. That approval is the executable-code
// trust boundary; the defenses below deny direct credentials and reduce ambient browser authority:
//
//   1. A per-launch, single-use NONCE. The session-authed shell mints a launch for ONE View and
//      fetches THAT launch's exact bytes once through the nonce route (session + X-Requested-With
//      required), verifies them against the approved content version, and hands them to the View
//      host (`@superbee/view-runtime/view-host`), which mounts them as a `blob:` URL. The View
//      frame itself never requests its HTML, and the nonce opens no data route.
//   2. A strict View CSP with `connect-src 'none'` ({@link pageCsp}) blocks ordinary
//      fetch/XHR/WebSocket/EventSource access. The View inherits it from the host document. The
//      shell validates the postMessage source and forwards only bounded requests to a
//      server-owned, launch-bound bridge authority.
//
// The nonce is a capability, not a durable grant: short-TTL, single-use, in-memory only.
import { PAGE_ENTRY_PREFIX, VIEW_ENTRY_PREFIX } from "@superbee/core/page";

/** LEGACY bundle-relative key prefix page HTML blobs live under (`promote <file> --doc-key pages/<name>.html`). */
export const PAGE_BLOB_PREFIX: string = PAGE_ENTRY_PREFIX;

/** Current bundle-relative key prefix View HTML blobs live under (`views/<name>.html`). */
export const VIEW_BLOB_PREFIX: string = VIEW_ENTRY_PREFIX;

/** Every accepted page-blob prefix (current `views/` + the legacy `pages/` LOCATION) — the mint guard and the watcher's hot-reload snapshot (`watch.ts`) honor BOTH: legacy locations stay recognized (relocation is a separate open decision) even though the legacy kind/field NAMES are retired. */
export const PAGE_BLOB_PREFIXES: readonly string[] = [PAGE_BLOB_PREFIX, VIEW_BLOB_PREFIX];

/**
 * The Content-Security-Policy every View document runs under. `connect-src 'none'` blocks direct
 * network APIs; the page also never receives the data credential. Exact-byte approval remains the
 * trust decision for executable View code. `script-src`/`style-src 'unsafe-inline'` are required
 * because pages are self-contained (inline `<script>`/`<style>`, no external hosts — the demos
 * embed everything). `frame-ancestors 'self'` lets ONLY the same-origin shell frame the View host
 * that carries this policy.
 */
export function pageCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/** The View policy applied to the blob child through its `csp` attribute (no `frame-ancestors`, which a local document cannot use). */
export function viewChildCsp(): string {
  return pageCsp()
    .split("; ")
    .filter((directive) => !directive.startsWith("frame-ancestors "))
    .join("; ");
}
