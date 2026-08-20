/**
 * PageFrame (tasks/ui-pages-spike): render one bundle page in a sandboxed iframe and broker its
 * bridge. The iframe is `sandbox="allow-scripts"` with NO `allow-same-origin`, so it runs at an
 * opaque origin — it cannot fetch the data API even if a token leaked, and its scripts talk to the
 * shell ONLY via postMessage. This component:
 *   1. Asks the server to resolve the registry doc and exact HTML into one immutable launch.
 *      Active data-bearing Views mount only after the trusted shell confirms that exact launch
 *      (unchanged approvals are remembered locally by the CLI host).
 *   2. Listens for the page's postMessage requests, VALIDATING `event.source` is this iframe, and
 *      forwards opaque requests to the server-owned bridge; `bundle-propose` may additionally
 *      prepare one v1 action for explicit confirmation in trusted shell chrome.
 *   3. Fans SSE doc changes into the subscribed page as bridge `change` events, and HOT-RELOADS the
 *      iframe (fresh nonce) when the page's own HTML blob changes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  authorizeViewLaunch,
  cancelTrustedAction,
  commitTrustedAction,
  mintPageNonce,
  prepareTrustedAction,
  invalidateKinds,
  sendViewBridge,
  verifyViewDelivery,
  verifyViewLaunch,
  type ActionConfirmation,
  type MintedView,
} from "../api/pages.js";
import { subscribeToChanges, subscribeToResync } from "../pages/pageEvents.js";
import { navigate } from "../routing.js";
import { actionError, actionReply, parseActionBridgeMessage } from "@superbee/view-runtime/action-bridge";

const ACTION_CONFIRMATION_ARM_MS = 500;
const VIEW_AUTHORIZATION_ARM_MS = 500;

function changeMessage(
  changes: { id: string; version: string }[],
  removed: string[],
): Record<string, unknown> {
  return { bridge: "v0", type: "change", event: { changes, removed } };
}

interface PendingAction {
  seq: number;
  requestId: string;
  approvalToken?: string;
  confirmation?: ActionConfirmation;
  inFlight: boolean;
}

function scalarLabel(value: string | number | boolean | null): string {
  return value === null ? "(not set)" : JSON.stringify(value);
}

/** A framed View must prove that its document loaded instead of leaving an indefinite blank panel. */
export const VIEW_LOAD_DEADLINE_MS = 8_000;

const VIEW_LOAD_FAILURE =
  "This View's content did not finish loading. A browser content blocker or privacy extension may have blocked its local HTML request. Allowlist this local address, or reopen it with extensions disabled.";

export function PageFrame({ pageId }: { pageId: string }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameLoadTimerRef = useRef<number | null>(null);
  const frameReadySeqRef = useRef<number | null>(null);
  const frameNeedsDeliveryProofRef = useRef(false);
  const subscribedRef = useRef(false);
  // A shell navigation consumes the currently framed document's right to navigate. Unlike the
  // async-load epoch below, this remains locked while that old iframe can still post messages.
  const navigationConsumedRef = useRef(false);
  // The generation owned by the currently keyed iframe DOM node. Ref assignment happens before
  // child scripts execute, so startup bridge requests are accepted; advancing loadSeq invalidates
  // the still-mounted old document immediately.
  const activeFrameSeqRef = useRef<number | null>(null);
  // Bumped on every (re)load trigger, revoke, and unmount — a resolution that finishes after a
  // newer one started (or after a revoke) must not clobber the newer state.
  const loadSeqRef = useRef(0);
  const launchIdRef = useRef<string | null>(null);
  const pendingActionRef = useRef<PendingAction | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [frameSeq, setFrameSeq] = useState<number | null>(null);
  const [entryKey, setEntryKey] = useState<string | null>(null);
  const [title, setTitle] = useState<string>(pageId);
  const [error, setError] = useState<string | null>(null);
  const [pendingLaunch, setPendingLaunch] = useState<MintedView | null>(null);
  const [authorizationBusy, setAuthorizationBusy] = useState(false);
  const [authorizationArmed, setAuthorizationArmed] = useState(false);
  const [confirmation, setConfirmation] = useState<ActionConfirmation | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionArmed, setActionArmed] = useState(false);

  const discardPendingAction = useCallback(() => {
    const pending = pendingActionRef.current;
    pendingActionRef.current = null;
    setConfirmation(null);
    setActionBusy(false);
    setActionArmed(false);
    if (pending?.approvalToken) void cancelTrustedAction(pending.approvalToken).catch(() => {});
  }, []);

  const clearFrameLoadTimer = useCallback(() => {
    if (frameLoadTimerRef.current === null) return;
    window.clearTimeout(frameLoadTimerRef.current);
    frameLoadTimerRef.current = null;
  }, []);

  // A hostile View controls when this dialog appears. Keep both predictable button targets inert
  // long enough that the click which triggered the proposal (or its immediate follow-up) cannot
  // become accidental confirmation in trusted shell chrome.
  useEffect(() => {
    if (!confirmation) {
      setActionArmed(false);
      return;
    }
    const timer = window.setTimeout(() => setActionArmed(true), ACTION_CONFIRMATION_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [confirmation]);

  useEffect(() => {
    if (!pendingLaunch) {
      setAuthorizationArmed(false);
      return;
    }
    const timer = window.setTimeout(
      () => setAuthorizationArmed(true),
      VIEW_AUTHORIZATION_ARM_MS,
    );
    return () => window.clearTimeout(timer);
  }, [pendingLaunch]);

  const ownFrame = useCallback((node: HTMLIFrameElement | null) => {
    iframeRef.current = node;
    if (!node) return;
    if (frameSeq !== null && frameSeq === loadSeqRef.current) {
      activeFrameSeqRef.current = frameSeq;
      navigationConsumedRef.current = false;
    }
  }, [frameSeq]);

  // P1 (doc-lifecycle revocation): tear the frame down to an explicit terminal state — the
  // sandboxed iframe unmounts, so its bridge access ends WITH its registry doc, not after it.
  const revoke = useCallback((reason: string) => {
    discardPendingAction();
    clearFrameLoadTimer();
    loadSeqRef.current++;
    frameReadySeqRef.current = null;
    frameNeedsDeliveryProofRef.current = false;
    subscribedRef.current = false;
    launchIdRef.current = null;
    setPendingLaunch(null);
    setAuthorizationBusy(false);
    setSrc(null);
    setFrameSeq(null);
    setEntryKey(null);
    setError(reason);
  }, [clearFrameLoadTimer, discardPendingAction]);

  const markFrameReady = useCallback((seq: number) => {
    if (seq !== loadSeqRef.current) return;
    frameReadySeqRef.current = seq;
    clearFrameLoadTimer();
  }, [clearFrameLoadTimer]);

  const failFrameLoad = useCallback((seq: number, explicitFailure = false) => {
    if (seq !== loadSeqRef.current || (!explicitFailure && frameReadySeqRef.current === seq)) return;
    revoke(VIEW_LOAD_FAILURE);
  }, [revoke]);

  useEffect(() => {
    clearFrameLoadTimer();
    if (src === null || frameSeq === null || frameReadySeqRef.current === frameSeq) return;
    frameLoadTimerRef.current = window.setTimeout(
      () => failFrameLoad(frameSeq),
      VIEW_LOAD_DEADLINE_MS,
    );
    return clearFrameLoadTimer;
  }, [clearFrameLoadTimer, failFrameLoad, frameSeq, src]);

  /**
   * Resolve registry doc -> entry key -> nonce URL and (re)load the frame. The ONE path for
   * initial mount, registry-doc change (which may RETARGET `entry`), and blob hot-reload — so a
   * reload always re-reads what the doc currently declares and re-mints against the live registry.
   */
  const loadPage = useCallback(async () => {
    discardPendingAction();
    clearFrameLoadTimer();
    const seq = ++loadSeqRef.current;
    frameReadySeqRef.current = null;
    frameNeedsDeliveryProofRef.current = false;
    // Pre-revoke IMMEDIATELY, synchronously, before the async server mint below. This
    // is the ONE entry point every re-resolution path shares (mount, page switch, a live
    // registry-doc change, blob hot-reload, resync), so the OLD capability/subscription can never
    // survive past this line: a bridge request arriving during the async gap below is answered
    // fail-closed (denied), never under a grant this reload is already in the middle of revoking
    // — closes the window where a live `bundle-read` -> `none` edit left the stale launch standing
    // through the mint round-trip (P1).
    subscribedRef.current = false;
    launchIdRef.current = null;
    setPendingLaunch(null);
    setAuthorizationBusy(false);

    try {
      const minted = await mintPageNonce(pageId);
      if (seq !== loadSeqRef.current) return;
      subscribedRef.current = false;
      launchIdRef.current = minted.launchId;
      frameNeedsDeliveryProofRef.current = minted.capability === "none";
      setEntryKey(minted.entry);
      setTitle(minted.title);
      setError(null);
      if (minted.authorization.required && !minted.authorization.authorized) {
        setPendingLaunch(minted);
        setFrameSeq(null);
        setSrc(null);
      } else {
        setFrameSeq(seq);
        setSrc(minted.url);
      }
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      subscribedRef.current = false;
      launchIdRef.current = null;
      setPendingLaunch(null);
      setSrc(null);
      setFrameSeq(null);
      setEntryKey(null);
      // A mint 403 is not necessarily a dead session: `/__page/mint` also rejects malformed
      // (code FORBIDDEN) when this doc's `entry` is a confinement violation — outside `pages/`,
      // or not any Page doc's registered entry (server.ts's `handleMint`) — a malformed-DOC
      // problem, not a dead session. The launcher doesn't filter entries by prefix, so such a
      // doc is clickable; tripping the terminal recovery screen for it would brick the whole tab
      // with the WRONG advice over what's really just a dismissable per-view error.
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [clearFrameLoadTimer, discardPendingAction, pageId]);

  // Resolve registry doc -> entry key -> nonce URL on mount / page switch. Launch revocation
  // happens unconditionally at the TOP of loadPage itself (every re-resolution path
  // shares it), so this effect only owns the page-SWITCH UX: blank the frame immediately so a
  // newly-selected page never shows the outgoing page's stale content while it resolves.
  useEffect(() => {
    subscribedRef.current = false;
    setSrc(null);
    setFrameSeq(null);
    setError(null);
    void loadPage();
    return () => {
      discardPendingAction();
      clearFrameLoadTimer();
      loadSeqRef.current++;
    };
  }, [clearFrameLoadTimer, discardPendingAction, loadPage]);

  // Broker page->shell bridge requests. v0 remains read-only; v1 may only prepare a trusted,
  // human-confirmed action and never receives the launch id or approval token.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || ev.source !== frame.contentWindow) return;
      if (activeFrameSeqRef.current !== loadSeqRef.current) return;
      // Capture the shell epoch at receipt. The server independently resolves the launch,
      // authorization, and current bytes before AND after the request; this browser fence ensures
      // a slow reply is not delivered into a later iframe generation. The SAME
      // framed document can be replaced by reload/hot-reload/page-switch while that work is in
      // flight, so without this check a reply computed for the OLD page could cross the revoke
      // boundary (P1).
      const seq = loadSeqRef.current;
      // Any message from the exact current opaque-origin frame proves its own script loaded.
      // Scriptless access:none Views use the separate host delivery receipt below.
      markFrameReady(seq);

      const actionMessage = parseActionBridgeMessage(ev.data);
      if (actionMessage !== null) {
        const post = (reply: Record<string, unknown>): void => {
          if (seq === loadSeqRef.current && frame.contentWindow) frame.contentWindow.postMessage(reply, "*");
        };
        const raw = ev.data as { id?: unknown; requestId?: unknown };
        if (!actionMessage.ok) {
          if (typeof raw.requestId === "string") {
            post(actionReply(raw.requestId, { status: "rejected", action: "document.set-field", message: actionMessage.message }));
          } else {
            post(actionError(typeof raw.id === "string" ? raw.id : undefined, actionMessage.message));
          }
          return;
        }
        if (actionMessage.message.type === "read-versioned") {
          const readMessage = actionMessage.message;
          const launchId = launchIdRef.current;
          if (!launchId) {
            post(actionError(readMessage.id, "the frame launch is no longer current"));
            return;
          }
          void sendViewBridge(launchId, readMessage).then(
            (outcome) => {
              if (outcome.reply) post(outcome.reply);
            },
            (error) => post(actionError(readMessage.id, error instanceof Error ? error.message : String(error))),
          );
          return;
        }

        const requestId = actionMessage.message.requestId;
        if (pendingActionRef.current) {
          post(actionReply(requestId, { status: "rejected", action: "document.set-field", message: "this frame already has a pending proposal" }));
          return;
        }
        const launchId = launchIdRef.current;
        if (!launchId) {
          post(actionReply(requestId, { status: "revoked", action: "document.set-field", message: "the frame launch is no longer current" }));
          return;
        }
        const pending: PendingAction = { seq, requestId, inFlight: true };
        pendingActionRef.current = pending;
        void prepareTrustedAction(launchId, actionMessage.message.action).then(
          (result) => {
            if (seq !== loadSeqRef.current || pendingActionRef.current !== pending) {
              if (result.status === "prepared") void cancelTrustedAction(result.approvalToken).catch(() => {});
              return;
            }
            if (result.status === "prepared") {
              pending.approvalToken = result.approvalToken;
              pending.confirmation = result.confirmation;
              pending.inFlight = false;
              setActionBusy(false);
              setActionArmed(false);
              setConfirmation(result.confirmation);
              return;
            }
            pendingActionRef.current = null;
            post(actionReply(requestId, result));
          },
          (error) => {
            if (seq !== loadSeqRef.current || pendingActionRef.current !== pending) return;
            pendingActionRef.current = null;
            post(actionReply(requestId, { status: "failed", action: "document.set-field", message: error instanceof Error ? error.message : String(error) }));
          },
        );
        return;
      }

      const launchId = launchIdRef.current;
      if (!launchId) return;
      void sendViewBridge(launchId, ev.data).then(
        (outcome) => {
          if (seq !== loadSeqRef.current) return; // frame reloaded/revoked since receipt — drop it
          if (outcome.openPageId) {
            if (outcome.openPageId === pageId) return;
            if (navigationConsumedRef.current) return;
            // End this source generation before changing history. Concurrent outcomes captured
            // under it then fail the fence above and cannot navigate a second time.
            navigationConsumedRef.current = true;
            loadSeqRef.current++;
            discardPendingAction();
            subscribedRef.current = false;
            launchIdRef.current = null;
            navigate({ view: "page", id: outcome.openPageId });
            return;
          }
          if (outcome.subscribed) subscribedRef.current = true;
          if (outcome.reply && frame.contentWindow) frame.contentWindow.postMessage(outcome.reply, "*");
        },
        (error) => {
          const raw = ev.data as { id?: unknown };
          if (seq === loadSeqRef.current && typeof raw?.id === "string") {
            frame.contentWindow?.postMessage(
              actionError(raw.id, error instanceof Error ? error.message : String(error)),
              "*",
            );
          }
        },
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [discardPendingAction, markFrameReady, pageId]);

  // Live: push doc changes to the subscribed page; REVOKE when this page's registry doc is
  // removed (P1 — an open frame must not keep reading through the bridge after its page is
  // deleted); re-resolve on a registry-doc change (which may retarget `entry`); hot-reload on
  // this page's own blob change.
  useEffect(() => {
    return subscribeToChanges((e) => {
      invalidateKinds([...e.docs.changed.map((c) => c.id), ...e.docs.removed]);
      const frame = iframeRef.current;
      const launchId = launchIdRef.current;
      if (
        launchId &&
        subscribedRef.current &&
        frame?.contentWindow &&
        (e.docs.changed.length > 0 || e.docs.removed.length > 0)
      ) {
        const seq = loadSeqRef.current;
        void verifyViewLaunch(launchId).then(
          (status) => {
            if (
              status.authorized &&
              seq === loadSeqRef.current &&
              subscribedRef.current &&
              iframeRef.current?.contentWindow
            ) {
              iframeRef.current.contentWindow.postMessage(
                changeMessage(e.docs.changed, e.docs.removed),
                "*",
              );
            }
          },
          () => {
            if (seq === loadSeqRef.current) {
              revoke("This View changed or its local authorization is no longer current.");
            }
          },
        );
      }
      if (e.docs.removed.includes(pageId)) {
        revoke("This page's registry doc was removed from the bundle — the page has been closed.");
        return;
      }
      if (e.docs.changed.some((c) => c.id === pageId) || (entryKey !== null && e.blobs.changed.some((b) => b.key === entryKey))) {
        void loadPage();
      }
    });
  }, [entryKey, pageId, loadPage, revoke]);

  // P1 (connection resilience): the SSE stream carries NO replay — anything that changed during a
  // gap never arrives as a delta. On reconnect, re-resolve and RELOAD the frame outright: the page
  // re-queries on boot (full catch-up), a registry doc deleted during the gap makes the server
  // mint fail, and a changed blob comes back as fresh bytes.
  useEffect(() => {
    return subscribeToResync(() => {
      invalidateKinds(); // anything may have changed during the gap, conventions included
      void loadPage();
    });
  }, [loadPage]);

  const settleConfirmation = useCallback(async (decision: "commit" | "cancel") => {
    const pending = pendingActionRef.current;
    if (!actionArmed || !pending?.approvalToken || pending.inFlight) return;
    pending.inFlight = true;
    setActionBusy(true);
    const seq = pending.seq;
    try {
      const result = decision === "commit"
        ? await commitTrustedAction(pending.approvalToken)
        : await cancelTrustedAction(pending.approvalToken);
      if (seq !== loadSeqRef.current || pendingActionRef.current !== pending) return;
      pendingActionRef.current = null;
      setConfirmation(null);
      setActionBusy(false);
      iframeRef.current?.contentWindow?.postMessage(actionReply(pending.requestId, result), "*");
    } catch (error) {
      if (seq !== loadSeqRef.current || pendingActionRef.current !== pending) return;
      pendingActionRef.current = null;
      setConfirmation(null);
      setActionBusy(false);
      iframeRef.current?.contentWindow?.postMessage(
        actionReply(pending.requestId, { status: "failed", action: "document.set-field", message: error instanceof Error ? error.message : String(error) }),
        "*",
      );
    }
  }, [actionArmed]);

  const settleAuthorization = useCallback(async (approve: boolean) => {
    const pending = pendingLaunch;
    if (!pending || !authorizationArmed || authorizationBusy) return;
    if (!approve) {
      setPendingLaunch(null);
      navigate({ view: "launcher" });
      return;
    }
    const seq = loadSeqRef.current;
    setAuthorizationBusy(true);
    try {
      const status = await authorizeViewLaunch(pending.launchId);
      if (seq !== loadSeqRef.current || pendingLaunch !== pending) return;
      if (!status.authorized) throw new Error("the View was not authorized");
      setPendingLaunch(null);
      setAuthorizationBusy(false);
      setFrameSeq(seq);
      setSrc(pending.url);
    } catch (error) {
      if (seq !== loadSeqRef.current || pendingLaunch !== pending) return;
      setPendingLaunch(null);
      setAuthorizationBusy(false);
      launchIdRef.current = null;
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [authorizationArmed, authorizationBusy, pendingLaunch]);

  return (
    <div className="page-frame">
      <div className="page-frame-bar">
        <button
          type="button"
          className="page-back"
          onClick={() => navigate({ view: "launcher" })}
        >
          ← Home
        </button>
        <span className="page-frame-title">{title}</span>
      </div>
      {error ? (
        <p className="view-status view-status-error">Could not open page: {error}</p>
      ) : pendingLaunch ? (
        <p className="view-status">Waiting for local View approval…</p>
      ) : src ? (
        // allow-scripts ONLY — no allow-same-origin: opaque origin, no data-API reach. And NO
        // referrer: the shell's URL (which carried ?token= before the scrub) must never reach the
        // untrusted page as document.referrer (tasks/ui-pages-spike P1).
        <iframe
          key={src}
          ref={ownFrame}
          className="page-frame-iframe"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={src}
          title={title}
          onLoad={() => {
            const launchId = launchIdRef.current;
            if (frameSeq === null || !frameNeedsDeliveryProofRef.current || !launchId) return;
            void verifyViewDelivery(launchId).then(
              ({ delivered }) => {
                if (delivered) markFrameReady(frameSeq);
              },
              () => {},
            );
          }}
          onError={() => {
            if (frameSeq !== null) failFrameLoad(frameSeq, true);
          }}
        />
      ) : (
        <p className="view-status">Opening page…</p>
      )}
      {pendingLaunch && (
        <div className="action-confirmation-backdrop" role="presentation">
          <section className="action-confirmation" role="dialog" aria-modal="true" aria-labelledby="view-authorization-title">
            <p className="action-confirmation-eyebrow">Local View approval</p>
            <h2 id="view-authorization-title">Allow this View to read bundle data?</h2>
            <p>
              <strong>{pendingLaunch.title}</strong> contains active HTML and requests{" "}
              <code>{pendingLaunch.capability}</code> access.
            </p>
            <dl>
              <div><dt>View</dt><dd><code>{pageId}</code></dd></div>
              <div><dt>HTML</dt><dd><code>{pendingLaunch.authorization.contentVersion}</code></dd></div>
            </dl>
            <p className="action-confirmation-note">
              Approval trusts these executable bytes with the declared bundle access. Approve only Views whose
              source or author you trust.{" "}
              Approval is stored only on this computer for these exact View bytes and declared access.
              Changed HTML or access asks again.
            </p>
            <div className="action-confirmation-buttons">
              <button
                type="button"
                disabled={authorizationBusy || !authorizationArmed}
                onClick={() => void settleAuthorization(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="action-apply"
                disabled={authorizationBusy || !authorizationArmed}
                onClick={() => void settleAuthorization(true)}
              >
                {authorizationBusy ? "Allowing…" : "Allow this View"}
              </button>
            </div>
          </section>
        </div>
      )}
      {confirmation && (
        <div className="action-confirmation-backdrop" role="presentation">
          <section className="action-confirmation" role="dialog" aria-modal="true" aria-labelledby="action-confirmation-title">
            <p className="action-confirmation-eyebrow">Superbee confirmation</p>
            <h2 id="action-confirmation-title">Apply this bundle change?</h2>
            <p>
              View <code>{confirmation.source.id}</code> proposes changing <strong>{confirmation.target.title}</strong>.
            </p>
            <dl>
              <div><dt>Document</dt><dd><code>{confirmation.target.docId}</code></dd></div>
              <div><dt>Kind</dt><dd>{confirmation.target.kind}</dd></div>
              <div><dt>Field</dt><dd><code>{confirmation.field}</code></dd></div>
              <div><dt>Before</dt><dd><code>{scalarLabel(confirmation.before)}</code></dd></div>
              <div><dt>After</dt><dd><code>{scalarLabel(confirmation.after)}</code></dd></div>
              <div><dt>Actor</dt><dd><code>{confirmation.actor}</code></dd></div>
              <div><dt>Timestamp</dt><dd><code>{confirmation.timestamp}</code></dd></div>
            </dl>
            <p className="action-confirmation-note">The write is conditional on the exact document, View, HTML, and Kind versions shown to the shell.</p>
            <div className="action-confirmation-buttons">
              <button type="button" disabled={actionBusy || !actionArmed} onClick={() => void settleConfirmation("cancel")}>Cancel</button>
              <button type="button" className="action-apply" disabled={actionBusy || !actionArmed} onClick={() => void settleConfirmation("commit")}>
                {actionBusy ? "Applying…" : "Apply change"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
