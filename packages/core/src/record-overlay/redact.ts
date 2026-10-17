// Provider URLs may carry credentials in userinfo or query parameters; no Signal echoes them.
const SECRET_PARAM = /^(token|access_token|api[_-]?key|key|secret|signature|sig|auth|password|pass|apikey|client_secret|session)$/i;

export function redactUrl(raw: string): string;
export function redactUrl(raw: unknown): unknown;
export function redactUrl(raw: unknown): unknown {
  if (typeof raw !== "string" || raw === "") return raw;
  let u: URL;
  try { u = new URL(raw); } catch { return raw; }
  let changed = false;
  if (u.username || u.password) { u.username = ""; u.password = ""; changed = true; }
  for (const k of [...u.searchParams.keys()]) {
    if (SECRET_PARAM.test(k)) { u.searchParams.set(k, "REDACTED"); changed = true; }
  }
  return changed ? u.toString() : raw;
}
