/** Bounded Link-field parsing for paging; parameter values never become parameter syntax. */
import { unsupportedContent } from "../source-engine/index.js";

const TOKEN_CHAR = /^[!#$%&'*+.^_`|~0-9A-Za-z-]$/;
const MAX_HEADER = 65_536;
const MAX_LINKS = 128;
const MAX_PARAMETERS = 64;

/**
 * RFC 8288 sections 3 and 3.3, with quoted-pairs from RFC 7230 section 3.2.6.
 * Malformed or unsupported input refuses the page, rather than establishing terminal completeness.
 */
export function nextLinkTarget(header: string, base: string): string | undefined {
  if (header.length > MAX_HEADER) unsupportedContent("Link header exceeds parser bound");
  let at = 0;
  let links = 0;
  let next: string | undefined;
  const malformed = (): never => unsupportedContent("malformed Link header");
  const whitespace = (): void => {while (header[at] === " " || header[at] === "\t") at++;};
  const token = (): string => {
    const begin = at;
    while (at < header.length && TOKEN_CHAR.test(header[at]!)) at++;
    if (at === begin) malformed();
    return header.slice(begin, at);
  };
  const quoted = (): string => {
    at++; // opening DQUOTE
    let value = "";
    while (at < header.length) {
      let ch = header[at++]!;
      if (ch === '"') return value;
      if (ch === "\\") {
        if (at === header.length) malformed();
        ch = header[at++]!;
      }
      const code = ch.charCodeAt(0);
      if (code !== 9 && (code < 32 || code === 127 || code > 255)) malformed();
      value += ch;
    }
    return malformed();
  };

  whitespace();
  while (at < header.length) {
    if (++links > MAX_LINKS) unsupportedContent("too many Link targets");
    if (header[at++] !== "<") malformed();
    const begin = at;
    while (at < header.length && header[at] !== ">") {
      const ch = header[at++]!;
      const code = ch.charCodeAt(0);
      if (code <= 32 || code >= 127 || ch === "<" || ch === '"' || ch === "\\") malformed();
    }
    if (header[at] !== ">") malformed();
    const target = header.slice(begin, at++);
    let relation: string | undefined;
    let anchor: string | undefined;
    let parameters = 0;
    whitespace();
    while (header[at] === ";") {
      if (++parameters > MAX_PARAMETERS) unsupportedContent("too many Link parameters");
      at++;
      whitespace();
      const name = token().toLowerCase();
      whitespace();
      let value: string | undefined;
      if (header[at] === "=") {
        at++;
        whitespace();
        value = header[at] === '"' ? quoted() : token();
        whitespace();
      }
      if (name === "rel" && relation === undefined) {
        if (value === undefined || value === "") malformed();
        relation = value;
      }
      if (name === "anchor" && anchor === undefined) {
        if (value === undefined) malformed();
        anchor = value;
      }
      if (at < header.length && header[at] !== ";" && header[at] !== ",") malformed();
    }
    if (relation === undefined) return malformed();
    let resolved: string;
    try {
      resolved = new URL(target, base).href;
      if (anchor !== undefined && new URL(anchor, base).href !== new URL(base).href) unsupportedContent("Link context override is unsupported");
    } catch {return unsupportedContent("invalid Link target or context");}
    const relations = relation.toLowerCase().split(/[ \t]+/);
    for (const name of relations) {
      if (/^[a-z][a-z0-9.-]*$/.test(name)) continue;
      try {new URL(name);} catch {malformed();}
    }
    if (relations.includes("next")) {
      if (next !== undefined) unsupportedContent("multiple next links");
      next = resolved;
    }
    if (at === header.length) break;
    if (header[at++] !== ",") malformed();
    whitespace();
    if (at === header.length) malformed();
  }
  return next;
}
