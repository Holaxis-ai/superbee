// Structural discovery of the code the repository's workflows execute.
//
// The release packet's input manifest must pin every source file that participates in performing a
// release. That set has to be DERIVED, not declared: a frozen list of entrypoints stops describing
// the workflows the moment someone edits one. This module derives it by parsing the workflow files
// themselves — a strict YAML subset reader that fails closed on anything it does not understand,
// then a shell reader that walks each `run:` block into simple commands (including inside `$( )`)
// and reports every `node` invocation with a resolvable script path.
//
// Two deliberate boundaries, both fail-closed at the edge rather than silently skipped:
//
//   * `npm run <name>` is expanded exactly ONE hop, into the direct `node` commands of the named
//     package script (plus its pre/post scripts). Nested `npm run` chains are not followed: the
//     repository gate (`npm run check`) fans out into workspace test scripts whose commands are
//     globs over TypeScript sources, which no static reader can resolve into a file set. Anything a
//     workflow reaches through that chain is still digest-bound by the packet's whole-tree
//     `source_files` set; it is only excluded from the reviewed release-execution closure.
//   * A `node` invocation whose script argument cannot be resolved statically is an error, not a
//     skip. Literal shell assignments in the same run block (and `env:` maps) are resolved first,
//     so the ordinary `CLI=path` / `node "$CLI"` shape works without weakening the rule.
//
// Nothing here reads git. Callers pass the tracked-path set and an ignore predicate so the module
// stays a pure reader over the checkout.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const WORKFLOW_DIRECTORY = ".github/workflows";
const WORKFLOW_EXTENSIONS = [".yml", ".yaml"];
// npm's own publish lifecycle names; the published package's hooks run as part of a release.
const PUBLISH_LIFECYCLE_SCRIPTS = Object.freeze([
  "prepare", "prepack", "prepublish", "prepublishOnly", "publish", "postpack", "postpublish",
]);
// Node CLI options that consume the following argument. An option not listed here is treated as a
// boolean flag; `--option=value` needs no entry.
const NODE_VALUE_OPTIONS = new Set([
  "-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions",
  "--env-file", "--env-file-if-exists", "--input-type", "--test-reporter", "--test-reporter-destination",
  "--test-name-pattern", "--test-skip-pattern", "--test-shard", "--test-concurrency", "--test-timeout",
  "--title", "--icu-data-dir", "--redirect-warnings", "--report-dir", "--report-filename", "--snapshot-blob",
  "--watch-path", "--cpu-prof-dir", "--heap-prof-dir", "--diagnostic-dir", "--max-old-space-size",
]);
// Node CLI options that replace the script argument with inline code or a query.
const NODE_INLINE_OPTIONS = new Set(["-e", "--eval", "-p", "--print", "-c", "--check", "-v", "--version", "-h", "--help"]);
// Shell words that introduce or separate a command rather than naming one.
const SHELL_LEADING_KEYWORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "time"]);
// npm options that consume the following argument, so the subcommand can be found positionally.
const NPM_VALUE_OPTIONS = new Set(["-w", "--workspace", "--prefix", "--loglevel", "--userconfig", "--registry", "--tag"]);
const NPM_RUN_SUBCOMMANDS = new Set(["run", "run-script"]);
const NPM_LIFECYCLE_SUBCOMMANDS = new Set(["test", "start", "stop", "restart"]);
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------------------------
// YAML subset reader
// ---------------------------------------------------------------------------------------------

function scalarText(value) {
  return typeof value === "string" ? value : null;
}

function splitMappingKey(content, fail, where) {
  if (content.startsWith('"') || content.startsWith("'")) {
    const quote = content[0];
    let index = 1;
    while (index < content.length) {
      if (content[index] === "\\" && quote === '"') { index += 2; continue; }
      if (content[index] === quote) break;
      index += 1;
    }
    if (index >= content.length || content[index + 1] !== ":") fail(`${where} has an unsupported quoted key`);
    return { key: content.slice(1, index), rest: content.slice(index + 2).trim() };
  }
  const colon = content.indexOf(": ");
  const trailing = content.endsWith(":") ? content.length - 1 : -1;
  if (colon === -1 && trailing === -1) fail(`${where} is not a mapping entry: ${JSON.stringify(content)}`);
  const at = colon === -1 || (trailing !== -1 && trailing < colon) ? trailing : colon;
  const key = content.slice(0, at).trim();
  if (!key || key.includes("#")) fail(`${where} has an unsupported mapping key: ${JSON.stringify(content)}`);
  return { key, rest: content.slice(at + 1).trim() };
}

function stripInlineComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\" && quote === '"') { index += 1; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "#" && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index).trimEnd();
  }
  return text.trimEnd();
}

function splitFlowItems(inner) {
  const items = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "[" || character === "{") { depth += 1; continue; }
    if (character === "]" || character === "}") { depth -= 1; continue; }
    if (character === "," && depth === 0) {
      items.push(inner.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(inner.slice(start).trim());
  return items;
}

function parseFlowSequence(text, fail, where) {
  if (!text.endsWith("]")) fail(`${where} has an unterminated flow sequence`);
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  return splitFlowItems(inner).map((item) => parseInlineScalar(item, fail, where));
}

function parseFlowMapping(text, fail, where) {
  if (!text.endsWith("}")) fail(`${where} has an unterminated flow mapping`);
  const inner = text.slice(1, -1).trim();
  if (inner === "") return {};
  const mapping = {};
  for (const item of splitFlowItems(inner)) {
    const { key, rest } = splitMappingKey(item, fail, where);
    if (Object.hasOwn(mapping, key)) fail(`${where} repeats flow mapping key ${JSON.stringify(key)}`);
    mapping[key] = parseInlineScalar(rest, fail, where);
  }
  return mapping;
}

function parseInlineScalar(text, fail, where) {
  const value = stripInlineComment(text);
  if (value === "") return null;
  if (value.startsWith("[")) return parseFlowSequence(value, fail, where);
  if (value.startsWith("{")) return parseFlowMapping(value, fail, where);
  if (value.startsWith("&") || value.startsWith("*") || value.startsWith("!")) {
    fail(`${where} uses an unsupported YAML anchor, alias, or tag`);
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) fail(`${where} has an unterminated double-quoted scalar`);
    return value.slice(1, -1).replace(/\\(.)/g, (_, character) => (character === "n" ? "\n" : character));
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) fail(`${where} has an unterminated single-quoted scalar`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function meaningfulIndex(lines, from) {
  for (let index = from; index < lines.length; index += 1) {
    if (lines[index].content !== "" && !lines[index].content.startsWith("#")) return index;
  }
  return -1;
}

function parseBlockScalar(lines, cursor, parentIndent, style, label, fail) {
  if (style !== "|") fail(`${label}:${lines[cursor.index - 1]?.number ?? 0} uses an unsupported folded block scalar`);
  const collected = [];
  let contentIndent = -1;
  let lastContent = -1;
  let index = cursor.index;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.content === "") { collected.push(""); continue; }
    if (line.indent <= parentIndent) break;
    if (contentIndent === -1) contentIndent = line.indent;
    if (line.indent < contentIndent) break;
    collected.push(line.raw.slice(contentIndent));
    lastContent = collected.length - 1;
  }
  cursor.index = index - (collected.length - 1 - lastContent);
  return `${collected.slice(0, lastContent + 1).join("\n")}\n`;
}

function parseNode(lines, cursor, minIndent, label, fail) {
  const index = meaningfulIndex(lines, cursor.index);
  if (index === -1 || lines[index].indent < minIndent) return null;
  const content = lines[index].content;
  if (content === "---" || content === "...") fail(`${label}:${lines[index].number} uses an unsupported document marker`);
  if (content === "-" || content.startsWith("- ")) return parseSequence(lines, cursor, lines[index].indent, label, fail);
  return parseMapping(lines, cursor, lines[index].indent, label, fail);
}

function parseValue(lines, cursor, line, rest, indent, label, fail) {
  const where = `${label}:${line.number}`;
  if (rest === "") {
    const next = meaningfulIndex(lines, cursor.index);
    if (next === -1 || lines[next].indent <= indent) return null;
    return parseNode(lines, cursor, lines[next].indent, label, fail);
  }
  const block = /^([|>])([+-]?)$/.exec(rest);
  if (block) return parseBlockScalar(lines, cursor, indent, block[1], label, fail);
  return parseInlineScalar(rest, fail, where);
}

function parseMapping(lines, cursor, indent, label, fail) {
  const mapping = {};
  for (;;) {
    const index = meaningfulIndex(lines, cursor.index);
    if (index === -1) break;
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent > indent) fail(`${label}:${line.number} has unexpected indentation inside a mapping`);
    if (line.content === "-" || line.content.startsWith("- ")) fail(`${label}:${line.number} mixes a sequence entry into a mapping`);
    const { key, rest } = splitMappingKey(line.content, fail, `${label}:${line.number}`);
    if (Object.hasOwn(mapping, key)) fail(`${label}:${line.number} repeats mapping key ${JSON.stringify(key)}`);
    cursor.index = index + 1;
    mapping[key] = parseValue(lines, cursor, line, rest, indent, label, fail);
  }
  return mapping;
}

function parseSequence(lines, cursor, indent, label, fail) {
  const items = [];
  for (;;) {
    const index = meaningfulIndex(lines, cursor.index);
    if (index === -1) break;
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent > indent) fail(`${label}:${line.number} has unexpected indentation inside a sequence`);
    if (line.content !== "-" && !line.content.startsWith("- ")) break;
    if (line.content === "-") {
      cursor.index = index + 1;
      const next = meaningfulIndex(lines, cursor.index);
      if (next === -1 || lines[next].indent <= indent) { items.push(null); continue; }
      items.push(parseNode(lines, cursor, lines[next].indent, label, fail));
      continue;
    }
    const offset = line.content.length - line.content.slice(1).trimStart().length;
    const virtualIndent = line.indent + offset;
    lines[index] = {
      number: line.number,
      indent: virtualIndent,
      content: line.content.slice(offset),
      raw: `${" ".repeat(virtualIndent)}${line.content.slice(offset)}`,
    };
    cursor.index = index;
    items.push(parseNode(lines, cursor, virtualIndent, label, fail));
  }
  return items;
}

/** Parse the YAML subset GitHub workflow files use. Anything outside the subset fails closed. */
export function parseWorkflowYaml(text, label, fail) {
  if (text.includes("\t")) fail(`${label} indents with a tab character`);
  if (text.includes("\r")) fail(`${label} contains a carriage return`);
  const lines = text.split("\n").map((raw, index) => {
    const content = raw.trimStart();
    return { number: index + 1, indent: raw.length - content.length, content: content.trimEnd(), raw };
  });
  const cursor = { index: 0 };
  const document = parseNode(lines, cursor, 0, label, fail);
  const trailing = meaningfulIndex(lines, cursor.index);
  if (trailing !== -1) fail(`${label}:${lines[trailing].number} has trailing content outside the document`);
  return document;
}

// ---------------------------------------------------------------------------------------------
// Shell reader
// ---------------------------------------------------------------------------------------------

function newWord() {
  return { parts: [] };
}

/**
 * Split a shell script into simple commands. Words keep their expansion structure so a caller can
 * decide whether a value is statically known. Command substitutions are parsed as nested scripts
 * and emitted as their own commands. Constructs this reader cannot model (heredocs, backticks,
 * `$'...'`) fail closed.
 */
export function parseShellScript(text, label, fail) {
  const commands = [];
  let words = [];
  let word = newWord();
  let literal = "";
  let dropWord = false;

  const flushLiteral = () => {
    if (literal !== "") {
      word.parts.push({ type: "literal", value: literal });
      literal = "";
    }
  };
  const endWord = () => {
    flushLiteral();
    if (word.parts.length > 0) {
      if (!dropWord) words.push(word);
      dropWord = false;
      word = newWord();
    }
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push({ words });
    words = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      if (text[index + 1] === "\n") { index += 1; continue; }
      if (index + 1 < text.length) { literal += text[index + 1]; index += 1; continue; }
      fail(`${label} ends with a dangling backslash`);
    }
    if (character === "'") {
      const end = text.indexOf("'", index + 1);
      if (end === -1) fail(`${label} has an unterminated single-quoted string`);
      literal += text.slice(index + 1, end);
      if (literal === "") word.parts.push({ type: "literal", value: "" });
      index = end;
      continue;
    }
    if (character === '"') {
      const consumed = readDoubleQuoted(text, index + 1, word, () => { flushLiteral(); }, (value) => { literal += value; }, label, fail, commands);
      index = consumed;
      continue;
    }
    if (character === "`") fail(`${label} uses an unsupported backtick command substitution`);
    if (character === "$") {
      const consumed = readExpansion(text, index, word, () => flushLiteral(), (value) => { literal += value; }, label, fail, commands);
      index = consumed;
      continue;
    }
    if (character === "#" && literal === "" && word.parts.length === 0) {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end - 1;
      continue;
    }
    if (character === ">" || character === "<") {
      if (/^[0-9]+$/.test(literal)) literal = "";
      endWord();
      let operator = character;
      let next = index + 1;
      while (next < text.length && (text[next] === ">" || text[next] === "<" || text[next] === "&")) {
        operator += text[next];
        next += 1;
      }
      if (operator.includes("<<")) fail(`${label} uses an unsupported heredoc`);
      if (operator.endsWith("&")) {
        while (next < text.length && /[0-9-]/.test(text[next])) { operator += text[next]; next += 1; }
      }
      index = next - 1;
      dropWord = !/&[0-9-]+$/.test(operator);
      continue;
    }
    if (character === " ") { endWord(); continue; }
    if (character === "\n" || character === ";" || character === "&" || character === "|") {
      endCommand();
      continue;
    }
    if (character === "(" || character === ")" || character === "{" || character === "}") {
      endCommand();
      continue;
    }
    literal += character;
  }
  endCommand();
  return commands;
}

function readDoubleQuoted(text, start, word, flushLiteral, appendLiteral, label, fail, commands) {
  let index = start;
  let sawContent = false;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') return index;
    sawContent = true;
    if (character === "\\") {
      if (index + 1 >= text.length) fail(`${label} ends with a dangling backslash`);
      appendLiteral(text[index + 1]);
      index += 1;
      continue;
    }
    if (character === "`") fail(`${label} uses an unsupported backtick command substitution`);
    if (character === "$") {
      index = readExpansion(text, index, word, flushLiteral, appendLiteral, label, fail, commands);
      continue;
    }
    appendLiteral(character);
  }
  if (!sawContent) fail(`${label} has an unterminated double-quoted string`);
  fail(`${label} has an unterminated double-quoted string`);
  return index;
}

function matchingBrace(text, start, open, close, label, fail) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") { index += 1; continue; }
    if (text[index] === open) { depth += 1; continue; }
    if (text[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  fail(`${label} has an unbalanced ${open}${close} expansion`);
  return -1;
}

function readExpansion(text, start, word, flushLiteral, appendLiteral, label, fail, commands) {
  const next = text[start + 1];
  if (next === "(") {
    const end = matchingBrace(text, start + 1, "(", ")", label, fail);
    for (const command of parseShellScript(text.slice(start + 2, end), label, fail)) commands.push(command);
    flushLiteral();
    word.parts.push({ type: "opaque" });
    return end;
  }
  if (next === "{" && text[start + 2] === "{") {
    const end = text.indexOf("}}", start + 3);
    if (end === -1) fail(`${label} has an unterminated workflow expression`);
    flushLiteral();
    word.parts.push({ type: "opaque", expression: text.slice(start + 3, end).trim() });
    return end + 1;
  }
  if (next === "{") {
    const end = matchingBrace(text, start + 1, "{", "}", label, fail);
    const inner = text.slice(start + 2, end);
    flushLiteral();
    word.parts.push(SHELL_NAME.test(inner) ? { type: "variable", name: inner } : { type: "opaque" });
    return end;
  }
  if (next === "'" || next === '"') fail(`${label} uses an unsupported $-quoted string`);
  if (next !== undefined && /[A-Za-z_]/.test(next)) {
    let end = start + 1;
    while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end += 1;
    flushLiteral();
    word.parts.push({ type: "variable", name: text.slice(start + 1, end) });
    return end - 1;
  }
  if (next === undefined) {
    appendLiteral("$");
    return start;
  }
  flushLiteral();
  word.parts.push({ type: "opaque" });
  return start + 1;
}

/** Resolve a word against a literal environment. Returns null when any part is not statically known. */
export function resolveWord(word, environment) {
  let text = "";
  for (const part of word.parts) {
    if (part.type === "literal") { text += part.value; continue; }
    if (part.type === "variable") {
      const value = environment.get(part.name);
      if (value === undefined) return null;
      text += value;
      continue;
    }
    return null;
  }
  return text;
}

function isAssignment(word) {
  const first = word.parts[0];
  if (first?.type !== "literal") return false;
  const equals = first.value.indexOf("=");
  if (equals <= 0) return false;
  return SHELL_NAME.test(first.value.slice(0, equals));
}

function assignmentName(word) {
  const first = word.parts[0];
  return first.value.slice(0, first.value.indexOf("="));
}

function assignmentValue(word, environment) {
  const first = word.parts[0];
  const head = first.value.slice(first.value.indexOf("=") + 1);
  const rest = resolveWord({ parts: word.parts.slice(1) }, environment);
  return rest === null ? null : `${head}${rest}`;
}

/** Strip leading assignments and shell keywords, returning the command's argv words. */
function commandArgv(command, environment) {
  const words = [...command.words];
  const assignments = [];
  while (words.length > 0 && isAssignment(words[0])) assignments.push(words.shift());
  while (words.length > 0) {
    const head = resolveWord(words[0], environment);
    if (head === null || !SHELL_LEADING_KEYWORDS.has(head)) break;
    words.shift();
    while (words.length > 0 && isAssignment(words[0])) assignments.push(words.shift());
  }
  return { assignments, words };
}

/** Extract the script path a `node` command executes, or a non-file classification. */
export function nodeCommandTarget(words, environment, label, fail) {
  for (let index = 1; index < words.length; index += 1) {
    const value = resolveWord(words[index], environment);
    if (value === null) {
      if (words[index].parts.every((part) => part.type === "opaque")) continue;
      fail(`${label} runs node with an unresolvable argument`);
    }
    if (value === "--") {
      const script = index + 1 < words.length ? resolveWord(words[index + 1], environment) : null;
      if (script === null) fail(`${label} runs node with an unresolvable script path`);
      return { kind: "script", script };
    }
    if (NODE_INLINE_OPTIONS.has(value)) return { kind: "inline" };
    if (NODE_VALUE_OPTIONS.has(value)) { index += 1; continue; }
    if (value.startsWith("-")) continue;
    return { kind: "script", script: value };
  }
  return { kind: "inline" };
}

function npmInvocation(words, environment) {
  const positional = [];
  const workspaces = [];
  let allWorkspaces = false;
  let unresolvedWorkspace = false;
  for (let index = 1; index < words.length; index += 1) {
    const value = resolveWord(words[index], environment);
    if (value === null) { positional.push(null); continue; }
    if (value === "--") break;
    if (value === "--workspaces") { allWorkspaces = true; continue; }
    if (value === "-w" || value === "--workspace") {
      const workspace = index + 1 < words.length ? resolveWord(words[index + 1], environment) : null;
      if (workspace === null) unresolvedWorkspace = true;
      else workspaces.push(workspace);
      index += 1;
      continue;
    }
    if (value.startsWith("--workspace=")) { workspaces.push(value.slice("--workspace=".length)); continue; }
    if (NPM_VALUE_OPTIONS.has(value)) { index += 1; continue; }
    if (value.startsWith("-")) continue;
    positional.push(value);
  }
  const [subcommand, ...rest] = positional;
  let script = null;
  if (subcommand !== null && NPM_RUN_SUBCOMMANDS.has(subcommand)) script = rest[0] ?? null;
  else if (subcommand !== null && NPM_LIFECYCLE_SUBCOMMANDS.has(subcommand)) script = subcommand;
  return { script, workspaces, allWorkspaces, unresolvedWorkspace };
}

// ---------------------------------------------------------------------------------------------
// Workflow topology
// ---------------------------------------------------------------------------------------------

function environmentFrom(base, value) {
  const environment = new Map(base);
  if (!value || typeof value !== "object" || Array.isArray(value)) return environment;
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string" && !entry.includes("${{")) environment.set(name, entry);
    else environment.delete(name);
  }
  return environment;
}

function workflowRunSteps(document, label, fail) {
  const steps = [];
  const workflowEnvironment = environmentFrom(new Map(), document?.env);
  const workflowDirectory = scalarText(document?.defaults?.run?.["working-directory"]) ?? ".";
  const jobs = document?.jobs;
  if (jobs === null || jobs === undefined) return steps;
  if (typeof jobs !== "object" || Array.isArray(jobs)) fail(`${label} has an unsupported jobs block`);
  for (const [jobName, job] of Object.entries(jobs)) {
    if (!job || typeof job !== "object" || Array.isArray(job)) continue;
    const jobEnvironment = environmentFrom(workflowEnvironment, job.env);
    const jobDirectory = scalarText(job.defaults?.run?.["working-directory"]) ?? workflowDirectory;
    const jobSteps = job.steps;
    if (jobSteps === null || jobSteps === undefined) continue;
    if (!Array.isArray(jobSteps)) fail(`${label} job ${jobName} has an unsupported steps block`);
    for (const [position, step] of jobSteps.entries()) {
      if (!step || typeof step !== "object" || Array.isArray(step)) continue;
      const uses = scalarText(step.uses);
      if (uses?.startsWith(".")) fail(`${label} job ${jobName} step ${position + 1} uses an unsupported local action ${uses}`);
      const run = step.run;
      if (run === undefined || run === null) continue;
      if (typeof run !== "string") fail(`${label} job ${jobName} step ${position + 1} has a non-scalar run block`);
      steps.push({
        label: `${label} job ${jobName} step ${position + 1}`,
        script: run,
        environment: environmentFrom(jobEnvironment, step.env),
        directory: scalarText(step["working-directory"]) ?? jobDirectory,
      });
    }
  }
  return steps;
}

function repositoryRelative(directory, target, label, fail) {
  if (path.posix.isAbsolute(target)) fail(`${label} executes an absolute path ${target}`);
  const resolved = path.posix.normalize(path.posix.join(directory, target));
  if (resolved.startsWith("../") || resolved === "..") fail(`${label} executes ${target} outside the repository`);
  return resolved;
}

async function readPackageScripts(root, relative, cache, fail) {
  if (cache.has(relative)) return cache.get(relative);
  let scripts = null;
  try {
    const manifest = JSON.parse(await readFile(path.join(root, relative), "utf8"));
    if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) {
      scripts = {
        name: typeof manifest.name === "string" ? manifest.name : null,
        scripts: manifest.scripts && typeof manifest.scripts === "object" && !Array.isArray(manifest.scripts) ? manifest.scripts : {},
        workspaces: Array.isArray(manifest.workspaces) ? manifest.workspaces : [],
      };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") fail(`${relative} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  cache.set(relative, scripts);
  return scripts;
}

async function workspacePackageFiles(root, cache, fail) {
  const rootPackage = await readPackageScripts(root, "package.json", cache, fail);
  const files = [];
  for (const pattern of rootPackage?.workspaces ?? []) {
    if (typeof pattern !== "string") fail("package.json workspaces must be strings");
    if (!pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) {
      fail(`package.json workspace pattern ${pattern} is not the supported <directory>/* form`);
    }
    const directory = pattern.slice(0, -2);
    let entries = [];
    try {
      entries = await readdir(path.join(root, directory), { withFileTypes: true });
    } catch (error) {
      fail(`workspace directory ${directory} is not readable: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relative = path.posix.join(directory, entry.name, "package.json");
      if (await readPackageScripts(root, relative, cache, fail)) files.push(relative);
    }
  }
  return files;
}

/**
 * Derive every node script the repository's workflows execute.
 *
 * `trackedPaths` and `isIgnored` come from git: a resolved target must be either a tracked source
 * file (which becomes a closure root) or a build output the checkout ignores (which cannot be
 * digest-bound and is reported instead). Anything else fails closed.
 */
export async function deriveWorkflowExecution({ root, publishedPackageNames = [], trackedPaths, isIgnored, fail }) {
  const workflowDirectory = path.join(root, ...WORKFLOW_DIRECTORY.split("/"));
  let entries;
  try {
    entries = await readdir(workflowDirectory);
  } catch (error) {
    fail(`workflow directory ${WORKFLOW_DIRECTORY} is not readable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const workflowFiles = entries
    .filter((name) => WORKFLOW_EXTENSIONS.some((extension) => name.endsWith(extension)))
    .map((name) => `${WORKFLOW_DIRECTORY}/${name}`)
    .sort();
  if (workflowFiles.length === 0) fail(`${WORKFLOW_DIRECTORY} declares no workflow files`);

  const packageCache = new Map();
  const entrypoints = new Set();
  const scriptAuthority = new Set();
  const generated = new Set();

  const recordTarget = async (target, label) => {
    if (trackedPaths.has(target)) { entrypoints.add(target); return true; }
    if (await isIgnored(target)) { generated.add(target); return false; }
    fail(`${label} executes ${target}, which is neither a tracked source file nor an ignored build output`);
    return false;
  };

  const expandPackageScript = async (invocation, directory, label) => {
    const candidates = [];
    if (invocation.workspaces.length > 0 || invocation.allWorkspaces || invocation.unresolvedWorkspace) {
      const files = await workspacePackageFiles(root, packageCache, fail);
      for (const file of files) {
        if (invocation.allWorkspaces || invocation.unresolvedWorkspace) { candidates.push(file); continue; }
        const manifest = await readPackageScripts(root, file, packageCache, fail);
        const directoryName = path.posix.dirname(file);
        if (invocation.workspaces.some((selector) => selector === manifest?.name || selector === directoryName)) candidates.push(file);
      }
    } else {
      candidates.push(repositoryRelative(directory, "package.json", label, fail));
    }
    for (const file of candidates) {
      const manifest = await readPackageScripts(root, file, packageCache, fail);
      if (!manifest) continue;
      const packageDirectory = path.posix.dirname(file) === "." ? "." : path.posix.dirname(file);
      for (const name of [`pre${invocation.script}`, invocation.script, `post${invocation.script}`]) {
        const command = manifest.scripts[name];
        if (typeof command !== "string") continue;
        const scriptLabel = `${file} script ${name}`;
        for (const inner of parseShellScript(command, scriptLabel, fail)) {
          const { words } = commandArgv(inner, new Map());
          if (words.length === 0) continue;
          if (resolveWord(words[0], new Map()) !== "node") continue;
          const target = nodeCommandTarget(words, new Map(), scriptLabel, fail);
          if (target.kind !== "script") continue;
          const relative = repositoryRelative(packageDirectory, target.script, scriptLabel, fail);
          if (await recordTarget(relative, scriptLabel)) scriptAuthority.add(file);
        }
      }
    }
  };

  for (const workflowFile of workflowFiles) {
    const text = await readFile(path.join(root, ...workflowFile.split("/")), "utf8");
    const document = parseWorkflowYaml(text, workflowFile, fail);
    for (const step of workflowRunSteps(document, workflowFile, fail)) {
      const environment = new Map(step.environment);
      for (const command of parseShellScript(step.script, step.label, fail)) {
        const { assignments, words } = commandArgv(command, environment);
        for (const assignment of assignments) {
          const value = assignmentValue(assignment, environment);
          if (value === null) environment.delete(assignmentName(assignment));
          else environment.set(assignmentName(assignment), value);
        }
        if (words.length === 0) continue;
        const head = resolveWord(words[0], environment);
        if (head === null) fail(`${step.label} runs a command whose name is not statically known`);
        if (head === "node") {
          const target = nodeCommandTarget(words, environment, step.label, fail);
          if (target.kind !== "script") continue;
          await recordTarget(repositoryRelative(step.directory, target.script, step.label, fail), step.label);
          continue;
        }
        if (head === "npm") {
          const invocation = npmInvocation(words, environment);
          if (invocation.script) await expandPackageScript(invocation, step.directory, step.label);
        }
      }
    }
  }

  for (const file of await workspacePackageFiles(root, packageCache, fail)) {
    const manifest = await readPackageScripts(root, file, packageCache, fail);
    if (!manifest?.name || !publishedPackageNames.includes(manifest.name)) continue;
    const packageDirectory = path.posix.dirname(file);
    for (const name of PUBLISH_LIFECYCLE_SCRIPTS) {
      const command = manifest.scripts[name];
      if (typeof command !== "string") continue;
      const scriptLabel = `${file} script ${name}`;
      for (const inner of parseShellScript(command, scriptLabel, fail)) {
        const { words } = commandArgv(inner, new Map());
        if (words.length === 0 || resolveWord(words[0], new Map()) !== "node") continue;
        const target = nodeCommandTarget(words, new Map(), scriptLabel, fail);
        if (target.kind !== "script") continue;
        if (await recordTarget(repositoryRelative(packageDirectory, target.script, scriptLabel, fail), scriptLabel)) {
          scriptAuthority.add(file);
        }
      }
    }
  }

  return {
    workflowFiles,
    entrypoints: [...entrypoints].sort(),
    scriptAuthorityFiles: [...scriptAuthority].sort(),
    generatedTargets: [...generated].sort(),
  };
}
