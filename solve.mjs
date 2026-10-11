// Can a level be finished? A breadth-first search over the real game engine
// (motion.mjs), so anything it finds can actually be played. Each step is one
// thing a player does: drive a locomotive one step, throw a lever, turn a
// turntable, or couple or uncouple two cars. A step is a whole car length,
// or half of one for levels that need a car stopped across a switch's points
// (`level.solveStep`). Cars start on that grid and stay on it, so the search
// stays finite.
//
// This is for checking levels while designing them, not for the game itself.
import { loadLevel } from "./setup.mjs";
import * as M from "./motion.mjs";

export function solve(level, { maxStates = 2e6 } = {}) {
  const { yard, cars, goals, state: start } = loadLevel(level);
  const STEP = level.solveStep ?? 1;
  const locos = cars.map((c, i) => (c.loco ? i : -1)).filter((i) => i >= 0);
  const key = (st) => st.at.map((p) => `${p.track}:${Math.round(p.s * 1000)}`).join(",")
    + "|" + st.sw.join("") + "|" + st.tt.join(",") + "|" + Object.values(st.face).join(",")
    + "|" + [...st.coupled].sort().join(";") + "|" + st.plateOn.map(Number).join("");
  if (M.goalMet(goals, start)) return { steps: [], states: 1 };
  const parent = new Map([[key(start), null]]);
  let frontier = [start];
  while (frontier.length) {
    const next = [];
    for (const st of frontier) {
      const k0 = key(st);
      const moves = [];
      for (const loco of locos) for (const d of [1, -1]) {
        const n = M.clone(st);
        const r = M.drive(yard, n, loco, d, STEP);
        if (r.moved > STEP - 1e-6) moves.push([n, { drive: loco, d }]);
        // or just up to the next car, when that's less than a step away
        // (cars on a diagonal sit further apart than a step)
        const front = M.group(yard, st, loco, d)[0], fp = st.at[front.c];
        const skip = new Set(M.group(yard, st, loco, d).map((m) => m.c));
        const ahead = M.scan(yard, st, fp.track, fp.s, front.dir, STEP + 1, skip);
        const gap = ahead ? ahead.dist - 1 : Infinity;
        if (gap > 1e-6 && gap < STEP - 1e-6) {
          const m = M.clone(st);
          if (M.drive(yard, m, loco, d, gap).moved > gap - 1e-6) moves.push([m, { drive: loco, d }]);
        }
        // or just far enough to put a goal car right on its marker (markers
        // round a curve sit at odd distances, off the step grid)
        for (const mem of M.group(yard, st, loco, d)) {
          const g = goals.find((x) => x.car === mem.c), p = st.at[mem.c];
          if (!g || p.track !== g.track) continue;
          const ds = (g.s - p.s) * mem.dir;
          if (ds > 1e-6 && ds < STEP - 1e-6) {
            const m = M.clone(st);
            if (M.drive(yard, m, loco, d, ds).moved > ds - 1e-6) moves.push([m, { drive: loco, d }]);
          }
        }
      }
      yard.switches.forEach((S, k) => {
        if (!S.lever) return;
        const n = M.clone(st);
        if (M.throwSwitch(yard, n, k)) moves.push([n, { lever: k }]);
      });
      yard.turntables.forEach((T, k) => {
        if (!T.manual) return;
        const n = M.clone(st);
        if (M.turnTurntable(yard, n, k)) moves.push([n, { turn: k }]);
      });
      for (const j of M.joints(yard, st)) {
        if (Math.abs(j.dist - 1) > 1e-3) continue; // on the grid, everything that can couple is touching
        const n = M.clone(st);
        M.toggleCoupling(n, j.a, j.b);
        moves.push([n, { couple: [j.a, j.b] }]);
      }
      for (const [n, how] of moves) {
        const k = key(n);
        if (parent.has(k)) continue;
        parent.set(k, { from: k0, how });
        if (M.goalMet(goals, n)) {
          const steps = []; let kk = k;
          while (parent.get(kk)) { const p = parent.get(kk); steps.push(p.how); kk = p.from; }
          return { steps: steps.reverse(), states: parent.size };
        }
        next.push(n);
        if (parent.size > maxStates) return { steps: null, states: parent.size, gaveUp: true };
      }
    }
    frontier = next;
  }
  return { steps: null, states: parent.size, impossible: true };
}

// The steps, summarized: how many drives (runs in one direction) and clicks.
export function summarize(steps) {
  let drives = 0, clicks = 0, last = null;
  for (const s of steps) {
    if (s.drive != null) {
      const run = `${s.drive}:${s.d}`;
      if (run !== last) drives++;
      last = run;
    } else { clicks++; last = null; }
  }
  return { drives, clicks };
}
