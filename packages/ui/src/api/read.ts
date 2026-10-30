/** Bound idempotent reads through body consumption; mutation outcomes are never inferred from a timeout. */
export const READ_TIMEOUT_MS = 15_000;

export class ReadTimeoutError extends TypeError {
  constructor() {
    super("Superbee did not respond in time. Retry the read, or reopen this document from the CLI.");
    this.name = "ReadTimeoutError";
  }
}

export async function withReadDeadline<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ReadTimeoutError());
        controller.abort();
      }, READ_TIMEOUT_MS);
    });
    return await Promise.race([read(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
