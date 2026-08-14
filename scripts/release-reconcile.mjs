// Thin CLI over the pure reconciler (scripts/release-state.mjs) so an OPERATOR can advance and
// VERIFY the staged-release ledger from immutable identifiers, failing closed (exit 1) on any
// illegal transition or contradicted identifier. It performs no build, no pack, no network — it
// only reconciles the receipt facts a prior step already fixed.
//
// NOTE: the workflows' runtime ordering gate consumes the SAME reconcile()/replay() authority
// through scripts/release-verify-ordering.mjs (signed operator receipts, tiered enforcement);
// this CLI remains the operator-side way to advance/verify a ledger by hand.
//
// Usage: node scripts/release-reconcile.mjs --to <state> --receipt <file|-> [--ledger <file|->]
import { readFile } from "node:fs/promises";
import { isMainModule } from "./is-main-module.mjs";
import { reconcile, ReleaseStateError } from "./release-state.mjs";

async function readSource(source) {
  if (!source) return null;
  const text = source === "-" ? await readStdin() : await readFile(source, "utf8");
  return text.trim() ? JSON.parse(text) : null;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function arg(argv, flag) {
  const at = argv.indexOf(flag);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
  return value;
}

if (await isMainModule(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const to = arg(argv, "--to");
    const receiptSrc = arg(argv, "--receipt");
    const ledgerSrc = arg(argv, "--ledger");
    if (!to || !receiptSrc) {
      throw new Error("usage: release-reconcile.mjs --to <state> --receipt <file|-> [--ledger <file|->]");
    }
    const ledger = (await readSource(ledgerSrc)) ?? { state: null, identifiers: {} };
    const receipt = await readSource(receiptSrc);
    if (!receipt) throw new Error("--receipt must contain a JSON receipt object");
    const result = reconcile(ledger, { to, receipt });
    console.log(JSON.stringify({ ...result.ledger, changed: result.changed }));
  } catch (error) {
    if (error instanceof ReleaseStateError) {
      console.error(JSON.stringify({ error: error.code, message: error.message }));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  }
}
