/** Lexical write identity rules, independent of transport and payload families. */
export function isWriteRequestId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
export function isWriteBinding(value: string): boolean { return /^sha256:[a-f0-9]{64}$/.test(value); }
export function isAgentLabelVia(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9._-]{1,32}$/.test(value) && !value.startsWith("superbee");
}
