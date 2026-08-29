// One invariant between Superbee's two local filesystem domains: private operational state and
// Knowledge Bundle content are PHYSICALLY DISJOINT. Neither directory may equal or contain the
// other, and no path the CLI reads from or writes to may cross the boundary.
//
// Identity is decided by (device, inode) rather than by names: one primitive that is exact across
// case folding, Unicode normalization form, symlinks, macOS firmlinks, and /tmp vs /private/tmp,
// while still distinguishing APFS clones. `dev` is mandatory — multiple volumes report ino 2.
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { CliError } from "./errors.js";
import { cliInvocation } from "./invocation.js";
import {
  resolveUserStatePolicy,
  userStatePathDisplay,
  type UserStateInput,
} from "./user-state.js";

/**
 * How a caller-supplied filesystem target stands to one private-state root. `bundle-contains-state`
 * and `bundle-inside-state` differ ONLY in which side encloses the other, so they stay distinct
 * values rather than folding into a single "overlaps": a swapped direction must be observable.
 */
export type PrivateStateRelation =
  | "unrelated"
  | "identical"
  | "bundle-contains-state"
  | "bundle-inside-state";

interface PrivateStateFinding {
  readonly relation: PrivateStateRelation;
  /** `~`-relative spelling of the guarded root that matched. Never the resolved private path. */
  readonly root: string;
  readonly platform: NodeJS.Platform;
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * ENOENT is an absent component. ENOTDIR means a REGULAR FILE sits at one of them — a state the
 * relation must CLASSIFY, not a runtime failure, so it walks up exactly like ENOENT. Without this
 * arm a plain file at the state-root path raises RUNTIME instead of CONFLICT.
 */
function absentComponent(error: unknown): boolean {
  const c = code(error);
  return c === "ENOENT" || c === "ENOTDIR";
}

/**
 * The host refused to LOOK rather than describing a shape: an unreadable `~/.config`, a sandboxed
 * profile directory, a Windows ACL that denies one hidden known folder. The walk anchors at the
 * deepest ancestor it can still stat and classifies the denied components BELOW that anchor by
 * name, the same way it classifies components that do not exist yet.
 *
 * Do NOT read this as "everything under a denial is unreachable". Denial is per-component, not
 * per-subtree: a mode-000 directory does block its whole subtree, but an ACL that denies attribute
 * reads on one directory (macOS `deny readattr`; the ordinary Windows shape, where traverse is
 * granted separately) leaves `stat` AND `lstat` answering for its children while `realpath` still
 * cannot resolve through it.
 *
 * DENIED is therefore not the same as UNAVAILABLE, and the two get opposite answers. Denial of
 * either channel — `stat` here, canonicalization in {@link realAnchor} — is one component the walk
 * steps over, because refusing on it would let a single protected ancestor of a guarded root veto
 * every unrelated explicit bundle. An answer the relation cannot interpret (ELOOP, EIO,
 * ENAMETOOLONG, or no anchor at all) is not a component and still refuses.
 *
 * Stepping over stays exact because the anchor is the deepest ancestor this process can both stat
 * and canonicalize, and {@link declaredLinkTarget} gets first refusal on every component below it,
 * so an alias the denial did not actually hide is followed instead of name-classified.
 */
function hostDeniedComponent(error: unknown): boolean {
  const c = code(error);
  return c === "EACCES" || c === "EPERM";
}

/** Components the walk must classify by name because no inode of their own is observable. */
function unobservableComponent(error: unknown): boolean {
  return absentComponent(error) || hostDeniedComponent(error);
}

function runtimeFailure(): CliError {
  return new CliError("RUNTIME", "cannot verify that the target is separate from private Superbee state");
}

interface PhysicalCoordinate {
  /** "dev:ino" of the deepest OBSERVABLE ancestor, or null when no usable inode could be observed. */
  readonly anchorKey: string | null;
  /** Inode keys of the anchor and every ancestor above it. */
  readonly anchorChain: readonly string[];
  /** Path components below the anchor with no observable inode of their own, outermost first. */
  readonly missing: readonly string[];
  /** The anchor's path, consulted only when inode identity is undeterminable. */
  readonly anchorPath: string;
}

/**
 * A filesystem that reports no inode — CIFS without `serverino`, some FUSE mounts, FAT/exFAT —
 * would otherwise make EVERY path key equal and refuse every guarded command, reads included.
 * Treat it as undeterminable and let the caller fall back to normalized path comparison.
 */
function inodeKey(status: { dev: bigint; ino: bigint }): string | null {
  return status.ino === 0n ? null : `${status.dev}:${status.ino}`;
}

/**
 * A symlink whose destination `stat` could not reach — because it is dangling, or because the host
 * denies the destination — still DECLARES where the path lands, so a state-root alias cannot
 * quietly become a bundle later. `lstat` needs only the link's own parent, so it keeps answering
 * after the destination stops being observable.
 *
 * ACCEPTED RESIDUAL RISK, when `lstat` is denied here rather than the destination: a symlink
 * strictly BELOW a subtree-blocking denial (a mode-000 directory) can relocate a guarded root to a
 * readable place, and that relocation is invisible — `stat` and `lstat` are both refused through
 * the same prefix, so no call can see it and the walk anchors above it. It does NOT extend to a
 * per-component attribute denial: there `lstat` still answers, so the hop below follows the alias
 * and the relocated root is classified exactly. The mode-000 case is accepted because the same
 * denial refuses every private-state read and write at that root, `ensureUserStateRoot` included,
 * so nothing can be stored at the relocated location while the denial stands; the collision only
 * becomes live if the denial is later lifted.
 */
function declaredLinkTarget(cursor: string, seenLinks: Set<string>): string | null {
  let status;
  try {
    status = lstatSync(cursor);
  } catch (error) {
    if (!unobservableComponent(error)) throw runtimeFailure();
    return null;
  }
  if (!status.isSymbolicLink()) return null;
  if (seenLinks.has(cursor)) {
    throw new CliError("RUNTIME", "cannot resolve the private-state filesystem boundary");
  }
  seenLinks.add(cursor);
  return path.resolve(path.dirname(cursor), readlinkSync(cursor));
}

/**
 * Canonicalization DENIED, as opposed to impossible. The two need opposite answers, and collapsing
 * them is a bug in both directions: substituting the lexical spelling lets a symlinked ancestor
 * (`/tmp` -> `/private/tmp` is enough) read a target inside private state as separate, while
 * refusing outright lets one protected ancestor of a guarded root veto every unrelated bundle.
 * A denial is a COMPONENT, so the walk steps over it; an uninterpretable answer is not.
 */
class CanonicalizationDenied extends Error {}

/**
 * The anchor must be an ancestor this process can BOTH stat and canonicalize, because `anchorPath`
 * is what the undeterminable-inode fallback compares. Returning a path `realpath` never confirmed
 * would put an unresolved spelling on one side of that comparison, so this refuses to guess:
 * denial hands the walk back a component to step over, and anything else refuses outright.
 */
function realAnchor(anchorPath: string): string {
  try {
    return realpathSync.native(anchorPath);
  } catch (error) {
    if (hostDeniedComponent(error)) throw new CanonicalizationDenied();
    throw runtimeFailure();
  }
}

/**
 * The ancestor chain walks the anchor's REAL location. Walking the lexical path instead would let a
 * symlinked state root hide every containment relation behind the link's own ancestors.
 */
function anchorAt(
  lexicalAnchorPath: string,
  anchorStatus: { dev: bigint; ino: bigint },
  missing: string[],
): PhysicalCoordinate {
  const anchorPath = realAnchor(lexicalAnchorPath);
  const chain: string[] = [];
  let current = anchorPath;
  let status = anchorStatus;
  for (;;) {
    const key = inodeKey(status);
    if (key === null) return { anchorKey: null, anchorChain: chain, missing, anchorPath };
    chain.push(key);
    const parent = path.dirname(current);
    if (parent === current) break;
    try {
      status = statSync(parent, { bigint: true });
    } catch {
      // An ancestor we cannot stat makes ancestry undecidable by inode; say so rather than
      // silently truncating the chain into a false `unrelated`.
      return { anchorKey: null, anchorChain: chain, missing, anchorPath };
    }
    current = parent;
  }
  return { anchorKey: chain[0] ?? null, anchorChain: chain, missing, anchorPath };
}

/**
 * Anchor a path at its deepest ancestor this process can both stat and canonicalize, retaining the
 * components below it. A component is stepped over when its own inode is unobservable OR when it
 * blocks canonicalization; either way the components below the eventual anchor are classified by
 * name, and `declaredLinkTarget` still gets first refusal on each one, so an alias that a denial
 * has not actually hidden is followed rather than name-classified.
 */
function physicalCoordinate(candidate: string, seenLinks: Set<string> = new Set()): PhysicalCoordinate {
  if (!path.isAbsolute(candidate)) {
    throw new CliError("RUNTIME", "private state and bundle identities require absolute filesystem paths");
  }
  let cursor = path.normalize(candidate);
  const missing: string[] = [];
  for (;;) {
    try {
      return anchorAt(cursor, statSync(cursor, { bigint: true }), [...missing].reverse());
    } catch (error) {
      if (!(error instanceof CanonicalizationDenied)) {
        if (error instanceof CliError) throw error;
        // Anything else — ELOOP, EIO, ENAMETOOLONG — is a filesystem answer this relation cannot
        // interpret. It stays a refusal rather than becoming a name-only classification.
        if (!unobservableComponent(error)) throw runtimeFailure();
      }
    }
    const hop = declaredLinkTarget(cursor, seenLinks);
    if (hop !== null) return physicalCoordinate(path.resolve(hop, ...[...missing].reverse()), seenLinks);
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new CliError("RUNTIME", "cannot resolve the private-state filesystem boundary");
    }
    missing.push(path.basename(cursor));
    cursor = parent;
  }
}

/**
 * Folding rule for path components that do not exist yet: their future physical identity depends on
 * the containing filesystem's case and Unicode rules, so fold to the portable equivalence class.
 * This OVER-refuses a genuinely distinct `SUPERBEE` on a case-sensitive volume. That is retained
 * deliberately — do not "fix" it.
 */
function fold(segment: string): string {
  return segment.normalize("NFC").toLowerCase();
}

function foldedSegments(coordinate: PhysicalCoordinate): string[] {
  return path.resolve(coordinate.anchorPath, ...coordinate.missing).split(path.sep).filter(Boolean).map(fold);
}

function relateSegments(bundle: readonly string[], state: readonly string[]): PrivateStateRelation {
  const shared = Math.min(bundle.length, state.length);
  for (let index = 0; index < shared; index += 1) {
    if (bundle[index] !== state[index]) return "unrelated";
  }
  if (bundle.length === state.length) return "identical";
  return bundle.length < state.length ? "bundle-contains-state" : "bundle-inside-state";
}

/** THE domain relation. Every private-state guard in the CLI answers to this one function. */
export function relateToPrivateState(candidate: string, stateRoot: string): PrivateStateRelation {
  const bundle = physicalCoordinate(path.resolve(candidate));
  const state = physicalCoordinate(path.resolve(stateRoot));

  // Undeterminable inode on EITHER side: compare normalized paths instead, and never conclude
  // `identical` from an inode collapse.
  if (bundle.anchorKey === null || state.anchorKey === null) {
    return relateSegments(foldedSegments(bundle), foldedSegments(state));
  }

  if (bundle.anchorKey === state.anchorKey) {
    return relateSegments(bundle.missing.map(fold), state.missing.map(fold));
  }

  // The `missing is empty` guards below are LOAD-BEARING. Without them a state root with no
  // observable inode — absent, or below a directory the host denies — collapses onto its nearest
  // observable ancestor ($HOME, or an unreadable `~/.config`), every project bundle under that
  // ancestor reads as a descendant of private state, and every guarded command refuses.
  if (bundle.missing.length === 0 && state.anchorChain.includes(bundle.anchorKey)) {
    return "bundle-contains-state";
  }
  if (state.missing.length === 0 && bundle.anchorChain.includes(state.anchorKey)) {
    return "bundle-inside-state";
  }
  return "unrelated";
}

/**
 * Every private-state root the CLI guards, canonical first. Both the `superbee` and the
 * `@holaxis/aslite` builds guard the WHOLE set unconditionally: which root a given build WRITES is a
 * separate question from which roots a bundle may not collide with. The set only grows — a
 * superseded root stays guarded for as long as it remains a migration source.
 */
export function guardedStateRoots(input: UserStateInput = homedir()): string[] {
  return [...resolveUserStatePolicy(input).guardedRoots];
}

/** Classify a target against every guarded root, returning the first collision in root order. */
function classifyAgainstPrivateState(candidate: string, input: UserStateInput = homedir()): PrivateStateFinding {
  const policy = resolveUserStatePolicy(input);
  for (const root of guardedStateRoots(input)) {
    const relation = relateToPrivateState(candidate, root);
    if (relation !== "unrelated") return { relation, root: userStatePathDisplay(input, root), platform: policy.platform };
  }
  return { relation: "unrelated", root: policy.displayRoot, platform: policy.platform };
}

function bundleBoundaryError(finding: PrivateStateFinding): CliError {
  const inv = cliInvocation();
  if (finding.relation === "bundle-contains-state") {
    // A refusal that breaks a working configuration needs a real exit node, not just a verdict:
    // whoever ran `init` at $HOME (or at ~/.config) has to be told how to move the bundle out.
    return new CliError(
      "CONFLICT",
      "an OKF bundle cannot enclose Superbee's private user-state directory",
      {
        help: finding.platform === "win32"
          ? `${finding.root} lives inside it — choose a project directory outside private state, `
            + `open it, and run ${inv} init --create-only --dir .superbee`
          : `${finding.root} lives inside it — create the bundle in a project directory instead: `
            + `mkdir -p ~/projects/<name> && cd ~/projects/<name> && ${inv} init --create-only --dir .superbee`
            + " (move any bundle files that already exist here into that directory first)",
      },
    );
  }
  if (finding.relation === "bundle-inside-state") {
    return new CliError(
      "CONFLICT",
      "an OKF bundle cannot live inside Superbee's private user-state directory",
      { help: `choose a project .superbee directory, then rerun ${inv} setup` },
    );
  }
  return new CliError(
    "CONFLICT",
    "Superbee's private user-state directory cannot be used as an OKF bundle",
    { help: `choose a project .superbee directory, then rerun ${inv} setup` },
  );
}

/** Bundle-root guard: a bundle may neither BE, CONTAIN, nor live INSIDE any private-state root. */
export function assertBundleOutsidePrivateState(bundleRoot: string, input: UserStateInput = homedir()): void {
  const finding = classifyAgainstPrivateState(path.resolve(bundleRoot), input);
  if (finding.relation === "unrelated") return;
  throw bundleBoundaryError(finding);
}

/**
 * Guard for a directory the CLI RUNS FROM or SEARCHES IN — the cwd/`--dir` a command walks for a
 * bundle, or hands to the board channel — as opposed to a path that BECOMES a bundle root.
 * `bundle-contains-state` deliberately does NOT refuse: every ancestor of a guarded root, `$HOME`
 * and `/` included, is a legitimate place to stand. `identical` and `bundle-inside-state` do, and
 * they refuse with the SAME error the bundle-root guard raises, because the answer a command owes
 * here is the conflict — never its own "nothing found" verdict, and never a next command derived
 * from a private coordinate.
 */
export function assertSearchDirOutsidePrivateState(dir: string, input: UserStateInput = homedir()): void {
  const finding = classifyAgainstPrivateState(path.resolve(dir), input);
  if (finding.relation !== "identical" && finding.relation !== "bundle-inside-state") return;
  throw bundleBoundaryError(finding);
}

/**
 * File-target guard for source positionals and `--out` destinations. `contains` is meaningless for a
 * single file, so only `identical` and `inside` refuse: reading a credential out of private state
 * into a bundle, or writing bundle bytes over the marker, are the reachable harms. `--out` is the
 * sharpest of them — `fs.writeFile` lands 0644, so even correct marker bytes written that way fail
 * the mode assertion and brick every later private-state command.
 */
export function assertPathOutsidePrivateState(target: string, input: UserStateInput = homedir()): void {
  const finding = classifyAgainstPrivateState(path.resolve(target), input);
  if (finding.relation !== "identical" && finding.relation !== "bundle-inside-state") return;
  throw new CliError(
    "CONFLICT",
    finding.relation === "identical"
      ? "this path IS Superbee's private user-state directory"
      : "this path is inside Superbee's private user-state directory",
    { help: `choose a path outside ${finding.root}` },
  );
}
