/**
 * `@superbee/core/hosted-client`: the headless client of a hosted Superbee's sync route family
 * (`/sync/v1`), a supported public API under core's normal versioning. It is runtime-neutral
 * (`fetch` and Web streams only), so it runs in Node, a browser or a Worker.
 *
 * The caller supplies the target (origin and sync prefix) and an async credential provider; the
 * client supplies identity, the bundle list, reads, history, workspace qualification, operations
 * by id, the one-call document write and the one-call blob write (`writeBlob`, journaled by
 * `driveJournaledBlob`) over `@superbee/core/hosted-transport`, and throws typed errors only.
 * `createHostedInbox` adds a person's inbox in one workspace over the same client, and
 * `readDirectory` with `matchDirectoryMember` finds a teammate where the host offers the directory.
 *
 * Export download is Node-only (its verification needs Node), so it is the separate
 * `@superbee/core/hosted-client/node`; nothing here imports it.
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
  HostedIntentsNotListable,
  INTENTS_NOT_LISTABLE,
  type HostedIntentStore,
  type HostedWriteInput,
  type HostedWriteIntent,
  type HostedWriteLookupResult,
  type HostedWriteOptions,
  type HostedWriteRefusalCode,
  type HostedWriteResult,
} from "./write.js";
export {
  isViewContentVersion,
  viewContentVersion,
  VIEW_CONTENT_MAX_BYTES,
  VIEW_CONTENT_READ_OPERATION,
  VIEW_CONTENT_UPDATE_OPERATION,
  WRITE_OUTCOME_UNKNOWN,
  type HostedViewContent,
  type HostedViewContentReadRequest,
  type HostedViewContentReadResult,
  type HostedViewContentRefusal,
  type HostedViewContentUpdate,
  type HostedViewContentUpdateRequest,
  type HostedViewContentUpdateResult,
} from "./view-content.js";
export { HostedBlobWritesNotServed, HostedRouteNotServed, isRouteNotServed, ROUTE_NOT_SERVED } from "./errors.js";
export {
  driveJournaledBlob,
  forgetJournaledBlob,
  HostedBlobDeletionsNotAccepted,
  HostedBlobWriteNotSent,
  type BlobDrivePremises,
  type BlobDriveSnapshot,
  type BlobDriveStep,
  type BlobPin,
  type HostedBlobDeleteInput,
  type HostedBlobForgetResult,
  type HostedBlobHeldWrite,
  type HostedBlobLookupResult,
  type HostedBlobOperation,
  type HostedBlobRefusalCode,
  type HostedBlobWriteInput,
  type HostedBlobWriteOptions,
  type HostedBlobWriteResult,
  type JournaledBlobContext,
  type JournaledBlobForgetResult,
  type JournaledBlobMode,
  type JournaledBlobResult,
} from "./blob-write.js";
// The browser-safe default blob journal and the head and read shapes, re-exported (same identities).
export { createMemoryBlobJournal, type BlobJournaledBackend, type MemoryBlobJournal } from "../blob-journal.js";
export type { HostedBlobHead, HostedBlobHeads, HostedBlobRead } from "../hosted-transport/index.js";
export {
  ATTENTION_OPERATION_IDS,
  ATTENTION_REFUSAL_CODES,
  createHostedInbox,
  DIRECTORY_PAGE_MAX,
  HOSTED_PRINCIPAL_ID,
  HostedAttentionOutcomeUnknown,
  HostedAttentionRefusal,
  INBOX_ANSWER_BYTES,
  INBOX_ITEM_STATES,
  INBOX_NOTE_MAX_LENGTH,
  isAttentionOutcomeUnknown,
  isAttentionRefusal,
  isAttentionTicket,
  mintAttentionTicket,
  PERSON_ITEM_KINDS,
  PROVENANCE_SURFACES,
  SELF_PRINCIPAL,
  TARGET_REQUIRED_KINDS,
  type AttentionCancelResult,
  type AttentionOperationId,
  type AttentionReceipt,
  type AttentionRefusalCode,
  type AttentionRequestInput,
  type DirectoryInput,
  type DirectoryMember,
  type DirectoryPage,
  type HostedInbox,
  type HostedInboxOptions,
  type InboxAckInput,
  type InboxAppMeta,
  type InboxCount,
  type InboxEntry,
  type InboxEntryTarget,
  type InboxFactMatch,
  type InboxItemKind,
  type InboxItemState,
  type InboxListInput,
  type InboxListPage,
  type InboxProducerDisplay,
  type InboxProducerFacts,
  type InboxRecipient,
  type InboxSummary,
  type InboxSummaryInput,
  type InboxThread,
  type InboxThreadsInput,
  type InboxThreadsPage,
  type PersonItemKind,
  type ProvenanceSurface,
} from "./inbox.js";
export {
  DIRECTORY_PAGES_MAX,
  directoryNameKey,
  matchDirectoryMember,
  readDirectory,
  type DirectoryListing,
  type DirectoryMatch,
  type DirectoryMatchBy,
} from "./directory.js";
// The other typed failures, re-exported (same identities) so a caller can tell them apart from
// this one subpath.
export { MALFORMED_ANSWER, MalformedAnswer, RemoteError, isMalformedAnswer } from "../remote-error.js";
export { HostedAnswerTooLarge, HostedCarrierError, isAnswerTooLarge } from "../hosted-transport/carrier.js";
export {
  BLOB_UNRECORDED_REFUSAL_CODES,
  performHostedBlobDelivery,
  type HostedBlobDeliveryContext,
  type HostedBlobDeliveryOptions,
  type HostedBlobDeliveryOutcome,
  type HostedBlobDeliveryResult,
} from "./blob-delivery.js";
