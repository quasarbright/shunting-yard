// Every level can actually be finished in the game. For each, find a solution
// in the slot model (yard.mjs: fewest drives, switches and couplings free), then
// play it move by move in the real engine (motion.mjs) and check the goal is met
// there. Slow (about a minute): runs only with SLOW=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEVELS } from "./levels.mjs";
import { loadLevel } from "./setup.mjs";
import { driveChain, drive, goalMet, occupancy } from "./yard.mjs";
import * as M from "./motion.mjs";

function verify(lv, maxStates = 5e6) {
  const { yard, cars, goals, state } = loadLevel(lv);
  const nSw = yard.switches.length;
  const combos = []; for (let m = 0; m < (1 << nSw); m++) combos.push([...Array(nSw)].map((_, k) => (m >> k) & 1));
  const key = (pos) => pos.join(",");
  const parent = new Map([[key(state.pos), null]]);
  let frontier = [state.pos.slice()], found = null, depth = 0;
  while (frontier.length && !found) {
    depth++;
    const next = [];
    for (const pos of frontier) {
      if (found) break;
      const occ = occupancy(yard, pos);
      for (const sw of combos) for (const d of [1, -1]) {
        const all = driveChain(yard, { pos, sw, coupled: new Set() }, 0, d, occ, true);
        const at = all.chain.indexOf(0), maxPull = all.chain.length - 1 - at;
        for (let pull = 0; pull <= maxPull && !found; pull++) {
          const pairs = []; for (let k = at; k < at + pull; k++) pairs.push([all.chain[k], all.chain[k + 1]]);
          const st = { pos: pos.slice(), sw, coupled: new Set(pairs.map(([a, b]) => (a < b ? `${a},${b}` : `${b},${a}`))) };
          let dir = d, steps = 0;
          for (;;) {
            dir = drive(yard, st, 0, dir); if (dir === null) break; steps++;
            const k = key(st.pos); if (parent.has(k)) continue;
            parent.set(k, { from: key(pos), sw, d, pairs, steps });
            if (goalMet(yard, cars, goals, st.pos)) { found = k; break; }
            next.push(st.pos.slice());
          }
        }
        if (found) break;
      }
      if (parent.size > maxStates) return { result: "gave up", states: parent.size };
    }
    frontier = next;
  }
  if (!found) return { result: "impossible (slot model)", states: parent.size };
  const plan = []; let k = found; while (parent.get(k)) { const p = parent.get(k); plan.push(p); k = p.from; } plan.reverse();
  // play it in the real engine
  const ms = M.fromSlots(yard, state);
  let clicks = 0;
  for (const [i, p] of plan.entries()) {
    // couplings: exactly the pull chain (uncouple first: a coupling across a switch locks it)
    const want = new Set(p.pairs.map(([a, b]) => (a < b ? `${a},${b}` : `${b},${a}`)));
    for (const kk of [...ms.coupled]) if (!want.has(kk)) { ms.coupled.delete(kk); clicks++; }
    for (let s = 0; s < nSw; s++) if (ms.sw[s] !== p.sw[s]) { if (!M.throwSwitch(yard, ms, s)) return { result: `real engine: switch locked at drive ${i + 1}` }; clicks++; }
    for (const kk of want) if (!ms.coupled.has(kk)) {
      const [a, b] = kk.split(",").map(Number);
      if (!M.joints(yard, ms).some((j) => (j.a === a && j.b === b) || (j.a === b && j.b === a))) return { result: `real engine: can't reach to couple at drive ${i + 1}` };
      ms.coupled.add(kk); clicks++;
    }
    // the slot model's d is relative to the loco's slot track; so is the engine's
    let dir = p.d;
    for (let s = 0; s < p.steps; s++) {
      const r = M.drive(yard, ms, 0, dir, 1);
      if (r.moved < 1 - 1e-6) return { result: `real engine: blocked (${r.stop?.why} at ${r.stop?.node}) at drive ${i + 1}, step ${s + 1}` };
      dir = r.dir;
    }
  }
  return { result: M.goalMet(yard, cars, goals, ms) ? "playable" : "real engine: goal not met at the end", drives: depth, clicks };
}


for (const lv of LEVELS) {
  test(`${lv.name} can be finished`, { skip: !process.env.SLOW }, () => {
    assert.equal(verify(lv).result, "playable");
  });
}
