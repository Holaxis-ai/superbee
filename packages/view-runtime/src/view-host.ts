/**
 * The loopback UI's View host: the one document between the trusted shell and a View's
 * sandboxed frame. The shell fetches a launch's exact HTML bytes itself (same origin,
 * session-authorized), verifies them against the approved content version, and posts them here;
 * this host turns them into a `blob:` URL for a `sandbox="allow-scripts"` child frame, so the
 * View frame never makes a network request for its own HTML.
 *
 * A local-scheme document inherits the Content-Security-Policy of the document that navigates
 * it. The shell's own policy forbids inline script, so a blob the shell navigated would break
 * every self-contained View. This host is served with the View policy plus a `sandbox` directive
 * (an opaque origin assigned by the response, not by a frame attribute, so browsers that refuse
 * requests from attribute-sandboxed frames still load it), and the View inherits that policy.
 *
 * Messages crossing the host are enveloped. The host forwards View messages to the shell only
 * from its own child frame, and accepts shell messages only from its parent at the origin it was
 * served from; it never interprets a View message.
 */

export const VIEW_HOST_PROTOCOL = "superbee-view-host/v1";

/** Shell-relative path the loopback UI serves the host document at. */
export const VIEW_HOST_PATH = "/__ui/view-host";

/**
 * Host -> shell. `loaded` echoes the shell's per-delivery id once the View frame fired `load`
 * (which a refused navigation also fires, so it is not proof of render); `failed` reports a
 * refusal the host could observe, such as a CSP violation on the child's blob navigation.
 */
export type ViewHostEvent =
  | { protocol: typeof VIEW_HOST_PROTOCOL; type: "ready" }
  | { protocol: typeof VIEW_HOST_PROTOCOL; type: "loaded"; deliveryId: string }
  | { protocol: typeof VIEW_HOST_PROTOCOL; type: "failed"; deliveryId: string; reason: string }
  | { protocol: typeof VIEW_HOST_PROTOCOL; type: "view-message"; message: unknown };

/** Shell -> host. One `load` per host document; `deliver` forwards a message to the View. */
export type ViewHostCommand =
  | {
      protocol: typeof VIEW_HOST_PROTOCOL;
      type: "load";
      deliveryId: string;
      bytes: ArrayBuffer;
      contentType: string;
      title: string;
    }
  | { protocol: typeof VIEW_HOST_PROTOCOL; type: "deliver"; message: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse one message the shell received from its host frame; anything else is `null`. */
export function parseViewHostEvent(data: unknown): ViewHostEvent | null {
  if (!isRecord(data) || data.protocol !== VIEW_HOST_PROTOCOL) return null;
  if (data.type === "ready") return { protocol: VIEW_HOST_PROTOCOL, type: "ready" };
  if (data.type === "loaded" && typeof data.deliveryId === "string" && data.deliveryId.length > 0) {
    return { protocol: VIEW_HOST_PROTOCOL, type: "loaded", deliveryId: data.deliveryId };
  }
  if (
    data.type === "failed" && typeof data.deliveryId === "string" && data.deliveryId.length > 0 &&
    typeof data.reason === "string"
  ) {
    return { protocol: VIEW_HOST_PROTOCOL, type: "failed", deliveryId: data.deliveryId, reason: data.reason.slice(0, 200) };
  }
  if (data.type === "view-message" && "message" in data) {
    return { protocol: VIEW_HOST_PROTOCOL, type: "view-message", message: data.message };
  }
  return null;
}

export function viewHostLoad(
  deliveryId: string,
  bytes: ArrayBuffer,
  contentType: string,
  title: string,
): ViewHostCommand {
  return { protocol: VIEW_HOST_PROTOCOL, type: "load", deliveryId, bytes, contentType, title };
}

export function viewHostDeliver(message: unknown): ViewHostCommand {
  return { protocol: VIEW_HOST_PROTOCOL, type: "deliver", message };
}

/**
 * The host's own response policy: the View policy (which the blob child inherits), a `sandbox`
 * directive giving the host an opaque origin, and `frame-src blob:` so it can mount the child.
 * `viewPolicy` must not contain `frame-src`, `child-src`, or `sandbox`, and should set
 * `worker-src` itself: otherwise workers fall back to `child-src blob:` here.
 *
 * `frame-ancestors` is removed: the child inherits this policy, and its ancestor (this opaque
 * host) can never match `'self'`, so WebKit would refuse to render the View. The serving host
 * protects the host document itself with `X-Frame-Options: SAMEORIGIN`, which a local-scheme
 * child does not inherit.
 */
export function viewHostCsp(viewPolicy: string): string {
  const inherited = viewPolicy
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive !== "" && !/^frame-ancestors(\s|$)/i.test(directive));
  return ["sandbox allow-scripts", ...inherited, "frame-src blob:", "child-src blob:"].join("; ");
}

/**
 * The static host document. `childPolicy` is applied to the View frame through the `csp`
 * attribute (CSP Embedded Enforcement) where the browser supports it, restoring the View's own
 * `frame-src 'none'` on top of the inherited host policy.
 */
export function viewHostDocument(childPolicy: string): string {
  const script = `(function () {
  "use strict";
  var PROTOCOL = ${JSON.stringify(VIEW_HOST_PROTOCOL)};
  var CHILD_POLICY = ${JSON.stringify(childPolicy)};
  var shellOrigin = new URL(location.href).origin;
  var view = null;
  var pending = null;
  function toShell(message) { parent.postMessage(message, shellOrigin); }
  function fail(reason) {
    if (pending === null) return;
    var deliveryId = pending;
    pending = null;
    toShell({ protocol: PROTOCOL, type: "failed", deliveryId: deliveryId, reason: String(reason).slice(0, 200) });
  }
  // A refused blob navigation still fires the child's load event; a violation of this host's own
  // policy is the refusal it can observe.
  document.addEventListener("securitypolicyviolation", function (event) {
    if (/^blob/.test(String(event.blockedURI)) || /^(frame|child)-src/.test(event.effectiveDirective)) {
      fail("the browser refused to load the View frame (" + event.effectiveDirective + ")");
    }
  });
  window.addEventListener("message", function (event) {
    if (view !== null && event.source === view.contentWindow) {
      toShell({ protocol: PROTOCOL, type: "view-message", message: event.data });
      return;
    }
    if (event.source !== parent || event.origin !== shellOrigin) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.protocol !== PROTOCOL) return;
    if (data.type === "deliver") {
      if (view !== null && view.contentWindow) view.contentWindow.postMessage(data.message, "*");
      return;
    }
    if (data.type !== "load" || view !== null) return;
    if (!(data.bytes instanceof ArrayBuffer) || typeof data.contentType !== "string" ||
        typeof data.deliveryId !== "string" || typeof data.title !== "string") return;
    var deliveryId = data.deliveryId;
    pending = deliveryId;
    var url = URL.createObjectURL(new Blob([data.bytes], { type: data.contentType }));
    view = document.createElement("iframe");
    view.setAttribute("sandbox", "allow-scripts");
    view.setAttribute("csp", CHILD_POLICY);
    view.setAttribute("referrerpolicy", "no-referrer");
    view.setAttribute("title", data.title);
    view.addEventListener("load", function () {
      URL.revokeObjectURL(url);
      // Let a violation reported for this navigation arrive first.
      setTimeout(function () {
        if (pending !== deliveryId) return;
        pending = null;
        toShell({ protocol: PROTOCOL, type: "loaded", deliveryId: deliveryId });
      }, 0);
    }, { once: true });
    view.src = url;
    document.body.appendChild(view);
  });
  toShell({ protocol: PROTOCOL, type: "ready" });
})();`;
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>Superbee View</title>',
    "<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style>",
    `</head><body><script>${script}</script></body></html>`,
  ].join("");
}
