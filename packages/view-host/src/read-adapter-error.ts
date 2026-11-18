/** A read adapter's own refusal, apart from any schemas that raise it, so a module that only
 * recognizes it (the View bridge host) loads no schema library. An adapter that checks the shape of
 * an operation's result throws this class, so the host tells a malformed result (`RUNTIME`) from a
 * result-size ceiling (`TOO_LARGE`), which throws a plain `Error("invalid_response")`. */
export class ReadAdapterError extends Error {
  constructor(readonly code: "invalid_input" | "invalid_response") {
    super(code);
  }
}
