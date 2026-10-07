import assert from "node:assert/strict";

/** A sweep completes only after every numbered kill point and a successful terminal child. */
export class CrashSweepProgress {
  steps = 0;
  completed = false;

  private readonly options: { singlePoint?: boolean };

  constructor(options: { singlePoint?: boolean } = {}) {
    this.options = options;
  }

  observe(killAt: number, result: { signal: NodeJS.Signals | null; code: number | null; stderr: string }): void {
    assert.equal(this.completed, false, "child launched after sweep completed");
    if (result.signal === "SIGKILL") {
      assert.match(result.stderr, new RegExp(`QA_KILL ${killAt} `), "child must reach the requested kill point");
      return;
    }
    assert.equal(result.signal, null, `unexpected child signal: ${result.stderr}`);
    assert.equal(result.code, 0, `uninterrupted child failed: ${result.stderr}`);
    const match = /QA_STEPS (\d+)/.exec(result.stderr);
    assert.ok(match, "uninterrupted child must report its side effects");
    this.steps = Number(match[1]);
    assert.ok(this.steps > 0, "sweep must exercise positive side effects");
    if (this.options.singlePoint) {
      assert.ok(this.steps < killAt, "selected kill point must exceed completed side effects");
    } else {
      assert.equal(this.steps, killAt - 1, "terminal child must follow the final kill point");
    }
    this.completed = true;
  }

  assertComplete(): void {
    assert.equal(this.completed, true, "crash sweep exhausted its kill-point cap without successful completion");
  }
}
