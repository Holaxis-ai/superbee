/**
 * `@superbee/core/hosted-transport`: one client grammar for a hosted Superbee bundle, shared by
 * the browser working copy and the CLI checkout. The carrier seam keeps the credential
 * (cookie and CSRF, or bearer) outside; the read adapter, the answer rows and the
 * whole-document write transport are the same for every client. Hosted Superbee serves the
 * `/sync/v1` routes it targets; `@superbee/core/hosted-client` is the headless client built on it.
 */
export * from "./carrier.js";
export * from "./answer-rows.js";
export * from "./read-adapter.js";
export * from "./paged-reads.js";
export * from "./whole-document-transport.js";
export * from "./history-pages.js";
export * from "./operations.js";
export * from "./root-write.js";
export * from "./blob-reads.js";
