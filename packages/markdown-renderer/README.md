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
a code block.

The page owner may choose real external links with `externalLinks`, on both the
interactive and static entrypoints:

| Value | Admits |
| --- | --- |
| `"none"`, absent, or any unknown value | Nothing. Every external link stays as its words. |
| `"https"` | Any `https:` URL with no userinfo, on any host or port. |
| `{ hosts: ["example.com"] }` | An `https:` URL with no userinfo and the default port, whose host is exactly one listed bare name after normalization. A subdomain, a homoglyph host or an IP literal is refused, and a malformed entry admits nothing. |

Only `https:` can ever be admitted: `http:`, `javascript:`, `data:`, other schemes, and
relative, scheme-less or unparsable targets stay inert under every policy. Images and raw HTML
are unaffected, and so are reference-style links such as `[text][ref]` and links in footnotes,
which render as text. A link inside another link, or a link with no words, also stays inert. The
anchor carries the parsed URL's canonical serialization, never the raw Markdown string, with
`rel="noopener noreferrer"`, `target="_blank"` and the `doc-link-external` class. Concept links
resolve first; the policy sees only targets the resolver rejects.

Set the policy in trusted host code. Never read it from a document, Kind, recipe, View manifest,
bundle record or tool argument, except a host's sealed room, whose host list comes from content
that host validated and sealed. `renderDocumentToStaticHtml` takes no options, because it is the
adapter behind a View's `render-document`, and Views stay link-free.

Body, parse, node and depth limits bound presentation; the host must show
the returned `bounded` state rather than imply the entire document was rendered. A document over the parse
limit renders as escaped source text in one code block, the same way in both entrypoints.
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
does not accept it; its image behavior remains inert. Existing body/node/depth bounds
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
