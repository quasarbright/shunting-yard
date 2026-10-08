import { test } from "node:test";
import assert from "node:assert/strict";
import { LEVELS, ladder } from "./levels.mjs";
import { loadLevel } from "./setup.mjs";
import { buildYard, walk, step, drive, throwSwitch, toggleCoupling, solve, goalMet, switchLocked } from "./yard.mjs";

const level = (start, layout = ladder(3, [3, 3])) =>
  loadLevel({ layout, start, goals: [] });

test("tracks are cut into whole car lengths", () => {
  const y = buildYard(ladder(3, [5, 3, 3]));
  assert.equal(y.tracks.head.slots.length, 3);
  assert.equal(y.tracks.s1.slots.length, 5);
  assert.equal(y.tracks.s3.slots.length, 3);
});

test("neighboring slots are exactly one car length apart, across switches too", () => {
  for (const lv of LEVELS) {
    const yard = buildYard(lv.layout);
    for (const sw of [yard.switches.map(() => 0), yard.switches.map(() => 1)]) {
      for (const sl of yard.slots) for (const d of [1, -1]) {
        const nx = step(yard, sl.id, d, sw);
        if (!nx) continue;
        const p = walk(yard, sl.track, sl.s, d, 1, sw), q = yard.slots[nx.slot];
        assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 1e-6, `${lv.name}: slot ${sl.id} → ${q.id}`);
      }
    }
  }
});

test("through the points from the trunk shoves a car on the other leg along; down a leg it's blocked", () => {
  const { yard, state } = level({ head: ". . L", s2: "A" });
  assert.notEqual(drive(yard, state, 0, 1), null);
  assert.equal(state.pos[1], yard.tracks.s2.slots[1]);
  const full = level({ head: ". . L", s2: "A B C" });
  assert.equal(drive(full.yard, full.state, 0, 1), null);
  const down = level({ s1: ". L", s2: "A" });
  assert.equal(drive(down.yard, down.state, 0, -1), null);
});

test("a loco pushes whatever it touches but only pulls what's coupled", () => {
  const { yard, state } = level({ head: "L A B" });
  const [L, A, B] = [0, 1, 2];
  const before = state.pos.slice();
  assert.notEqual(drive(yard, state, L, 1), null);
  assert.deepEqual(state.pos, before.map((s) => s + 1)); // all three shifted along the head
  drive(yard, state, L, -1);
  assert.equal(state.pos[L], before[L]);
  assert.equal(state.pos[A], before[A] + 1); // left behind
  toggleCoupling(state, L, A);
  drive(yard, state, L, 1); // back up against A
  drive(yard, state, L, -1);
  assert.equal(state.pos[A], before[A]);
  assert.equal(state.pos[B], before[B] + 1); // not coupled to A
});

test("buffers stop a train", () => {
  const { yard, state } = level({ head: "L" });
  assert.equal(drive(yard, state, 0, -1), null);
});

test("trailing into a switch set the other way is blocked", () => {
  const { yard, state } = level({ s2: "L" });
  assert.equal(drive(yard, state, 0, -1), null);
  state.sw[0] = 1;
  assert.notEqual(drive(yard, state, 0, -1), null);
});

test("switches can't be thrown with cars across the points", () => {
  const { yard, state } = level({ head: ". . L", s1: "A" });
  assert.ok(!switchLocked(yard, state, 0)); // touching across, but not coupled
  toggleCoupling(state, 0, 1);
  assert.ok(switchLocked(yard, state, 0));
  assert.equal(throwSwitch(yard, state, 0), false);
  const free = level({ head: ". . L", s2: "A" });
  assert.ok(throwSwitch(free.yard, free.state, 0)); // A is on the other leg
});

test("every level's fewest moves is the solver's answer", () => {
  for (const lv of LEVELS) {
    if (lv.fewest == null || (lv.fewest > 12 && !process.env.SLOW)) continue;
    const { yard, cars, goals, state } = loadLevel(lv);
    assert.ok(!goalMet(yard, cars, goals, state.pos), `${lv.name} starts solved`);
    assert.equal(solve(yard, cars, state, goals).moves, lv.fewest, lv.name);
  }
});
