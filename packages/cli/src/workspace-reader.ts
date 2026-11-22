import { queryHeads, readDocVersioned } from "@superbee/core";
import { openPluginWorkspace } from "./workspace-resolver.js";

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
  const { bundle, name } = await openPluginWorkspace(source, selector);
  return Object.freeze({
    name,
    queryHeads: () => queryHeads(bundle),
    async read(id: string) {
      const { doc, version } = await readDocVersioned(bundle, id);
      return { ...doc, version };
    },
  });
}
