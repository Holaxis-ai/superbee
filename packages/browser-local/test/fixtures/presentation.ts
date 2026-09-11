/**
 * The proof presentation: one plain DOM surface over a {@link PlatformRuntime} and nothing
 * else. It imports only the platform contract's types and helpers and receives the runtime
 * object it renders. It keys nothing on the mode name: the affordances it exposes as data
 * attributes follow the capability booleans (`offlineCommits`, `localPersistence`), and the
 * mode name appears only where the contract returns it as a field of `syncStatus`, printed
 * with the rest of the status line. What it shows is exactly what the contract returns: a
 * document list from `query`, one selected document with its body, an edit box wired to
 * `commit`, a provenance badge per document from the result's own provenance, a status line
 * from `syncStatus`, and a sync button. Deliberately unstyled; it is a proof surface, not a
 * product.
 */

import { provenanceLabel, type PlatformQueryRow, type PlatformRuntime, type PlatformSyncStatus, type Provenance } from "@superbee/core/platform";

export interface Presentation {
  root: HTMLElement;
  /** Re-query the list, re-read the selection, and refresh the status line. */
  refresh(): Promise<void>;
  select(id: string): Promise<void>;
  /** Commit the edit box over the selected document at the version shown. */
  commit(): Promise<void>;
  sync(): Promise<void>;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, role: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.dataset.role = role;
  if (text) node.textContent = text;
  return node;
}

function statusLine(status: PlatformSyncStatus): string {
  const fields = [
    `mode=${status.mode}`,
    `online=${status.online === null ? "unknown" : String(status.online)}`,
    `pending=${status.pending}`,
    `conflicts=${status.conflicts}`,
    `refused=${status.refused}`,
    `unconfirmed=${status.unconfirmed}`,
    `paused=${status.paused}`,
    `complete=${status.complete}`,
  ];
  if (status.pausedReason) fields.push(`reason=${status.pausedReason}`);
  // The sync's own outcome, kept apart from `online`: a sync the authority answered with a
  // refusal or a malformed listing is a failed sync on a reachable carrier.
  fields.push(`lastSync=${status.lastSync === undefined ? "none" : status.lastSync.ok ? "ok" : "failed"}`);
  if (status.lastSync?.error) fields.push(`lastSyncError=${status.lastSync.error}`);
  if (status.lastSync?.refusedDeletions) fields.push(`refusedDeletions=${status.lastSync.refusedDeletions.deletions}`);
  return fields.join(" ");
}

export function mountPresentation(container: HTMLElement, runtime: PlatformRuntime): Presentation {
  const capabilities = runtime.capabilities();
  const root = element("section", "presentation");
  root.dataset.offlineCommits = String(capabilities.offlineCommits);
  root.dataset.localPersistence = String(capabilities.localPersistence);
  const caps = element("p", "capabilities", `offlineCommits=${capabilities.offlineCommits} localPersistence=${capabilities.localPersistence}`);
  const list = element("ul", "list");
  const article = element("article", "document");
  const heading = element("h2", "heading", "(nothing selected)");
  const badge = element("span", "badge");
  const body = element("pre", "body");
  article.append(heading, badge, body);
  const editor = element("textarea", "editor");
  const commitButton = element("button", "commit", "Commit");
  const syncButton = element("button", "sync", "Sync");
  const status = element("p", "status");
  const error = element("p", "error");
  root.append(caps, list, article, editor, commitButton, syncButton, status, error);
  container.append(root);

  let selected: { id: string; provenance: Provenance } | null = null;

  const showError = (failure: unknown): void => {
    const err = failure as { name?: unknown; message?: unknown };
    error.textContent = `${typeof err?.name === "string" ? err.name : "Error"}: ${typeof err?.message === "string" ? err.message : String(failure)}`;
  };

  const renderList = (rows: PlatformQueryRow[]): void => {
    list.replaceChildren();
    for (const row of rows) {
      const item = document.createElement("li");
      item.dataset.id = row.id;
      item.dataset.provenance = provenanceLabel(row.provenance);
      const pick = document.createElement("button");
      pick.dataset.role = "pick";
      pick.textContent = row.id;
      pick.addEventListener("click", () => {
        void presentation.select(row.id);
      });
      const rowBadge = element("span", "badge", provenanceLabel(row.provenance));
      item.append(pick, rowBadge);
      list.append(item);
    }
  };

  const renderSelected = async (): Promise<void> => {
    if (!selected) return;
    const result = await runtime.read(selected.id);
    selected = { id: result.doc.id, provenance: result.provenance };
    heading.textContent = result.doc.id;
    article.dataset.id = result.doc.id;
    article.dataset.provenance = provenanceLabel(result.provenance);
    badge.textContent = provenanceLabel(result.provenance);
    body.textContent = result.doc.body;
  };

  /**
   * Re-query, re-read, and reprint the status line. A caller that has just shown an error
   * (a failed sync) renders with `keepError`, so the message survives the redraw and the
   * status line beside it says `lastSync=failed`; a plain refresh starts from a clean line.
   */
  const render = async (keepError: boolean): Promise<void> => {
    if (!keepError) error.textContent = "";
    try {
      renderList(await runtime.query());
      await renderSelected();
    } catch (failure) {
      showError(failure);
    }
    // Last, so the line reports what the list and selection just learned about the authority.
    status.textContent = statusLine(await runtime.syncStatus());
  };

  const presentation: Presentation = {
    root,
    refresh: () => render(false),
    async select(id) {
      error.textContent = "";
      try {
        const result = await runtime.read(id);
        selected = { id: result.doc.id, provenance: result.provenance };
        editor.value = result.doc.body;
        await renderSelected();
      } catch (failure) {
        showError(failure);
      }
    },
    async commit() {
      error.textContent = "";
      if (!selected) {
        showError(new Error("select a document first"));
        return;
      }
      try {
        await runtime.commit(selected.id, { body: editor.value, expectedVersion: selected.provenance.version });
      } catch (failure) {
        showError(failure);
        status.textContent = statusLine(await runtime.syncStatus());
        return;
      }
      await presentation.refresh();
    },
    async sync() {
      error.textContent = "";
      let failed = false;
      try {
        status.textContent = statusLine(await runtime.sync());
      } catch (failure) {
        failed = true;
        showError(failure);
      }
      await render(failed);
    },
  };

  commitButton.addEventListener("click", () => {
    void presentation.commit();
  });
  syncButton.addEventListener("click", () => {
    void presentation.sync();
  });
  return presentation;
}
