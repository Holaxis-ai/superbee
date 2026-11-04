// Real-privilege rows: a second uid and a bind mount need root, which a scratch HOME cannot give.
// The CI runtime job runs on Linux with passwordless sudo and sets
// SUPERBEE_TEST_EXPECT_PRIVILEGED_LINUX=1. There the rows are never skipped, and a missing sudo
// fails the row loudly. Anywhere else (a Mac, a Linux box without sudo) they skip with a reason.
import { spawnSync } from "node:child_process";

export const PRIVILEGED_LINUX_VARIABLE = "SUPERBEE_TEST_EXPECT_PRIVILEGED_LINUX";

export function privilegedLinuxRequired(): boolean {
  return process.env[PRIVILEGED_LINUX_VARIABLE] === "1";
}

/** Skip reason for a row that needs root on Linux; undefined when the row must run. */
export function privilegedLinuxSkip(): string | undefined {
  if (privilegedLinuxRequired()) return undefined;
  if (process.platform !== "linux") {
    return `needs Linux with passwordless sudo (this host is ${process.platform}); CI sets ${PRIVILEGED_LINUX_VARIABLE}=1 and runs it`;
  }
  const probe = spawnSync("sudo", ["-n", "true"], { stdio: "ignore" });
  return probe.status === 0
    ? undefined
    : `needs passwordless sudo, which this host lacks; CI sets ${PRIVILEGED_LINUX_VARIABLE}=1 and runs it`;
}

/** Run one command as root. Throws with the command's stderr, so a row never passes on a failed setup. */
export function sudo(args: readonly string[]): void {
  const result = spawnSync("sudo", ["-n", ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`sudo ${args.join(" ")} failed (${result.status ?? result.error?.message}): ${result.stderr}`);
  }
}

/** Hand a tree back to the running user so ordinary cleanup works. */
export function reclaim(target: string): void {
  sudo(["chown", "-R", `${process.getuid?.()}:${process.getgid?.()}`, target]);
}
