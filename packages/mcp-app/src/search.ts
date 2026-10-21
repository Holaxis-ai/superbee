import { versionOfBytes } from "@superbee/core";
import { backendFor } from "@superbee/core/bundle-ops";
import { SEARCH_MAX_OUTPUT_BYTES, searchSourceFromBackend, searchDocuments, validateSearchRequest, SearchInputError, SearchLimitError } from "@superbee/core/search";
import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpBundleContext, McpWorkspaceResolver } from "./workspace.js";

export const SEARCH_DOCUMENTS_TOOL_NAME = "search_documents";
const requestSchema = z.object({
  query: z.string(), match: z.enum(["auto", "all", "any"]).optional(),
  type: z.string().optional(), tag: z.string().optional(), prefix: z.string().optional(),
  limit: z.number().int().optional(), cursor: z.string().optional(),
  facets: z.array(z.enum(["type", "tags"])).optional(),
}).strict();

export function registerSearchTool(
  server: McpServer,
  selection: { resolver: McpWorkspaceResolver; selector: z.ZodString } | { context: McpBundleContext },
): void {
  const schema = "resolver" in selection
    ? requestSchema.extend({ workspace: selection.selector }).strict()
    : requestSchema;
  server.registerTool(SEARCH_DOCUMENTS_TOOL_NAME, {
    title: "Search Superbee documents",
    description: "Search current local document text, including unsent edits. Select an exact catalog workspace when required. Results use the core search contract; cursors require the same unchanged corpus and filters.",
    inputSchema: schema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input): Promise<CallToolResult> => {
    const { workspace, ...raw } = input as z.infer<typeof requestSchema> & { workspace?: string };
    try {
      const request = validateSearchRequest(raw);
      let context: McpBundleContext;
      if ("resolver" in selection) {
        try { context = await selection.resolver.open(workspace!); }
        catch { return { isError: true, content: [{ type: "text", text: "Could not open the selected workspace. Call list_workspaces and retry with an available exact ID or label." }] }; }
      } else context = selection.context;
      const source = await searchSourceFromBackend(backendFor(context.bundle));
      const result = await searchDocuments(source, request, { scope: versionOfBytes(context.bundle.root) }, undefined, { maxResultBytes: SEARCH_MAX_OUTPUT_BYTES });
      const text = JSON.stringify(result);
      const bytes = new TextEncoder().encode(text).byteLength;
      if (bytes > SEARCH_MAX_OUTPUT_BYTES) throw new SearchLimitError("maxResultBytes", SEARCH_MAX_OUTPUT_BYTES, bytes);
      return { content: [{ type: "text", text }], structuredContent: { ...result } };
    } catch (error) {
      const text = error instanceof SearchInputError || error instanceof SearchLimitError
        ? error.message : "Could not search the selected local corpus. Check that its documents are readable and retry.";
      return { isError: true, content: [{ type: "text", text }] };
    }
  });
}
