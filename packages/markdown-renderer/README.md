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

Raw HTML is literal text. External links and images are inert; Mermaid remains
a code block. Body, node and depth limits bound presentation; the host must show
the returned `bounded` state rather than imply the entire document was rendered.
The inert profile has no active document navigation and does not call the route
builder. Do not render arbitrary bundle-authored executable code in the host shell.

For static inert HTML use `renderMarkdownToStaticHtml` or
`renderDocumentToStaticHtml` from `@superbee/markdown-renderer/static`.
The static adapter has no interactive routing. It shares the same parser and
closed element construction as the interactive entrypoint.

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

The renderer has its own version. It is not part of the synchronized core/server
`libraries/v*` release workflow or the CLI `v*` workflow. Preparing or packing this
package does not publish it. Its first registry publication and subsequent release
automation require a separate maintainer-approved release step; do not tag either
existing workflow to publish the renderer.
