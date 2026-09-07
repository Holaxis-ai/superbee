import descriptorSchema from "../schema/bundle-descriptor-v1.schema.json" with { type: "json" };

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The stable Bundle Descriptor v1 schema identifier. */
export const BUNDLE_DESCRIPTOR_V1 = "https://getsuperbee.com/schemas/bundle-descriptor/v1" as const;

/** The canonical JSON Schema 2020-12 contract, deeply immutable at runtime. */
export const BUNDLE_DESCRIPTOR_SCHEMA_V1: Readonly<Record<string, unknown>> =
  deepFreeze(descriptorSchema);
