// Build the `packages/ui` SPA fresh, then embed its dist/ as deterministic gzip bytes into a
// generated TypeScript source module the CLI's esbuild bundle inlines (plans/ui-v1.md rev 3.2
// "Asset shipping" / "Build ordering"). Called from `build.mjs` BEFORE `buildCliBundle` — always
// rebuilding `packages/ui` here (rather than merely checking a staleness heuristic) is what
// makes "the CLI build FAILS FAST when packages/ui/dist is missing or stale" trivially true: it
// can never be stale, because this step just produced it, in THIS SAME invocation, for the
// root build, `npm run build -w superbee`, and the release workflow alike (all three run
// `packages/cli/build.mjs`, which calls this first).
//
// Determinism: files are walked in a stable sorted order, and each is gzipped with the
// exact-version-pinned pure-JS compressor
// `pako` (packages/cli devDependency) — NOT `node:zlib`, whose DEFLATE output varies across zlib
// (i.e. Node) versions for identical input, which made the built CLI's bytes depend on
// which Node built it (a node-25 machine produced different gzip streams than CI's node-20 for
// byte-identical uncompressed assets). The gzip header's MTIME field (RFC 1952 bytes 4-7) and OS
// byte (byte 9) are still normalized. Decompression is format-standard, so the RUNTIME keeps
// using `node:zlib`'s gunzip (packages/ui-server/src/assets.ts) — pako is build-time only, never bundled.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzip as pakoGzip } from "pako";

const here = dirname(fileURLToPath(import.meta.url));
// packages/cli/scripts -> packages/cli
const cliRoot = resolve(here, "..");
// packages/cli -> repo root
const repoRoot = resolve(cliRoot, "../..");
const uiDist = resolve(cliRoot, "../ui/dist");
const generatedDir = resolve(cliRoot, "src/generated");
const generatedFile = join(generatedDir, "ui-assets.generated.ts");

/** ≤ 400 KB gzipped total (rev 3.2) — the graph renderer (phase C) is the recorded heavy tail; the chips fallback is the escape hatch if it slips this budget. */
export const UI_ASSET_BUDGET_BYTES = 400 * 1024;

const CONTENT_TYPES = [
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".mjs", "application/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".txt", "text/plain; charset=utf-8"],
];

function guessContentType(path) {
  const match = CONTENT_TYPES.find(([ext]) => path.endsWith(ext));
  return match ? match[1] : "application/octet-stream";
}

/** Gzip `buf` deterministically via the pinned pako compressor (machine/runtime-independent bytes), then normalize the header's MTIME + OS fields so identical input bytes always produce identical output regardless of when/where the build runs. */
function gzipDeterministic(buf) {
  const gz = Buffer.from(pakoGzip(buf, { level: 9 }));
  gz[4] = 0;
  gz[5] = 0;
  gz[6] = 0;
  gz[7] = 0;
  gz[9] = 0xff; // OS = unknown
  return gz;
}

/** All files under `dir`, recursively, in a stable (locale-sorted, depth-first) order. */
function walk(dir) {
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function npmInvocation(args, env = process.env) {
  const npmCli = env.npm_execpath?.trim();
  if (!npmCli) {
    throw new Error("npm_execpath is required; run the build through an npm script");
  }
  return { command: process.execPath, args: [npmCli, ...args] };
}

/** Sibling workspaces whose `dist/` the packages/ui PRODUCTION build resolves through package
 * exports (`@superbee/core/kinds`, `@superbee/view-runtime/action-bridge`), IN build
 * order — core first, because view-runtime's own tsc consumes core's dist types. npm does NOT
 * build a workspace's deps on a single-workspace build, so on a fresh checkout (the CI
 * a fresh single-workspace `npm ci` state) these dists don't exist and Vite's build fails to resolve
 * the imports. markdown-renderer is covered by packages/ui's own `prebuild` and stays out of this
 * list. */
export const UI_DIST_PREREQUISITE_WORKSPACES = [
  "@superbee/core",
  "@superbee/view-runtime",
];

/** Rebuild `packages/ui`'s dist/ fresh via its own workspace script, building the sibling dists it
 * resolves FIRST (see UI_DIST_PREREQUISITE_WORKSPACES). Callers that go through root
 * `npm run build` get this ordering for free. Keeping this step self-sufficient also makes direct
 * package builds correct.
 * Throws (uncaught, `execFileSync`'s default) — and so fails this whole build immediately — on any
 * build error, e.g. a TypeScript or Vite failure. */
function buildUiDist() {
  for (const workspace of [...UI_DIST_PREREQUISITE_WORKSPACES, "@superbee/ui"]) {
    const invocation = npmInvocation(["run", "build", `--workspace=${workspace}`]);
    execFileSync(invocation.command, invocation.args, {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
}

/** Build the ui SPA fresh, embed its dist/ as deterministic gzip, write the generated module, and enforce the size budget. Returns `{ count, totalGzipBytes }`. */
export function embedUiAssets() {
  buildUiDist();

  const files = walk(uiDist);
  let totalGzipBytes = 0;
  const entries = [];
  for (const file of files) {
    const relPath = "/" + relative(uiDist, file).split(sep).join("/");
    const raw = readFileSync(file);
    const gz = gzipDeterministic(raw);
    totalGzipBytes += gz.length;
    entries.push({ path: relPath, contentType: guessContentType(relPath), gzipBase64: gz.toString("base64") });
  }

  if (totalGzipBytes > UI_ASSET_BUDGET_BYTES) {
    console.error(
      `ui asset budget exceeded: ${totalGzipBytes} bytes gzipped > ${UI_ASSET_BUDGET_BYTES} byte budget (packages/cli/scripts/embed-ui-assets.mjs)`,
    );
    process.exit(1);
  }

  mkdirSync(generatedDir, { recursive: true });
  const body = entries
    .map((e) => `  ${JSON.stringify(e.path)}: { contentType: ${JSON.stringify(e.contentType)}, gzipBase64: ${JSON.stringify(e.gzipBase64)} },`)
    .join("\n");
  const source = `// AUTO-GENERATED by packages/cli/scripts/embed-ui-assets.mjs — DO NOT EDIT BY HAND.
//
// Regenerated fresh from a \`packages/ui\` build on every \`packages/cli/build.mjs\` run (never
// committed — gitignored like every other package's \`dist/\`). \`src/ui/assets.ts\` is the CLI-owned
// adapter that injects this table into the ui-server runtime. See that script's module doc for the
// determinism discipline (stable file order, zeroed gzip MTIME/OS header fields).

export interface EmbeddedAsset {
  contentType: string;
  /** Deterministically gzipped bytes (mtime/OS header fields zeroed), base64-encoded. */
  gzipBase64: string;
}

export const UI_ASSETS: Record<string, EmbeddedAsset> = {
${body}
};

export const UI_ASSETS_GZIP_BYTES = ${totalGzipBytes};
`;
  writeFileSync(generatedFile, source);
  console.log(`embedded ${entries.length} ui asset(s), ${totalGzipBytes} bytes gzipped (budget ${UI_ASSET_BUDGET_BYTES})`);
  return { count: entries.length, totalGzipBytes };
}
