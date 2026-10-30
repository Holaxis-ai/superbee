import { useEffect, useState, useSyncExternalStore } from "react";
import type { DocumentOffersSnapshot } from "@superbee/ui-server";
import { readShellJson } from "../api/pages.js";
import { parseDocumentOffers, subscribeToDocumentOffers, subscribeToResync } from "../pages/pageEvents.js";
import { getRoute, subscribeToRoute, navigate } from "../routing.js";

/** Offers never replace the current document or a live View without the person's choice. */
export function DocumentOffers() {
  const route = useSyncExternalStore(subscribeToRoute, getRoute, getRoute);
  const [snapshot, setSnapshot] = useState<DocumentOffersSnapshot>({ revision: -1, offers: [] });
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let active = true;
    const adopt = (incoming: DocumentOffersSnapshot) => {
      if (active) setSnapshot((previous) => incoming.revision >= previous.revision ? incoming : previous);
    };
    const refresh = () => {
      void readShellJson<unknown>("/__ui/document-offers").then((value) => {
        const incoming = parseDocumentOffers(value);
        if (incoming) adopt(incoming);
      }).catch(() => { /* Optional offers do not gate the reader; reconnect re-reads them. */ });
    };
    const stopOffers = subscribeToDocumentOffers(adopt);
    const stopResync = subscribeToResync(refresh);
    refresh();
    return () => { active = false; stopOffers(); stopResync(); };
  }, []);
  useEffect(() => {
    const remaining = snapshot.offers.map((offer) => offer.expiresAt - Date.now()).filter((duration) => duration > 0);
    if (!remaining.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(...remaining));
    return () => clearTimeout(timer);
  }, [snapshot, now]);
  useEffect(() => {
    const current = new Set(snapshot.offers.map((offer) => `${offer.documentId}:${offer.expiresAt}`));
    setDismissed((previous) => new Set([...previous].filter((key) => current.has(key))));
  }, [snapshot]);
  const offers = snapshot.offers.filter((offer) => offer.expiresAt > Date.now() && !dismissed.has(`${offer.documentId}:${offer.expiresAt}`) && !(route.view === "doc" && route.id === offer.documentId));
  if (!offers.length) return null;
  const dismiss = (key: string) => setDismissed((previous) => new Set([...previous, key]));
  return <aside aria-label="Documents offered by agents" className="document-offers">
    <p>An agent offered a document. Your current page stays open until you choose another.</p>
    <ul>{offers.map((offer) => {
      const key = `${offer.documentId}:${offer.expiresAt}`;
      return <li key={key}><span>{offer.documentId}</span>{" "}
        <button type="button" onClick={() => { dismiss(key); navigate({ view: "doc", id: offer.documentId }); }}>Open</button>{" "}
        <button type="button" onClick={() => dismiss(key)}>Dismiss</button>
      </li>;
    })}</ul>
  </aside>;
}
