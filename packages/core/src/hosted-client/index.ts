/**
 * `@superbee/core/hosted-client`: the headless client of a hosted Superbee's sync route family
 * (`/sync/v1`), a supported public API under core's normal versioning. It is runtime-neutral
 * (`fetch` and Web streams only), so it runs in Node, a browser or a Worker.
 *
 * The caller supplies the target (origin and sync prefix) and an async credential provider; the
 * client supplies identity, the bundle list, reads, history, workspace qualification, operations
 * by id and the one-call document write over `@superbee/core/hosted-transport`, and throws typed
 * errors only.
 */
export {
  bearerCredentials,
  createHostedClient,
  qualifyingCarrier,
  syncRoutePrefix,
  type HostedClient,
  type HostedClientOptions,
  type HostedClientTarget,
  type HostedCredentialProvider,
  type HostedIdentity,
  type HostedRunOptions,
  type HostedWorkspace,
} from "./client.js";
export {
  BUNDLE_LIST_CAP,
  readBundleListing,
  type HostedBundleListing,
  type HostedBundleRow,
  type HostedListedBundle,
} from "./bundle-listing.js";
export {
  hostedBundleReferenceText,
  isWorkspaceSlug,
  parseHostedBundleReference,
  type HostedBundleReference,
} from "./reference.js";
export { checkoutBindingDigest } from "./binding.js";
export {
  createMemoryIntentStore,
  type HostedIntentStore,
  type HostedWriteInput,
  type HostedWriteIntent,
  type HostedWriteOptions,
  type HostedWriteRefusalCode,
  type HostedWriteResult,
} from "./write.js";
export { HostedRouteNotServed, isRouteNotServed, ROUTE_NOT_SERVED } from "./errors.js";
// The other typed failures, re-exported (same identities) so a caller can tell them apart from
// this one subpath.
export { MALFORMED_ANSWER, MalformedAnswer, RemoteError, isMalformedAnswer } from "../remote-error.js";
export { HostedAnswerTooLarge, HostedCarrierError, isAnswerTooLarge } from "../hosted-transport/carrier.js";
