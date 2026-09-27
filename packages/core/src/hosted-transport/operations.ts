/**
 * Hosted operations by id: the host lists the reads it runs for one bundle
 * (`POST <sync prefix>/operations {bundleId}`) and runs one of them
 * (`POST <sync prefix>/run {bundleId, operationId, input}`), answering the kernel's operation
 * result. A client reaches a read the host adds with no change of its own.
 *
 * Everything the host says here is untrusted data. A descriptor's title and description go
 * through {@link stripHostText}; its JSON Schemas are carried for rendering only, never compiled
 * and never followed (`$ref`, `$id`); a result is data, never a path, URL or command. A listing
 * is bounded: at most {@link HOSTED_READ_BOUNDS.operations} descriptors, and a descriptor that is
 * malformed or out of bounds is dropped with a note while the rest still list.
 */

import { stripHostText } from "../host-text.js";
import { malformed } from "../remote-error.js";
import { operationRefusal, HOSTED_READ_BOUNDS, type HostedOperationRefusal } from "./read-adapter.js";

/** The longest operation id admitted. */
const OPERATION_ID_MAX = 128;

const OPERATION_ID = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*\.v[1-9][0-9]*$/;

/** True for an id in the operation grammar (`documents.history.v1`), at most 128 characters. */
export function isOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length <= OPERATION_ID_MAX && OPERATION_ID.test(value);
}

/** A JSON object, as parsed from an answer. */
export type JsonObject = { readonly [key: string]: unknown };

/** One operation the host runs by id, as its listing describes it. */
export interface HostedOperation {
  readonly operationId: string;
  /** Host text, stripped of control and format characters, at most {@link HOSTED_READ_BOUNDS.operationTitleChars}. */
  readonly title: string;
  /** Host text, stripped of control and format characters, at most {@link HOSTED_READ_BOUNDS.operationDescriptionChars}. */
  readonly description: string;
  /** The most bytes the host answers a run of this operation with. */
  readonly maximumOutputBytes: number;
  /** For rendering only: never compiled, never followed. */
  readonly inputJsonSchema: JsonObject;
  /** For rendering only: never compiled, never followed. */
  readonly resultJsonSchema: JsonObject;
  /** The boolean hints the host states (`readOnlyHint`, `destructiveHint`, ...); any other value is left out. */
  readonly annotations: Readonly<Record<string, boolean>>;
}

/** A decoded listing: the operations admitted, in the host's order, and a note for each one dropped. */
export interface HostedOperationListing {
  readonly operations: readonly HostedOperation[];
  readonly notes: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` nests objects and arrays deeper than `limit` levels (the value itself is level 1). */
function deeperThan(value: unknown, limit: number, level = 1): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (level > limit) return true;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => deeperThan(child, limit, level + 1));
}

/** One descriptor, admitted, or the reason it is dropped. */
function admitDescriptor(raw: unknown): HostedOperation | string {
  if (!isRecord(raw)) return "not an object";
  const { operationId, title, description, maximumOutputBytes, inputJsonSchema, resultJsonSchema, annotations } = raw;
  if (!isOperationId(operationId)) return "its id is not an operation id";
  if (typeof title !== "string" || typeof description !== "string") return "it has no title or description";
  if (typeof maximumOutputBytes !== "number" || !Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes <= 0) return "its maximumOutputBytes is not a positive integer";
  if (!isRecord(inputJsonSchema) || !isRecord(resultJsonSchema)) return "its schemas are not objects";
  if (deeperThan(inputJsonSchema, HOSTED_READ_BOUNDS.operationSchemaDepth) || deeperThan(resultJsonSchema, HOSTED_READ_BOUNDS.operationSchemaDepth)) return `a schema is nested deeper than ${HOSTED_READ_BOUNDS.operationSchemaDepth} levels`;
  if (annotations !== undefined && !isRecord(annotations)) return "its annotations are not an object";
  const hints: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(annotations ?? {})) if (typeof value === "boolean") hints[key] = value;
  return Object.freeze({
    operationId,
    title: stripHostText(title, HOSTED_READ_BOUNDS.operationTitleChars),
    description: stripHostText(description, HOSTED_READ_BOUNDS.operationDescriptionChars),
    maximumOutputBytes,
    inputJsonSchema,
    resultJsonSchema,
    annotations: Object.freeze(hints),
  });
}

/**
 * The listing route's `200` answer (`{ operations: [descriptor, ...] }`). A body that is not an
 * object with an `operations` array is malformed, naming `route`; fields the answer may gain are
 * ignored. Each descriptor is admitted on its own: one that is malformed, whose id is outside the
 * operation grammar or repeats an earlier one, whose `maximumOutputBytes` is not positive, or
 * whose schema nests deeper than {@link HOSTED_READ_BOUNDS.operationSchemaDepth} is dropped with a note. At most
 * {@link HOSTED_READ_BOUNDS.operations} are read.
 */
export function decodeOperationListing(body: unknown, route?: string): HostedOperationListing {
  if (!isRecord(body) || !Array.isArray(body.operations)) throw malformed("operations answered a body that is not an operation listing", route);
  const rows = body.operations as unknown[];
  const operations: HostedOperation[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  rows.slice(0, HOSTED_READ_BOUNDS.operations).forEach((raw, index) => {
    const admitted = admitDescriptor(raw);
    // Only an id that passed the grammar is named: anything else the host sent stays out of the note.
    const named = isRecord(raw) && isOperationId(raw.operationId) ? ` (${raw.operationId})` : "";
    if (typeof admitted === "string") notes.push(`dropped the host's operation #${index + 1}${named}: ${admitted}`);
    else if (seen.has(admitted.operationId)) notes.push(`dropped the host's operation #${index + 1}${named}: its id repeats an earlier one`);
    else {
      seen.add(admitted.operationId);
      operations.push(admitted);
    }
  });
  if (rows.length > HOSTED_READ_BOUNDS.operations) notes.push(`dropped ${rows.length - HOSTED_READ_BOUNDS.operations} operations past the first ${HOSTED_READ_BOUNDS.operations} the host listed`);
  return Object.freeze({ operations: Object.freeze(operations), notes: Object.freeze(notes) });
}

/**
 * The body a run sends: the bundle the request selects its tenant by, the operation, and the
 * operation's input with its `bundleId` set to that same bare bundle id (the host refuses an
 * input naming another bundle). An input that already names another bundle is refused here.
 */
export function operationRunBody(bundleId: string, operationId: string, input: JsonObject): { bundleId: string; operationId: string; input: Record<string, unknown> } {
  if (input.bundleId !== undefined && input.bundleId !== bundleId) throw new RangeError("the operation input names another bundle than the one the run selects");
  const rest: Record<string, unknown> = { ...input };
  delete rest.bundleId;
  return { bundleId, operationId, input: { bundleId, ...rest } };
}

/** A run's `200` answer: the operation's data, or its refusal (the kernel's code, message and retry advice). */
export type HostedOperationRun = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly refusal: HostedOperationRefusal };

/**
 * A run's `200` answer, the kernel's operation result: `{ ok: true, operationId, data }` for the
 * operation asked for, or its refusal through {@link operationRefusal}. Anything else, including
 * a result for another operation, or data nested deeper than `HOSTED_READ_BOUNDS.runDepth`
 * levels (which no renderer could walk), is malformed, naming `route`. The data is not interpreted.
 */
export function decodeOperationRun(operationId: string, body: unknown, route?: string): HostedOperationRun {
  const refusal = operationRefusal(body, operationId, route);
  if (refusal) return Object.freeze({ ok: false, refusal });
  if (!isRecord(body) || body.ok !== true || body.operationId !== operationId || !("data" in body) || body.data === undefined)
    throw malformed(`run answered an envelope that is not ${operationId}'s result`, route);
  if (deeperThan(body.data, HOSTED_READ_BOUNDS.runDepth)) throw malformed(`run answered data nested deeper than ${HOSTED_READ_BOUNDS.runDepth} levels`, route);
  return Object.freeze({ ok: true, data: body.data });
}
