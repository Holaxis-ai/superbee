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
  /** Same rules as the interactive profile; absent or unknown keeps every external target inert. */
  externalLinks?: RenderOptions["externalLinks"];
  /** Trusted presentation inventory, never bundle-authored renderer configuration.
   * Omit to keep images inert. The bridge-shaped document adapter does not accept this. */
  imageAssets?: RenderOptions["imageAssets"];
}

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

/**
 * Bridge-shaped adapter shared by every host that presents a canonical bundle document. It takes no
 * options, so a View's `render-document` cannot carry a link policy or local images.
 */
export function renderDocumentToStaticHtml(document: StaticRenderableDocument): StaticRenderedDocument {
  const rendered = renderMarkdownToStaticHtml(document.body, { fromId: document.id });
  return { html: rendered.html, bounded: rendered.bounded };
}
