import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function probe(source: string): void {
  const result = spawnSync(process.execPath, ["--import", fileURLToPath(new URL("./ts-loader.mjs", import.meta.url)), "--input-type=module", "-e", source], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
}

test("source composition shares identity with private-state selection and never invents a worker entry", () => {
  for (const name of ["superbee", "@holaxis/aslite"]) {
    probe(`import assert from 'node:assert/strict';
      import {configureSourceIdentity, staticBuildIdentity, currentExecutableRealPath} from './src/index.ts';
      import {userStateDir, userStateDirForPackage} from './src/user-state.ts';
      configureSourceIdentity({name:${JSON.stringify(name)},version:'1.2.3'});
      assert.equal(staticBuildIdentity().package.name, ${JSON.stringify(name)});
      assert.equal(userStateDir('/temporary-home'), userStateDirForPackage('/temporary-home', ${JSON.stringify(name)}));
      assert.equal(currentExecutableRealPath(), undefined);
      configureSourceIdentity({name:${JSON.stringify(name)},version:'1.2.3'});
      assert.throws(() => configureSourceIdentity({name:'different',version:'1.2.3'}), /already/);
    `);
  }
});

test("late source identity and invalid identity are refused independently of declaration checking", () => {
  probe(`import assert from 'node:assert/strict';
    import {configureSourceIdentity, cliVersion} from './src/index.ts';
    assert.throws(() => configureSourceIdentity({name:'Invalid Name',version:'1.2.3'}), /valid/);
    assert.equal(cliVersion(), 'unknown');
    assert.throws(() => configureSourceIdentity({name:'superbee',version:'1.2.3'}), /already/);
  `);
});
