/** The bundle-relative prefix a Kind convention doc must live under to be discovered. */
export const CONVENTIONS_PREFIX = "conventions/";

/** The exact OKF type of a Kind convention doc. */
export const CONVENTION_TYPE = "Convention";

/** Whether an ID is under the case-sensitive discovery prefix. */
export function isConventionId(id: string): boolean {
  return id.startsWith(CONVENTIONS_PREFIX);
}

/** Recognizes a convention record independently of whether it successfully declares a Kind. */
export function isConventionRecord(id: string, type: unknown): boolean {
  return type === CONVENTION_TYPE && isConventionId(id);
}
