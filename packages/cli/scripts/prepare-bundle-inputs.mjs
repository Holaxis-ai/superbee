// Generate every source module consumed by the self-contained npm CLI bundle. Returns the
// absolute paths each stage embedded, so the artifact's provenance record can name their workspaces,
// and the source modules compiled into those embedded bytes, so the distribution can ship their
// third-party notices.
import { embedUiAssets } from "./embed-ui-assets.mjs";

export async function prepareCliBundleInputs({ compiledWorkspaces = [] } = {}) {
  const ui = embedUiAssets({ compiledWorkspaces });
  return ui;
}
