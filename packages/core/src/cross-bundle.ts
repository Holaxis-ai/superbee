/**
 * Cross-bundle link resolution: the resolver interface every backend implements, and the local
 * resolver over explicitly bound {@link StorageBackend}s.
 *
 * Resolution is always explicit. A resolver reads only the copies it was constructed with; nothing
 * is fetched or discovered. Browser-safe: bindings are backends, never filesystem paths, and pin
 * checks are injected (the CLI probes git; core never spawns a process).
 */

import type { DependencyEntry, DependencyMap } from "./dependencies.js";
import { readManyExisting } from "./engine.js";
import { InvalidInputError } from "./errors.js";
import { qualifiedHref, type QualifiedLink, type QualifiedRef } from "./qualified-links.js";
import type { ConceptId, OkfDocument, ReadResult, StorageBackend, Version } from "./types.js";

/**
 * Why a link did not resolve. An unresolved link is still a valid link.
 * - `bundle_unavailable`: no copy is bound, or the bound copy is not the declared bundle.
 * - `pin_mismatch`: the bound copy is not at the pinned version.
 * - `target_missing`: the document is not in the bound copy.
 * - `not_authorized`: the reader may not read the target bundle.
 * - `unknown_alias`: the alias is not declared in `docs/dependencies`.
 * - `invalid_ref`: the href is malformed.
 */
export type UnresolvedReason =
  | "bundle_unavailable"
  | "pin_mismatch"
  | "target_missing"
  | "not_authorized"
  | "unknown_alias"
  | "invalid_ref";

export const UNRESOLVED_REASONS: readonly UnresolvedReason[] = Object.freeze([
  "bundle_unavailable",
  "pin_mismatch",
  "target_missing",
  "not_authorized",
  "unknown_alias",
  "invalid_ref",
]);

/**
 * The reasons that are the referring document's fault (fix the link or the target). The others
 * (`bundle_unavailable`, `pin_mismatch`, `not_authorized`) describe the reader's environment or
 * access, and a check must not blame the document for them.
 */
export const RECORD_REASONS: readonly UnresolvedReason[] = Object.freeze([
  "target_missing",
  "unknown_alias",
  "invalid_ref",
]);

export function isRecordReason(reason: UnresolvedReason): boolean {
  return RECORD_REASONS.includes(reason);
}

/** The one detail every `not_authorized` result carries, so it says nothing about the target. */
export const NOT_AUTHORIZED_DETAIL = "the reader is not authorized to read this bundle";

export type Resolution =
  | {
      state: "resolved";
      ref: QualifiedRef;
      bundle_id: string;
      /** A backend-defined revision of the bound copy, when it has one. The local resolver sets none. */
      revision?: string;
      document: OkfDocument;
      version: Version;
    }
  | {
      state: "unresolved";
      /** Null when the ref itself is malformed. */
      ref: QualifiedRef | null;
      href: string;
      reason: UnresolvedReason;
      /** Only ever the id from the reader's own declaration. */
      bundle_id?: string;
      detail: string;
    };

/** A link into a target document from a bundle the reader may read. */
export interface CrossBacklink {
  from: { bundle_id: string; id: ConceptId };
  text: string;
  href: string;
}

/**
 * Resolves `okf://` refs for ONE reader.
 *
 * Authorization invariants, binding on every implementation (local, hosted, any future one):
 *
 * 1. A resolver is built for one reader. Grants are a constructor concern, never a method
 *    parameter.
 * 2. The grant check comes first. For a reader without a grant on the target bundle, the answer is
 *    `not_authorized` before any "bundle not found", "document not found" or `pin_mismatch`, and
 *    before any revision or version is disclosed.
 * 3. `not_authorized` results for a present target and for a missing target are deep-equal, with
 *    the fixed detail {@link NOT_AUTHORIZED_DETAIL}. Their `bundle_id` comes only from the
 *    reader's own declaration.
 * 4. `backlinks()` returns only hits in readable bundles, and never names or counts the others.
 *
 * The local resolver reads only copies the reader bound explicitly, so it never answers
 * `not_authorized`.
 */
export interface BundleResolver {
  /** `"local"` here; `"hosted"` later. */
  readonly kind: string;
  readonly dependencies: DependencyMap;
  /** Batched and positional: `result[i]` answers `refs[i]`. */
  resolve(refs: readonly QualifiedRef[]): Promise<Resolution[]>;
  backlinks(target: { bundle_id: string; id: ConceptId }, options?: { text?: string }): Promise<CrossBacklink[]>;
}

export interface CommitPin {
  kind: "commit";
  value: string;
}

/** Whether a bound copy is at a commit pin. Injected by the caller (the CLI checks the bundle's git subtree). */
export type PinCheck = (pin: CommitPin) => Promise<{ ok: true } | { ok: false; detail: string }>;

export interface BundleBinding {
  backend: StorageBackend;
  /** How the caller named the copy (a path or catalog label), for messages. */
  label: string;
  /** The bound copy's own portable id. Absent or different from the declaration: `bundle_unavailable`. */
  identity?: string;
  /** Required to satisfy a commit pin; without it a pinned dependency is `pin_mismatch`. */
  pin?: PinCheck;
}

export interface LocalResolverOptions {
  dependencies: DependencyMap;
  bindings: ReadonlyMap<string, BundleBinding>;
}

type Unresolved = Extract<Resolution, { state: "unresolved" }>;

function hrefOf(ref: QualifiedRef): { href: string; valid: boolean } {
  try {
    return { href: qualifiedHref(ref), valid: true };
  } catch (error) {
    if (error instanceof InvalidInputError) return { href: `okf://${ref.alias}/${ref.id}.md`, valid: false };
    throw error;
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The per-alias verdict before any document is read: null when the copy may be read. */
async function bindingVerdict(
  entry: DependencyEntry,
  binding: BundleBinding | undefined,
): Promise<{ reason: UnresolvedReason; detail: string } | null> {
  if (!binding) return { reason: "bundle_unavailable", detail: `no copy of '${entry.bundle_id}' is bound for alias '${entry.alias}'` };
  if (binding.identity === undefined) {
    return { reason: "bundle_unavailable", detail: `${binding.label} declares no bundle_id; expected '${entry.bundle_id}'` };
  }
  if (binding.identity !== entry.bundle_id) {
    return { reason: "bundle_unavailable", detail: `${binding.label} is '${binding.identity}', not '${entry.bundle_id}'` };
  }
  const pin = entry.pin;
  if (!pin) return null;
  if (pin.kind === "digest") return { reason: "pin_mismatch", detail: "digest pins are verified by a hosted resolver" };
  if (!binding.pin) return { reason: "pin_mismatch", detail: `no pin check is available for ${binding.label}` };
  try {
    const verdict = await binding.pin({ kind: "commit", value: pin.value });
    return verdict.ok ? null : { reason: "pin_mismatch", detail: verdict.detail };
  } catch (error) {
    return { reason: "pin_mismatch", detail: `pin check failed: ${errorDetail(error)}` };
  }
}

/**
 * The local resolver: each alias reads through the backend the caller bound to it. One
 * delete-tolerant batch read per alias per `resolve` call.
 *
 * `backlinks()` always returns `[]`: a local reader has no index of who links into a bundle, and
 * scanning other bound copies for inbound links is deferred until something needs it.
 */
export function createLocalResolver(options: LocalResolverOptions): BundleResolver {
  const { dependencies, bindings } = options;
  return {
    kind: "local",
    dependencies,
    async resolve(refs) {
      const out: Array<Resolution | undefined> = new Array(refs.length);
      const unresolved = (i: number, ref: QualifiedRef | null, href: string, reason: UnresolvedReason, detail: string, bundleId?: string): void => {
        const row: Unresolved = { state: "unresolved", ref, href, reason, detail };
        if (bundleId !== undefined) row.bundle_id = bundleId;
        out[i] = row;
      };

      // alias -> indexes of the refs that reached the read stage
      const pending = new Map<string, number[]>();
      const verdicts = new Map<string, Promise<{ reason: UnresolvedReason; detail: string } | null>>();
      const hrefs: string[] = [];
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i]!;
        const { href, valid } = hrefOf(ref);
        hrefs[i] = href;
        if (!valid) {
          unresolved(i, null, href, "invalid_ref", "not a valid cross-bundle target");
          continue;
        }
        const entry = dependencies.get(ref.alias);
        if (!entry) {
          unresolved(i, ref, href, "unknown_alias", `alias '${ref.alias}' is not declared in docs/dependencies`);
          continue;
        }
        if (!verdicts.has(ref.alias)) verdicts.set(ref.alias, bindingVerdict(entry, bindings.get(ref.alias)));
        const indexes = pending.get(ref.alias) ?? [];
        indexes.push(i);
        pending.set(ref.alias, indexes);
      }

      for (const [alias, indexes] of pending) {
        const entry = dependencies.get(alias)!;
        const verdict = await verdicts.get(alias)!;
        if (verdict) {
          for (const i of indexes) unresolved(i, refs[i]!, hrefs[i]!, verdict.reason, verdict.detail, entry.bundle_id);
          continue;
        }
        const binding = bindings.get(alias)!;
        const ids = [...new Set(indexes.map((i) => refs[i]!.id))];
        const malformed = new Map<ConceptId, string>();
        let found: Map<ConceptId, ReadResult>;
        try {
          const results = await readManyExisting(binding.backend, ids, (skip) => malformed.set(skip.id, skip.reason));
          found = new Map(results.map((result) => [result.doc.id, result]));
        } catch (error) {
          const detail = `${binding.label} could not be read: ${errorDetail(error)}`;
          for (const i of indexes) unresolved(i, refs[i]!, hrefs[i]!, "bundle_unavailable", detail, entry.bundle_id);
          continue;
        }
        for (const i of indexes) {
          const ref = refs[i]!;
          const hit = found.get(ref.id);
          if (hit) {
            out[i] = { state: "resolved", ref, bundle_id: entry.bundle_id, document: hit.doc, version: hit.version };
          } else {
            const why = malformed.get(ref.id);
            const detail = why === undefined
              ? `'${ref.id}' is not in ${binding.label}`
              : `'${ref.id}' in ${binding.label} is malformed: ${why}`;
            unresolved(i, ref, hrefs[i]!, "target_missing", detail, entry.bundle_id);
          }
        }
      }
      return out as Resolution[];
    },
    async backlinks() {
      return [];
    },
  };
}

export interface QualifiedLinkResolution {
  link: QualifiedLink;
  resolution: Resolution;
}

/**
 * Resolve parsed links (from {@link parseQualifiedLinks}) in one `resolve` call. A malformed href
 * is `invalid_ref` here without reaching the resolver, and carries the parser's detail.
 */
export async function resolveQualifiedLinks(
  resolver: BundleResolver,
  links: readonly QualifiedLink[],
): Promise<QualifiedLinkResolution[]> {
  const refs: QualifiedRef[] = [];
  for (const link of links) if (link.ref) refs.push(link.ref);
  const resolved = await resolver.resolve(refs);
  let next = 0;
  return links.map((link) => {
    if (!link.ref) {
      return {
        link,
        resolution: { state: "unresolved", ref: null, href: link.href, reason: "invalid_ref", detail: link.detail ?? "malformed cross-bundle link" },
      };
    }
    return { link, resolution: resolved[next++]! };
  });
}
