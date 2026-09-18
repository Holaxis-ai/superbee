// Generate every source module consumed by the self-contained npm CLI bundle. Returns the
// absolute paths each stage embedded, so the artifact's provenance record can name their workspaces.
import { buildMcpViewResources } from "../../mcp-app/scripts/build-view.mjs";
import { embedUiAssets } from "./embed-ui-assets.mjs";

export async function prepareCliBundleInputs({ compiledWorkspaces = [] } = {}) {
  const ui = embedUiAssets({ compiledWorkspaces });
  const mcp = await buildMcpViewResources();
  return { inputs: [...ui.inputs, ...mcp.inputs] };
}
