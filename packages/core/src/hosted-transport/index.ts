/**
 * Experimental (`0.2.0-pre`): names and exports may change before a stable release, and the
 * `/sync/v1` routes this module targets are not yet served.
 *
 * `@superbee/core/hosted-transport`: one client grammar for a hosted Superbee bundle, shared by
 * the browser working copy and the CLI checkout. The carrier seam keeps the credential
 * (cookie and CSRF, or bearer) outside; the read adapter, the answer rows and the
 * whole-document write transport are the same for every client.
 */
export * from "./carrier.js";
export * from "./answer-rows.js";
export * from "./read-adapter.js";
export * from "./paged-reads.js";
export * from "./whole-document-transport.js";
export * from "./history-pages.js";
