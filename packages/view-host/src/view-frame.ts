/**
 * How a page serves a View's HTML into its frame: the response headers a View entry is served
 * with. The page embeds the entry in `<iframe sandbox="allow-scripts">`; the response's own
 * `sandbox allow-scripts` applies the same sandbox when the entry is opened directly, so the View
 * always runs at an opaque origin with no network channel.
 *
 * Inline images and fonts as data URIs are the View authoring contract every host allows; with
 * default, connect and form sources at 'none' a data URI opens no network channel. The View can
 * still navigate its own frame.
 */
export function viewFramePolicy(origin: string): string {
  const trusted = new URL(origin);
  if (trusted.origin !== origin || !["https:", "http:"].includes(trusted.protocol))
    throw new Error("Invalid app origin");
  return `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors ${trusted.origin}`;
}

/** The headers a View entry is served with, for the page at `origin` that frames it. */
export function viewFrameHeaders(origin: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": viewFramePolicy(origin),
    "X-Frame-Options": "SAMEORIGIN",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
}
