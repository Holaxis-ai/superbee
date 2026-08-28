export type PublicationErrorCodeV1 =
  | "SOURCE_NOT_FOUND"
  | "UNSUPPORTED_SOURCE"
  | "SOURCE_CHANGED"
  | "LIMIT_EXCEEDED"
  | "INVALID_BUNDLE"
  | "INVALID_OBJECT_IDENTITY"
  | "OBJECT_MISSING"
  | "OBJECT_VERSION_MISMATCH"
  | "MALFORMED_DOCUMENT"
  | "DUPLICATE_DOCUMENT_ID"
  | "UNSERIALIZABLE_VALUE"
  | "RENDER_FAILED"
  | "INVALID_VIEW_REGISTRATION"
  | "VIEW_ENTRY_MISSING"
  | "VIEW_ENTRY_VERSION_MISMATCH"
  | "CAPABILITY_UNAVAILABLE"
  | "INVALID_SNAPSHOT"
  | "OBJECT_DIGEST_MISMATCH"
  | "INVALID_BRIDGE_ADMISSION"
  | "HANDLE_CLOSED"
  | "IO_ERROR"
  | "INTERNAL_ERROR";

export interface PublicationErrorOptions {
  retryable?: boolean;
  subject?: string;
  expected?: unknown;
  actual?: unknown;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** Stable error boundary for every `superbee/publication` operation. */
export class PublicationError extends Error {
  readonly code: PublicationErrorCodeV1;
  readonly retryable: boolean;
  readonly subject?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: PublicationErrorCodeV1, message: string, options: PublicationErrorOptions = {}) {
    super(message);
    this.name = "PublicationError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.subject !== undefined) this.subject = options.subject;
    if (options.expected !== undefined) this.expected = options.expected;
    if (options.actual !== undefined) this.actual = options.actual;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function isPublicationError(value: unknown): value is PublicationError {
  return value instanceof PublicationError;
}
