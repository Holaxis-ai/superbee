/**
 * `@superbee/server` — the wire-protocol v0 REFERENCE server
 * (`docs/WIRE-PROTOCOL.md`): a Web-standard `fetch`-style router over the OKF
 * engine, plus a thin `node:http` bootstrap. A pure consumer of
 * `@superbee/core` — no parsing/link/OKF logic lives here (see `router.ts`
 * module doc). Reference-not-production: no auth, loopback-only default bind.
 *
 * @packageDocumentation
 */

export { createRouter, createRouterForBackend } from "./legacy-router.js";
export { WIRE_ENDPOINTS } from "./router.js";
export {
  RequestBodyTooLargeError,
  serve,
  requestFromIncomingMessage,
  writeResponseToServerResponse,
} from "./serve.js";
export type {
  RequestAdapterOptions,
  ServeOptions,
  ServerHandle,
} from "./serve.js";
