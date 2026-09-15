/** Run with the existing test loader for a manually operable, disposable fixture page. */
import { startDriverServer } from "./harness.ts";
import { serveBodyFixture } from "./body-remote.ts";

const driver = await startDriverServer();
const authority = await serveBodyFixture();
console.log(`${driver.origin}/?bodyFixture=${encodeURIComponent(authority.origin)}&bodyStore=manual-body`);
const close = async () => { await authority.close(); await driver.close(); process.exit(0); };
process.on("SIGINT", () => { void close(); });
process.on("SIGTERM", () => { void close(); });
