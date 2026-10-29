# Site declarations in a publication

`superbee/publication/site-manifest` is the portable, data-only Site surface. It imports no
filesystem, credential or network implementation. The existing full publication surface also
re-exports it. Core owns the declaration grammar; the facade checks references against a
publication snapshot.

```yaml
type: Site
title: Example plan
presentation: "@example/document@1.0.0"
audience: restricted
views: [views-registry/model]
options: {plan: plans/main}
```

One bundle has one `Site` document at `sites/<site>`. A site uses the existing host-label grammar:
3 to 32 lowercase letters, digits and single hyphens, beginning with a letter and ending with a
letter or digit. The caller supplies the expected site when reading the publication.

```js
import { readPublicationSiteManifest } from 'superbee/publication/site-manifest';
const result = readPublicationSiteManifest(snapshot.manifest, 'example');
if (!result.ok) throw new Error('Invalid Site declaration');
const declaration = result.manifest;
```

`parseSiteManifestDoc(document)` validates one parsed document. A presentation is an npm name with
an exact version, or `repo:owner/name`; neither form installs or resolves code. The normalized
result separates the reference's kind, package name/version or repository. A builder admits its
trusted resolved implementation separately.

`readPublicationSiteManifest(snapshot, site)` also requires exactly one declaration at the fixed
id. Declared Views must be registered in that snapshot, landing must exist, a landing View must
be admitted by the declaration, and brand references must name its blobs. It does not read those
blobs or verify a raw snapshot's provenance; the existing capture/load boundary owns snapshot
validation.

The parser accepts only the restricted audience. It preserves View order and refuses duplicate
references, more than 64 Views, more than 16 capability names, malformed paths and floating npm
versions. Options are JSON data, limited to 16 KiB; the presentation owner validates their meaning.
Optional brand data contains a blob reference `logo` and up to 16 blob references in `fonts`.
A title is limited to 512 bytes and an optional description to 8192 bytes. Unknown Site fields
are refused, while ordinary OKF and managed metadata remain on the source document.

The document engine owns standard OKF metadata validation. Hosts own model-write permission,
including both the stored and candidate types, and the builder owns its code allowlist. A
successful declaration parse grants no build, publication, activation or reader access.
