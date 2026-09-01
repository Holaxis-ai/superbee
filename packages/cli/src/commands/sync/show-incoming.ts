// `sync --show-incoming <id>` — the conflict VIEWER: prints the upstream version of one doc via
// `git show origin/board:<path>` with full doc-read semantics (truncation, raw `--out` and parsed
// `--body-out` byte hatches, stdout-stream stderr envelopes), labeled "as of last fetch" (no
// implicit fetch, ever).
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertSafeConceptId,
  conceptIdFromPath,
  isReservedFile,
  parseMarkdown,
  pathFromConceptId,
  versionOfBytes,
} from "@superbee/core";
import {
  BOARD_BRANCH,
  BOARD_REF,
  bundleDirNameForProject,
  committedBundleAtHead,
  inTreeUpstreamSha,
  readDocBytesAtRef,
  repoTopLevel,
  resolveInTreeUpstream,
  retargetBoardInterior,
  runGit,
} from "@superbee/board-git";
import { type SyncCliDeps } from "../../sync-cli.js";
import { ffSwallowToError, syncOutcomeError, type InTreeNoBasisReason } from "../../sync-outcomes.js";
import { CliError, asHandled, toExit } from "../../errors.js";
import { render, renderErrorEnvelope, resolveMode } from "../../output.js";
import { cliInvocation } from "../../invocation.js";
import {
  assertPathOutsidePrivateState,
  assertSearchDirOutsidePrivateState,
} from "../../private-state-bundle-boundary.js";
import { attachBodyPreview, BODY_PREVIEW_RESERVED_KEYS } from "../doc/common.js";
import { assertSafeNonDocumentOutTarget, inBundlePollutionWarning } from "../egress.js";
import type { ResolvedLocalRoute } from "../../bundle.js";
import { commandToken, type CommandPrefix } from "../../command-text.js";
// `--show-incoming` (branch mode) reads only the last fetched remote ref, never fetches
// implicitly — the refusal string lives in THE sync-outcome table; this re-export keeps the
// module's historical import surface stable.
export { SHOW_INCOMING_NO_UPSTREAM } from "../../sync-outcomes.js";

/** The staleness label every render carries: `origin/board` AS OF THE LAST FETCH — never an implicit fetch. */
export const SHOW_INCOMING_AS_OF = "last fetch";

/** The expected-state string for a doc that is absent on origin/board (deleted upstream, or new locally). */
export const SHOW_INCOMING_ABSENT_STATE =
  "absent upstream — not on origin/board as of the last fetch (deleted upstream, or a new local doc)";

/** The in-tree viewer's refusal when the branch has no usable upstream to read a version from. */
export function showIncomingInTreeNoBasis(inv: CommandPrefix, reason: InTreeNoBasisReason, ref?: string): CliError {
  return syncOutcomeError("in-tree.show-incoming.no-basis", { inv, reason, ref });
}

/**
 * Print the UPSTREAM version of one board doc — `git show origin/board:<path>` — with FULL
 * doc-read semantics (gate-1): the default render truncates a large body and points at the byte
 * hatches; `--out` preserves the raw blob while `--body-out` emits only a valid parsed concept
 * document's body. A `-` destination streams payload bytes to stdout with the receipt (or ANY error
 * envelope) on STDERR. A doc absent upstream renders as an EXPECTED STATE (exit 0), never a fatal.
 * Every render is labeled "as of last fetch" (no implicit fetch).
 */
export async function showIncoming(
  id: string,
  values: { out?: string; "body-out"?: string; dir?: string; json?: boolean },
  deps: Partial<SyncCliDeps>,
  route?: ResolvedLocalRoute,
): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const writeStdoutBytes = deps.writeStdoutBytes ?? ((d: Uint8Array) => void process.stdout.write(d));
  const inv = cliInvocation();
  const mode = resolveMode(values);
  const out = values.out?.trim();
  const bodyOut = values["body-out"]?.trim();
  const streamMode = out === "-" || bodyOut === "-";
  const rawHatch = `${inv} sync --show-incoming ${commandToken(id)} --out <file>`;
  const bodyHatch = `${inv} sync --show-incoming ${commandToken(id)} --body-out <path-outside-bundle>`;

  const run = async (): Promise<void> => {
    // A destination inside private state would land 0644 over an operational record.
    const fileTarget = out ?? bodyOut;
    if (fileTarget && !streamMode) assertPathOutsidePrivateState(path.resolve(fileTarget));

    // Same location resolution as sync itself (board-interior invocations retarget to the
    // enclosing project); refs/remotes are SHARED across a repo's worktrees, so any directory
    // inside the repo can read the last-fetched origin/board state — no provisioning required.
    // The viewer's run directory answers to the relation at its own resolution point, exactly as
    // sync's does: a guarded root is a conflict to report, not a repo that turns out to be absent.
    if (route?.kind === "bound-local") throw syncOutcomeError("show-incoming.no-upstream", { inv });
    if (route?.kind === "bound-board" && route.readiness !== "ready") {
      throw new CliError(
        "CONFLICT",
        "the selected private board has a board-origin rebase pending; --show-incoming cannot recover it",
      );
    }
    if (!route) assertSearchDirOutsidePrivateState(path.resolve(values.dir ?? process.cwd()));
    const dir = route?.kind === "bound-board"
      ? route.owner.bundleRoot
      : retargetBoardInterior(values.dir ?? process.cwd());
    const top = repoTopLevel(dir);
    if (!top) {
      throw new CliError(
        "RUNTIME",
        "not inside a git repository — there is no fetched board state to show",
        { details: { state: "no-repo" } },
      );
    }

    // The '..'/absolute safety guard applies to EVERY interpretation of the id (this read
    // bypasses the engine, so it must enforce its own path safety).
    if (path.isAbsolute(id) || id.split("/").some((seg) => seg === "..")) {
      throw new CliError("USAGE", `--show-incoming needs a repo-relative doc id or path without '..' segments: ${id}`);
    }

    // The ref the incoming version is read FROM, and the repo-relative prefix doc paths live
    // under. Branch mode: the board ref, no prefix. In-tree (tracked conventional folder, no
    // board refs anywhere): the branch's OWN tracking upstream, docs under the selected bundle directory —
    // still "as of last fetch", still no implicit fetch (the resolution is local config/refs).
    let readRef = `refs/remotes/${BOARD_REF}`;
    let pathPrefix = "";
    let inTreeBundleDir = bundleDirNameForProject(top);
    if (runGit(top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${BOARD_REF}`]).status !== 0) {
      if (runGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${BOARD_BRANCH}`]).status === 0) {
        throw ffSwallowToError("no-upstream", inv, top);
      }
      const committed = committedBundleAtHead(top);
      if (committed !== null) {
        const resolution = resolveInTreeUpstream(top);
        if (resolution.state === "none") throw showIncomingInTreeNoBasis(inv, resolution.reason);
        const sha = inTreeUpstreamSha(top, resolution.config.ref);
        if (sha === null) throw showIncomingInTreeNoBasis(inv, "unusable-upstream", resolution.config.ref);
        readRef = sha;
        inTreeBundleDir = committed.bundleDir;
        pathPrefix = `${inTreeBundleDir}/`;
      } else {
        throw syncOutcomeError("show-incoming.no-upstream", { inv });
      }
    }

    // id → repo-relative path, PROBE-FIRST (no string-shape heuristic — a dotted concept id like
    // `notes/v1.2` is legal): the CONCEPT interpretation first, the verbatim raw path (log.md, a
    // stray blob) as fallback. Bytes, not utf8: --out must deliver the blob's exact bytes.
    // The derived path keeps concept-first precedence, but its CLASSIFICATION follows what the
    // file IS: when the derivation lands on a reserved filename (`log.md` / `index.md` at any
    // nesting — no frontmatter, no concept identity — under ANY spelling: `log`, `log.md`,
    // `tasks/index`), the probe is RAW — honest `path:` plus literal content, never a fabricated
    // `id:`. A `.md`-suffixed NON-reserved doc id collapses onto its own path and stays a DOC,
    // matching `doc read` for the same spelling.
    interface Probe { relPath: string; isDoc: boolean; conceptId?: string }
    const candidates: Probe[] = [];
    let conceptIdOk = true;
    const aliasId = conceptIdFromPath(id);
    try {
      assertSafeConceptId(aliasId);
    } catch {
      conceptIdOk = false;
    }
    if (conceptIdOk) {
      // Mirror CLI `.md` ambiguity resolution against the fetched tree: a literal canonical id
      // (`x.md` -> `x.md.md`) wins when present; otherwise `x.md` remains the path alias for `x`.
      const aliasPath = pathFromConceptId(aliasId);
      // Keep the same explicit physical-path escape as every other CLI ingress: leading `./`
      // suppresses the deeper literal-id probe, so `./x.md.md` always reads physical `x.md.md`.
      if (id.endsWith(".md") && !/^\.[\\/]/.test(id) && !isReservedFile(aliasPath)) {
        const literalId = conceptIdFromPath(`${id}.md`);
        assertSafeConceptId(literalId);
        const literalPath = pathFromConceptId(literalId);
        candidates.push({ relPath: literalPath, isDoc: !isReservedFile(literalPath), conceptId: literalId });
      }
      candidates.push({ relPath: aliasPath, isDoc: !isReservedFile(aliasPath), conceptId: aliasId });
    }
    if (candidates.every((c) => c.relPath !== id)) candidates.push({ relPath: id, isDoc: false });

    let hit: { probe: Probe; bytes: Buffer } | null = null;
    for (const probe of candidates) {
      // Absence is detected STRUCTURALLY (`cat-file -e` on the exact ref:path), never by matching
      // git's human error prose: message strings drift across git versions even with LC_ALL=C.
      const bytes = readDocBytesAtRef(top, readRef, `${pathPrefix}${probe.relPath}`);
      if (bytes === null) continue; // absent under THIS interpretation — try the next candidate
      hit = { probe, bytes };
      break;
    }
    if (hit === null) {
      const state = {
        sync: "show-incoming",
        id,
        as_of: SHOW_INCOMING_AS_OF,
        state: pathPrefix === ""
          ? SHOW_INCOMING_ABSENT_STATE
          : `absent upstream — not under ${inTreeBundleDir}/ on the branch's tracking upstream as of the last fetch (deleted upstream, or a new local doc)`,
      };
      // Stream mode keeps stdout a pure byte channel — the state record rides the receipt
      // channel (stderr), same as the receipt would have.
      (streamMode ? stderr : stdout)(render(state, mode));
      return;
    }
    const bytes = hit.bytes;

    // Byte channel (`--out`): the blob's EXACT bytes, receipt on the appropriate channel.
    if (out) {
      const receipt: Record<string, unknown> = {
        sync: "show-incoming",
        as_of: SHOW_INCOMING_AS_OF,
        out,
        size_bytes: bytes.byteLength,
      };
      // Report the identity that was actually read, not the caller's potentially path-like alias.
      if (hit.probe.isDoc && hit.probe.conceptId !== undefined) receipt.id = hit.probe.conceptId;
      else receipt.path = hit.probe.relPath;
      if (streamMode) {
        writeStdoutBytes(bytes);
        stderr(render(receipt, mode));
        return;
      }
      const bundleRoot = route?.kind === "bound-board"
        ? route.owner.bundleRoot
        : path.join(top, inTreeBundleDir);
      const warning = await inBundlePollutionWarning({ root: bundleRoot }, out);
      if (warning) receipt.warning = warning;
      await fs.writeFile(out, bytes);
      stdout(render(receipt, mode));
      return;
    }

    // Parsed body channel (`--body-out`): this is the directly composable
    // `doc update --body-file` input. It is intentionally unavailable for raw/reserved paths,
    // malformed concept docs, or invalid-UTF-8 blobs whose decoded body would be lossy; `--out`
    // remains the exact-byte escape hatch for all three.
    if (bodyOut) {
      if (!hit.probe.isDoc || hit.probe.conceptId === undefined) {
        throw new CliError(
          "USAGE",
          `--body-out only applies to a parsed concept document; '${hit.probe.relPath}' is a raw or reserved path`,
          { help: rawHatch },
        );
      }
      const content = bytes.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(bytes)) {
        throw new CliError(
          "RUNTIME",
          `incoming concept document '${hit.probe.conceptId}' is not valid UTF-8, so --body-out cannot decode it without changing bytes`,
          { help: rawHatch },
        );
      }
      let body: string;
      try {
        ({ body } = parseMarkdown(content, hit.probe.relPath));
      } catch {
        throw new CliError(
          "RUNTIME",
          `incoming concept document '${hit.probe.conceptId}' has malformed frontmatter, so --body-out cannot identify a safe body boundary`,
          { help: rawHatch },
        );
      }
      const bundleRoot = route?.kind === "bound-board"
        ? route.owner.bundleRoot
        : path.join(top, inTreeBundleDir);
      if (!streamMode) {
        await assertSafeNonDocumentOutTarget(
          { root: bundleRoot },
          "--body-out",
          bodyOut,
          "body-only markdown",
          bodyHatch,
        );
      }
      const bodyBytes = Buffer.from(body, "utf8");
      const receipt: Record<string, unknown> = {
        sync: "show-incoming",
        id: hit.probe.conceptId,
        as_of: SHOW_INCOMING_AS_OF,
        body_out: bodyOut,
        size_bytes: bodyBytes.byteLength,
        content_type: "text/markdown; charset=utf-8",
        version: versionOfBytes(content),
      };
      if (streamMode) {
        writeStdoutBytes(bodyBytes);
        stderr(render(receipt, mode));
        return;
      }
      await fs.writeFile(bodyOut, bodyBytes);
      stdout(render(receipt, mode));
      return;
    }

    // Default render: the parsed detail view with doc-read body semantics (a TEXT view — the
    // byte-exact channel is --out above). A raw/reserved path (log.md carries no frontmatter) —
    // or a doc whose upstream frontmatter is malformed — renders the raw content as the body:
    // the viewer's job is to SHOW the incoming version, whatever its shape.
    const content = bytes.toString("utf8");
    const rec: Record<string, unknown> = {};
    if (!hit.probe.isDoc) {
      // The path SHOWN is the one actually read — for a bare reserved spelling (`log`) that is
      // the derived `log.md`, not the input echo.
      rec.path = hit.probe.relPath;
      rec.as_of = SHOW_INCOMING_AS_OF;
      attachBodyPreview(rec, content, [rawHatch]);
    } else {
      let parsed: { frontmatter: Record<string, unknown>; body: string } | null = null;
      try {
        const { frontmatter, body } = parseMarkdown(content, hit.probe.relPath);
        parsed = { frontmatter: frontmatter as Record<string, unknown>, body };
      } catch {
        parsed = null;
      }
      rec.id = hit.probe.conceptId;
      if (parsed) {
        const KNOWN_ORDER = ["type", "title", "description", "resource", "tags", "timestamp"];
        const RESERVED_OUTPUT = new Set(["id", "as_of", ...BODY_PREVIEW_RESERVED_KEYS]);
        for (const key of KNOWN_ORDER) {
          if (parsed.frontmatter[key] !== undefined && parsed.frontmatter[key] !== null) rec[key] = parsed.frontmatter[key];
        }
        for (const key of Object.keys(parsed.frontmatter)) {
          if (KNOWN_ORDER.includes(key) || RESERVED_OUTPUT.has(key)) continue;
          if (parsed.frontmatter[key] === undefined || parsed.frontmatter[key] === null) continue;
          rec[key] = parsed.frontmatter[key];
        }
      }
      rec.as_of = SHOW_INCOMING_AS_OF;
      const bodyChannelSafe = parsed !== null && Buffer.from(content, "utf8").equals(bytes);
      attachBodyPreview(rec, parsed ? parsed.body : content, [bodyChannelSafe ? bodyHatch : rawHatch]);
    }
    stdout(render(rec, mode));
  };

  if (!streamMode) {
    await run();
    return;
  }
  // `--out -` / `--body-out -`: route any error envelope to STDERR (stdout is reserved for payload bytes), then rethrow
  // as `handled` so the bin wrapper sets the exit code WITHOUT re-emitting the envelope to stdout —
  // the same dance `doc read --out -` pins (gate-1).
  try {
    await run();
  } catch (err) {
    const { envelope } = toExit(err);
    stderr(renderErrorEnvelope(envelope));
    throw asHandled(err);
  }
}
