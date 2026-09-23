/**
 * `@superbee/core/hosted-transport`: one client grammar for a hosted Superbee bundle, shared by
 * the browser working copy and the CLI checkout. The carrier seam keeps the credential
 * (cookie and CSRF, or bearer) outside; the read adapter, the answer rows and the
 * whole-document write transport are the same for every client.
 */
export * from "./carrier.js";
export * from "./answer-rows.js";
export * from "./read-adapter.js";
export * from "./whole-document-transport.js";
