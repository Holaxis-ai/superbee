// Post-write findings for an authoring receipt (`doc write`, `doc update`, `doc field`, `new`):
// links in the stored body that will not register, links whose target has no document, and a
// type no Kind declares. Core owns every rule (`documentLinkReport`, `undeclaredTypeFinding`);
// this module only words each finding's next step for the CLI, as `link add` words its own.
// Advisory and post-write: the document is already stored, so nothing here can fail the write.
import {
  documentLinkReport,
  readDoc,
  undeclaredTypeFinding,
  type Bundle,
  type KindRegistry,
  type LinkFinding,
  type LinkTargetReader,
  type OkfDocument,
  type ValidationWarning,
} from "@superbee/core";
import { cliInvocation } from "./invocation.js";
import { commandToken } from "./command-text.js";

/** Core's link target reader over this bundle: an absent target is undefined; other failures throw. */
export function bundleTargetReader(bundle: Bundle): LinkTargetReader {
  return async (id) => {
    try {
      return await readDoc(bundle, id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw err;
    }
  };
}

/** At most this many link findings on one receipt; the last entry then says how many were left out. */
export const LINK_FINDINGS_SHOWN = 10;

/** The link forms that register, said once on the receipt that has a link finding. */
export const LINK_FORM_HELP =
  "a link registers only as [Text](/folder/id.md) from the bundle root or [Text](./id.md) beside this document";

/** Facts an agent acts on, without the body offsets (UTF-16 indices are no use outside the body). */
function facts(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { start: _start, end: _end, ...rest } = details;
  return rest;
}

const REASONS: Record<string, string> = {
  wikilink: "a [[wikilink]] is plain text in OKF",
  "missing-md-extension": "its target does not end in .md",
  "reserved-target": "index.md and log.md are never documents",
  "invalid-target": "its target is not a valid document id",
};

function linkWarning(finding: LinkFinding): ValidationWarning | undefined {
  if (finding.code === "LINK_NOT_RECOGNIZED") {
    const d = finding.details;
    const written = d.reason === "wikilink" ? `[[${d.href}]]` : `[${d.text}](${d.href})`;
    const fix = d.suggestedHref !== undefined ? `; write [${d.text || d.suggestedTo}](${d.suggestedHref})` : "";
    return {
      code: finding.code,
      message: `${written} will not register as a link: ${REASONS[d.reason] ?? "it is not a link to a document"}${fix}.`,
      field: "body",
      severity: finding.severity,
      details: facts(d),
    };
  }
  if (finding.code === "LINK_TARGET_ABSENT") {
    const d = finding.details;
    const fix = d.suggestedHref !== undefined
      ? `; did you mean ${d.suggestedHref} ('${d.suggestedTo}' exists)?`
      : ` (kept as a forward declaration); create it with \`${cliInvocation()} doc write ${commandToken(d.to)} --type <t>\`.`;
    return {
      code: finding.code,
      message: `target '${d.to}' has no document yet${fix}`,
      field: "body",
      severity: finding.severity,
      details: facts(d),
    };
  }
  // Link type lint is `link add`'s; a body write passes no registry, so core reports none here.
  return undefined;
}

/** A link finding's identity across two versions of one document: what was written, not where. */
function findingKey(finding: LinkFinding): string {
  const d = finding.details as Readonly<Record<string, unknown>>;
  return JSON.stringify([finding.code, d.reason ?? null, d.href ?? null, d.text ?? null, d.to ?? null]);
}

/**
 * The findings this write introduced into `doc` as stored, against `prior` (the version it
 * replaced; undefined for a create): link findings the prior body did not already have (at most
 * {@link LINK_FINDINGS_SHOWN}, in body order), and an undeclared type when the type is new to the
 * document. A write that leaves the body and type as they were introduces nothing, so a repeated
 * edit never repeats an old finding. Empty when there is nothing to say. A read that fails while
 * checking is reported as `LINK_LINT_UNAVAILABLE`, never thrown: the write already landed.
 */
export async function writeFindings(
  bundle: Bundle,
  doc: OkfDocument,
  registry: KindRegistry,
  prior: OkfDocument | undefined,
): Promise<ValidationWarning[]> {
  const out: ValidationWarning[] = [];
  if (prior === undefined || prior.body !== doc.body) {
    try {
      const readTarget = bundleTargetReader(bundle);
      const { findings } = await documentLinkReport(doc, { readTarget });
      // Counted, so a second copy of an old finding is new.
      const before = new Map<string, number>();
      if (prior !== undefined && findings.length > 0) {
        for (const finding of (await documentLinkReport({ ...prior, id: doc.id }, { readTarget })).findings) {
          before.set(findingKey(finding), (before.get(findingKey(finding)) ?? 0) + 1);
        }
      }
      const links = findings.flatMap((finding) => {
        const key = findingKey(finding);
        const seen = before.get(key) ?? 0;
        if (seen > 0) {
          before.set(key, seen - 1);
          return [];
        }
        const warning = linkWarning(finding);
        return warning ? [warning] : [];
      });
      out.push(...links.slice(0, LINK_FINDINGS_SHOWN));
      if (links.length > LINK_FINDINGS_SHOWN) {
        const last = out[out.length - 1]!;
        out[out.length - 1] = { ...last, message: `${last.message} (${links.length - LINK_FINDINGS_SHOWN} more link findings not shown)` };
      }
    } catch (err) {
      out.push({
        code: "LINK_LINT_UNAVAILABLE",
        message: `the document was written, but its links could not be checked: ${err instanceof Error ? err.message : String(err)}`,
        field: "body",
        severity: "warning",
      });
    }
  }
  const type = prior === undefined || prior.frontmatter.type !== doc.frontmatter.type ? undeclaredTypeFinding(registry, doc) : undefined;
  if (type) {
    const { type: written, declaredTypes, suggestedType } = type.details;
    out.push({
      code: type.code,
      message: suggestedType !== undefined
        ? `no Kind declares type '${written}'; did you mean '${suggestedType}'?`
        : `no Kind declares type '${written}', so it is not checked against a Kind (declared: ${declaredTypes.slice(0, 8).join(", ")}${declaredTypes.length > 8 ? ", ..." : ""}).`,
      field: "type",
      severity: type.severity,
      // The full declared list is `kinds`'s to print; the receipt names the type and any suggestion.
      details: { type: written, ...(suggestedType !== undefined ? { suggestedType } : {}) },
    });
  }
  return out;
}

/** The receipt's fix lines for these findings: the link form that registers, and where the declared types are listed. */
export function writeFindingsHelp(findings: readonly ValidationWarning[]): string[] {
  const help: string[] = [];
  if (findings.some((f) => f.code === "LINK_NOT_RECOGNIZED")) help.push(LINK_FORM_HELP);
  if (findings.some((f) => f.code === "KIND_TYPE_UNDECLARED")) help.push(`${cliInvocation()} kinds`);
  return help;
}
