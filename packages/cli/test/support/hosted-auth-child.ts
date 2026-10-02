// Child process for the cross-process refresh test: waits for a start signal file, then asks for
// an access token once and prints the outcome as one JSON line.
import { existsSync } from "node:fs";

import { resolveHostedTarget } from "../../src/hosted-auth/discovery.js";
import { defaultHostedAuthDeps, ensureHostedAccessToken } from "../../src/hosted-auth/session.js";

const [home, host, startSignal] = process.argv.slice(2) as [string, string, string];
while (!existsSync(startSignal)) await new Promise((resolve) => setTimeout(resolve, 5));
try {
  const token = await ensureHostedAccessToken(resolveHostedTarget(host), {}, defaultHostedAuthDeps(home));
  process.stdout.write(`${JSON.stringify({ ok: true, source: token.source, token: token.accessToken })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: (error as { code?: string }).code, message: String((error as Error).message) })}\n`);
}
