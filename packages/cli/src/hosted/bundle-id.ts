// A hosted bundle id as the CLI takes it: lower-case letters and digits joined by `.`, `_` or `-`,
// starting with a letter, at most 128 characters. The one rule `checkout`, `export` and `publish`
// accept an id by, and the one a printed `checkout <id>` command is emitted for: an id it rejects
// (one starting with `-` would read as an option) never appears in a command.
const BUNDLE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const BUNDLE_ID_MAX_LENGTH = 128;

export function isHostedBundleId(id: string): boolean {
  return id.length <= BUNDLE_ID_MAX_LENGTH && BUNDLE_ID.test(id);
}
