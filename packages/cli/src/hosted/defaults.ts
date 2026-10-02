// The default hosted workspace `superbee setup hosted` records: which of a person's workspaces on
// a host commands mean when they reach more than one and none is named. Private state, one record
// per machine user; the host it applies to is recorded with it, so another host never inherits it.
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { readUserStateFile, writeUserStateFileAtomic0600 } from "../user-state.js";
import { hostedAuthRoot } from "../hosted-auth/session.js";

const FILE = "default-workspace.json";

export interface DefaultWorkspace {
  /** The hosted origin the workspace belongs to. */
  readonly origin: string;
  readonly workspace: string;
}

export async function readDefaultWorkspace(home: string, origin: string): Promise<string | null> {
  const file = join(hostedAuthRoot(home), FILE);
  try {
    await lstat(file);
    const value = JSON.parse(await readUserStateFile(home, file, 4096)) as Partial<DefaultWorkspace> | null;
    return value?.origin === origin && typeof value.workspace === "string" ? value.workspace : null;
  } catch {
    return null;
  }
}

export async function writeDefaultWorkspace(home: string, value: DefaultWorkspace): Promise<void> {
  await writeUserStateFileAtomic0600(home, hostedAuthRoot(home), FILE, `${JSON.stringify(value)}\n`);
}
