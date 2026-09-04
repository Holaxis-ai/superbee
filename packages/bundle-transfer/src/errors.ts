export type BundleTransferErrorCode =
  | "INVALID_ARTIFACT"
  | "INVALID_BUNDLE"
  | "INVALID_SOURCE"
  | "LIMIT_EXCEEDED"
  | "OBJECT_MISMATCH"
  | "SOURCE_CHANGED"
  | "UNSUPPORTED_HOST";

export class BundleTransferError extends Error {
  override readonly name = "BundleTransferError";
  readonly code: BundleTransferErrorCode;
  readonly options: { subject?: string; retryable?: boolean; cause?: unknown };

  constructor(
    code: BundleTransferErrorCode,
    message: string,
    options: { subject?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.options = options;
  }
}

export function isBundleTransferError(value: unknown): value is BundleTransferError {
  return value instanceof BundleTransferError;
}
