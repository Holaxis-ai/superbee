/** Presentation requests belong to one managed bundle/actor, never to a global viewer authority. */
export interface DocumentOffer { documentId: string; expiresAt: number }
export interface DocumentOffersSnapshot { revision: number; offers: DocumentOffer[] }
const OFFER_TTL_MS = 60_000;
const OPEN_GRACE_MS = 10_000;
const MAX_OFFERS = 20;

export class DocumentOffers {
  private readonly offers = new Map<string, DocumentOffer>();
  private revision = 0;
  private openingUntil = 0;
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  snapshot(): DocumentOffersSnapshot {
    const now = this.now();
    for (const [id, offer] of this.offers) {
      if (offer.expiresAt <= now) { this.offers.delete(id); this.revision++; }
    }
    return { revision: this.revision, offers: [...this.offers.values()].map((offer) => ({ ...offer })) };
  }

  offer(documentId: string, activeClients: number): { openBrowser: boolean; snapshot: DocumentOffersSnapshot } | null {
    this.snapshot();
    if (!this.offers.has(documentId) && this.offers.size >= MAX_OFFERS) return null;
    const now = this.now();
    this.offers.set(documentId, { documentId, expiresAt: now + OFFER_TTL_MS });
    this.revision++;
    const openBrowser = activeClients === 0 && now >= this.openingUntil;
    if (openBrowser) this.openingUntil = now + OPEN_GRACE_MS;
    if (activeClients > 0) this.openingUntil = 0;
    return { openBrowser, snapshot: this.snapshot() };
  }
}
