import path from "node:path";
import { readFileSync, statSync } from "node:fs";

export const timing = JSON.parse(readFileSync(new URL("./test-durations.json", import.meta.url), "utf8"));

export function partitionFiles(files, total, weights = timing.weights, fallback = timing.fallback_seconds) {
  if (!Number.isSafeInteger(total) || total < 1 || files.length < total) throw new Error("shards must contain at least one test file each");
  if (!(Number.isFinite(fallback) && fallback > 0)) throw new Error("fallback weight must be positive");
  if (new Set(files.map(file => path.resolve(file))).size !== files.length) throw new Error("duplicate test file");
  const weighted = files.map(file => {
    const weight = weights[path.basename(file)] ?? fallback;
    if (!(Number.isFinite(weight) && weight > 0)) throw new Error(`invalid weight for ${file}`);
    return { file, weight };
  }).sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const shards = Array.from({ length: total }, () => ({ files: [], seconds: 0 }));
  for (const { file, weight } of weighted) {
    const shard = shards.reduce((best, next) => next.seconds < best.seconds ? next : best);
    shard.files.push(file);
    shard.seconds += weight;
  }
  return shards;
}

// Inputs come from the caller's shell expansion, including scoped host-class invocations. Never
// discover the global suite here: doing so would widen a caller's explicitly selected coverage.
export function selectTestShard(args, shard, weights = timing.weights) {
  if (shard === undefined) return args;
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(shard);
  const [index, total] = match ? match.slice(1).map(Number) : [];
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
    throw new Error(`SUPERBEE_TEST_SHARD must be <index>/<total> with 1 <= index <= total, got ${JSON.stringify(shard)}`);
  }
  if (args[0] !== "--test") throw new Error("SUPERBEE_TEST_SHARD applies only to a node --test command");
  const firstFile = args.findIndex(arg => /\.test\.[cm]?[jt]s$/.test(arg));
  if (firstFile < 0) throw new Error("shards require explicit test files");
  const options = args.slice(0, firstFile);
  if (options.some(arg => arg.startsWith("--test-shard"))) throw new Error("nested test sharding is forbidden");
  const files = args.slice(firstFile);
  for (const file of files) {
    if (!/\.test\.[cm]?[jt]s$/.test(file) || !statSync(file).isFile()) throw new Error(`invalid explicit test file: ${file}`);
  }
  const shards = partitionFiles(files, total, weights);
  const selected = shards[index - 1];
  console.error(`CLI shard ${index}/${total}: ${selected.files.length}/${files.length} files, estimated ${selected.seconds}s`);
  return [...options, ...selected.files];
}
