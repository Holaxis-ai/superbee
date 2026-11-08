import type { ServerResponse } from "node:http";

/**
 * Observe how a Node response ends: `true` when it was fully flushed ("finish"), `false` when the
 * connection closed first. Always settles, so a client that disconnects mid-response cannot hang
 * the caller. Attach before writing; both listeners are removed on settle.
 */
export function observeResponseCompletion(res: ServerResponse): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const settle = (completed: boolean): void => {
      res.off("finish", onFinish);
      res.off("close", onClose);
      resolve(completed);
    };
    const onFinish = (): void => settle(true);
    const onClose = (): void => settle(res.writableFinished);
    res.once("finish", onFinish);
    res.once("close", onClose);
  });
}
