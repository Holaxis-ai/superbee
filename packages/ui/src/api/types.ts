/**
 * Wire response shapes for the surface the launcher + pages bridge consume — hand-written against
 * `packages/server/src/router.ts` directly (contract-first codegen is recorded future work,
 * `plans/ui-v1.md` rev 2's Package layout section). `Frontmatter` is the ONE shared type,
 * imported type-only so it is erased at compile time and never pulls `@superbee/core`
 * runtime code into the browser bundle (rev 2: "importing shared types type-only").
 *
 * ROUTE-SHAPE NOTE (plan-vs-code drift, verified against the router rather than trusted from
 * the plan prose): every doc/blob/reserved route is BUNDLE-SCOPED — `/v0/bundles/{bundle}/...`,
 * never a bare `/v0/docs` — see `BUNDLE_PATH_RE` in router.ts. `{bundle}` is accepted
 * syntactically but unused by the single-bundle reference router, so this client hardcodes the
 * literal `"default"` (client.ts's `BUNDLE`), matching the worker's own `DEFAULT_BUNDLE`.
 */
import type { Frontmatter } from "@superbee/core";

export type { Frontmatter };

/** One row of `GET .../docs?fields=frontmatter`: full frontmatter (never a body), plus its version. */
export interface DocHead {
  id: string;
  version: string;
  frontmatter: Frontmatter;
}

/** `GET .../docs?fields=frontmatter&type=...` response shape. */
export interface ListDocsResponse {
  count: number;
  docs: DocHead[];
  next_cursor: string | null;
}

/** `GET .../docs/{id}` response body (the version itself travels on the `X-Version`/`ETag` headers, not the body). */
export interface ReadDocResponse {
  id: string;
  frontmatter: Frontmatter;
  body: string;
}

/** `PUT .../docs/{id}` response body. */
export interface WriteDocResponse {
  version: string;
}

/** One row of `GET /__ui/edges` — hand-mirrors core's `Link` (bundle.ts) per this module's no-runtime-import convention. */
export interface Edge {
  from: string;
  to: string;
  text: string;
}

/** `GET /__ui/edges?from=&to=&text=` response shape (the shell-only endpoint the bridge's `edges` request proxies). */
export interface EdgesResponse {
  count: number;
  edges: Edge[];
}

/** The wire-protocol JSON error envelope (`docs/WIRE-PROTOCOL.md` Conventions; `router.ts`'s `errorResponse`). */
export interface WireErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// NOTE: no kind-specific enum here — this module stays GENERIC wire shapes only. Any kind/enum
// interpretation (e.g. a page bucketing tasks by status) is the consuming page's own concern,
// read off `DocHead.frontmatter`; the shell never bakes in a kind here.
