/** Shared display formatting for the home surface (launcher + activity feed). */
import { parseIsoInstant } from "@superbee/core/verification";

/** Render an explicit instant in the browser's system timezone. Ambiguous imports stay literal. */
export function formatWhen(timestamp?: string): string | null {
  if (!timestamp) return null;
  const instant = parseIsoInstant(timestamp);
  if (instant === null) return timestamp;
  const d = new Date(instant);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}
