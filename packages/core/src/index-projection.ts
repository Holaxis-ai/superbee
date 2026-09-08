/**
 * Portable `index.md` projection policy.
 *
 * Concept heads are authoritative. Index files are deterministic, replaceable views over
 * one observed head set. Planning is pure; preparation reads and classifies EVERY target
 * before a write; application uses those exact versions with single-shot CAS. A conflict
 * stops the batch instead of silently re-deciding one file outside the global preflight.
 */

import { backendFor } from "./bundle.js";
import { InvalidInputError } from "./errors.js";
import { parseMarkdown, parseReservedMarkdown, stringifyReservedMarkdown } from "./frontmatter.js";
import { GENERATED_INDEX_MARKER } from "./index-marker.js";
import { assertSafeConceptId, toPosix } from "./paths.js";
import type { Bundle, HeadResult, Version } from "./types.js";

export { GENERATED_INDEX_MARKER } from "./index-marker.js";

/** One directory's deterministic, frontmatter-free body. `dir === ""` is the bundle root. */
export interface PlannedIndex {
  dir: string;
  body: string;
}

/** A complete recursive projection over one observed set of concept heads. */
export interface IndexProjectionPlan {
  targets: PlannedIndex[];
}

export type IndexProjectionDisposition = "missing" | "generated" | "unchanged" | "adopted" | "refused";

/** One target after reading its current bytes and classifying ownership. */
export interface PreparedIndexTarget {
  dir: string;
  content: string;
  expectedVersion: Version | null;
  disposition: IndexProjectionDisposition;
  reason?: "unmarked" | "malformed-marker" | "duplicate-marker" | "nested-frontmatter" | "malformed-root";
}

export interface ReadyIndexProjection {
  ready: true;
  targets: PreparedIndexTarget[];
  refused: [];
}

export interface RefusedIndexProjection {
  ready: false;
  targets: PreparedIndexTarget[];
  refused: PreparedIndexTarget[];
}

/** Preparation is the dry-run/check result the future CLI can project directly. */
export type IndexProjectionPreparation = ReadyIndexProjection | RefusedIndexProjection;

export interface AppliedIndexTarget {
  dir: string;
  disposition: Exclude<IndexProjectionDisposition, "unchanged" | "refused">;
  version: Version;
}

export interface IndexProjectionApplyResult {
  completed: AppliedIndexTarget[];
  unchanged: string[];
  pending: [];
}

/** A terminal per-file failure after zero or more earlier targets completed. */
export class IndexProjectionWriteError extends Error {
  override readonly name = "IndexProjectionWriteError";
  readonly failed: string;
  readonly completed: AppliedIndexTarget[];
  readonly pending: string[];

  constructor(
    failed: string,
    completed: AppliedIndexTarget[],
    pending: string[],
    cause: unknown,
  ) {
    super(`index projection write failed at '${displayDir(failed)}'`, { cause });
    this.failed = failed;
    this.completed = completed;
    this.pending = pending;
  }
}

interface DirectoryProjection {
  direct: HeadResult[];
  children: Set<string>;
}

function displayDir(dir: string): string {
  return dir === "" ? "index.md" : `${dir}/index.md`;
}

/** Collapse frontmatter display text to one Markdown line. */
function inlineText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed === "" ? undefined : collapsed;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** URL-encode each path segment while preserving hierarchy and the `.md` suffix. */
function hrefSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function ensureDirectory(map: Map<string, DirectoryProjection>, dir: string): DirectoryProjection {
  const existing = map.get(dir);
  if (existing) return existing;
  const created = { direct: [], children: new Set<string>() };
  map.set(dir, created);
  return created;
}

function depth(dir: string): number {
  return dir === "" ? 0 : dir.split("/").length;
}

/** Locale-independent code-unit ordering keeps projection bytes portable across hosts. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Plan root + every ancestor directory from ONE complete `queryHeads`-shaped set.
 * The caller supplies the root display name; core never derives it from a local path or URL.
 */
export function planIndexProjection(displayName: string, heads: readonly HeadResult[]): IndexProjectionPlan {
  const directories = new Map<string, DirectoryProjection>();
  ensureDirectory(directories, "");

  for (const head of heads) {
    assertSafeConceptId(head.id);
    const normalized = toPosix(head.id).replace(/^\.\//, "");
    const segments = normalized.split("/");
    const conceptName = segments.pop()!;
    let parent = "";
    for (const child of segments) {
      const next = parent === "" ? child : `${parent}/${child}`;
      ensureDirectory(directories, parent).children.add(child);
      ensureDirectory(directories, next);
      parent = next;
    }
    ensureDirectory(directories, parent).direct.push({ ...head, id: parent === "" ? conceptName : `${parent}/${conceptName}` });
  }

  const rootTitle = inlineText(displayName) ?? "bundle";
  const targets = [...directories.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([dir, projection]): PlannedIndex => {
      const groups = new Map<string, string[]>();
      const prefix = dir === "" ? "" : `${dir}/`;
      for (const head of projection.direct) {
        const fileName = head.id.slice(prefix.length);
        const type = inlineText(head.frontmatter.type) ?? "Concept";
        const title = inlineText(head.frontmatter.title) ?? fileName;
        const description = inlineText(head.frontmatter.description);
        const href = `${hrefSegment(fileName)}.md`;
        const bullet = `* [${escapeLabel(title)}](${href})${description ? ` - ${description}` : ""}`;
        const group = groups.get(type) ?? [];
        group.push(bullet);
        groups.set(type, group);
      }

      const sections: string[] = [];
      for (const type of [...groups.keys()].sort()) {
        sections.push(`# ${type}\n\n${groups.get(type)!.sort().join("\n")}\n`);
      }
      if (projection.children.size > 0) {
        const bullets = [...projection.children]
          .sort()
          .map((child) => `* [${escapeLabel(child)}](${hrefSegment(child)}/index.md)`);
        sections.push(`# Subdirectories\n\n${bullets.join("\n")}\n`);
      }

      const title = dir === "" ? rootTitle : inlineText(dir.split("/").pop()) ?? "directory";
      const body = `${GENERATED_INDEX_MARKER}\n# ${title}\n\n${sections.join("\n")}`.trimEnd() + "\n";
      return { dir, body };
    });

  return { targets };
}

interface Ownership {
  owned: boolean;
  body: string;
  frontmatter?: Record<string, unknown>;
  unparseable?: boolean;
  reason?: PreparedIndexTarget["reason"];
}

function markerOwnership(body: string): Pick<Ownership, "owned" | "reason"> {
  const lines = body.split("\n");
  const exact = lines.filter((line) => line === GENERATED_INDEX_MARKER).length;
  const markerLike = lines.filter((line) =>
    /^\s*<!--\s*agentstate-lite:generated-index(?::[^>]*)?\s*-->\s*$/.test(line),
  ).length;
  if (exact > 1) return { owned: false, reason: "duplicate-marker" };
  if (exact === 1 && markerLike === 1 && lines[0] === GENERATED_INDEX_MARKER) return { owned: true };
  if (markerLike > 0) return { owned: false, reason: "malformed-marker" };
  return { owned: false, reason: "unmarked" };
}

function inspectExisting(dir: string, content: string): Ownership {
  if (dir === "") {
    try {
      const { frontmatter, body } = parseReservedMarkdown(content, "index.md");
      if (Object.hasOwn(frontmatter, "okf_version") && typeof frontmatter.okf_version !== "string") {
        return { owned: false, body, frontmatter, reason: "malformed-root" };
      }
      return {
        ...markerOwnership(body),
        body,
        frontmatter,
      };
    } catch {
      return { owned: false, body: content, unparseable: true, reason: "malformed-root" };
    }
  }

  try {
    const { frontmatter, body } = parseMarkdown(content, `${dir}/index.md`);
    if (Object.keys(frontmatter).length > 0) {
      return { owned: false, body, reason: "nested-frontmatter" };
    }
    return { ...markerOwnership(body), body };
  } catch {
    return { owned: false, body: content, reason: "nested-frontmatter" };
  }
}

function desiredContent(dir: string, body: string, frontmatter: Record<string, unknown> = { okf_version: "0.1" }): string {
  return dir === "" ? stringifyReservedMarkdown(frontmatter, body) : body;
}

/**
 * Read and classify every planned target before any write. A single refusal blocks the
 * whole preparation; `force` makes each unmarked/malformed target an explicit adoption.
 */
export async function prepareIndexProjection(
  bundle: Bundle,
  plan: IndexProjectionPlan,
  options: { force?: boolean } = {},
): Promise<IndexProjectionPreparation> {
  const backend = backendFor(bundle);
  const targets: PreparedIndexTarget[] = [];

  for (const planned of plan.targets) {
    const current = await backend.readReserved(planned.dir, "index.md");
    if (current === null) {
      targets.push({
        dir: planned.dir,
        content: desiredContent(planned.dir, planned.body),
        expectedVersion: null,
        disposition: "missing",
      });
      continue;
    }

    const ownership = inspectExisting(planned.dir, current.content);
    const content = desiredContent(planned.dir, planned.body, ownership.frontmatter);
    if (ownership.owned) {
      targets.push({
        dir: planned.dir,
        content,
        expectedVersion: current.version,
        disposition: current.content === content ? "unchanged" : "generated",
      });
    } else if (options.force && !ownership.unparseable) {
      targets.push({
        dir: planned.dir,
        content,
        expectedVersion: current.version,
        disposition: "adopted",
        ...(ownership.reason ? { reason: ownership.reason } : {}),
      });
    } else {
      targets.push({
        dir: planned.dir,
        content,
        expectedVersion: current.version,
        disposition: "refused",
        ...(ownership.reason ? { reason: ownership.reason } : {}),
      });
    }
  }

  const refused = targets.filter((target) => target.disposition === "refused");
  return refused.length > 0
    ? { ready: false, targets, refused }
    : { ready: true, targets, refused: [] };
}

function writableDisposition(
  disposition: IndexProjectionDisposition,
): disposition is AppliedIndexTarget["disposition"] {
  return disposition === "missing" || disposition === "generated" || disposition === "adopted";
}

/**
 * Apply a ready preparation deepest-first and root-last. Each target gets ONE CAS attempt
 * against the version captured during global preparation; a conflict is terminal and reports
 * completed/pending paths so a full re-prepare can resume idempotently.
 */
export async function applyIndexProjection(
  bundle: Bundle,
  prepared: ReadyIndexProjection,
  options: { actor?: string } = {},
): Promise<IndexProjectionApplyResult> {
  if (!prepared.ready) {
    throw new InvalidInputError("Cannot apply a refused index projection; re-prepare with explicit force to adopt it.");
  }
  const backend = backendFor(bundle);
  const unchanged = prepared.targets
    .filter((target) => target.disposition === "unchanged")
    .map((target) => target.dir);
  const writable = prepared.targets
    .filter((target): target is PreparedIndexTarget & { disposition: AppliedIndexTarget["disposition"] } =>
      writableDisposition(target.disposition),
    )
    .sort((a, b) => depth(b.dir) - depth(a.dir) || compareText(a.dir, b.dir));
  const completed: AppliedIndexTarget[] = [];

  for (let index = 0; index < writable.length; index++) {
    const target = writable[index]!;
    try {
      const version = await backend.writeReserved(target.dir, "index.md", target.content, {
        expectedVersion: target.expectedVersion,
        ...(options.actor !== undefined ? { actor: options.actor } : {}),
      });
      completed.push({ dir: target.dir, disposition: target.disposition, version });
    } catch (cause) {
      throw new IndexProjectionWriteError(
        target.dir,
        completed,
        writable.slice(index + 1).map((pending) => pending.dir),
        cause,
      );
    }
  }

  return { completed, unchanged, pending: [] };
}
