import { renderToStaticMarkup } from "react-dom/server";
import {
  renderMarkdown,
  type RenderedMarkdown,
  type RenderOptions,
} from "./index.js";

export interface StaticRenderOptions {
  fromId: string;
  titleFor?: RenderOptions["titleFor"];
  limits?: RenderOptions["limits"];
  /** Same allowlist rules as the interactive profile; absent keeps every external target inert. */
  externalLinkHosts?: RenderOptions["externalLinkHosts"];
}

/** The subset of {@link StaticRenderOptions} the bridge-shaped document adapter accepts. */
export type StaticDocumentRenderOptions = Pick<StaticRenderOptions, "externalLinkHosts">;

export interface StaticRenderedMarkdown extends Omit<RenderedMarkdown, "element"> {
  html: string;
}

export interface StaticRenderableDocument {
  id: string;
  body: string;
}

export interface StaticRenderedDocument {
  html: string;
  bounded: boolean;
}

/** Serialize the shared renderer's inert profile for transport into an opaque-origin View. */
export function renderMarkdownToStaticHtml(
  body: string,
  options: StaticRenderOptions,
): StaticRenderedMarkdown {
  const rendered = renderMarkdown(body, {
    ...options,
    profile: "inert",
    onNavigateDoc: () => {},
  });
  const html = renderToStaticMarkup(
    <div data-aslite-rendered-document="">{rendered.element}</div>,
  );
  return { html, bounded: rendered.bounded, limits: rendered.limits };
}

/** Bridge-shaped adapter shared by every host that presents a canonical bundle document. */
export function renderDocumentToStaticHtml(
  document: StaticRenderableDocument,
  options: StaticDocumentRenderOptions = {},
): StaticRenderedDocument {
  const rendered = renderMarkdownToStaticHtml(document.body, {
    fromId: document.id,
    externalLinkHosts: options.externalLinkHosts,
  });
  return { html: rendered.html, bounded: rendered.bounded };
}
