import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "json-schema-to-typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "schema", "publication-snapshot-v1.schema.json");
const outputPath = path.join(root, "src", "generated", "publication-snapshot-v1.ts");
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const generated = await compile(schema, "PublicationSnapshotV1", {
  bannerComment: "/* GENERATED from schema/publication-snapshot-v1.schema.json — do not edit. */",
  style: { singleQuote: false },
  unreachableDefinitions: true,
});

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== generated) {
    console.error("publication snapshot generated types are stale; run npm run generate -w @superbee/publication");
    process.exitCode = 1;
  }
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated, "utf8");
}
