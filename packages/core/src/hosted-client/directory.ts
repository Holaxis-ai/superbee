// Finding a teammate in a hosted workspace's notification directory (decision
// notification-directory-2026-10-17): reading every page, and the one matching rule every client
// uses to turn what a person typed (a principal id, an email, a name) into one member, or into a
// refusal that names the candidates. A match never guesses: only an exact principal id, email or
// name names a member; two that fit equally are ambiguous, and the start of a name only suggests
// members, because someone who turned the directory off is not there to make it ambiguous.
import { stripHostControls } from "../host-text.js";
import { DIRECTORY_PAGE_MAX, type DirectoryMember, type HostedInbox } from "./inbox.js";

/** The most directory pages {@link readDirectory} reads by default: 2,000 members. */
export const DIRECTORY_PAGES_MAX = 20;

export interface DirectoryListing {
  readonly members: readonly DirectoryMember[];
  /** False when the directory had more pages than were read: a match over it may miss a duplicate. */
  readonly complete: boolean;
}

/** Every member the directory lists, page by page, up to `maxPages` pages. */
export async function readDirectory(inbox: Pick<HostedInbox, "directory">, options: { readonly maxPages?: number } = {}): Promise<DirectoryListing> {
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? DIRECTORY_PAGES_MAX));
  const members: DirectoryMember[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const answer = await inbox.directory({ limit: DIRECTORY_PAGE_MAX, ...(after === undefined ? {} : { after }) });
    for (const member of answer.members) {
      if (seen.has(member.principalId)) continue;
      seen.add(member.principalId);
      members.push(member);
    }
    // A cursor that does not move would page forever: stop and say the listing is not whole.
    if (answer.nextAfter === null) return { members, complete: true };
    if (answer.nextAfter === after) return { members, complete: false };
    after = answer.nextAfter;
  }
  return { members, complete: false };
}

/** How a member matched exactly: its principal id, its email, or its whole name. */
export type DirectoryMatchBy = "principal_id" | "email" | "name";

export type DirectoryMatch =
  | { readonly outcome: "matched"; readonly member: DirectoryMember; readonly by: DirectoryMatchBy }
  | { readonly outcome: "ambiguous"; readonly by: Exclude<DirectoryMatchBy, "principal_id">; readonly candidates: readonly DirectoryMember[] }
  /** No exact match, but these names start with the query: suggestions, never a recipient. */
  | { readonly outcome: "prefix"; readonly candidates: readonly DirectoryMember[] }
  /** `emails` false: the query was an email and the directory shares none, so it cannot match one. */
  | { readonly outcome: "none"; readonly emails: boolean };

/**
 * A name as matching compares it: control and format characters removed, NFC, runs of space
 * folded to one, trimmed and lowercased.
 */
export function directoryNameKey(value: string): string {
  return stripHostControls(value).replace(/[\t\n\r]/g, " ").normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * The one member `query` names, by these rules in order: an exact principal id; with an `@`, an
 * exact email (any case) when the directory shares emails; else an exact display name (any case,
 * spacing folded). Several at the first rule that matches any are ambiguous. With no exact name,
 * the names that start with the query are returned as `prefix` suggestions; nothing at all is none.
 */
export function matchDirectoryMember(members: readonly DirectoryMember[], query: string): DirectoryMatch {
  const byId = members.find((member) => member.principalId === query);
  if (byId) return { outcome: "matched", member: byId, by: "principal_id" };
  const key = directoryNameKey(query);
  if (key === "") return { outcome: "none", emails: true };
  if (query.includes("@")) {
    const shared = members.some((member) => typeof member.email === "string");
    if (!shared) return { outcome: "none", emails: false };
    return settle(
      members.filter((member) => typeof member.email === "string" && directoryNameKey(member.email) === key),
      "email",
    ) ?? { outcome: "none", emails: true };
  }
  const named = members.filter((member): member is DirectoryMember & { displayName: string } => member.displayName !== null);
  return (
    settle(named.filter((member) => directoryNameKey(member.displayName) === key), "name") ??
    suggest(named.filter((member) => directoryNameKey(member.displayName).startsWith(key))) ?? { outcome: "none", emails: true }
  );
}

function suggest(found: readonly DirectoryMember[]): DirectoryMatch | null {
  return found.length === 0 ? null : { outcome: "prefix", candidates: found };
}

function settle(found: readonly DirectoryMember[], by: Exclude<DirectoryMatchBy, "principal_id">): DirectoryMatch | null {
  if (found.length === 0) return null;
  if (found.length === 1) return { outcome: "matched", member: found[0]!, by };
  return { outcome: "ambiguous", by, candidates: found };
}
