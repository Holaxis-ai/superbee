// Dispatch-layer unit tests for cli.ts's leading-global-flag hoist (cold-start study r3: `--dir x
// list` used to error "options must follow the command"; it now behaves like `list --dir x`).
import test from "node:test";
import assert from "node:assert/strict";
import { hoistLeadingGlobalFlags } from "../src/cli.js";

test("hoistLeadingGlobalFlags: reorders [global flags] <known-subcommand> so `--dir x list` runs like `list --dir x`", () => {
  assert.deepEqual(hoistLeadingGlobalFlags(["--dir", "x", "list"]), ["list", "--dir", "x"]);
  // The leading flag block moves to the END (after the full command path), so the subcommand's own
  // flags keep their place and TWO-WORD commands (`doc read`) don't get the flags spliced mid-path.
  assert.deepEqual(
    hoistLeadingGlobalFlags(["--dir", "x", "list", "--type", "Task"]),
    ["list", "--type", "Task", "--dir", "x"],
  );
  assert.deepEqual(hoistLeadingGlobalFlags(["--json", "--remote", "u", "status"]), ["status", "--json", "--remote", "u"]);
  // Round-4 regression: a two-word command must land as `doc read y --dir x`, NOT `doc --dir x read y`.
  assert.deepEqual(hoistLeadingGlobalFlags(["--dir", "x", "doc", "read", "y"]), ["doc", "read", "y", "--dir", "x"]);
  assert.deepEqual(hoistLeadingGlobalFlags(["--dir", "x", "bundle", "locate"]), ["bundle", "locate", "--dir", "x"]);
  assert.deepEqual(hoistLeadingGlobalFlags(["--dir", "x", "catalog", "add", "mine"]), ["catalog", "add", "mine", "--dir", "x"]);
});

test("hoistLeadingGlobalFlags: returns null (existing USAGE error still fires) for a non-command first positional or no subcommand", () => {
  assert.equal(hoistLeadingGlobalFlags(["--bogus", "x", "list"]), null); // --bogus leaks 'x' as the first positional — not a known command
  assert.equal(hoistLeadingGlobalFlags(["--dir", "x", "notacommand"]), null); // first positional isn't a known command
  assert.equal(hoistLeadingGlobalFlags(["--dir", "x"]), null); // global flags only, no subcommand (that path routes to home)
});
