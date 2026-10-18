/**
 * The robots.txt and address rules of the source engine, storage-neutral and transport-free: a
 * declared fetch identity, RFC 9309 parsing, matching and decision, the bot-challenge test, and
 * the lexical address refusal applied to every hop. The robots read loop that uses them lives in
 * the guarded transport, so every robots.txt request passes the same host guard as a page.
 */

/** A declared fetch identity: `Product/version (+https://contact; optional@email)`. */
const IDENTITY =
  /^([A-Za-z][A-Za-z_-]{0,63})\/([0-9A-Za-z][0-9A-Za-z.-]{0,31}) \(\+(https:\/\/[^\s;()]+)(; [^\s;()@]+@[^\s;()]+)?\)$/;

export interface FetchIdentity {
  /** The exact User-Agent sent on every request, robots.txt included. */
  userAgent: string;
  /** The robots.txt product token (RFC 9309 2.2.1: letters, `_` and `-`). */
  productToken: string;
}

/**
 * The identity for a declared User-Agent, or undefined when it does not name a product, a version
 * and an https contact page.
 */
export function fetchIdentity(userAgent: string): FetchIdentity | undefined {
  const match = IDENTITY.exec(userAgent);
  if (!match) return undefined;
  try {
    new URL(match[3]!);
  } catch {
    return undefined;
  }
  return { userAgent, productToken: match[1]! };
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * RFC 9309 2.2.2: percent-encoded unreserved characters decoded, other non-ASCII percent-encoded,
 * escapes in upper case, so a rule and a path compare in one canonical form.
 */
export function canonicalRobotsPath(path: string): string {
  const chars = Array.from(path);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    const escape = chars.slice(i + 1, i + 3).join("");
    if (char === "%" && /^[0-9A-Fa-f]{2}$/.test(escape)) {
      const decoded = String.fromCharCode(parseInt(escape, 16));
      out += UNRESERVED.test(decoded) ? decoded : "%" + escape.toUpperCase();
      i += 2;
    } else if (char.codePointAt(0)! > 0x7e || char.codePointAt(0)! < 0x21) {
      for (const byte of new TextEncoder().encode(char)) out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    } else out += char;
  }
  return out;
}

export interface RobotsGroup {
  agents: string[];
  rules: Array<{ allow: boolean; path: string }>;
}

/** Robots groups: product tokens (lowercase) and their canonical Allow and Disallow rules. */
export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    // Split on the first colon by index: a regular expression here backtracks on long runs of
    // whitespace, and the body is provider text.
    const line = raw.replace(/#.*/, "").trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!/^[a-z-]+$/.test(key)) continue;
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      // The product token ends at the first character outside letters, `_` and `-`.
      current!.agents.push(value === "*" ? "*" : (/^[A-Za-z_-]*/.exec(value)![0] ?? "").toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (key === "allow" || key === "disallow") && value !== "") {
        current.rules.push({ allow: key === "allow", path: canonicalRobotsPath(value) });
      }
    }
  }
  return groups;
}

/**
 * Whether a robots rule matches a canonical path from its start: `*` is any run, a trailing `$`
 * anchors the end. Linear, with no backtracking regex: both sides are untrusted.
 */
export function robotsRuleMatches(rule: string, path: string): boolean {
  const anchored = rule.endsWith("$");
  const parts = (anchored ? rule.slice(0, -1) : rule).split("*");
  if (!path.startsWith(parts[0]!)) return false;
  let at = parts[0]!.length;
  if (parts.length === 1) return !anchored || at === path.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const found = path.indexOf(parts[i]!, at);
    if (found === -1) return false;
    at = found + parts[i]!.length;
  }
  const last = parts.at(-1)!;
  if (anchored) return path.length - last.length >= at && path.endsWith(last);
  return path.indexOf(last, at) !== -1;
}

/**
 * RFC 9309 matching: the groups naming the product token exactly, else `*`; the longest matching
 * rule wins, Allow on a tie. The path includes the query.
 */
export function robotsDecision(robotsText: string, pathAndQuery: string, productToken: string): { allow: boolean; rule?: string } {
  const groups = parseRobots(robotsText);
  const token = productToken.toLowerCase();
  const path = canonicalRobotsPath(pathAndQuery);
  const mine = groups.filter((group) => group.agents.includes(token));
  const rules = (mine.length ? mine : groups.filter((group) => group.agents.includes("*"))).flatMap((group) => group.rules);
  let best: { allow: boolean; path: string } | undefined;
  for (const rule of rules) {
    if (robotsRuleMatches(rule.path, path) && (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow))) {
      best = rule;
    }
  }
  return best ? { allow: best.allow, rule: `${best.allow ? "Allow" : "Disallow"}: ${best.path}` } : { allow: true };
}

/**
 * Why `url` may not be fetched at all, or undefined: a scheme other than http(s), userinfo, a
 * non-default port, an IP literal or a local name. Lexical only; a transport that resolves names
 * also refuses private addresses after resolution.
 */
export function refusedAddress(url: URL): string | undefined {
  if (url.protocol !== "https:" && url.protocol !== "http:") return "scheme";
  if (url.username || url.password) return "credentials";
  if (url.port !== "") return "port";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return "ip_literal";
  if (!host.includes(".")) return "local_name";
  if (/(^|\.)(localhost|local|internal|intranet|home|lan|arpa|test|invalid|example)$/.test(host)) return "local_name";
  return undefined;
}

/** A bot-mitigation interstitial rather than the content: stop, never retry around it. */
export function challenged(status: number, headers: Readonly<Record<string, string>>, text: string): boolean {
  if (headers["cf-mitigated"]?.toLowerCase() === "challenge") return true;
  if (![403, 429, 503].includes(status)) return false;
  return /just a moment\.\.\.|challenge-platform|cf-chl-|captcha|are you a robot|verify you are human/i.test(text);
}
