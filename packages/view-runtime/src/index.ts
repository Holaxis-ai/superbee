import { randomBytes } from "node:crypto";
import {
  DocumentNotFoundError,
  KindConformanceError,
  VersionConflict,
  blobVersion,
  loadKinds,
  mutateDocument,
  readBundleOkfVersion,
  readBlob,
  readDocVersioned,
  resolveKindFieldCoordinate,
  validateAgainstKind,
  versionOfBytes,
  type Bundle,
  type Frontmatter,
  type KindConvention,
  type ValidationWarning,
  type Version,
} from "@superbee/core";
import {
  parseRegistration,
  resolveDeclaredAccess,
  type BridgeCapability,
  type PageTypeName,
} from "@superbee/core/page";
import {
  ACTIVE_VIEW_POLICY_VERSION,
  SessionViewAuthorizationStore,
  admitActiveView,
  type ViewAuthorizationStore,
  type ViewAuthorizationSubject,
} from "./authorization.js";
import type { BridgeLaunch, BridgeLaunchAuthority } from "./bridge.js";
import {
  persistTransientView,
  TransientViewSaveError,
  type SaveTransientViewInput,
  type SaveTransientViewResult,
} from "./transient-save.js";
import {
  parseDocumentSetFieldAction,
  type ActionScalar,
  type DocumentSetFieldAction,
} from "./action-bridge.js";

export {
  actionError,
  actionReply,
  parseActionBridgeMessage,
  parseDocumentSetFieldAction,
  type ActionBridgeMessage,
  type ActionScalar,
  type DocumentSetFieldAction,
} from "./action-bridge.js";

export {
  TransientViewSaveError,
  type SaveTransientViewInput,
  type SaveTransientViewResult,
} from "./transient-save.js";

export {
  listViewCatalog,
  listViewCatalogPage,
  projectViewCatalog,
  type ViewCatalog,
  type ViewCatalogEntry,
  type ViewCatalogPage,
  type ViewCatalogPageOptions,
  type ViewCatalogProjectionOptions,
  type ViewPresentation,
} from "./catalog.js";

interface BasePageLaunch {
  launchId: string;
  nonce: string;
  contentType: string;
  contentVersion: Version;
  bytes: Uint8Array;
  capability: BridgeCapability;
  nonceExpiresAt: number;
  expiresAt: number;
}

export interface RegisteredPageLaunch extends BasePageLaunch {
  sourceKind: "registered";
  registryId: string;
  registryType: PageTypeName;
  registryVersion: Version;
  registryTitle: string;
  entryKey: string;
}

export interface TransientPageLaunch extends BasePageLaunch {
  sourceKind: "transient";
  title: string;
  bundleIdentity: string;
}

export type PageLaunch = RegisteredPageLaunch | TransientPageLaunch;
type PageLaunchInput = PageLaunch extends infer Launch
  ? Launch extends PageLaunch
    ? Omit<Launch, "launchId" | "nonce" | "nonceExpiresAt" | "expiresAt">
    : never
  : never;

/** A caller-supplied View registration ID does not exist in the active bundle. */
export class ViewNotFoundError extends Error {
  readonly code = "VIEW_NOT_FOUND";
  readonly viewId: string;
  readonly storageCause?: unknown;

  constructor(viewId: string, storageCause?: unknown) {
    super(`No registered View with ID '${viewId}'.`);
    this.name = "ViewNotFoundError";
    this.viewId = viewId;
    this.storageCause = storageCause;
  }
}

export type RegisteredViewLaunchErrorCode =
  | "VIEW_REGISTRY_READ_FAILED"
  | "VIEW_INVALID_REGISTRATION"
  | "VIEW_ENTRY_READ_FAILED"
  | "VIEW_ENTRY_NOT_FOUND"
  | "VIEW_ENTRY_VERSION_CONFLICT"
  | "VIEW_ADMISSION_REJECTED"
  | "VIEW_CHANGED_DURING_PREPARATION";

/** A registered View exists, but its current registration or entry cannot produce an active launch. */
export class RegisteredViewLaunchError extends Error {
  readonly code: RegisteredViewLaunchErrorCode;
  readonly viewId: string;
  readonly entryKey?: string;
  readonly storageCause?: unknown;

  constructor(
    code: RegisteredViewLaunchErrorCode,
    message: string,
    viewId: string,
    entryKey?: string,
    storageCause?: unknown,
  ) {
    super(message);
    this.name = "RegisteredViewLaunchError";
    this.code = code;
    this.viewId = viewId;
    this.entryKey = entryKey;
    this.storageCause = storageCause;
  }
}

export function pageLaunchAuthorizationSubject(launch: PageLaunch): ViewAuthorizationSubject {
  const common = {
    contentVersion: launch.contentVersion,
    contentType: launch.contentType,
    capability: launch.capability,
    execution: "active",
    policyVersion: ACTIVE_VIEW_POLICY_VERSION,
  } as const;
  return launch.sourceKind === "registered"
    ? { ...common, sourceKind: "registered", registryId: launch.registryId }
    : { ...common, sourceKind: "transient", bundleIdentity: launch.bundleIdentity };
}

const DEFAULT_LAUNCH_TTL_MS = 60 * 60 * 1000;
const DEFAULT_NONCE_TTL_MS = 120_000;
const DEFAULT_MAX_LAUNCHES = 256;

/** Bounded, in-memory identity for the exact registry and HTML bytes loaded into one frame. */
export class PageLaunchRegistry {
  private readonly byLaunch = new Map<string, PageLaunch>();
  private readonly byNonce = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly nonceTtlMs: number;

  constructor(
    ttlMs = DEFAULT_LAUNCH_TTL_MS,
    maxEntries = DEFAULT_MAX_LAUNCHES,
    now: () => number = Date.now,
    nonceTtlMs = DEFAULT_NONCE_TTL_MS,
  ) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.nonceTtlMs = nonceTtlMs;
  }

  mint(input: PageLaunchInput): PageLaunch {
    this.sweepExpired();
    while (this.byLaunch.size >= Math.max(1, this.maxEntries)) {
      const oldest = this.byLaunch.keys().next().value as string | undefined;
      if (!oldest) break;
      this.revoke(oldest);
    }
    const launchId = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const launch = {
      ...input,
      bytes: input.bytes.slice(),
      launchId,
      nonce,
      nonceExpiresAt: this.now() + this.nonceTtlMs,
      expiresAt: this.now() + this.ttlMs,
    } as PageLaunch;
    this.byLaunch.set(launchId, launch);
    this.byNonce.set(nonce, launchId);
    return launch;
  }

  resolveLaunch(launchId: string): PageLaunch | null {
    const launch = this.byLaunch.get(launchId);
    if (!launch) return null;
    if (this.now() > launch.expiresAt) {
      this.revoke(launchId);
      return null;
    }
    return launch;
  }

  resolveNonce(nonce: string): PageLaunch | null {
    const launchId = this.byNonce.get(nonce);
    const launch = launchId ? this.resolveLaunch(launchId) : null;
    if (!launch) return null;
    if (this.now() > launch.nonceExpiresAt) {
      this.byNonce.delete(nonce);
      return null;
    }
    return launch;
  }

  revoke(launchId: string): void {
    const launch = this.byLaunch.get(launchId);
    if (!launch) return;
    this.byLaunch.delete(launchId);
    this.byNonce.delete(launch.nonce);
  }

  size(): number {
    this.sweepExpired();
    return this.byLaunch.size;
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [launchId, launch] of this.byLaunch) {
      if (now > launch.expiresAt) this.revoke(launchId);
    }
  }
}

function ownRecord(source: Record<string, unknown>): Frontmatter {
  const target: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return target as Frontmatter;
}

function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

function scalarEqual(a: unknown, b: ActionScalar): boolean {
  return typeof a === typeof b && a === b;
}

function isActionScalar(value: unknown): value is ActionScalar {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function kindDigest(kind: KindConvention): Version {
  return versionOfBytes(stableJson(kind));
}

export async function launchIsCurrent(bundle: Bundle, launch: PageLaunch): Promise<boolean> {
  if (launch.sourceKind === "transient") {
    return (
      launch.bundleIdentity === bundle.root &&
      blobVersion(launch.bytes) === launch.contentVersion
    );
  }
  try {
    const registryRead = await readDocVersioned(bundle, launch.registryId);
    if (registryRead.version !== launch.registryVersion) return false;
    const registration = parseRegistration(registryRead.doc.id, registryRead.doc.frontmatter);
    if (
      !registration ||
      registration.type !== launch.registryType ||
      registration.entry !== launch.entryKey ||
      resolveDeclaredAccess(registryRead.doc.frontmatter) !== launch.capability
    ) {
      return false;
    }
    const blob = await readBlob(bundle, launch.entryKey);
    if (blob === null) return false;
    if (registration.entryVersion && registration.entryVersion !== blob.version) return false;
    const admitted = admitActiveView(blob.bytes, blob.contentType);
    return (
      admitted.contentType === launch.contentType &&
      blobVersion(admitted.bytes) === launch.contentVersion
    );
  } catch {
    return false;
  }
}

/**
 * Resolve one local registered View and its exact entry bytes into the shared active-View launch
 * model. Host adapters decide how to present authorization and transport the bytes; registry,
 * entry, admission, and currentness stay owned here.
 */
export async function mintActiveViewLaunch(
  bundle: Bundle,
  launches: PageLaunchRegistry,
  registryId: string,
): Promise<RegisteredPageLaunch> {
  let registryRead;
  try {
    registryRead = await readDocVersioned(bundle, registryId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new ViewNotFoundError(registryId, error);
    }
    throw new RegisteredViewLaunchError(
      "VIEW_REGISTRY_READ_FAILED",
      error instanceof Error ? error.message : String(error),
      registryId,
      undefined,
      error,
    );
  }
  const registration = parseRegistration(registryRead.doc.id, registryRead.doc.frontmatter);
  if (!registration) {
    throw new RegisteredViewLaunchError(
      "VIEW_INVALID_REGISTRATION",
      `'${registryId}' is not a valid type:View registration (the legacy type:Page name no longer registers)`,
      registryId,
    );
  }
  let blob: Awaited<ReturnType<typeof readBlob>>;
  try {
    blob = await readBlob(bundle, registration.entry);
  } catch (error) {
    throw new RegisteredViewLaunchError(
      "VIEW_ENTRY_READ_FAILED",
      error instanceof Error ? error.message : String(error),
      registryId,
      registration.entry,
      error,
    );
  }
  if (blob === null) {
    throw new RegisteredViewLaunchError(
      "VIEW_ENTRY_NOT_FOUND",
      `no View bytes found for '${registration.entry}'`,
      registryId,
      registration.entry,
    );
  }
  if (registration.entryVersion && registration.entryVersion !== blob.version) {
    throw new RegisteredViewLaunchError(
      "VIEW_ENTRY_VERSION_CONFLICT",
      `View entry '${registration.entry}' no longer matches its pinned entry_version`,
      registryId,
      registration.entry,
    );
  }
  let admitted: ReturnType<typeof admitActiveView>;
  try {
    admitted = admitActiveView(blob.bytes, blob.contentType);
  } catch (error) {
    throw new RegisteredViewLaunchError(
      "VIEW_ADMISSION_REJECTED",
      error instanceof Error ? error.message : String(error),
      registryId,
      registration.entry,
    );
  }
  const launch = launches.mint({
    sourceKind: "registered",
    registryId: registration.id,
    registryType: registration.type,
    registryVersion: registryRead.version,
    registryTitle:
      typeof registryRead.doc.frontmatter.title === "string"
        ? registryRead.doc.frontmatter.title
        : registration.id,
    entryKey: registration.entry,
    contentType: admitted.contentType,
    contentVersion: blobVersion(admitted.bytes),
    bytes: admitted.bytes,
    capability: resolveDeclaredAccess(registryRead.doc.frontmatter),
  });
  if (!(await launchIsCurrent(bundle, launch))) {
    launches.revoke(launch.launchId);
    throw new RegisteredViewLaunchError(
      "VIEW_CHANGED_DURING_PREPARATION",
      "the View changed while its launch was being prepared",
      registryId,
      registration.entry,
    );
  }
  return launch as RegisteredPageLaunch;
}

/** Admit exact, process-local HTML bytes into the same active-View runtime as a registered View. */
export function mintTransientViewLaunch(
  bundle: Bundle,
  launches: PageLaunchRegistry,
  input: { title: string; html: string; capability?: BridgeCapability },
): TransientPageLaunch {
  const admitted = admitActiveView(
    new TextEncoder().encode(input.html),
    "text/html; charset=utf-8",
  );
  return launches.mint({
    sourceKind: "transient",
    title: input.title,
    bundleIdentity: bundle.root,
    contentType: admitted.contentType,
    contentVersion: blobVersion(admitted.bytes),
    bytes: admitted.bytes,
    capability: input.capability ?? "bundle-read",
  }) as TransientPageLaunch;
}

async function requireApprovedTransientLaunch(
  bundle: Bundle,
  launches: PageLaunchRegistry,
  authorizations: ViewAuthorizationStore,
  launchId: string,
): Promise<TransientPageLaunch> {
  const launch = launches.resolveLaunch(launchId);
  if (
    !launch ||
    launch.sourceKind !== "transient" ||
    !(await launchIsCurrent(bundle, launch))
  ) {
    if (launch) launches.revoke(launch.launchId);
    throw new TransientViewSaveError(
      "The transient View is unknown, expired, or no longer the exact launched content.",
    );
  }
  if (!(await authorizations.isAuthorized(pageLaunchAuthorizationSubject(launch)))) {
    throw new TransientViewSaveError(
      "The transient View must be locally approved before its exact bytes can be saved.",
    );
  }
  return launch;
}

/**
 * Persist one approved transient launch unchanged as a durable registered View.
 *
 * The caller supplies durable identity metadata only. HTML is resolved exclusively from the
 * process-local launch registry, revalidated before each write boundary, and stored with
 * expect-absent CAS. Exact existing content makes the operation idempotent; different content at
 * either destination fails closed. The blob intentionally precedes the registry document so a
 * partial failure can leave only an inert entry, never a discoverable registration pointing at
 * absent bytes.
 */
export async function saveTransientView(
  bundle: Bundle,
  launches: PageLaunchRegistry,
  authorizations: ViewAuthorizationStore,
  input: SaveTransientViewInput,
  options: { actor?: string; now?: string } = {},
): Promise<SaveTransientViewResult> {
  const launchId = input.launchId.trim();
  if (!launchId || launchId.length > 128) {
    throw new TransientViewSaveError("launchId must be a non-empty string of at most 128 characters");
  }
  const launch = await requireApprovedTransientLaunch(
    bundle,
    launches,
    authorizations,
    launchId,
  );
  return persistTransientView(
    bundle,
    launch,
    input,
    async () => {
      try {
        return (
          (await requireApprovedTransientLaunch(
            bundle,
            launches,
            authorizations,
            launchId,
          )) === launch
        );
      } catch {
        return false;
      }
    },
    options,
  );
}

/**
 * Server-side launch authority shared by the web bridge endpoint and MCP adapter. Transient
 * approval defaults to an isolated session store and never aliases registered-View approval.
 */
export class PageBridgeLaunchAuthority implements BridgeLaunchAuthority {
  constructor(
    private readonly bundle: Bundle,
    private readonly launches: PageLaunchRegistry,
    private readonly registeredAuthorizations: ViewAuthorizationStore,
    private readonly transientAuthorizations: ViewAuthorizationStore =
      new SessionViewAuthorizationStore(),
  ) {}

  async resolve(launchId: string, requireAuthorization: boolean): Promise<BridgeLaunch | null> {
    const launch = this.launches.resolveLaunch(launchId);
    if (!launch || !(await launchIsCurrent(this.bundle, launch))) {
      if (launch) this.launches.revoke(launch.launchId);
      return null;
    }
    if (
      requireAuthorization &&
      launch.capability !== "none" &&
      !(await (launch.sourceKind === "registered"
        ? this.registeredAuthorizations
        : this.transientAuthorizations
      ).isAuthorized(pageLaunchAuthorizationSubject(launch)))
    ) {
      return null;
    }
    return { launchId: launch.launchId, capability: launch.capability };
  }

  revoke(launchId: string): void {
    this.launches.revoke(launchId);
  }
}

export interface TrustedActionLaunch {
  launchId: string;
  capability: BridgeCapability;
  source: {
    kind: "registered" | "transient" | "generated";
    id: string;
    title: string;
    version: Version;
    contentVersion: Version;
  };
  /**
   * When present, actions are confined to these exact document versions. Active registered and
   * transient Views omit this because their declared bundle-propose capability is bundle-scoped;
   * generated snapshot presentations supply it because their explicit selection is also their
   * read/action envelope.
   */
  documentVersions?: Readonly<Record<string, Version>>;
}

export interface TrustedActionLaunchAuthority {
  resolve(launchId: string): Promise<TrustedActionLaunch | null>;
  revoke(launchId: string): void;
}

/** Adapts registered and transient active-View launches to the shared action authority. */
export class PageActionLaunchAuthority implements TrustedActionLaunchAuthority {
  constructor(
    private readonly bundle: Bundle,
    private readonly launches: PageLaunchRegistry,
    private readonly registeredAuthorizations: ViewAuthorizationStore,
    private readonly transientAuthorizations: ViewAuthorizationStore = new SessionViewAuthorizationStore(),
  ) {}

  async resolve(launchId: string): Promise<TrustedActionLaunch | null> {
    const launch = this.launches.resolveLaunch(launchId);
    if (
      !launch ||
      !(await launchIsCurrent(this.bundle, launch)) ||
      (launch.capability !== "none" &&
        !(await (launch.sourceKind === "registered"
          ? this.registeredAuthorizations
          : this.transientAuthorizations
        ).isAuthorized(pageLaunchAuthorizationSubject(launch))))
    ) {
      if (launch) this.launches.revoke(launch.launchId);
      return null;
    }
    return {
      launchId: launch.launchId,
      capability: launch.capability,
      source: launch.sourceKind === "registered"
        ? {
            kind: "registered",
            id: launch.registryId,
            title: launch.registryTitle,
            version: launch.registryVersion,
            contentVersion: launch.contentVersion,
          }
        : {
            kind: "transient",
            id: `transient:${launch.contentVersion}`,
            title: launch.title,
            version: launch.contentVersion,
            contentVersion: launch.contentVersion,
          },
    };
  }

  revoke(launchId: string): void {
    this.launches.revoke(launchId);
  }
}

export {
  ACTIVE_VIEW_CONTENT_TYPE,
  ACTIVE_VIEW_POLICY_VERSION,
  MAX_ACTIVE_VIEW_BYTES,
  SessionViewAuthorizationStore,
  admitActiveView,
  type RegisteredViewAuthorizationSubject,
  type ViewAuthorizationStore,
  type ViewAuthorizationSubject,
} from "./authorization.js";
export {
  ACTION_BRIDGE_PROTOCOL,
  BRIDGE_PROTOCOL,
  BridgeService,
  changeMessage,
  parseBridgeRequest,
  type BridgeConfig,
  type BridgeDocumentRenderer,
  type BridgeDocumentRendererInput,
  type BridgeDocumentRendererResult,
  type BridgeLaunch,
  type BridgeLaunchAuthority,
  type BridgeOutcome,
  type BridgePollOutcome,
  type BridgeServiceOptions,
  type EdgeParams,
} from "./bridge.js";

export interface ActionConfirmation {
  source: {
    kind: "registered" | "transient" | "generated";
    id: string;
    title: string;
    version: Version;
    contentVersion: Version;
  };
  target: { docId: string; title: string; kind: string; version: Version };
  field: string;
  storageField?: string;
  before: ActionScalar | null;
  after: ActionScalar;
  actor: string;
  timestamp: string;
}

export type ActionTerminalStatus = "committed" | "unchanged" | "cancelled" | "conflict" | "revoked" | "expired" | "rejected" | "failed";

export interface ActionTerminalResult {
  status: ActionTerminalStatus;
  action: "document.set-field";
  docId?: string;
  field?: string;
  storageField?: string;
  changed?: boolean;
  version?: Version;
  warnings?: ValidationWarning[];
  confirmed?: boolean;
  expectedVersion?: Version;
  actualVersion?: Version | null;
  source?: {
    kind: "registered" | "transient" | "generated";
    id: string;
    version: Version;
    contentVersion: Version;
  };
  message?: string;
}

export type ActionPrepareResult =
  | { status: "prepared"; approvalToken: string; expiresAt: number; confirmation: ActionConfirmation }
  | ActionTerminalResult;

interface PendingApproval {
  token: string;
  expiresAt: number;
  launchId: string;
  action: DocumentSetFieldAction;
  storageField: string;
  okfVersion: string | undefined;
  timestamp: string;
  targetTitle: string;
  targetType: string;
  before: ActionScalar | null;
  kindId: string;
  kindVersion: Version;
  kindDigest: Version;
}

class ActionBundleEditionChanged extends Error {}

const DEFAULT_APPROVAL_TTL_MS = 120_000;
const DEFAULT_MAX_APPROVALS = 128;

export class TrustedActionService {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly bundle: Bundle;
  private readonly launches: TrustedActionLaunchAuthority;
  private readonly actor: string | undefined;
  private readonly now: () => number;
  private readonly approvalTtlMs: number;
  private readonly maxApprovals: number;

  constructor(
    bundle: Bundle,
    launches: TrustedActionLaunchAuthority,
    actor: string | undefined,
    now: () => number = Date.now,
    approvalTtlMs = DEFAULT_APPROVAL_TTL_MS,
    maxApprovals = DEFAULT_MAX_APPROVALS,
  ) {
    this.bundle = bundle;
    this.launches = launches;
    this.actor = actor;
    this.now = now;
    this.approvalTtlMs = approvalTtlMs;
    this.maxApprovals = maxApprovals;
  }

  async prepare(launchId: string, rawAction: unknown): Promise<ActionPrepareResult> {
    const rejected = (message: string): ActionTerminalResult => ({ status: "rejected", action: "document.set-field", message });
    const actor = this.actor?.trim();
    if (!actor) return rejected("set an action actor for this View host before proposing writes");
    const launch = await this.launches.resolve(launchId);
    if (!launch || launch.capability !== "bundle-propose") {
      if (launch) this.launches.revoke(launch.launchId);
      return { status: "revoked", action: "document.set-field", message: "the source View is no longer the exact launched content" };
    }

    let action: DocumentSetFieldAction;
    try {
      action = parseDocumentSetFieldAction(rawAction);
    } catch (error) {
      return rejected(error instanceof Error ? error.message : String(error));
    }
    if (["type", "timestamp", "actor"].includes(action.field)) return rejected(`field '${action.field}' is shell-managed and cannot be proposed`);
    if (
      launch.documentVersions &&
      (!Object.hasOwn(launch.documentVersions, action.docId) ||
        launch.documentVersions[action.docId] !== action.expectedVersion)
    ) {
      return rejected(`document '${action.docId}' at that version is outside this View's action envelope`);
    }

    let target: Awaited<ReturnType<typeof readDocVersioned>>;
    try {
      target = await readDocVersioned(this.bundle, action.docId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return rejected(`document '${action.docId}' does not exist`);
      return { status: "failed", action: "document.set-field", message: error instanceof Error ? error.message : String(error) };
    }
    if (target.version !== action.expectedVersion) {
      return {
        status: "conflict",
        action: "document.set-field",
        docId: action.docId,
        field: action.field,
        expectedVersion: action.expectedVersion,
        actualVersion: target.version,
      };
    }

    let registry: Awaited<ReturnType<typeof loadKinds>>;
    let okfVersion: string | undefined;
    try {
      [registry, okfVersion] = await Promise.all([
        loadKinds(this.bundle),
        readBundleOkfVersion(this.bundle),
      ]);
    } catch (error) {
      return { status: "failed", action: "document.set-field", message: error instanceof Error ? error.message : String(error) };
    }
    const targetType = String(target.doc.frontmatter.type ?? "");
    const kind = registry.kinds.get(targetType);
    if (!kind) return rejected(`document '${action.docId}' is not governed by a declared Kind`);
    const fieldCoordinate = resolveKindFieldCoordinate(okfVersion, kind, action.field);
    if (!fieldCoordinate) {
      return rejected(`field '${action.field}' is not declared by the '${kind.governs}' Kind`);
    }
    const beforeRaw = target.doc.frontmatter[fieldCoordinate.storageField];
    let before: ActionScalar | null;
    if (beforeRaw === undefined || beforeRaw === null) {
      before = null;
    } else if (!isActionScalar(beforeRaw)) {
      return rejected(`field '${action.field}' currently contains a non-scalar value; trusted scalar actions cannot replace it`);
    } else {
      before = beforeRaw;
    }
    if (scalarEqual(beforeRaw, action.value)) {
      return {
        status: "unchanged",
        action: "document.set-field",
        docId: action.docId,
        field: action.field,
        ...(fieldCoordinate.storageField !== action.field
          ? { storageField: fieldCoordinate.storageField }
          : {}),
        changed: false,
        version: target.version,
        confirmed: false,
        source: {
          kind: launch.source.kind,
          id: launch.source.id,
          version: launch.source.version,
          contentVersion: launch.source.contentVersion,
        },
      };
    }

    const timestamp = new Date(this.now()).toISOString();
    const candidate = ownRecord(target.doc.frontmatter);
    setOwn(candidate, fieldCoordinate.storageField, action.value);
    if (okfVersion !== "0.2" || kind.fields.required.includes("timestamp")) {
      setOwn(candidate, "timestamp", timestamp);
    }
    if (okfVersion !== "0.2" || kind.fields.required.includes("actor")) {
      setOwn(candidate, "actor", actor);
    }
    const violations = validateAgainstKind({ id: action.docId, frontmatter: candidate, body: target.doc.body }, kind);
    if (violations.length > 0) return rejected(violations.map((warning) => warning.message).join("; "));

    let kindVersion: Version;
    try {
      kindVersion = (await readDocVersioned(this.bundle, kind.id)).version;
    } catch (error) {
      return { status: "failed", action: "document.set-field", message: error instanceof Error ? error.message : String(error) };
    }

    this.sweepExpired();
    if (this.pending.size >= this.maxApprovals) return rejected("the trusted shell has too many pending confirmations; cancel one and try again");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.approvalTtlMs;
    this.pending.set(token, {
      token,
      expiresAt,
      launchId,
      action,
      storageField: fieldCoordinate.storageField,
      okfVersion,
      timestamp,
      targetTitle: typeof target.doc.frontmatter.title === "string" ? target.doc.frontmatter.title : action.docId,
      targetType,
      before,
      kindId: kind.id,
      kindVersion,
      kindDigest: kindDigest(kind),
    });
    return {
      status: "prepared",
      approvalToken: token,
      expiresAt,
      confirmation: {
        source: {
          kind: launch.source.kind,
          id: launch.source.id,
          title: launch.source.title,
          version: launch.source.version,
          contentVersion: launch.source.contentVersion,
        },
        target: { docId: action.docId, title: this.pending.get(token)!.targetTitle, kind: targetType, version: target.version },
        field: action.field,
        ...(fieldCoordinate.storageField !== action.field
          ? { storageField: fieldCoordinate.storageField }
          : {}),
        before,
        after: action.value,
        actor,
        timestamp,
      },
    };
  }

  cancel(token: string, launchId?: string): ActionTerminalResult {
    const pending = this.consume(token, launchId);
    return pending
      ? { status: "cancelled", action: "document.set-field", docId: pending.action.docId, field: pending.action.field, changed: false, confirmed: false }
      : { status: "expired", action: "document.set-field", message: "the approval is unknown or expired" };
  }

  async commit(token: string, launchId?: string): Promise<ActionTerminalResult> {
    const pending = this.consume(token, launchId);
    if (!pending) return { status: "expired", action: "document.set-field", message: "the approval is unknown or expired" };
    if (this.now() > pending.expiresAt) return { status: "expired", action: "document.set-field", docId: pending.action.docId, field: pending.action.field };
    const launch = await this.resolvePendingLaunch(pending);
    if (!launch) {
      return { status: "revoked", action: "document.set-field", docId: pending.action.docId, field: pending.action.field };
    }

    try {
      const target = await readDocVersioned(this.bundle, pending.action.docId);
      if (target.version !== pending.action.expectedVersion) {
        return {
          status: "conflict",
          action: "document.set-field",
          docId: pending.action.docId,
          field: pending.action.field,
          expectedVersion: pending.action.expectedVersion,
          actualVersion: target.version,
        };
      }
      const [registry, okfVersion] = await Promise.all([
        loadKinds(this.bundle),
        readBundleOkfVersion(this.bundle),
      ]);
      if (okfVersion !== pending.okfVersion) {
        return { status: "revoked", action: "document.set-field", message: "the bundle OKF edition changed" };
      }
      const kind = registry.kinds.get(pending.targetType);
      if (!kind || kind.id !== pending.kindId) return { status: "revoked", action: "document.set-field", message: "the governing Kind changed" };
      const fieldCoordinate = resolveKindFieldCoordinate(okfVersion, kind, pending.action.field);
      if (!fieldCoordinate || fieldCoordinate.storageField !== pending.storageField) {
        return { status: "revoked", action: "document.set-field", message: "the governing Kind field mapping changed" };
      }
      const currentKindVersion = (await readDocVersioned(this.bundle, kind.id)).version;
      if (currentKindVersion !== pending.kindVersion || kindDigest(kind) !== pending.kindDigest) {
        return { status: "revoked", action: "document.set-field", message: "the governing Kind changed" };
      }

      // Re-check after every target/Kind read and immediately before the write. The View and
      // target are separate backend resources, so no cross-resource atomic CAS exists; the target
      // CAS below remains the final write guard while this closes the reachable asynchronous gap.
      const finalLaunch = await this.resolvePendingLaunch(pending);
      if (!finalLaunch) {
        return { status: "revoked", action: "document.set-field", docId: pending.action.docId, field: pending.action.field };
      }
      const result = await mutateDocument({
        bundle: this.bundle,
        id: pending.action.docId,
        mode: "patch",
        registry,
        strict: true,
        actor: this.actor!.trim(),
        expectedVersion: pending.action.expectedVersion,
        now: () => pending.timestamp,
        buildCandidate: (existing, context) => {
          if (!existing) throw new DocumentNotFoundError(pending.action.docId);
          if (context.okfVersion !== (pending.okfVersion ?? "0.1")) {
            throw new ActionBundleEditionChanged("the bundle OKF edition changed");
          }
          const frontmatter = ownRecord(existing.frontmatter);
          setOwn(frontmatter, pending.storageField, pending.action.value);
          if (context.okfVersion !== "0.2" || kind.fields.required.includes("timestamp")) {
            setOwn(frontmatter, "timestamp", pending.timestamp);
          }
          return { frontmatter, body: existing.body };
        },
      });
      return {
        status: "committed",
        action: "document.set-field",
        docId: pending.action.docId,
        field: pending.action.field,
        ...(pending.storageField !== pending.action.field
          ? { storageField: pending.storageField }
          : {}),
        changed: result.changed,
        version: result.version,
        warnings: result.warnings,
        confirmed: true,
        source: {
          kind: finalLaunch.source.kind,
          id: finalLaunch.source.id,
          version: finalLaunch.source.version,
          contentVersion: finalLaunch.source.contentVersion,
        },
      };
    } catch (error) {
      if (error instanceof VersionConflict) {
        return {
          status: "conflict",
          action: "document.set-field",
          docId: pending.action.docId,
          field: pending.action.field,
          expectedVersion: error.expected ?? pending.action.expectedVersion,
          actualVersion: error.actual,
        };
      }
      if (error instanceof DocumentNotFoundError) {
        return { status: "conflict", action: "document.set-field", docId: pending.action.docId, field: pending.action.field, expectedVersion: pending.action.expectedVersion, actualVersion: null };
      }
      if (error instanceof KindConformanceError) {
        return { status: "rejected", action: "document.set-field", docId: pending.action.docId, field: pending.action.field, message: error.message };
      }
      if (error instanceof ActionBundleEditionChanged) {
        return { status: "revoked", action: "document.set-field", docId: pending.action.docId, field: pending.action.field, message: error.message };
      }
      return { status: "failed", action: "document.set-field", docId: pending.action.docId, field: pending.action.field, message: error instanceof Error ? error.message : String(error) };
    }
  }

  size(): number {
    this.sweepExpired();
    return this.pending.size;
  }

  private async resolvePendingLaunch(pending: PendingApproval): Promise<TrustedActionLaunch | null> {
    const launch = await this.launches.resolve(pending.launchId);
    if (
      !launch ||
      launch.capability !== "bundle-propose" ||
      (launch.documentVersions &&
        (!Object.hasOwn(launch.documentVersions, pending.action.docId) ||
          launch.documentVersions[pending.action.docId] !== pending.action.expectedVersion))
    ) {
      if (launch) this.launches.revoke(launch.launchId);
      return null;
    }
    return launch;
  }

  private consume(token: string, launchId?: string): PendingApproval | undefined {
    const pending = this.pending.get(token);
    if (pending && launchId !== undefined && pending.launchId !== launchId) return undefined;
    if (pending) this.pending.delete(token);
    return pending;
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [token, pending] of this.pending) {
      if (now > pending.expiresAt) this.pending.delete(token);
    }
  }
}
