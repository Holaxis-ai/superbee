// A hosted bundle reference: how a person, a command and the host's bundle list name one hosted
// bundle. `<bundle-id>` names it when one of the person's workspaces holds that id;
// `<workspace-slug>/<bundle-id>` names the workspace too, for an id more than one of them holds.
// The slug is the workspace's own (the first label of its host, as `whoami` reports it), resolved
// by the host among the person's own workspaces. The CLI keeps the bare id everywhere a bundle id
// is stored or compared (folder names, catalog labels, the host's answers) and sends the reference
// only in the body of a bundle-scoped sync request (`hosted/client.ts`). The bundle id part is held
// to the one rule `hosted/bundle-id.ts` states, so a reference never carries an id a bare one could
// not.

import { isHostedBundleId } from "./bundle-id.js";

/** One lowercase DNS label: the host's workspace slug grammar. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** True for a workspace slug as the host reports it. */
export function isWorkspaceSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG.test(value);
}

export interface HostedBundleReference {
  /** The workspace the reference names, or null for a bare id. */
  readonly slug: string | null;
  readonly bundleId: string;
}

/** The reference a string names, or null when it is neither a hosted bundle id nor `<slug>/<id>`. */
export function parseHostedBundleReference(value: string): HostedBundleReference | null {
  const at = value.indexOf("/");
  const slug = at < 0 ? null : value.slice(0, at);
  const bundleId = at < 0 ? value : value.slice(at + 1);
  if (slug !== null && !SLUG.test(slug)) return null;
  if (!isHostedBundleId(bundleId)) return null;
  return { slug, bundleId };
}

/** The reference's spelling: the bare id, or `<slug>/<bundle-id>`. */
export function hostedBundleReferenceText(reference: HostedBundleReference): string {
  return reference.slug === null ? reference.bundleId : `${reference.slug}/${reference.bundleId}`;
}
