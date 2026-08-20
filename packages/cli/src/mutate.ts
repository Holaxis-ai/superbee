/**
 * CLI adapter for core's document mutation service.
 *
 * Core owns the read/decide/CAS/retry policy and typed domain failures. This
 * module deliberately owns only CLI presentation: verb-specific error wording,
 * remote error hints, help text, and the best-effort board attribution hook.
 */
import {
  DocumentNotFoundError,
  KindConformanceError,
  mutateDocument,
  readDoc,
  VersionConflict,
  type Bundle,
  type ConceptId,
  type DocumentMutationCandidate,
  type DocumentMutationContext,
  type DocumentMutationMode,
  type Frontmatter,
  type KindRegistry,
  type OkfDocument,
  type ValidationWarning,
  type Version,
} from "@superbee/core";
import { CliError, classifyBundleError } from "./errors.js";
import { kindConformanceCliError } from "./kind-write.js";

export type MutateMode = DocumentMutationMode;

/** The frontmatter and body a CLI verb wants persisted; the service supplies the id. */
export interface MutateCandidate extends DocumentMutationCandidate {
  frontmatter: Frontmatter;
}

/** Structured CLI errors for the conflict shapes a verb can hit. */
export interface MutateErrorHooks {
  notFound?: () => CliError;
  alreadyExists?: (err: VersionConflict) => CliError;
  staleHead?: (err: VersionConflict) => CliError;
}

export interface MutateDocOptions {
  bundle: Bundle;
  id: ConceptId;
  mode: MutateMode;
  registry: KindRegistry;
  strict: boolean;
  /** Fallback `help` for a kind rejection whose violations name no completable field (see `kindConformanceCliError`). */
  helpOnKindReject: string;
  buildCandidate: (
    existing: OkfDocument | undefined,
    context: DocumentMutationContext,
  ) => MutateCandidate | Promise<MutateCandidate>;
  onAbsent?: "fail" | "create";
  maxAttempts?: number;
  compareTimestamp?: boolean;
  remoteUrl?: string;
  actor?: string;
  persistActor?: boolean;
  expectedVersion?: Version;
  /** Best-effort CLI orchestration hook; it never changes mutation success. */
  onPersisted?: () => void | Promise<void>;
  errors: MutateErrorHooks;
}

export interface MutateResult {
  doc: OkfDocument;
  changed: boolean;
  version: Version;
  warnings: ValidationWarning[];
}

async function firePostPersist(hook: (() => void | Promise<void>) | undefined): Promise<void> {
  if (!hook) return;
  try {
    await hook();
  } catch {
    // Best-effort by contract: orchestration cannot turn a successful write into a failure.
  }
}

/**
 * Whether `id` can safely be assumed to already exist in `bundle`, for the purpose of deciding if a
 * kind refusal's `help` may be a completing `doc update <id>` command (see
 * `kindConformanceCliError`'s doc comment). `patch` mode requires an existing target
 * (`mutateDocument`'s own precondition), so it's always `true` with no I/O. `create-only` is an
 * expect-absent create, so it's always `false` with no I/O. `overwrite` can go either way — a real
 * best-effort read is the only honest answer there; any read failure (including a genuine absence)
 * is treated as "does not exist," the conservative choice that only ever suppresses a completing
 * command, never emits a broken one.
 */
async function docExistsForMode(bundle: Bundle, id: ConceptId, mode: MutateMode): Promise<boolean> {
  if (mode === "patch") return true;
  if (mode === "create-only") return false;
  try {
    await readDoc(bundle, id);
    return true;
  } catch {
    return false;
  }
}

async function translateMutationError(error: unknown, opts: MutateDocOptions): Promise<never> {
  if (error instanceof KindConformanceError) {
    const docExists = await docExistsForMode(opts.bundle, opts.id, opts.mode);
    throw kindConformanceCliError(error, opts.registry, opts.helpOnKindReject, docExists);
  }
  if (error instanceof DocumentNotFoundError) {
    throw opts.errors.notFound?.() ?? new CliError("NOT_FOUND", error.message);
  }
  if (error instanceof VersionConflict) {
    if (opts.mode === "create-only") {
      throw opts.errors.alreadyExists?.(error) ?? new CliError("ALREADY_EXISTS", `'${opts.id}' already exists`);
    }
    throw opts.errors.staleHead?.(error) ?? new CliError("STALE_HEAD", error.message);
  }
  throw classifyBundleError(error, opts.remoteUrl);
}

export async function mutateDoc(opts: MutateDocOptions): Promise<MutateResult> {
  try {
    const result = await mutateDocument({
      bundle: opts.bundle,
      id: opts.id,
      mode: opts.mode,
      registry: opts.registry,
      strict: opts.strict,
      buildCandidate: opts.buildCandidate,
      onAbsent: opts.onAbsent,
      maxAttempts: opts.maxAttempts,
      compareTimestamp: opts.compareTimestamp,
      actor: opts.actor,
      persistActor: opts.persistActor,
      expectedVersion: opts.expectedVersion,
    });

    if (result.changed) await firePostPersist(opts.onPersisted);

    return result;
  } catch (error) {
    return await translateMutationError(error, opts);
  }
}
