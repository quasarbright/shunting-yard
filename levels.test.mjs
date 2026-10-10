// Every level can be finished in the game: the solver searches the real
// engine, so a solution it finds can be played. Slow: runs only with SLOW=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEVELS } from "./levels.mjs";
import { solve } from "./solve.mjs";

for (const lv of LEVELS) {
  test(`${lv.name} can be finished`, { skip: !process.env.SLOW || (lv.searchTooBig && "too big to search; see the note in levels.mjs") }, () => {
    const r = solve(lv, { maxStates: 3e6 });
    assert.ok(r.steps, `${lv.name}: ${r.impossible ? "impossible" : "search gave up"} after ${r.states} positions`);
  });
}
