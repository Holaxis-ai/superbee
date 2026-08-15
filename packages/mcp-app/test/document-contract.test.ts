import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCUMENT_PRESENTATION_SCHEMA_VERSION,
  parseDocumentPresentationPayload,
} from "../src/document-contract.js";

test("document presentation payload parser accepts the exact bounded contract", () => {
  assert.deepEqual(
    parseDocumentPresentationPayload({
      schemaVersion: DOCUMENT_PRESENTATION_SCHEMA_VERSION,
      document: {
        id: "docs/brief",
        version: "sha256:abc",
        title: "Brief",
        type: "Document",
        html: "<p>Safe</p>",
        bounded: false,
      },
    }),
    {
      schemaVersion: DOCUMENT_PRESENTATION_SCHEMA_VERSION,
      document: {
        id: "docs/brief",
        version: "sha256:abc",
        title: "Brief",
        type: "Document",
        html: "<p>Safe</p>",
        bounded: false,
      },
    },
  );
});

test("document presentation payload parser rejects incomplete or foreign results", () => {
  assert.equal(parseDocumentPresentationPayload(null), null);
  assert.equal(
    parseDocumentPresentationPayload({
      schemaVersion: "other",
      document: {},
    }),
    null,
  );
  assert.equal(
    parseDocumentPresentationPayload({
      schemaVersion: DOCUMENT_PRESENTATION_SCHEMA_VERSION,
      document: {
        id: "docs/brief",
        version: "sha256:abc",
        title: "Brief",
        html: "<p>Safe</p>",
      },
    }),
    null,
  );
});
