/**
 * Bundle identity and the `docs/dependencies` declaration.
 *
 * A bundle names the other bundles it links into in ONE committed document, `docs/dependencies`
 * (type `Bundle Dependencies`). Each entry maps a local alias (the `<alias>` in
 * `okf://<alias>/<path>.md`) to the target's portable `bundle_id`, plus optional `source`, `pin`
 * and `path`. A target confirms its own identity with `bundle_id` in its `docs/bundle` document.
 *
 * Pure and browser-safe: no `node:*` import, no I/O. Consumers read the documents through their
 * own backend and hand them here.
 */

import type { OkfDocument } from "./types.js";

// ── Bundle identity ─────────────────────────────────────────────────────────

// A portable bundle id: lower-case letters and digits joined by `.`, `_` or `-`, starting with a
// letter, at most 128 characters. The one rule hosted `checkout`, `export` and `publish` accept an
// id by, and the one a printed `checkout <id>` command is emitted for: an id it rejects (one
// starting with `-` would read as an option) never appears in a command.
const BUNDLE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const BUNDLE_ID_MAX_LENGTH = 128;

/** True when `id` is a portable bundle id (the hosted bundle-id grammar). */
export function isHostedBundleId(id: string): boolean {
  return id.length <= BUNDLE_ID_MAX_LENGTH && BUNDLE_ID.test(id);
}

/**
 * The well-known concept id carrying a bundle's explicit display name and portable id. NOT the
 * bundle-root `index.md` — OKF §3.1 reserves that file's frontmatter solely for `okf_version`, so
 * the name needs its own small doc.
 */
export const BUNDLE_NAME_DOC_ID = "docs/bundle";

/**
 * The ownership marker: `docs/bundle` speaks for the bundle ONLY when it carries exactly this
 * `type`. A `docs/bundle` doc of any other type is an ordinary document and is ignored, so an
 * unrelated pre-existing doc is never appropriated as the bundle's name or id.
 */
export const BUNDLE_NAME_DOC_TYPE = "Bundle Name";

/**
 * The bundle's self-declared portable id: `bundle_id` in `docs/bundle` under the marker type, when
 * it satisfies {@link isHostedBundleId}. Anything else (absent doc, other type, missing or
 * malformed id) is `undefined`; the caller decides what a bundle without a declared id means.
 */
export function declaredBundleId(doc: OkfDocument | null | undefined): string | undefined {
  if (!doc || doc.id !== BUNDLE_NAME_DOC_ID) return undefined;
  const type = doc.frontmatter.type;
  if (typeof type !== "string" || type.trim() !== BUNDLE_NAME_DOC_TYPE) return undefined;
  const id = doc.frontmatter.bundle_id;
  return typeof id === "string" && isHostedBundleId(id) ? id : undefined;
}

// ── docs/dependencies ───────────────────────────────────────────────────────

export const DEPENDENCIES_DOC_ID = "docs/dependencies";
export const DEPENDENCIES_DOC_TYPE = "Bundle Dependencies";

/** The alias grammar shared by `okf://<alias>/…` hrefs, dependency keys and qualified Kind targets. */
export const BUNDLE_ALIAS = /^[a-z][a-z0-9-]{0,62}$/;

export function isBundleAlias(alias: string): boolean {
  return BUNDLE_ALIAS.test(alias);
}

/**
 * A dependency pin. A `commit` pin (7-40 hex) is checked by an injected `PinCheck` against the
 * bound copy's subtree. A `digest` pin (`sha256:<64 hex>`) parses, but only a hosted resolver can
 * verify it; a local resolver fails it closed.
 */
export type DependencyPin =
  | { kind: "commit"; value: string }
  | { kind: "digest"; value: string };

export interface DependencyEntry {
  alias: string;
  bundle_id: string;
  /** Where to get the bundle (git URL or `hosted:<host>/<bundle_id>`). Informational only. */
  source?: string;
  pin?: DependencyPin;
  /** Relative to the declaring bundle's root; used only by an explicit `--with-deps`. */
  path?: string;
}

/** Alias -> entry. A Map, so an alias such as `constructor` can never hit an inherited property. */
export type DependencyMap = ReadonlyMap<string, DependencyEntry>;

export type DependencyProblemCode =
  | "DEP_TYPE"
  | "DEP_SHAPE"
  | "DEP_ALIAS"
  | "DEP_BUNDLE_ID"
  | "DEP_PIN"
  | "DEP_PATH_ABSOLUTE"
  | "DEP_DUPLICATE_BUNDLE"
  | "DEP_SELF"
  | "DEP_UNKNOWN_KEY"
  | "DEP_RESERVED_KEY";

export interface DependencyProblem {
  code: DependencyProblemCode;
  alias?: string;
  detail: string;
}

export interface ParsedDependencies {
  dependencies: DependencyMap;
  problems: DependencyProblem[];
}

export interface ParseDependenciesOptions {
  /** The declaring bundle's own id; an entry naming it is `DEP_SELF`. */
  selfBundleId?: string;
}

const KNOWN_KEYS = new Set(["bundle_id", "source", "pin", "path"]);
/** Reserved for recipe dependencies, which will reuse this declaration. */
const RESERVED_KEYS = new Set(["use", "version", "channel"]);

const COMMIT_PIN = /^[0-9a-f]{7,40}$/;
const DIGEST_PIN = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Absolute under POSIX or win32 rules, or carrying a backslash. Pure string checks (no
 * `node:path`) so the verdict is the same on every host: `/x`, `\x`, `\\server\share`, `C:\x`,
 * `C:/x` and the drive-relative `C:x` are all refused.
 */
export function isNonPortableDependencyPath(value: string): boolean {
  return value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value);
}

function parsePin(value: unknown): DependencyPin | null {
  if (typeof value !== "string") return null;
  if (COMMIT_PIN.test(value)) return { kind: "commit", value };
  if (DIGEST_PIN.test(value)) return { kind: "digest", value };
  return null;
}

/**
 * Parse `docs/dependencies`. Never throws: every defect is a problem, and an entry whose alias,
 * `bundle_id` or `pin` is unusable is dropped (fail closed: a link under it reads as
 * `unknown_alias`, never as resolved against the wrong copy). An unusable `source` or `path` drops
 * only that field. Unknown and reserved keys are reported and the entry is kept.
 */
export function parseDependencies(
  doc: OkfDocument | null | undefined,
  options: ParseDependenciesOptions = {},
): ParsedDependencies {
  const dependencies = new Map<string, DependencyEntry>();
  const problems: DependencyProblem[] = [];
  const result = (): ParsedDependencies => ({ dependencies, problems });
  if (!doc) return result();

  const type = doc.frontmatter.type;
  if (typeof type !== "string" || type.trim() !== DEPENDENCIES_DOC_TYPE) {
    problems.push({ code: "DEP_TYPE", detail: `type must be '${DEPENDENCIES_DOC_TYPE}'` });
    return result();
  }
  const declared = doc.frontmatter.dependencies;
  if (declared === undefined || declared === null) return result();
  if (!isRecord(declared)) {
    problems.push({ code: "DEP_SHAPE", detail: "dependencies must be a mapping of alias to entry" });
    return result();
  }

  const aliasByBundle = new Map<string, string>();
  for (const [alias, raw] of Object.entries(declared)) {
    if (!isBundleAlias(alias)) {
      problems.push({ code: "DEP_ALIAS", alias, detail: "alias must match ^[a-z][a-z0-9-]{0,62}$" });
      continue;
    }
    if (!isRecord(raw)) {
      problems.push({ code: "DEP_SHAPE", alias, detail: "entry must be a mapping" });
      continue;
    }

    const bundleId = raw.bundle_id;
    if (typeof bundleId !== "string" || !isHostedBundleId(bundleId)) {
      problems.push({ code: "DEP_BUNDLE_ID", alias, detail: "bundle_id is required and must be a portable bundle id" });
      continue;
    }

    let pin: DependencyPin | undefined;
    if (raw.pin !== undefined) {
      const parsed = parsePin(raw.pin);
      if (parsed === null) {
        // A YAML scalar such as 1234567 or 3e45678 arrives as a number, so the hint says to quote.
        problems.push({ code: "DEP_PIN", alias, detail: "pin must be a quoted commit (7-40 lower-case hex) or sha256:<64 hex>" });
        continue;
      }
      pin = parsed;
    }

    if (options.selfBundleId !== undefined && bundleId === options.selfBundleId) {
      problems.push({ code: "DEP_SELF", alias, detail: `bundle_id '${bundleId}' is this bundle` });
      continue;
    }
    const earlier = aliasByBundle.get(bundleId);
    if (earlier !== undefined) {
      problems.push({ code: "DEP_DUPLICATE_BUNDLE", alias, detail: `bundle_id '${bundleId}' is already declared as '${earlier}'` });
      continue;
    }

    const entry: DependencyEntry = { alias, bundle_id: bundleId };
    if (raw.source !== undefined) {
      if (typeof raw.source === "string" && raw.source.trim() !== "") entry.source = raw.source;
      else problems.push({ code: "DEP_SHAPE", alias, detail: "source must be a non-empty string" });
    }
    if (pin) entry.pin = pin;
    if (raw.path !== undefined) {
      if (typeof raw.path !== "string" || raw.path.trim() === "") {
        problems.push({ code: "DEP_SHAPE", alias, detail: "path must be a non-empty string" });
      } else if (isNonPortableDependencyPath(raw.path)) {
        problems.push({ code: "DEP_PATH_ABSOLUTE", alias, detail: "path must be relative to this bundle's root, with '/' separators" });
      } else {
        entry.path = raw.path;
      }
    }
    for (const key of Object.keys(raw)) {
      if (KNOWN_KEYS.has(key)) continue;
      if (RESERVED_KEYS.has(key)) {
        problems.push({ code: "DEP_RESERVED_KEY", alias, detail: `'${key}' is reserved for recipe dependencies` });
      } else {
        problems.push({ code: "DEP_UNKNOWN_KEY", alias, detail: `unknown key '${key}'` });
      }
    }

    aliasByBundle.set(bundleId, alias);
    dependencies.set(alias, entry);
  }
  return result();
}
