/** Time allowed for the current iframe generation to prove it loaded. */
export const VIEW_LOAD_DEADLINE_MS = 8_000;

/** One bounded retry covers the race between iframe load and the host recording delivery. */
export const VIEW_DELIVERY_RETRY_MS = 250;
