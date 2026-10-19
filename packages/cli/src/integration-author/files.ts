/** Read-only, bounded acquisition for author packages and recorded fixtures. */
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { containsCredentialText } from "@superbee/core/connectors";

export const AUTHOR_FILE_LIMITS = Object.freeze({ files: 512, depth: 12, fileBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 });

export interface AuthorDiagnostic { code: string; file: string; path: string; message: string }
export interface AuthorFile { path: string; bytes: string }
export type AuthorFolder = { ok: true; files: AuthorFile[] } | { ok: false; diagnostics: AuthorDiagnostic[] };

/** Diagnostics name locations, never file contents or exception messages. */
export function authorLocation(value: string): string {
  return containsCredentialText(value) ? "[redacted location]" : value.replace(/[\p{Cc}\p{Cf}]/gu, "?").slice(0, 512);
}

function diagnostic(code: string, file: string, message: string): AuthorDiagnostic {
  return { code, file: authorLocation(file), path: "", message };
}

const FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** Open one regular leaf, then read at most the bound from that same descriptor. */
async function readLeaf(file: string, limit: number): Promise<string | undefined> {
  const handle = await fs.open(file, FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return undefined;
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let used = 0;
    while (used < buffer.length) {
      const read = await handle.read(buffer, used, buffer.length - used, null);
      if (read.bytesRead === 0) break;
      used += read.bytesRead;
    }
    if (used > limit || used > stat.size) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used));
  } finally { await handle.close(); }
}

export async function readAuthorFolder(folder: string, options: { scanSecrets?: boolean; requiredFile?: "recipe.md" | "fixture.json" } = {}): Promise<AuthorFolder> {
  const files: AuthorFile[] = [];
  const diagnostics: AuthorDiagnostic[] = [];
  let root: string;
  let total = 0;
  let entriesSeen = 0;
  try {
    root = await fs.realpath(folder);
    if (!(await fs.stat(root)).isDirectory()) return { ok: false, diagnostics: [diagnostic("AUTHOR_FOLDER_INVALID", ".", "Expected a recipe or fixture directory.")] };
    // Recipe roots are selected explicitly, outside ordinary ingress. Require their manifest
    // before inventorying unrelated files (in particular a private-state directory is no recipe).
    if (options.requiredFile && !(await fs.lstat(path.join(root, options.requiredFile)).catch(() => null))?.isFile()) {
      return { ok: false, diagnostics: [diagnostic("AUTHOR_MANIFEST_MISSING", options.requiredFile, "The selected directory needs this regular manifest file before its contents can be inspected.")] };
    }
    async function walk(dir: string, rel: string, depth: number): Promise<void> {
      if (diagnostics.length) return;
      if (depth > AUTHOR_FILE_LIMITS.depth) { diagnostics.push(diagnostic("AUTHOR_FOLDER_LIMIT", rel, "Directory nesting exceeds the author-package bound.")); return; }
      const resolved = await fs.realpath(dir);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) { diagnostics.push(diagnostic("AUTHOR_UNSAFE_PATH", rel, "A directory leaves the author-package root.")); return; }
      for await (const entry of await fs.opendir(resolved)) {
        const relative = rel ? `${rel}/${entry.name}` : entry.name;
        if (++entriesSeen > AUTHOR_FILE_LIMITS.files) { diagnostics.push(diagnostic("AUTHOR_FOLDER_LIMIT", relative, "Too many entries in the author package.")); return; }
        const absolute = path.join(resolved, entry.name);
        // Author packages are immutable input, not links to additional ambient authority.
        if (entry.isSymbolicLink()) { diagnostics.push(diagnostic("AUTHOR_UNSAFE_PATH", relative, "Symbolic links are not accepted in author packages.")); return; }
        if (entry.name === ".git") { diagnostics.push(diagnostic("AUTHOR_UNSAFE_PATH", relative, "Select the recipe directory, not a repository root containing .git.")); return; }
        if (entry.isDirectory()) { await walk(absolute, relative, depth + 1); if (diagnostics.length) return; continue; }
        if (!entry.isFile()) { diagnostics.push(diagnostic("AUTHOR_UNSAFE_PATH", relative, "Only regular files and directories are accepted.")); return; }
        // Refuse credential containers without opening them; never ask the author to share these.
        if (entry.name === ".env" || entry.name.startsWith(".env.")) { diagnostics.push(diagnostic("CONNECTOR_SECRET_PRESENT", relative, "Credential environment files must not be distributed with a recipe.")); return; }
        const real = await fs.realpath(absolute);
        if (!real.startsWith(root + path.sep)) { diagnostics.push(diagnostic("AUTHOR_UNSAFE_PATH", relative, "A file leaves the author-package root.")); return; }
        const text = await readLeaf(real, Math.min(AUTHOR_FILE_LIMITS.fileBytes, AUTHOR_FILE_LIMITS.totalBytes - total));
        if (text === undefined) { diagnostics.push(diagnostic("AUTHOR_FILE_LIMIT", relative, "File is not regular UTF-8 text within the author-package bounds.")); return; }
        total += Buffer.byteLength(text);
        if ((options.scanSecrets !== false && containsCredentialText(text)) || containsCredentialText(relative)) { diagnostics.push(diagnostic("CONNECTOR_SECRET_PRESENT", relative, "Secret-shaped text is not accepted in a distributable author package.")); return; }
        files.push({ path: relative, bytes: text });
      }
    }
    await walk(root, "", 0);
  } catch {
    diagnostics.push(diagnostic("AUTHOR_INPUT_UNREADABLE", ".", "The author package could not be read as bounded UTF-8 files."));
  }
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
