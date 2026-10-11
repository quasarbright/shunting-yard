import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLevel } from "./setup.mjs";
import { buildYard } from "./yard.mjs";
import { drive, toggleCoupling, switchLocked, throwSwitch, joints, goalMet, turnTurntable, turntableLocked, FOUL, REACH, POINTS, BODY } from "./motion.mjs";

// A headshunt from 0 to the switch at 4 (its points at 3.5), a straight
// siding on to 7, and one that curves down a row to 8.
// Spots: head 0.5 1.5 2.5; straight siding 4.5 5.5 6.5;
// curved siding [4.5, 0.5] on the diagonal, then 5.5 6.5 7.5 on row 1.
const LADDER = [[[0, 0], [7, 0]], [[4, 0], [5, 1], [8, 1]]];
const loco = (x, y, coupler = "E") => ({ at: [x, y], kind: "locomotive", coupler });
const car = (x, y, name) => ({ at: [x, y], ...(name ? { name } : {}) });
const setup = (cars, extra = {}) => {
  const lv = loadLevel({ track: LADDER, cars, ...extra });
  return { yard: lv.yard, state: lv.state, goals: lv.goals };
};
const pairs = (yard, state) => joints(yard, state).map((j) => [j.a, j.b].sort().join("-")).sort();
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
// how far a car's center is from a node at one end of its track
const toNode = (yard, p, id) => (yard.tracks[p.track].from === id ? p.s : yard.tracks[p.track].len - p.s);
const SW = "4,0";

test("the loco stops exactly where it's driven to", () => {
  const { yard, state } = setup([loco(0.5, 0)]);
  const s0 = state.at[0].s;
  const r = drive(yard, state, 0, 1, 0.37);
  near(r.moved, 0.37, "moved");
  near(state.at[0].s, s0 + 0.37, "position");
});

test("pushing moves an uncoupled car; backing off leaves it where it was pushed", () => {
  const { yard, state } = setup([loco(0.5, 0), car(2.5, 0, "A")]);
  const a0 = state.at[1].s;
  drive(yard, state, 0, 1, 1.4); // 1 car of gap, then 0.4 of pushing
  near(state.at[1].s, a0 + 0.4, "A pushed");
  drive(yard, state, 0, -1, 0.8);
  near(state.at[1].s, a0 + 0.4, "A stays put");
});

test("coupled cars move rigidly both ways, across a switch and round its curve", () => {
  const { yard, state } = setup([loco(0.5, 0), car(1.5, 0, "A"), car(2.5, 0, "B")]);
  state.sw[0] = 1;
  toggleCoupling(state, 0, 1); toggleCoupling(state, 1, 2);
  for (const [d, amt] of [[1, 2.3], [-1, 1.1], [1, 0.6]]) {
    drive(yard, state, 0, d, amt);
    assert.equal(joints(yard, state).length, 2, "still touching after each drive");
  }
});

test("buffers stop a train", () => {
  const { yard, state } = setup([loco(1.5, 0)]);
  const r = drive(yard, state, 0, -1, 5);
  near(r.moved, 1, "rolls until it touches the buffer");
  assert.equal(r.stop.why, "buffer");
});

test("a car on the points locks the switch; next to it doesn't", () => {
  const { yard, state } = setup([loco(2.5, 0)]);
  assert.ok(!switchLocked(yard, state, 0));
  drive(yard, state, 0, 1, 0.6); // now overhangs the points
  assert.ok(switchLocked(yard, state, 0));
  assert.equal(throwSwitch(yard, state, 0), false);
  drive(yard, state, 0, 1, 0.5); // on the leg, but still over the switch's own stretch of it
  assert.ok(switchLocked(yard, state, 0));
  drive(yard, state, 0, 1, 1); // clear of it
  assert.ok(!switchLocked(yard, state, 0));
});

test("a car starting right on the points is in the way from either leg", () => {
  const { yard, state } = setup([car(3.5, 0, "A"), loco(4.5, 0)]);
  assert.ok(switchLocked(yard, state, 0));
  const r = drive(yard, state, 1, -1, 0.5);
  near(r.moved, 0.5, "pushes it");
  near(toNode(yard, state.at[0], SW), 0.5, "A pushed back along the trunk");
});

test("coming through the points from the trunk shoves a car near the points up the other leg", () => {
  const { yard, state } = setup([loco(2.5, 0), car(4.5, 0.5, "A")]);
  const r = drive(yard, state, 0, 1, 2);
  near(r.moved, 2, "loco carries on");
  near(toNode(yard, state.at[1], SW), FOUL + 0.5, "A shoved just clear of the points");
  const far = setup([loco(2.5, 0), car(5.5, 1, "A")]);
  const a1 = far.state.at[1].s;
  drive(far.yard, far.state, 0, 1, 2);
  near(far.state.at[1].s, a1, "a car already clear isn't touched");
});

test("the shove carries on after the nose reaches a track between two switches", () => {
  // the locomotive goes through the first switch onto the short lead to the
  // second, with D parked beside the first switch on the straight siding
  const lv = loadLevel({
    track: [[[0, 0], [8, 0]], [[4, 0], [5, 1], [9, 1]], [[6, 1], [7, 2], [10, 2]]],
    cars: [loco(2.5, 0), car(4.5, 0, "D")],
  });
  const { yard, state } = lv;
  state.sw[0] = 1; // toward the lead
  drive(yard, state, 0, 1, 2);
  near(toNode(yard, state.at[1], SW), FOUL + 0.5, "D shoved fully clear, not left half in the way");
});

test("the shove stops if the car it shoves can't move", () => {
  const { yard, state } = setup([loco(2.5, 0), car(4.5, 0.5, "A"), car(5.5, 1, "B"), car(6.5, 1, "C"), car(7.5, 1, "D")]);
  // A is on the diagonal, a little short of touching B
  const a = toNode(yard, state.at[1], SW), slack = toNode(yard, state.at[2], SW) - a - 1;
  const r = drive(yard, state, 0, 1, 2);
  near(r.moved, a + slack, "nose stops where A, shoved up against B, is still in the way");
  assert.equal(r.stop.why, "foul");
});

test("coming down a leg into the side of a car on the other leg is blocked", () => {
  const { yard, state } = setup([loco(5.5, 0), car(4.5, 0.5, "A")]);
  const a0 = state.at[1].s;
  const r = drive(yard, state, 0, -1, 2);
  assert.equal(r.stop.why, "foul");
  near(state.at[1].s, a0, "A not moved");
  assert.ok(r.moved < 1, "stopped short of the points");
});

test("against a switch set the other way, the train stops at the points", () => {
  const { yard, state } = setup([loco(5.5, 1)]);
  const r = drive(yard, state, 0, -1, 5);
  assert.equal(r.stop.why, "against");
  near(toNode(yard, state.at[0], SW), POINTS + BODY / 2, "drawn nose at the end of the drawn track");
  assert.ok(!switchLocked(yard, state, 0), "and so not blocking the switch");
});

test("done means every goal car is on its own marker, hardly hanging over it", () => {
  const { state, goals } = setup([loco(0.5, 0), car(5.5, 0, "A"), car(6.5, 0, "B")],
    { goals: [{ at: [5.5, 0], name: "A" }, { at: [6.5, 0], name: "B" }] });
  assert.ok(goalMet(goals, state), "on the markers: done");
  state.at[1].s -= 0.08; state.at[2].s -= 0.08; // a hair over the marker's end: still done
  assert.ok(goalMet(goals, state));
  state.at[1].s -= 0.1; state.at[2].s -= 0.1; // more of the car off the marker: not done
  assert.ok(!goalMet(goals, state));
});

test("cars a little apart are in reach to couple; farther apart they aren't", () => {
  const { yard, state } = setup([loco(0.5, 0)]);
  state.at.push({ track: state.at[0].track, s: state.at[0].s + 1 + REACH * 0.8 });
  assert.equal(joints(yard, state).length, 1, "in reach");
  state.at[1].s += REACH * 0.5;
  assert.equal(joints(yard, state).length, 0, "out of reach");
});

test("a locomotive couples only on its coupler end, and pushes with both", () => {
  // cars: 0 is the gray car, 1 the locomotive, 2 is A
  const front = setup([car(0.5, 0), loco(1.5, 0, "E"), car(2.5, 0, "A")]); // coupler toward A
  assert.deepEqual(pairs(front.yard, front.state), ["1-2"], "only the coupler side can couple");
  const back = setup([car(0.5, 0), loco(1.5, 0, "W"), car(2.5, 0, "A")]); // coupler toward the gray car
  assert.deepEqual(pairs(back.yard, back.state), ["0-1"]);
  // pushing A with the end that has no coupler still works
  const a0 = back.state.at[2].s;
  drive(back.yard, back.state, 1, 1, 0.5);
  near(back.state.at[2].s, a0 + 0.5, "A pushed by the end with no coupler");
});

test("a locomotive keeps its coupler on the same end as it rolls onto a track running the other way", () => {
  // two tracks joined head to head: the second one runs right to left
  const yard = buildYard({ nodes: { A: [0, 0], J: [3, 0], B: [6, 0] }, tracks: [{ id: "one", from: "A", to: "J" }, { id: "two", from: "B", to: "J" }], switches: {} });
  const state = { at: [{ track: "one", s: 0.5 }], sw: [], tt: [], face: { 0: 1 }, coupled: new Set(), plateOn: [] };
  drive(yard, state, 0, 1, 3);
  assert.equal(state.at[0].track, "two");
  assert.equal(state.face[0], -1, "still facing the way it's going, which is -1 on track two");
});

// A turntable two cars long with exits west, east and north.
const TABLE = {
  track: [[[-6, 0], [-2, 0]], [[2, 0], [6, 0]], [[0, -2], [0, -6]]],
  turntables: [{ at: [0, 0], length: 2, exits: ["W", "E", "N"] }],
};

test("a turntable carries a locomotive round, and turns it", () => {
  const { yard, state } = loadLevel({ ...TABLE, cars: [loco(-2.5, 0)] });
  const T = yard.turntables[0];
  near(drive(yard, state, 0, 1, 2).moved, 2, "on to the deck");
  assert.equal(state.at[0].track, T.deck);
  // turn until the deck lines up with the north exit
  let guard = 0;
  while (T.stops[state.tt[0]].a !== 2 && T.stops[state.tt[0]].b !== 2 && guard++ < 8) assert.ok(turnTurntable(yard, state, 0));
  const d = T.stops[state.tt[0]].a === 2 ? -1 : 1; // toward whichever end of the deck faces north
  const r = drive(yard, state, 0, d, 2);
  near(r.moved, 2, "off the deck onto the north exit");
  const t = yard.tracks[state.at[0].track];
  assert.ok([t.from, t.to].includes(`${T.id}.2`), "on the north exit's track");
});

test("a turntable won't turn with a car hanging off it", () => {
  const { yard, state } = loadLevel({ ...TABLE, cars: [loco(-2.5, 0)] });
  drive(yard, state, 0, 1, 1.6); // half on the deck
  assert.ok(turntableLocked(yard, state, 0));
  drive(yard, state, 0, 1, 1.4); // all the way on
  assert.ok(!turntableLocked(yard, state, 0));
});

test("rolling onto a plate throws the switches wired to it, once per train", () => {
  const { yard, state } = setup([loco(0.5, 0), car(1.5, 0, "A")], { plates: [{ at: [2.5, 0], wires: [[4, 0]] }] });
  toggleCoupling(state, 0, 1);
  assert.equal(state.sw[0], 0);
  // the coupled pair rolls over the plate: one train, one throw
  const r = drive(yard, state, 0, 1, 2);
  assert.equal(r.events.length, 1);
  assert.equal(state.sw[0], 1);
  assert.ok(!yard.switches[0].lever, "a switch a plate drives has no lever");
});

test("a plate can't throw a switch with a car on its points; the other one still goes", () => {
  const { yard, state } = loadLevel({
    track: [[[0, 0], [8, 0]], [[5, 0], [6, 1], [10, 1]], [[7, 1], [8, 2], [11, 2]]],
    plates: [{ at: [1.5, 0], wires: [[5, 0], [7, 1]] }],
    cars: [loco(0.5, 0), car(5.5, 0.5, "A")],
  });
  // put A across the second switch's points (it starts in the middle of the lead)
  state.at[1].s += 0.8;
  assert.ok(switchLocked(yard, state, 1));
  assert.ok(!switchLocked(yard, state, 0));
  drive(yard, state, 0, 1, 1.2);
  assert.equal(state.sw[0], 1, "first switch thrown");
  assert.equal(state.sw[1], 0, "second held by the car on it");
});
