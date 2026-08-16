import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  RegisteredTool,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AnySchema,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
  ListToolsRequestSchema,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";

export const MCP_JSON_SCHEMA_DIALECT =
  "https://json-schema.org/draft/2020-12/schema";

type ToolConfig<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema,
> = {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};

function advertisedSchema(
  schema: AnySchema,
  io: "input" | "output",
): ReturnType<typeof toJsonSchemaCompat> {
  return toJsonSchemaCompat(schema, {
    target: "draft-2020-12",
    strictUnions: true,
    pipeStrategy: io,
  });
}

/**
 * The MCP SDK 1.x high-level server advertises Zod schemas as draft-07 and does not expose its
 * supported 2020-12 target. Keep its registration, parsing, and tool-call authority; replace only
 * the tools/list projection at this one server boundary.
 */
export class McpServer202012 extends McpServer {
  override registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: ToolConfig<OutputArgs, InputArgs>,
    callback: ToolCallback<InputArgs>,
  ): RegisteredTool {
    const tool = super.registerTool(name, config, callback);
    const update = tool.update.bind(tool);
    tool.update = ((updates) => {
      update(updates);
      if (typeof updates.name === "undefined") return;
      for (const [registeredName, registeredTool] of Object.entries(this.#registeredTools())) {
        if (registeredTool === tool && registeredName !== updates.name) {
          delete this.#registeredTools()[registeredName];
        }
      }
    }) as RegisteredTool["update"];
    this.#installToolListProjection();
    return tool;
  }

  #registeredTools(): Record<string, RegisteredTool> {
    // McpServer exposes neither its registry nor a tools/list projection hook. Keep this temporary
    // SDK-private dependency isolated here; the inventory/lifecycle tests fail if that shape moves.
    return (this as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;
  }

  #installToolListProjection(): void {
    this.server.removeRequestHandler("tools/list");
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: Object.entries(this.#registeredTools())
        .filter(([, tool]) => tool.enabled)
        .map(([name, tool]) => ({
          name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema
            ? advertisedSchema(tool.inputSchema, "input")
            : {
                $schema: MCP_JSON_SCHEMA_DIALECT,
                type: "object" as const,
                properties: {},
                additionalProperties: false,
              },
          ...(tool.outputSchema
            ? { outputSchema: advertisedSchema(tool.outputSchema, "output") }
            : {}),
          annotations: tool.annotations,
          execution: tool.execution,
          _meta: tool._meta,
        })),
    }));
  }
}
