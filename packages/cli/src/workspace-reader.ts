import { queryHeads, readDocVersioned } from "@superbee/core";
import { openBundle } from "./bundle.js";
import { assertSupportedCliHost } from "./posix-host.js";
import { createCatalogWorkspaceResolver, serveWorkspace } from "./workspace-resolver.js";

export interface WorkspaceDocumentHead {
  readonly id: string;
  readonly frontmatter: Readonly<Record<string, unknown>> & { readonly type: string };
  readonly version: string;
}

export interface WorkspaceDocument extends WorkspaceDocumentHead {
  readonly body: string;
}

export interface WorkspaceReader {
  readonly name: string;
  queryHeads(): Promise<readonly WorkspaceDocumentHead[]>;
  read(id: string): Promise<WorkspaceDocument>;
}

/** Select once. Each operation observes the selected working copy at the time of the call. */
export async function openWorkspaceReader(
  source: "catalog" | "directory",
  selector: string,
): Promise<WorkspaceReader> {
  assertSupportedCliHost();
  if (source !== "catalog" && source !== "directory") {
    throw new TypeError("workspace source must be catalog or directory");
  }
  if (typeof selector !== "string" || !selector.trim()) {
    throw new TypeError("a workspace selector is required");
  }
  const { bundle, name } = source === "catalog"
    ? await createCatalogWorkspaceResolver().open(selector)
    : await serveWorkspace(await openBundle(selector));
  return Object.freeze({
    name,
    queryHeads: () => queryHeads(bundle),
    async read(id: string) {
      const { doc, version } = await readDocVersioned(bundle, id);
      return { ...doc, version };
    },
  });
}
