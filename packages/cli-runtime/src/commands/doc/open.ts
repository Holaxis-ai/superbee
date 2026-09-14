// `doc open <id>` is the terminal/browser counterpart to MCP `show_document`: it delegates to the
// existing trusted web DocPage and shared UI lifecycle rather than creating another renderer.
import { openDocumentUi, type UiCliDeps } from "../ui.js";

export async function docOpen(argv: string[], deps: Partial<UiCliDeps> = {}): Promise<void> {
  await openDocumentUi(argv, deps);
}
