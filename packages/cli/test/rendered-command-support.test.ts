/**
 * Direct tests for the test-support helpers.
 *
 * These are INSTRUMENTS: `extractSerializedField` decides what three other tests believe an emitted
 * command was, and `parseCommandLine` decides what a shell would have delivered. A silently wrong
 * instrument does not fail — it makes its callers pass confidently on a wrong answer. That is the
 * single most repeated failure shape in this change, so the instruments are pinned directly rather
 * than covered incidentally through their callers.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeSerializedScalar, escapeForRegExp, extractSerializedField, parseCommandLine,
} from "./support/rendered-command.js";

const COMMAND_WIN = 'superbee doc update tasks/x --progress_status "<todo|done>"';
const COMMAND_POSIX = "superbee doc update tasks/x --progress_status '<todo|done>'";

test("decode: a Windows-serialized scalar and a POSIX bare scalar both yield the command itself", () => {
  // TOON/JSON quote-and-escape a scalar containing `"`; a POSIX token contains only `'`, so its
  // scalar is emitted bare. Both must decode to the command, not to its envelope.
  assert.equal(decodeSerializedScalar(JSON.stringify(COMMAND_WIN)), COMMAND_WIN);
  assert.equal(decodeSerializedScalar(COMMAND_POSIX), COMMAND_POSIX);
});

test("decode: an escaped quote inside the value survives the round trip", () => {
  const value = 'a "quoted" b \\ c';
  assert.equal(decodeSerializedScalar(JSON.stringify(value)), value);
});

test("extract: reads the field from a real envelope on either platform", () => {
  const win = `error:\n  code: USAGE\n  help: ${JSON.stringify(COMMAND_WIN)}\n`;
  const posix = `error:\n  code: USAGE\n  help: ${COMMAND_POSIX}\n`;
  assert.equal(extractSerializedField(win, "help"), COMMAND_WIN);
  assert.equal(extractSerializedField(posix, "help"), COMMAND_POSIX);
});

test("extract: a field name that is a prefix or suffix of another does not cross-match", () => {
  const output = "  help_text: WRONG\n  extra_help: WRONG\n  help: RIGHT\n";
  assert.equal(extractSerializedField(output, "help"), "RIGHT");
  assert.equal(extractSerializedField("  help_text: ONLY\n", "help"), undefined);
});

test("extract: the field name is a NAME, not a pattern", () => {
  // Without escaping, `a.b` would match a line called `axb` and return a confidently wrong value.
  assert.equal(extractSerializedField("  axb: WRONG\n", "a.b"), undefined);
  assert.equal(extractSerializedField("  a.b: RIGHT\n", "a.b"), "RIGHT");
  assert.equal(escapeForRegExp("a.b"), String.raw`a\.b`);
});

test("extract: only whitespace may precede the field on its own line", () => {
  assert.equal(extractSerializedField("\terror_help: WRONG\n\thelp: RIGHT\n", "help"), "RIGHT");
  assert.equal(extractSerializedField("x help: WRONG\n", "help"), undefined);
});

test("extract: a missing field returns undefined rather than something plausible", () => {
  assert.equal(extractSerializedField("error:\n  code: USAGE\n", "help"), undefined);
  assert.equal(extractSerializedField("", "help"), undefined);
  // Not an empty string, which a caller could mistake for "the command was empty".
  assert.notEqual(extractSerializedField("error:\n", "help"), "");
});

/**
 * The limit, pinned rather than assumed away: a line regex cannot tell a real field from a line
 * that merely looks like one inside another field's value. Both the loose (`\s*`) and tight
 * (`[ \t]*`) anchors behave identically here — which is also the evidence that tightening the
 * anchor was a clarity change, not a bug fix.
 */
test("extract: a field-looking line inside another value is a documented limit, not a silent one", () => {
  const output = '  message: "see\n  help: DECOY"\n  help: REAL\n';
  assert.equal(extractSerializedField(output, "help"), 'DECOY"');
});

test("parseCommandLine: splits the way a shell does, for both quoting conventions", () => {
  assert.deepEqual(parseCommandLine(COMMAND_POSIX),
    ["superbee", "doc", "update", "tasks/x", "--progress_status", "<todo|done>"]);
  assert.deepEqual(parseCommandLine(COMMAND_WIN),
    ["superbee", "doc", "update", "tasks/x", "--progress_status", "<todo|done>"]);
  // An embedded quote in each convention, and an empty argument.
  assert.deepEqual(parseCommandLine(String.raw`a 'b'\''c' d`), ["a", "b'c", "d"]);
  assert.deepEqual(parseCommandLine('a "b""c" d'), ["a", 'b"c', "d"]);
  assert.deepEqual(parseCommandLine("a '' b"), ["a", "", "b"]);
});
