// The level files: each one loads, doesn't start finished, and (with SLOW=1)
// can be finished. The solver searches the real engine, so a solution it
// finds can be played.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadLevel } from "./setup.mjs";
import { goalMet } from "./motion.mjs";
import { solve } from "./solve.mjs";

const dir = new URL("./levels/", import.meta.url);
export const ORDER = JSON.parse(readFileSync(new URL("order.json", dir)));
export const level = (id) => JSON.parse(readFileSync(new URL(`${id}.level.json`, dir)));

// how the solver steps for levels whose trick is a car stopped half a car along
const SOLVE_STEP = { "block-one": 0.5, "merry-go-round": 0.5, "turn-around": 0.5 };
// too big for the solver to finish
const TOO_BIG = new Set(["tight-squeeze"]);

for (const id of ORDER) {
  test(`${id} loads and isn't already finished`, () => {
    const { goals, state } = loadLevel(level(id));
    assert.ok(goals.length, "has goals");
    assert.ok(!goalMet(goals, state));
  });
  test(`${id} can be finished`, { skip: !process.env.SLOW || (TOO_BIG.has(id) && "too big to search") }, () => {
    const r = solve({ ...level(id), solveStep: SOLVE_STEP[id] }, { maxStates: 3e6 });
    assert.ok(r.steps, `${r.impossible ? "impossible" : "search gave up"} after ${r.states} positions`);
  });
}
