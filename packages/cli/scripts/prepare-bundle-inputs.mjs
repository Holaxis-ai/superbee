// Generate every source module consumed by the self-contained npm CLI bundle.
import { buildMcpViewHtml } from "../../mcp-app/scripts/build-view.mjs";
import { embedUiAssets } from "./embed-ui-assets.mjs";

export async function prepareCliBundleInputs() {
  embedUiAssets();
  await buildMcpViewHtml();
}
