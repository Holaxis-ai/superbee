/**
 * Home-surface pins (designs/home-surface):
 *
 *  1. The empty Views state is a SHORT pointer: the plain-language ask that produces a view.
 *     The full what-is-a-view explanation lives in the orientation walkthrough (2026-07-26);
 *     authoring mechanics (kind names, blob prefixes, registry docs) are pinned ABSENT from the
 *     first read and reachable behind "learn more".
 *  2. The grid is FLAT — the capability-grouped sections (Dashboards / Interactive / Documents)
 *     are gone; capability renders as a per-card BADGE (`live data` / `can edit` / `artifact`)
 *     derived from the same enforced `bridge` field. Red-on-old: the grouped launcher rendered a
 *     "Documents" heading.
 *  3. Orientation shows until dismissed; dismissal persists per bundle root in localStorage, and
 *     a stored dismissal suppresses it. It stays REACHABLE afterwards: "what is this?" reopens
 *     it (the 2026-07-24 landing rethink — the overview and the example view prompts must not
 *     vanish after one reading).
 *  4. Landing copy is agent-first (the 2026-07-24 rethink): it says what ASLite IS (a cognitive
 *     ecosystem for agents), WHY it is valuable (the problems it solves; long-horizon work),
 *     that it is used THROUGH agents with this window as the human's insight surface, and it
 *     hands the reader example view-building prompts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BRIDGE_BADGES,
  Launcher,
  MAX_SHARING_REFRESH_DELAY_MS,
  MIN_SHARING_REFRESH_DELAY_MS,
  orientationStorageKey,
  sharingChip,
  sharingRefreshDelay,
} from "./Launcher.js";
import { fetchConfig, listPages, type SharingSummary, type UiConfig } from "../api/pages.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BUNDLE_ROOT = "/tmp/bundle";
/**
 * The canonical View-authoring vocabulary. ONE list, asserted in both directions: absent from the
 * empty state's first read, present once "learn more" is expanded. Editing either surface without
 * the other turns one of the two assertions red.
 */
const AUTHORING_JARGON = ["type: View", "type: Page", "views/", "examples/views/"] as const;
const BASE_CONFIG: UiConfig = { mode: "dir", remoteUrl: null, root: BUNDLE_ROOT, name: "bundle", sharing: null, workspaces: [] };

vi.mock("../api/pages.js", () => ({
  fetchConfig: vi.fn(async () => ({ mode: "dir", remoteUrl: null, root: "/tmp/bundle", name: "bundle", sharing: null, workspaces: [] })),
  listPages: vi.fn(async () => []),
  invalidateKinds: vi.fn(),
}));

vi.mock("../pages/pageEvents.js", () => ({
  subscribeToChanges: vi.fn(() => () => {}),
  subscribeToResync: vi.fn(() => () => {}),
}));

// The feed has its own suite (ActivityFeed.test.tsx); the Launcher tests pin the shell around it.
vi.mock("./ActivityFeed.js", () => ({
  ActivityFeed: () => null,
}));

// Likewise the document browser (DocumentBrowser.test.tsx) — stub it so the Launcher tests stay focused.
vi.mock("./DocumentBrowser.js", () => ({
  DocumentBrowser: () => null,
}));

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Deterministic localStorage stub — the runtime's own (Node webstorage/jsdom mix) is nonstandard under vitest. */
function stubLocalStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(window, "localStorage", { value: stub, configurable: true });
  return stub;
}

describe("home surface", () => {
  let container: HTMLDivElement;
  let root: Root;
  let storage: ReturnType<typeof stubLocalStorage>;

  beforeEach(() => {
    storage = stubLocalStorage();
    vi.mocked(listPages).mockReset();
    vi.mocked(listPages).mockResolvedValue([]);
    vi.mocked(fetchConfig).mockReset();
    vi.mocked(fetchConfig).mockResolvedValue({ ...BASE_CONFIG });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  async function render(): Promise<void> {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Launcher />
        </QueryClientProvider>,
      );
    });
    // Let the mocked queries settle (isPending -> resolved) before the callers assert.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await flush();
      });
    }
  }

  it("empty state is a short pointer to the agent ask — the orientation panels own the full Views explanation", async () => {
    storage.setItem(orientationStorageKey(BUNDLE_ROOT), "dismissed");
    await render();
    for (let i = 0; i < 50 && !container.querySelector(".launcher-empty"); i++) {
      await act(async () => {
        await flush();
      });
    }

    const empty = container.querySelector(".launcher-empty");
    expect(empty, "empty state must render when no views are registered").not.toBeNull();
    const text = empty!.textContent ?? "";
    // One route to getting a view: ask the agent in plain language. The WHAT lives in the
    // orientation walkthrough now, so the empty state stays a one-breath pointer.
    expect(text).toContain("Ask your agent");
    expect(text).toMatch(/create a view showing every open task/);
    // Authoring MECHANICS are deliberately absent from the FIRST read: a reader who has never
    // seen a view should not have to parse kind names or blob prefixes to understand it. They
    // live one click behind "learn more" — asserted below, so this is disclosure, not deletion.
    for (const jargon of AUTHORING_JARGON) {
      expect(text, `first read must stay free of "${jargon}"`).not.toContain(jargon);
    }
  });

  it("'learn more' discloses the authoring mechanics the first read withholds", async () => {
    storage.setItem(orientationStorageKey(BUNDLE_ROOT), "dismissed");
    await render();
    for (let i = 0; i < 50 && !container.querySelector(".launcher-empty"); i++) {
      await act(async () => {
        await flush();
      });
    }

    const empty = container.querySelector(".launcher-empty");
    const toggle = empty!.querySelector<HTMLButtonElement>("button.where-btn");
    expect(toggle, "empty state must offer a 'learn more' disclosure").not.toBeNull();
    // Collapsed by default — the whole point is that the mechanics are not the first thing read.
    expect(toggle!.textContent).toContain("learn more");
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    expect(empty!.querySelector(".launcher-empty-details")).toBeNull();

    await act(async () => {
      toggle!.click();
      await flush();
    });

    const details = empty!.querySelector(".launcher-empty-details");
    expect(details, "clicking 'learn more' must reveal the mechanics panel").not.toBeNull();
    const disclosed = details!.textContent ?? "";
    // Every term withheld from the first read is reachable here — the canonical authoring
    // vocabulary, with Page named only as the legacy form that keeps working.
    for (const jargon of AUTHORING_JARGON) {
      expect(disclosed, `"${jargon}" must be reachable behind 'learn more'`).toContain(jargon);
    }
    // All THREE capability modes, worded as the card badges word them. The panel used to describe
    // every view as live and read-only, which was false for `none` (denied all bundle data) and for
    // `bundle-propose` (may propose an edit) -- and contradicted the badges on the same screen.
    for (const badge of Object.values(BRIDGE_BADGES)) {
      expect(disclosed, `capability mode "${badge.label}" must be explained behind 'learn more'`).toContain(badge.label);
    }
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
    expect(toggle!.textContent).toContain("hide details");
  });

  it("renders ONE flat grid with capability badges — no Dashboards/Interactive/Documents sections", async () => {
    storage.setItem(orientationStorageKey(BUNDLE_ROOT), "dismissed");
    vi.mocked(listPages).mockResolvedValue([
      { id: "views-registry/board", version: "v1", title: "Board", bridge: "bundle-propose" },
      { id: "views-registry/pulse", version: "v1", title: "Pulse", bridge: "bundle-read" },
      { id: "views-registry/map", version: "v1", title: "Map", bridge: "none" },
    ]);
    await render();
    for (let i = 0; i < 50 && container.querySelectorAll(".launcher-card").length < 3; i++) {
      await act(async () => {
        await flush();
      });
    }

    // The old capability-section headings are gone…
    const headings = [...container.querySelectorAll("h3")].map((h) => h.textContent);
    for (const retired of ["Dashboards", "Interactive", "Documents"]) {
      expect(headings, `retired section heading '${retired}' must not render`).not.toContain(retired);
    }
    // …one grid holds every card, in listPages order (recency — the API sorts)…
    const grids = container.querySelectorAll(".launcher-grid");
    expect(grids).toHaveLength(1);
    const cardIds = [...grids[0]!.querySelectorAll(".launcher-card")].map((c) => c.getAttribute("data-page-id"));
    expect(cardIds).toEqual(["views-registry/board", "views-registry/pulse", "views-registry/map"]);
    // …and capability renders as the role-worded badge.
    const badges = [...container.querySelectorAll(".launcher-card .badge")].map((b) => b.textContent);
    expect(badges).toEqual(["can edit", "live data", "artifact"]);
  });

  it("first-run orientation is a 4-panel walkthrough: Back/Next navigation, Got it only at the end, dismissal persists", async () => {
    await render();
    for (let i = 0; i < 50 && !container.querySelector(".orientation"); i++) {
      await act(async () => {
        await flush();
      });
    }

    const orientation = () => container.querySelector(".orientation");
    const panelText = () => orientation()!.textContent ?? "";
    const clickNext = async () => {
      await act(async () => {
        (orientation()!.querySelector(".orientation-next") as HTMLButtonElement).click();
        await flush();
      });
    };
    expect(orientation(), "first run must render the orientation").not.toBeNull();

    // Panel 1 — what ASLite IS, and WHY it is valuable (the ratchet in plain words: settled work
    // is a floor, not something re-derived — Derfer & Collier 2026). No Back, no Got it yet.
    const panel1 = panelText();
    expect(panel1).toContain("What is agentstate-lite?");
    expect(panel1).toContain("cognitive ecosystem");
    expect(panel1).toContain("folder of plain markdown");
    expect(panel1).toContain("What problems does it solve?");
    expect(panel1).toContain("forget important information between sessions");
    expect(panel1).toMatch(/ratchets forward instead of slipping back/);
    expect(panel1).toMatch(/becomes the floor the next one builds on/);
    expect(panel1).toMatch(/span days, sessions, and many agents/);
    expect(panel1).toContain("1 of 4");
    expect(orientation()!.querySelector(".orientation-dismiss"), "Got it only on the last panel").toBeNull();
    expect(panel1).not.toContain("Back");
    // designs/home-surface: orient without OKF jargon — the standard lives behind "learn more".
    expect(panel1, "first read must orient without OKF jargon (designs/home-surface)").not.toContain("OKF");
    const learnMore = orientation()!.querySelector<HTMLButtonElement>("button.where-btn");
    expect(learnMore, "panel 1 must offer a 'learn more' disclosure").not.toBeNull();
    expect(orientation()!.querySelector(".orientation-details"), "collapsed by default").toBeNull();
    await act(async () => {
      learnMore!.click();
      await flush();
    });
    const okfPanel = orientation()!.querySelector(".orientation-details");
    expect(okfPanel, "clicking 'learn more' must reveal the standard").not.toBeNull();
    expect(okfPanel!.textContent ?? "").toContain("OKF");

    // Panel 2 — HOW it is used: agents are the primary users; install commands connect one.
    await clickNext();
    const panel2 = panelText();
    expect(panel2).toContain("How do I use ASLite?");
    expect(panel2).toContain("agents are the main users");
    expect(panel2).toContain("built by agents, for agents");
    expect(panel2).toContain("ask your agent to install the ASLite skill and hooks");
    expect(panel2).toContain("2 of 4");
    expect(orientation()!.querySelector(".orientation-dismiss")).toBeNull();

    // Back returns to panel 1, Next comes back.
    await act(async () => {
      (orientation()!.querySelector(".orientation-nav-btn") as HTMLButtonElement).click();
      await flush();
    });
    expect(panelText()).toContain("What is agentstate-lite?");
    await clickNext();
    await clickNext();

    // Panel 3 — Views examples + the Recipes subsection (how the bundle learns new document types).
    const panel3 = panelText();
    expect(panel3).toContain("Views");
    const examples = orientation()!.querySelector(".orientation-examples");
    expect(examples, "panel 3 must list example view prompts").not.toBeNull();
    expect(examples!.querySelectorAll("li").length).toBeGreaterThanOrEqual(3);
    expect(examples!.textContent).toMatch(/all tasks that have not been completed/i);
    expect(panel3).toContain("Recipes");
    // Flexibility first (own document types / relationships / views), then recipes as the
    // reusable, sharable packaging of that flexibility.
    expect(panel3).toContain("your own document types");
    expect(panel3).toContain("relationships");
    expect(panel3).toContain("share with others");
    expect(panel3).toMatch(/set this project up for task tracking/i);
    expect(panel3).toMatch(/suggest a recipe/i);
    expect(panel3).toContain("3 of 4");
    expect(orientation()!.querySelector(".orientation-dismiss")).toBeNull();

    // Panel 4 — Collaborating with others: how sync works today (the privacy promise, worded to
    // cover the in-tree mode: chip and promise must never contradict) + the try-it hook.
    await clickNext();
    const panel4 = panelText();
    expect(panel4).toContain("Collaborating with others");
    expect(panel4).toMatch(/stays local until you choose to share it/i);
    expect(panel4).toContain("ask your agent to");
    expect(panel4).toContain("publishes the bundle onto its own");
    // Public-repo awareness: sharing inherits the repo's visibility — stated as a consideration
    // (open-by-design can be a feature), never buried, never alarmist.
    expect(panel4).toContain("as visible as the repository that carries it");
    expect(panel4).toContain("part of the project’s public record");
    expect(panel4).toContain("committing the folder with your code");
    // The closing CTA wraps the TOUR, not the sharing section (visually separated, "That's the
    // tour" framing) — so it cannot read as "try syncing".
    expect(panel4).toContain("That’s the tour.");
    expect(panel4).toContain("ask your agent to write something down");
    expect(orientation()!.querySelector(".orientation-close"), "closing CTA must be its own separated block").not.toBeNull();
    expect(panel4).toContain("4 of 4");
    expect(orientation()!.querySelector(".orientation-next"), "no Next past the last panel").toBeNull();

    // Global copy rules hold across the WHOLE walkthrough, not just one panel.
    const all = panel1 + panel2 + panel3 + panel4;
    expect(all).not.toMatch(/works from any terminal/i);
    expect(all).not.toContain('new "Context Note"');
    // Never advertise the UNSCOPED npm coordinate: `aslite` is not ours (404 on the registry),
    // so a copy-pasted `npx -y aslite …` runs whatever lands on that name. Ours is @holaxis/aslite.
    expect(all).not.toMatch(/npx\s+-y\s+aslite\b/);
    // No paste-ready bare CLI invocations anywhere in the walkthrough; actions stay
    // agent-mediated and mechanics are described without commands.
    expect(all).not.toMatch(/aslite (skill|hook|recipes|recipe|sync)\b/);

    // The second click of a double-click on the nav slot (detail 2 — React reuses Next's DOM
    // node as Got it) must never dismiss.
    await act(async () => {
      container
        .querySelector(".orientation-dismiss")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 2 }));
      await flush();
    });
    expect(container.querySelector(".orientation"), "a double-click's trailing click must not dismiss").not.toBeNull();
    expect(storage.getItem(orientationStorageKey(BUNDLE_ROOT))).toBeNull();

    await act(async () => {
      (container.querySelector(".orientation-dismiss") as HTMLButtonElement).click();
      await flush();
    });
    expect(container.querySelector(".orientation"), "Got it hides the walkthrough").toBeNull();
    expect(storage.getItem(orientationStorageKey(BUNDLE_ROOT))).toBe("dismissed");
  });

  it("suppresses orientation when a stored dismissal exists", async () => {
    storage.setItem(orientationStorageKey(BUNDLE_ROOT), "dismissed");
    await render();
    await act(async () => {
      await flush();
    });
    expect(container.querySelector(".orientation")).toBeNull();
  });

  it("'what is this?' reopens the dismissed orientation — the overview stays reachable", async () => {
    storage.setItem(orientationStorageKey(BUNDLE_ROOT), "dismissed");
    await render();
    for (let i = 0; i < 50 && !container.querySelector(".about-btn"); i++) {
      await act(async () => {
        await flush();
      });
    }

    const about = container.querySelector<HTMLButtonElement>(".about-btn");
    expect(about, "a dismissed orientation must leave a 'what is this?' way back").not.toBeNull();
    expect(about!.textContent).toContain("what is this?");
    expect(container.querySelector(".orientation")).toBeNull();

    await act(async () => {
      about!.click();
      await flush();
    });
    const orientation = container.querySelector(".orientation");
    expect(orientation, "'what is this?' must reopen the orientation").not.toBeNull();
    // Reopening starts the walkthrough over at panel 1.
    expect(orientation!.textContent).toContain("What is agentstate-lite?");
    // The affordance yields to the open card (one copy of the overview on screen at a time).
    expect(container.querySelector(".about-btn")).toBeNull();

    // Got it lives on the last panel — walk forward to reach it.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        (container.querySelector(".orientation-next") as HTMLButtonElement).click();
        await flush();
      });
    }
    await act(async () => {
      (container.querySelector(".orientation-dismiss") as HTMLButtonElement).click();
      await flush();
    });
    expect(container.querySelector(".orientation"), "Got it closes the reopened card").toBeNull();
    expect(container.querySelector(".about-btn"), "…and the way back returns").not.toBeNull();
    expect(storage.getItem(orientationStorageKey(BUNDLE_ROOT))).toBe("dismissed");

    // A SECOND reopen starts over at panel 1 — pins dismissOrientation's step reset, which is the
    // only guard after an in-session reopen→dismiss cycle.
    await act(async () => {
      (container.querySelector(".about-btn") as HTMLButtonElement).click();
      await flush();
    });
    expect(container.querySelector(".orientation")!.textContent).toContain("What is agentstate-lite?");
  });

  it("never shows local privacy onboarding in remote mode, even when config.root carries the remote URL", async () => {
    vi.mocked(fetchConfig).mockResolvedValue({
      ...BASE_CONFIG,
      mode: "remote",
      remoteUrl: "https://host.example",
      root: "https://host.example",
      sharing: { kind: "hosted", remote: "host.example", as_of: "2026-07-21T12:00:00.000Z" },
    });
    await render();
    // The remote exception IS badged up front.
    expect(container.querySelector(".launcher-meta .pill")?.textContent).toBe("remote");
    expect(container.querySelector(".orientation")).toBeNull();
    // The reopen affordance is gated with the orientation itself — its copy makes the same
    // local-bundle privacy promise, so remote mode gets neither.
    expect(container.querySelector(".about-btn")).toBeNull();

    await act(async () => {
      (container.querySelector(".where-btn") as HTMLButtonElement).click();
      await flush();
    });
    expect(container.querySelector(".where-panel")?.textContent).toContain("https://host.example");
  });

  it("refetches sharing config at evidence expiry without an SSE document event", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-07-21T12:00:00.000Z");
    vi.setSystemTime(startedAt);
    let calls = 0;
    vi.mocked(fetchConfig).mockImplementation(async () => {
      calls += 1;
      return {
        ...BASE_CONFIG,
        sharing: {
          kind: calls === 1 ? "private" : "shared_branch",
          remote: calls === 1 ? undefined : "org/repo",
          as_of: new Date(Date.now()).toISOString(),
          refresh_after_ms: 1_000,
        },
      };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Launcher />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
      });
    }
    expect(calls).toBe(1);
    expect(container.querySelector(".chip")?.textContent).toBe("private — this computer only");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(calls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
      });
    }
    expect(calls).toBe(2);
    expect(client.getQueryData<UiConfig>(["ui-config"])?.sharing?.kind).toBe("shared_branch");
  });

  it("renders the sharing chip and the where-panel behind the disclosure (path no longer up front)", async () => {
    storage.setItem(orientationStorageKey(BUNDLE_ROOT), "dismissed");
    vi.mocked(fetchConfig).mockResolvedValue({
      ...BASE_CONFIG,
      sharing: { kind: "shared_branch", remote: "org/repo", as_of: "2026-07-21T12:00:00.000Z" },
    });
    await render();
    for (let i = 0; i < 50 && !container.querySelector(".chip"); i++) {
      await act(async () => {
        await flush();
      });
    }

    // The chip is up front; the raw path is NOT (progressive disclosure), and dir mode — the
    // default experience — carries no mode pill (only the remote exception gets a badge).
    expect(container.querySelector(".launcher-meta .pill")).toBeNull();
    expect(container.querySelector(".chip")!.textContent).toBe("shared · org/repo");
    expect(container.querySelector(".launcher-meta")!.textContent).not.toContain(BUNDLE_ROOT);
    expect(container.querySelector(".where-panel")).toBeNull();

    await act(async () => {
      (container.querySelector(".where-btn") as HTMLButtonElement).click();
      await flush();
    });
    const panel = container.querySelector(".where-panel");
    expect(panel, "the disclosure opens the panel").not.toBeNull();
    expect(panel!.textContent).toContain(BUNDLE_ROOT);
    expect(panel!.textContent).toContain("dedicated board branch");
  });

  it("workspaces block is COLLAPSED by default; expanding reveals rows, then per-row paths", async () => {
    storage.setItem(orientationStorageKey(BUNDLE_ROOT), "dismissed");
    vi.mocked(fetchConfig).mockResolvedValue({
      ...BASE_CONFIG,
      workspaces: [
        { label: "here", path: BUNDLE_ROOT, open: true },
        { label: "other", path: "/tmp/other", open: false },
      ],
    });
    await render();
    for (let i = 0; i < 50 && !container.querySelector(".workspaces-toggle"); i++) {
      await act(async () => {
        await flush();
      });
    }

    const toggle = container.querySelector(".workspaces-toggle") as HTMLButtonElement;
    expect(toggle.textContent).toContain("Workspaces (2)");
    expect(container.querySelector(".workspace-list"), "collapsed by default").toBeNull();

    await act(async () => {
      toggle.click();
      await flush();
    });
    expect(container.querySelectorAll(".workspace")).toHaveLength(2);
    expect(container.textContent).not.toContain("/tmp/other"); // paths stay behind the row expand

    await act(async () => {
      ([...container.querySelectorAll(".workspace-row")] as HTMLButtonElement[])
        .find((b) => b.textContent!.includes("other"))!
        .click();
      await flush();
    });
    expect(container.textContent).toContain("/tmp/other");
    expect(container.textContent).toContain("aslite ui --dir /tmp/other");
  });
});

describe("sharingChip truth table (the SPA owns the words; every state row pinned)", () => {
  const asOf = "2026-07-21T12:00:00.000Z";
  const rows: Array<[SharingSummary["kind"], string | undefined, string | null, string]> = [
    ["private", undefined, "private — this computer only", "chip chip-private"],
    ["private_local_branch", undefined, "private — local board branch, not yet shared", "chip chip-private"],
    ["private_intree_no_remote", undefined, "private — committed with code, no remote", "chip chip-private"],
    ["private_intree_not_pushed", undefined, "private — committed with code, not yet pushed", "chip chip-private"],
    ["shared_branch", "org/repo", "shared · org/repo", "chip chip-shared"],
    ["shared_intree", "org/repo", "shared with the code · org/repo", "chip chip-shared"],
    ["hosted", "host:1", "hosted · host:1", "chip chip-shared"],
    ["unavailable", undefined, "sharing status unavailable", "chip chip-unavailable"],
  ];

  for (const [kind, remote, text, className] of rows) {
    it(`${kind} → “${text}”`, () => {
      const chip = sharingChip({ kind, remote, as_of: asOf });
      expect(chip).not.toBeNull();
      expect(chip!.text).toBe(text);
      expect(chip!.className).toBe(className);
    });
  }

  it("unscoped and null make NO claim (no chip at all)", () => {
    expect(sharingChip({ kind: "unscoped", as_of: asOf })).toBeNull();
    expect(sharingChip(null)).toBeNull();
  });

  it("an unknown future kind refuses honestly instead of fabricating", () => {
    const chip = sharingChip({ kind: "surprise" as SharingSummary["kind"], as_of: asOf });
    expect(chip!.text).toBe("sharing status unavailable");
  });
});

describe("sharing config refresh scheduling", () => {
  const asOf = "2026-07-21T12:00:00.000Z";
  const now = Date.parse(asOf);
  const summary: SharingSummary = { kind: "private", as_of: asOf, refresh_after_ms: 30_000 };

  it("uses remaining evidence lifetime with a positive expired floor", () => {
    expect(sharingRefreshDelay(summary, now)).toBe(30_000);
    expect(sharingRefreshDelay(summary, now + 12_000)).toBe(18_000);
    expect(sharingRefreshDelay(summary, now + 30_000)).toBe(MIN_SHARING_REFRESH_DELAY_MS);
  });

  it("bounds malformed, future, and oversized timing inputs", () => {
    expect(sharingRefreshDelay({ ...summary, as_of: "not-a-date" }, now)).toBe(30_000);
    expect(sharingRefreshDelay({ ...summary, as_of: new Date(now + 60_000).toISOString() }, now)).toBe(30_000);
    expect(sharingRefreshDelay({ ...summary, refresh_after_ms: Number.POSITIVE_INFINITY }, now)).toBe(false);
    expect(sharingRefreshDelay({ ...summary, refresh_after_ms: 0 }, now)).toBe(false);
    expect(sharingRefreshDelay({ ...summary, refresh_after_ms: 60 * 60_000 }, now)).toBe(MAX_SHARING_REFRESH_DELAY_MS);
    expect(sharingRefreshDelay({ ...summary, refresh_after_ms: undefined }, now)).toBe(false);
  });

  it("honors every terminal interceptor state before scheduling", () => {
    expect(sharingRefreshDelay(summary, now, "ok")).toBe(30_000);
    for (const status of ["unauthorized", "rate_limited", "session_expired"] as const) {
      expect(sharingRefreshDelay(summary, now, status)).toBe(false);
    }
  });
});
