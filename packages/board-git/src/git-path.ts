/** The lexical path operation used to adapt Git output to a caller's platform dialect. */
export interface GitPathDialect {
  normalize(path: string): string;
}

/**
 * Convert a Git-reported filesystem coordinate to the selected dialect's lexical spelling.
 * This does not access the filesystem and therefore makes no realpath or identity claim.
 */
export function normalizeGitLexicalPath(gitPath: string, dialect: GitPathDialect): string {
  return dialect.normalize(gitPath);
}
