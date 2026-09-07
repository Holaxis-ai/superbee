import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "json-schema-to-typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "schema", "bundle-descriptor-v1.schema.json");
const outputPath = path.join(root, "src", "generated", "bundle-descriptor-v1.ts");
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const generated = (await compile(schema, "BundleDescriptorV1", {
  bannerComment: "/* GENERATED from schema/bundle-descriptor-v1.schema.json - do not edit. */",
  style: { singleQuote: false },
  unreachableDefinitions: true,
})).replace(/\r\n?/g, "\n");

if (process.argv.includes("--check")) {
  const current = (await readFile(outputPath, "utf8").catch(() => "")).replace(/\r\n?/g, "\n");
  if (current !== generated) {
    console.error("bundle descriptor generated types are stale; run npm run generate -w @superbee/bundle-descriptor");
    process.exitCode = 1;
  }
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated, "utf8");
}
