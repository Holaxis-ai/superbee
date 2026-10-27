/** CLI presentation for core-owned body replacement failures. */
import {
  BodyReplaceError, guardTruncatedBodyPreview as coreGuardTruncatedBodyPreview,
  guardDroppedLinks as coreGuardDroppedLinks, guardBodyReplace as coreGuardBodyReplace,
  BODY_PREVIEW_LIMIT, BODY_PREVIEW_TRUNCATION_MARKER,
  type Bundle, type OkfDocument, type BodyReplacePosture,
} from "@superbee/core";
export { attachBodyPreview, BODY_PREVIEW_LIMIT, BODY_PREVIEW_TRUNCATION_MARKER,
  BODY_PREVIEW_TRUNCATION_SIGNATURE, BODY_PREVIEW_KEY, BODY_PREVIEW_RESERVED_KEYS,
  droppedLinks, type BodyReplacePosture } from "@superbee/core";
import { CliError } from "./errors.js";
import { cliInvocation } from "./invocation.js";
import { commandToken } from "./command-text.js";

export function bodyReplaceCliError(error: BodyReplaceError): CliError {
  const existing = { id: error.id };
  if (error.finding.reason === "dropped_links") {
    const dropped = error.finding.dropped_links;
    const named = dropped.map((l) => `'${l.text}' -> ${l.bundle === undefined ? l.to : `okf://${l.bundle}/${l.to}`}`).join(", ");
    return new CliError(
      "USAGE",
      `this body replace would silently drop ${dropped.length} outbound link(s) from '${existing.id}': ${named}. ` +
        `OKF cross-links live in the document body, so a full-body replace removes any link the new body ` +
        `doesn't repeat. Pass --replace-links to drop them deliberately, or keep them by including the same ` +
        `markdown link(s) in the new body, or re-add them afterward with ` +
        `'${cliInvocation()} link add ${commandToken(existing.id)} <to>'` +
        `${dropped.some((l) => l.bundle !== undefined) ? " (with --bundle <alias> for a link into another bundle)" : ""}.`,
      {
        help: `${cliInvocation()} link add ${commandToken(existing.id)} <to>`,
        details: { dropped_links: dropped.map((l) => ({ to: l.to, text: l.text, ...(l.bundle === undefined ? {} : { bundle: l.bundle }) })) },
      },
    );
  }
  const inv = cliInvocation();
  const help = `${inv} doc read ${commandToken(existing.id)} --body-out <path-outside-bundle>`;
  const storedCarriesNotice = error.storedCarriesNotice;
  const recovery =
    `Read the COMPLETE body first — '${help} --json' (its receipt carries the version), edit that ` +
    `file, then '${inv} doc update ${commandToken(existing.id)} --body-file <path-outside-bundle> ` +
    `--expected-version <version>'. Pass --accept-truncated-body to write this body deliberately.` +
    (storedCarriesNotice
      ? ` This document's stored body already carries the generated sentence, so a rewrite that keeps ` +
        `that sentence but not the whole stored body is refused every time: append to it instead, ` +
        `remove the quoted sentence from your rewrite, or pass --accept-truncated-body deliberately ` +
        `for this document.`
      : "");

  if (error.finding.reason === "preview_marker") {
    const notice = error.finding.notice;
    return new CliError(
      "USAGE",
      `the body given for '${existing.id}' still carries Superbee's generated truncation notice ` +
        `('${notice}') — it is a PREVIEW of a document body, not a complete body, so writing it ` +
        `would persist a truncated document. ${recovery}`,
      {
        help,
        details: { reason: "preview_marker", marker: BODY_PREVIEW_TRUNCATION_MARKER, notice },
      },
    );
  }

  const storedBodyChars = error.finding.stored_body_chars;
  const omitted = storedBodyChars - BODY_PREVIEW_LIMIT;
  return new CliError(
    "USAGE",
    `the body given for '${existing.id}' is exactly the TRUNCATED ${BODY_PREVIEW_LIMIT}-character ` +
      `preview 'doc read' shows for this document — writing it would DESTROY the ${omitted} ` +
      `character(s) beyond the cut, leaving ${BODY_PREVIEW_LIMIT} of its ${storedBodyChars}-` +
      `character body. ${recovery}`,
    {
      help,
      details: {
        reason: "stored_body_preview",
        preview_limit: BODY_PREVIEW_LIMIT,
        supplied_body_chars: error.finding.supplied_body_chars,
        stored_body_chars: storedBodyChars,
      },
    },
  );
}

export function guardTruncatedBodyPreview(existing: OkfDocument, nextBody: string, acceptTruncatedBody: boolean): void {
  try { coreGuardTruncatedBodyPreview(existing, nextBody, acceptTruncatedBody); }
  catch (error) { if (error instanceof BodyReplaceError) throw bodyReplaceCliError(error); throw error; }
}

export function guardDroppedLinks(bundle: Bundle, existing: OkfDocument, nextBody: string, replaceLinks: boolean): void {
  try { coreGuardDroppedLinks(bundle, existing, nextBody, replaceLinks); }
  catch (error) { if (error instanceof BodyReplaceError) throw bodyReplaceCliError(error); throw error; }
}

export function guardBodyReplace(bundle: Bundle, existing: OkfDocument, nextBody: string, posture?: BodyReplacePosture): void {
  try { coreGuardBodyReplace(bundle, existing, nextBody, posture); }
  catch (error) { if (error instanceof BodyReplaceError) throw bodyReplaceCliError(error); throw error; }
}
