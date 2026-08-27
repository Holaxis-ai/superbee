import path from "node:path";

/** Complete isolated profile for child CLI fixtures on POSIX and Windows. */
export function isolatedUserEnv(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    APPDATA: path.join(home, "AppData", "Roaming"),
    ...overrides,
  };
}
