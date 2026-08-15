import {
  queryHeads,
  readBlob,
  type Bundle,
  type HeadResult,
} from "@superbee/core";
import { meaningfulChangeTimeValue } from "@superbee/core/meaningful-change-time";
import { mutationActorFromFrontmatter } from "@superbee/core/mutation-attribution";
import {
  parseRegistration,
  resolveDeclaredAccess,
  type BridgeCapability,
} from "@superbee/core/page";
import { admitActiveView } from "./authorization.js";

export type ViewPresentation = "workspace" | "inline" | "adaptive";

export interface ViewCatalogEntry {
  id: string;
  version: string;
  title: string;
  access: BridgeCapability;
  presentation?: ViewPresentation;
  description?: string;
  actor?: string;
  timestamp?: string;
}

export interface ViewCatalog {
  entries: ViewCatalogEntry[];
  total: number;
  invalidRegistrations: number;
  unavailableEntries: number;
  skippedDocuments: number;
}

export interface ViewCatalogProjectionOptions {
  skippedDocuments?: number;
  admitEntry: (entry: string, expectedVersion?: string) => Promise<boolean>;
}

export interface ViewCatalogPageOptions {
  afterId?: string;
  limit: number;
  scanLimit: number;
  access: readonly BridgeCapability[];
}

export interface ViewCatalogPage {
  entries: ViewCatalogEntry[];
  registeredTotal: number;
  excludedAccess: number;
  invalidRegistrations: number;
  pageUnavailableEntries: number;
  skippedDocuments: number;
  examined: number;
  truncated: boolean;
  nextAfterId?: string;
}

interface ViewCatalogCandidate {
  row: ViewCatalogEntry;
  entry: string;
  entryVersion?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function presentation(value: unknown): ViewPresentation | undefined {
  return value === "workspace" || value === "inline" || value === "adaptive"
    ? value
    : undefined;
}

function projectCandidates(heads: readonly HeadResult[]): {
  candidates: ViewCatalogCandidate[];
  invalidRegistrations: number;
} {
  const candidates: ViewCatalogCandidate[] = [];
  let invalidRegistrations = 0;
  for (const head of heads) {
    const registration = parseRegistration(head.id, head.frontmatter);
    if (!registration) {
      invalidRegistrations += 1;
      continue;
    }
    const declaredPresentation = presentation(head.frontmatter.presentation);
    const description = optionalString(head.frontmatter.description);
    const actor = mutationActorFromFrontmatter(head.frontmatter);
    const timestamp = optionalString(meaningfulChangeTimeValue(head.frontmatter));
    candidates.push({
      entry: registration.entry,
      ...(registration.entryVersion ? { entryVersion: registration.entryVersion } : {}),
      row: {
        id: registration.id,
        version: head.version,
        title: optionalString(head.frontmatter.title) ?? registration.id,
        access: resolveDeclaredAccess(head.frontmatter),
        ...(declaredPresentation ? { presentation: declaredPresentation } : {}),
        ...(description ? { description } : {}),
        ...(actor ? { actor } : {}),
        ...(timestamp ? { timestamp } : {}),
      },
    });
  }
  candidates.sort((a, b) => a.row.id.localeCompare(b.row.id));
  return { candidates, invalidRegistrations };
}

function cachedAdmission(
  admitEntry: (entry: string, expectedVersion?: string) => Promise<boolean>,
): (entry: string, expectedVersion?: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (entry, expectedVersion) => {
    const cacheKey = `${entry}\0${expectedVersion ?? ""}`;
    const existing = cache.get(cacheKey);
    if (existing) return existing;
    const pending = admitEntry(entry, expectedVersion).catch(() => false);
    cache.set(cacheKey, pending);
    return pending;
  };
}

async function admitBundleEntry(bundle: Bundle, entry: string, expectedVersion?: string): Promise<boolean> {
  const blob = await readBlob(bundle, entry);
  if (blob === null) return false;
  if (expectedVersion && expectedVersion !== blob.version) return false;
  admitActiveView(blob.bytes, blob.contentType);
  return true;
}

/**
 * Project View-typed document heads through the one registration and active-HTML admission path
 * used by every launcher. The entry key is consumed only by the injected admission probe and is
 * never returned in catalog rows.
 */
export async function projectViewCatalog(
  heads: readonly HeadResult[],
  options: ViewCatalogProjectionOptions,
): Promise<ViewCatalog> {
  const { candidates, invalidRegistrations } = projectCandidates(heads);
  const admitEntry = cachedAdmission(options.admitEntry);
  const entries: ViewCatalogEntry[] = [];
  let unavailableEntries = 0;
  for (const candidate of candidates) {
    if (!(await admitEntry(candidate.entry, candidate.entryVersion))) {
      unavailableEntries += 1;
      continue;
    }
    entries.push(candidate.row);
  }
  return {
    entries,
    total: entries.length,
    invalidRegistrations,
    unavailableEntries,
    skippedDocuments: options.skippedDocuments ?? 0,
  };
}

/** Read the current bundle's complete catalog of registered, admissible active Views. */
export async function listViewCatalog(bundle: Bundle): Promise<ViewCatalog> {
  const skipped: unknown[] = [];
  const heads = await queryHeads(bundle, { type: "View" }, { onSkip: (row) => skipped.push(row) });
  return projectViewCatalog(heads, {
    skippedDocuments: skipped.length,
    admitEntry: (entry, expectedVersion) => admitBundleEntry(bundle, entry, expectedVersion),
  });
}

/**
 * Read one work-bounded page for an agent-facing catalog. The registration total is exact from
 * document heads; active-HTML admission is deliberately limited to `scanLimit` candidates, so a
 * hostile or very large bundle cannot turn a 20-row tool result into an unbounded blob scan.
 */
export async function listViewCatalogPage(
  bundle: Bundle,
  options: ViewCatalogPageOptions,
): Promise<ViewCatalogPage> {
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
    throw new Error("View catalog page limit must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.scanLimit) || options.scanLimit < options.limit) {
    throw new Error("View catalog scan limit must be a safe integer at least as large as the page limit");
  }
  const skipped: unknown[] = [];
  const heads = await queryHeads(bundle, { type: "View" }, { onSkip: (row) => skipped.push(row) });
  const { candidates, invalidRegistrations } = projectCandidates(heads);
  const supported = new Set(options.access);
  const compatible = candidates.filter((candidate) => supported.has(candidate.row.access));
  const offset = options.afterId === undefined
    ? 0
    : compatible.findIndex((candidate) => candidate.row.id.localeCompare(options.afterId!) > 0);
  let index = offset < 0 ? compatible.length : offset;
  let examined = 0;
  let unavailableEntries = 0;
  let lastExaminedId: string | undefined;
  const entries: ViewCatalogEntry[] = [];
  const admitEntry = cachedAdmission((entry, expectedVersion) => admitBundleEntry(bundle, entry, expectedVersion));
  while (
    index < compatible.length &&
    examined < options.scanLimit &&
    entries.length < options.limit
  ) {
    const candidate = compatible[index]!;
    index += 1;
    examined += 1;
    lastExaminedId = candidate.row.id;
    if (await admitEntry(candidate.entry, candidate.entryVersion)) entries.push(candidate.row);
    else unavailableEntries += 1;
  }
  const truncated = index < compatible.length;
  return {
    entries,
    registeredTotal: compatible.length,
    excludedAccess: candidates.length - compatible.length,
    invalidRegistrations,
    pageUnavailableEntries: unavailableEntries,
    skippedDocuments: skipped.length,
    examined,
    truncated,
    ...(truncated && lastExaminedId ? { nextAfterId: lastExaminedId } : {}),
  };
}
