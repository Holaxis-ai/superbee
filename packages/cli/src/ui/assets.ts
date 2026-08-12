// CLI adapter for the generated, gzip-embedded SPA table. The reusable server owns response
// behavior; the publishable CLI remains the only owner of its build-generated asset bytes.
import { createEmbeddedAssetHandler } from "@superbee/ui-server";
import { UI_ASSETS } from "../generated/ui-assets.generated.js";

export const serveEmbeddedUiAsset = createEmbeddedAssetHandler(UI_ASSETS);
