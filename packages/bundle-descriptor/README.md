# Bundle Descriptor v1

Bundle Descriptor v1 is a small public contract for identifying and describing a bundle across tools. It is a programmatic interchange contract, not a discovery or authorization mechanism.

```js
import {
  BUNDLE_DESCRIPTOR_SCHEMA_V1,
  BUNDLE_DESCRIPTOR_V1,
} from "superbee/bundle-descriptor";
```

The contract contains `schema`, an authority-qualified `bundleId`, an untrusted display `name`, and an untrusted concise `purpose`. The schema rejects undeclared fields. Access, authority, ownership, sensitivity, lifecycle, policy, routing, resolution, and technical capability claims are outside v1.

`BUNDLE_DESCRIPTOR_SCHEMA_V1` is the canonical JSON Schema 2020-12 value and is deeply immutable. Consumers can compile it with any conforming validator. Display text is constrained against blank values, control characters, and bidirectional-control characters, but consumers must still escape it for their output context.

`bundleId` requires at least two dot-separated segments. Publishers own the first segment and keep the full identifier stable. Directories decide how to handle collisions across publishers.

The v1 URI, `superbee/bundle-descriptor` export, schema, and generated `BundleDescriptorV1` TypeScript type remain stable for the package's supported compatibility horizon. Additive or breaking fields require a new schema URI and versioned export while v1 remains supported. The v1 schema URI is an identifier and does not promise network dereferencing.

Bundle discovery is separate. Generic Superbee core does not locate or interpret descriptors.
