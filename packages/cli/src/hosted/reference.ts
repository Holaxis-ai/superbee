// A hosted bundle reference (`<bundle-id>` or `<workspace-slug>/<bundle-id>`). Core's hosted client
// owns the grammar; this module names it for the CLI. The CLI keeps the bare id everywhere a bundle
// id is stored or compared (folder names, catalog labels, the host's answers) and sends the
// reference only in the body of a bundle-scoped sync request (`HostedSyncClient.within`).
export {
  hostedBundleReferenceText,
  isWorkspaceSlug,
  parseHostedBundleReference,
  type HostedBundleReference,
} from "@superbee/core/hosted-client";
