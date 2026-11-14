// Post-write findings for an authoring receipt (`doc write`, `doc update`, `doc field`, `new`):
// links in the stored body that will not register, links whose target has no document, and a
// type that misspells a declared Kind's type. Core owns every rule (`documentLinkReport`, `undeclaredTypeFinding`);
// this module only words each finding's next step for the CLI, as `link add` words its own.
// Advisory and post-write: the document is already stored, so nothing here can fail the write.
import {
  documentLinkReport,
  inspectDocumentLinks,
  readDoc,
  undeclaredTypeFinding,
  type Bundle,
  type ConceptId,
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

function linkWarning(finding: LinkFinding, body: string): ValidationWarning | undefined {
  if (finding.code === "LINK_NOT_RECOGNIZED") {
    const d = finding.details;
    // Quoted exactly as the body has it (an aliased wikilink keeps its alias).
    const written = body.slice(d.start, d.end);
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

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * One read per target across every check of this write, and a target that cannot be read
 * (malformed frontmatter, a spelling that folds onto another document) is recorded and treated as
 * present, so it never hides the findings about the other links.
 */
function cachedReader(bundle: Bundle, failures: Map<ConceptId, string>): LinkTargetReader {
  const read = bundleTargetReader(bundle);
  const cache = new Map<ConceptId, Promise<OkfDocument | undefined>>();
  return (id) => {
    const held = cache.get(id);
    if (held) return held;
    // An empty type: present, and no Kind's, which is all a check without a registry asks.
    const pending = read(id).catch((err: unknown): OkfDocument => {
      failures.set(id, errorText(err));
      return { id, frontmatter: { type: "" }, body: "" };
    });
    cache.set(id, pending);
    return pending;
  };
}

/** The link findings `doc`'s stored body has that `prior`'s did not, and the targets that could not be read. */
async function linkFindings(bundle: Bundle, doc: OkfDocument, prior: OkfDocument | undefined): Promise<ValidationWarning[]> {
  const failures = new Map<ConceptId, string>();
  const readTarget = cachedReader(bundle, failures);
  let findings: LinkFinding[];
  let unavailable: string | undefined;
  try {
    ({ findings } = await documentLinkReport(doc, { readTarget }));
  } catch (err) {
    // Anything but a target read: the findings that need no read still stand.
    ({ findings } = inspectDocumentLinks(doc));
    unavailable = errorText(err);
  }
  const unreadable = [...failures];
  // Counted, so a second copy of an old finding is new.
  const before = new Map<string, number>();
  if (prior !== undefined && findings.length > 0) {
    let old: LinkFinding[];
    try {
      ({ findings: old } = await documentLinkReport({ ...prior, id: doc.id }, { readTarget }));
    } catch {
      ({ findings: old } = inspectDocumentLinks({ ...prior, id: doc.id }));
    }
    for (const finding of old) before.set(findingKey(finding), (before.get(findingKey(finding)) ?? 0) + 1);
  }
  const links = findings.flatMap((finding) => {
    const key = findingKey(finding);
    const seen = before.get(key) ?? 0;
    if (seen > 0) {
      before.set(key, seen - 1);
      return [];
    }
    const warning = linkWarning(finding, doc.body);
    return warning ? [warning] : [];
  });
  const out = links.slice(0, LINK_FINDINGS_SHOWN);
  if (links.length > LINK_FINDINGS_SHOWN) {
    const last = out[out.length - 1]!;
    out[out.length - 1] = { ...last, message: `${last.message} (${links.length - LINK_FINDINGS_SHOWN} more link findings not shown)` };
  }
  for (const [to, reason] of unreadable.slice(0, LINK_FINDINGS_SHOWN)) {
    out.push({ code: "LINK_LINT_UNAVAILABLE", message: `the link to '${to}' could not be checked: ${reason}`, field: "body", severity: "warning", details: { to } });
  }
  if (unavailable !== undefined) {
    out.push({ code: "LINK_LINT_UNAVAILABLE", message: `the document was written, but its links to other documents could not be checked: ${unavailable}`, field: "body", severity: "warning" });
  }
  return out;
}

/**
 * The findings this write introduced into `doc` as stored, against `prior` (the version it
 * replaced; undefined for a create): link findings the prior body did not already have (at most
 * {@link LINK_FINDINGS_SHOWN}, in body order), and a near-miss type (one a declared Kind's type
 * matches but for case, spacing, hyphens or underscores) when the type is new to the document. A
 * deliberate ad-hoc type is legal and says nothing. A write that leaves the body and type as they
 * were introduces nothing, so a repeated edit never repeats an old finding. Empty when there is
 * nothing to say. A target that cannot be read is `LINK_LINT_UNAVAILABLE` for that target, never
 * thrown: the write already landed.
 */
export async function writeFindings(
  bundle: Bundle,
  doc: OkfDocument,
  registry: KindRegistry,
  prior: OkfDocument | undefined,
): Promise<ValidationWarning[]> {
  const out = prior === undefined || prior.body !== doc.body ? await linkFindings(bundle, doc, prior) : [];
  const type = prior === undefined || prior.frontmatter.type !== doc.frontmatter.type ? undeclaredTypeFinding(registry, doc) : undefined;
  if (type?.details.suggestedType !== undefined) {
    const { type: written, suggestedType } = type.details;
    out.push({
      code: type.code,
      message: `no Kind declares type '${written}'; did you mean '${suggestedType}'?`,
      field: "type",
      severity: type.severity,
      details: { type: written, suggestedType },
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
