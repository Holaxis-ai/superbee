import type { KindConvention } from "../kinds.js";
import { SITE_TYPE, SITES_PREFIX } from "../site-manifest.js";

export const SITE_KIND: KindConvention = {
  id: "conventions/site",
  title: SITE_TYPE,
  governs: SITE_TYPE,
  description: "A private content site's presentation and publication inputs, without reader grants or builder authority.",
  path: SITES_PREFIX,
  fields: {
    required: ["title", "presentation", "audience"],
    // Kind-required arrays must be nonempty; the trusted Site grammar also admits views: [].
    optional: ["description", "landing", "views", "capabilities", "options", "brand"],
    values: { audience: ["restricted"] },
    terminal: {},
    types: { views: "string-list", capabilities: "string-list" },
    descriptions: {
      title: "The site's display title.",
      description: "A short description for the presentation.",
      presentation: "An exact package version (name@version) or repo:owner/name; declaration does not admit code execution.",
      audience: "Restricted to the readers admitted by the hosting authority; this is not a reader list.",
      landing: "A canonical document or registered View id in this publication.",
      views: "Registered View ids. Complete Site YAML must explicitly provide views: [] when there are no Views.",
      capabilities: "Product capability names; hosting separately checks support, entitlements and reader permission.",
      options: "A JSON object validated by the selected presentation; author structured values in complete YAML.",
      brand: "Optional logo and font blob references in the publication; author structured values in complete YAML.",
    },
  },
};

export const SITE_CONVENTION_BODY = `# Site

Describe one private content site at sites/<site>, with the site label matching the hosting contract.
This convention helps author and inspect declarations. The portable Site validator owns the full
grammar and frozen-publication reference checks; editing this convention cannot relax that contract.
Reader grants, builder authorization and activation are separate hosting decisions.

See [Site authoring](../references/site-authoring.md) for a complete no-View declaration.
`;

export const SITE_AUTHORING_BODY = `# Site authoring

Install this recipe with \`superbee recipe add site\`. It installs a convention and this reference,
not a Site instance, builder, reader grant or running site. Writing or syncing a declaration is
not, by itself, proof that a builder published it or that a recipient can read it.

Author a complete document at \`sites/<site>.md\`, using the site's label and one exact presentation
version. For example, a declaration at \`sites/example.md\` can contain:

\`\`\`yaml
---
type: Site
title: Example briefing
presentation: "@superbee/portal-document@0.1.1"
audience: restricted
views: []
capabilities: []
options: {}
---
\`\`\`

Use the existing complete-document import or pull/promote authoring path when structured YAML is
needed. Do not pass \`[]\` as a string-list CLI flag: that is a string item, not an empty list.
The convention leaves views optional because generic Kind-required arrays must be nonempty;
the trusted Site validator still requires an explicit list, including \`views: []\` for no Views.

\`superbee/publication/site-manifest\` exposes the shared declaration validator and the frozen
publication reference validator. A declaration requires one Site at \`sites/<site>\`, an exact
package version or repository presentation reference, and the restricted audience. Views, the
optional landing document and optional brand blobs must resolve in that publication. The selected
presentation validates its own options; declaring a package does not install or execute it.

Do not put credentials, reader lists, origins or builder settings in the declaration. Hosted
model-write permissions, trusted builder admission, grants, entitlements and release checks remain
authoritative. Local creation never registers an app or grants publication or recipient access.
`;
