---
type: Reference
title: Open Knowledge Format v0.1 (Draft)
description: A version-scoped OKF v0.1 interop reference, not Superbee's cross-edition authority.
resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a/okf/SPEC.md
tags: [okf, spec, reference]
timestamp: 2026-08-23T17:47:52Z
---
# Summary

This reference is scoped to OKF v0.1 interop; it is not the authority for
Superbee's v0.2 behavior or cross-edition compatibility. Open Knowledge Format
(OKF) v0.1 (Draft), published by Google Cloud in
`GoogleCloudPlatform/knowledge-catalog` under `okf/`, defines a "Knowledge
Bundle" as a directory tree of UTF-8 markdown files. Each non-reserved `.md`
file is a Concept whose ID is its path minus `.md`. The only required
frontmatter field is `type`. This document mirrors the external spec as a
first-class concept (§8) so citations resolve inside the graph.

OKF has since moved to its own repository,
`GoogleCloudPlatform/open-knowledge-format`, which publishes v0.2. The
`knowledge-catalog` copy is a frozen snapshot, so the v0.1 citation below is a
permalink to the commit that published v0.1.

# Key sections

* §3 bundle structure and reserved filenames (`index.md`, `log.md`).
* §4 concept documents and §4.1 frontmatter (`type` required).
* §5 cross-linking: standard markdown links, absolute or relative, untyped.
* §9 conformance: parseable frontmatter, non-empty `type`, valid index/log.

# Citations

1. [OKF v0.1 SPEC.md](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a/okf/SPEC.md)
2. [Open Knowledge Format repository](https://github.com/GoogleCloudPlatform/open-knowledge-format)
