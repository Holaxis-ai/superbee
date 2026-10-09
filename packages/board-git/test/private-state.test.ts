// The publication-side private-state detector (specification F8/P11) as a row table, plus the push
// backstop every board push runs, exercised below the CLI so a caller that skips its own check
// (the moved-marker push, a future publisher) is still covered.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  isBoardGitError,
  isPrivateStateRefusal,
  privateStateFinding,
  privateStateInOutgoingCommits,
  push,
  pushBoardCommit,
  type PrivateStateEvidence,
} from "../src/index.js";
import { BOARD_BRANCH, commitBoard, git, makeTwoCloneTopology, originBoardHead } from "./git-harness.js";

const MARKER = '{"product":"superbee","schema_version":1}\n';

// [label, relative path, bytes, expected evidence (null = not private state)]
const ROWS: ReadonlyArray<readonly [string, string, string, PrivateStateEvidence | null]> = [
  ["canonical root folder, any file", "x/.superbee-state/anything.txt", "hi", "state_folder"],
  ["legacy root folder, case-folded", "x/.AgentState/catalog.json", "{}", "state_folder"],
  ["credential file by name", "okf-config.json", "", "credential_file"],
  ["credential file by name, case-folded", "a/OKF-Config.JSON", "x", "credential_file"],
  ["marker on its prefix even when truncated", "m.json", '{"product":"superbee","sch', "state_marker"],
  ["marker reformatted", "m.json", '﻿{ "schema_version": 1, "product": "superbee" }', "state_marker"],
  ["API-key credentials under any name", "c.json", '{"remotes":{"https://a.example":{"api_key":"k"}}}', "api_key_credentials"],
  ["hosted session", "s.json", '{"access_token":"t","access_token_expires_at_ms":5}', "hosted_session"],
  ["hosted refresh token", "r.json", '{"account":"a b","refresh_token":"r"}', "hosted_refresh_token"],
  ["older bearer credential", "b.json", '{"server":"https://s","access_token":"t"}', "bearer_credentials"],
  ["workspace catalog", "w.json", '{"schema_version":1,"entries":[{"id":"bnd_x","label":"l","locator":{"kind":"local-path","path":"/p"}}]}', "workspace_catalog"],
  ["empty workspace catalog", "w.json", '{"schema_version":1,"entries":[]}', "workspace_catalog"],
  ["CONTROL: a bundle dir named like the product", ".superbee/index.md", "# x", null],
  ["CONTROL: the legacy BUNDLE dir", ".agentstate-lite/index.md", "# x", null],
  ["CONTROL: a project binding file", ".agentstate.json", '{"bundle":"x"}', null],
  ["CONTROL: another product's marker", "m.json", '{"product":"other","schema_version":1}', null],
  ["CONTROL: remotes without keys", "r.json", '{"remotes":{"a":{"url":"u"}}}', null],
  ["CONTROL: a list with other keys", "l.json", '{"schema_version":1,"entries":[],"extra":true}', null],
  ["CONTROL: a document mentioning the names", "notes/n.md", "---\ntype: Note\n---\n~/.superbee-state/okf-config.json\n", null],
  ["CONTROL: not JSON", "a.txt", "access_token refresh_token api_key", null],
];

test("F8 detector: one row per evidence class, with controls", () => {
  for (const [label, relPath, bytes, expected] of ROWS) {
    assert.equal(privateStateFinding(relPath, Buffer.from(bytes, "utf8"))?.evidence ?? null, expected, label);
  }
});

test("F8 detector: a name match names the state FOLDER to move, not each file in it", () => {
  assert.equal(privateStateFinding("notes/.superbee-state/sub/x.json", null)?.remove, "notes/.superbee-state");
});

test("F8 push backstop: every board push refuses objects carrying private state, before sending", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    const before = originBoardHead(topo);
    await mkdir(path.join(topo.a.board, "kept"), { recursive: true });
    await writeFile(path.join(topo.a.board, "kept", "owner.json"), MARKER);
    const head = commitBoard(topo.a, "marker by hand");
    assert.deepEqual(privateStateInOutgoingCommits(topo.a.board, head).map((row) => row.path), ["kept/owner.json"]);
    for (const attempt of [() => push(topo.a.board), () => push(topo.a.board, head, BOARD_BRANCH), () => pushBoardCommit(topo.a.root, head)]) {
      assert.throws(attempt, (error: unknown) => {
        assert.ok(isBoardGitError(error) && error.code === "CONFLICT", String(error));
        assert.ok(isPrivateStateRefusal(error));
        assert.match(error.message, /'kept\/owner\.json'.*private-state ownership marker/);
        return true;
      });
    }
    assert.equal(originBoardHead(topo), before, "nothing reached origin");
    // Objects origin already has are not re-judged: once removed and pushed, later pushes pass.
    git(topo.a.board, ["reset", "-q", "--hard", "origin/board"]);
    await writeFile(path.join(topo.a.board, "plain.json"), '{"ok":true}\n');
    commitBoard(topo.a, "ordinary file");
    push(topo.a.board);
    assert.notEqual(originBoardHead(topo), before);
  } finally {
    await topo.cleanup();
  }
});
