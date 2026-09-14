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

/** Run an in-process fixture with the same complete isolated profile as child CLI fixtures. */
export async function withIsolatedUserEnv<T>(home: string, run: () => Promise<T>): Promise<T> {
  const keys = ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const isolated = isolatedUserEnv(home);
  for (const key of keys) process.env[key] = isolated[key];
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
