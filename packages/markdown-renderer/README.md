# Superbee Markdown renderer

Bounded GFM rendering shared by Superbee readers. This package depends on the
core link resolver, React and React DOM, with no CLI or server dependency.

```tsx
import { renderMarkdown } from '@superbee/markdown-renderer';

const rendered = renderMarkdown(body, {
  fromId: documentId,
  hrefForDoc: id => `/bundles/${encodeURIComponent(bundleId)}/documents/${encodeURIComponent(id)}`,
  onNavigateDoc: id => selectDocument(bundleId, id),
});
// Render rendered.element and show a truncation notice when rendered.bounded is true.
```

The host owns data loading, authorization, styling and selection. Both callbacks
receive resolved concept IDs, never raw Markdown URLs. `hrefForDoc` accepts
same-origin root-relative, query or fragment URLs; invalid routes throw. Without
it, links retain the local reader's `?view=doc&id=...` route. Modified clicks use
normal browser navigation; ordinary clicks invoke `onNavigateDoc`. Every target
read still needs the host's authorization check.

Raw HTML is literal text. External links and images are inert by default; Mermaid remains
a code block. A host may opt in to real external links with `externalLinkHosts`,
a list of bare host names. A link renders as an anchor only when its target
parses with the WHATWG `URL` constructor to `https:` with no userinfo, no IP
literal, the default port, and a host that is exactly one listed name after
normalization; a subdomain, `http:`, a homoglyph host, or a scheme-less or
unparsable target stays inert. The anchor carries the parsed URL's canonical
serialization, never the raw Markdown string, with `rel="noopener noreferrer"`,
`target="_blank"` and the `doc-link-external` class. Concept links resolve first;
the allowlist sees only targets the resolver rejects. Both the interactive and
static entrypoints accept the option, and `renderDocumentToStaticHtml` takes it
as an optional second argument. Without the option, or with an empty list, every
external link stays inert exactly as before. Body, node and depth limits bound presentation; the host must show
the returned `bounded` state rather than imply the entire document was rendered.
The inert profile has no active document navigation and does not call the route
builder. Do not render arbitrary bundle-authored executable code in the host shell.

For static inert HTML use `renderMarkdownToStaticHtml` or
`renderDocumentToStaticHtml` from `@superbee/markdown-renderer/static`.
The static adapter has no interactive routing. It shares the same parser and
closed element construction as the interactive entrypoint.

A trusted static presentation may opt in to local images with an exact asset inventory:

```ts
renderMarkdownToStaticHtml(body, {
  fromId: documentId,
  imageAssets: ['/assets/screens/example.png', '/assets/screens/model.svg'],
});
```

Only a Markdown image whose target exactly matches an inventory entry becomes a React-constructed
`img` element. Entries must be canonical root-relative `/assets/` image paths, at most 2048 characters,
with ASCII alphanumeric-leading segments and a PNG, JPEG, GIF, WebP, AVIF or SVG suffix. The inventory
has at most 4096 entries. Schemes, protocol-relative URLs, queries/fragments, encoded paths,
backslashes, whitespace, dot segments and other suffixes are refused. Unlisted images retain the
inert alt-text fallback. React escapes the alt text and attributes; SVG remains an image URL and is
never inserted as markup. Images are lazy-loaded with a no-referrer policy.

The caller must derive this inventory from already-admitted immutable presentation assets and own
their bytes, MIME, response headers and access checks. This renderer does not load, authorize or
inspect the image bytes, widen asset publication rules, or make arbitrary SVG safe for other
embedding contexts. Never populate the inventory directly from bundle-authored renderer options.
Interactive rendering ignores this option. The bridge-shaped `renderDocumentToStaticHtml` adapter
does not accept or forward it; its image behavior remains inert. Existing body/node/depth bounds
also apply when the static image option is enabled.

## Package preparation

From the repository root, install dependencies and build before packing:

```sh
npm ci
npm run build
npm pack -w @superbee/markdown-renderer --pack-destination /path/to/artifacts
```

Install the artifact with compatible `@superbee/core` (0.1.3 or later within 0.1),
React 19 and React DOM 19. Restricted packages require registry access. The
repository's external-consumer test installs actual tarballs outside the workspace
and checks browser bundling, TypeScript declarations and static rendering.

Flattened AST text is wrapped in a noninteractive `doc-markdown-fallback` span.
This marks unknown/unmapped constructs, depth-limited subtrees and relationship
verbs whose code/link semantics were flattened. Visible fallback text is retained;
downstream text decorators should skip this marker instead of treating it as
ordinary prose. Normally mapped prose, code, quotes and links keep their structure.

The renderer has its own version. It is not part of the synchronized core/server
`libraries/v*` release workflow or the CLI `v*` workflow. Preparing or packing this
package does not publish it. Its first registry publication and subsequent release
automation require a separate maintainer-approved release step; do not tag either
existing workflow to publish the renderer.
