import { test } from "node:test";
import assert from "node:assert/strict";
import { ladder, LEVELS } from "./levels.mjs";
import { loadLevel } from "./setup.mjs";
import { fromSlots, drive, toggleCoupling, switchLocked, throwSwitch, joints, goalMet, turnTurntable, turntableLocked, FOUL, BLANK, REACH } from "./motion.mjs";

const setup = (start, layout = ladder(3, [3, 3])) => {
  const lv = loadLevel({ layout, start, goals: [] });
  return { yard: lv.yard, state: fromSlots(lv.yard, lv.state) };
};
const pairs = (yard, state) => joints(yard, state).map((j) => [j.a, j.b].sort().join("-")).sort();
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

test("the loco stops exactly where it's driven to", () => {
  const { yard, state } = setup({ head: "L" });
  const s0 = state.at[0].s;
  const r = drive(yard, state, 0, 1, 0.37);
  near(r.moved, 0.37, "moved");
  near(state.at[0].s, s0 + 0.37, "position");
});

test("pushing moves an uncoupled car; backing off leaves it where it was pushed", () => {
  const { yard, state } = setup({ head: "L . A" });
  const a0 = state.at[1].s;
  drive(yard, state, 0, 1, 1.4); // 1 car of gap, then 0.4 of pushing
  near(state.at[1].s, a0 + 0.4, "A pushed");
  drive(yard, state, 0, -1, 0.8);
  near(state.at[1].s, a0 + 0.4, "A stays put");
});

test("coupled cars move rigidly both ways, across a switch", () => {
  const { yard, state } = setup({ head: "L A B" });
  state.sw[0] = 1;
  toggleCoupling(state, 0, 1); toggleCoupling(state, 1, 2);
  for (const [d, amt] of [[1, 2.3], [-1, 1.1], [1, 0.6]]) {
    drive(yard, state, 0, d, amt);
    assert.equal(joints(yard, state).length, 2, "still touching after each drive");
  }
});

test("buffers stop a train", () => {
  const { yard, state } = setup({ head: ". L" });
  const r = drive(yard, state, 0, -1, 5);
  near(r.moved, 1.3, "rolls until it touches the buffer");
  assert.equal(r.stop.why, "buffer");
});

test("a car on the points locks the switch; next to it doesn't", () => {
  const { yard, state } = setup({ head: ". . L" });
  assert.ok(!switchLocked(yard, state, 0));
  drive(yard, state, 0, 1, 0.3); // now overhangs the points
  assert.ok(switchLocked(yard, state, 0));
  assert.equal(throwSwitch(yard, state, 0), false);
  drive(yard, state, 0, 1, 1); // all the way onto the leg
  assert.ok(!switchLocked(yard, state, 0));
});

test("coming through the points from the trunk shoves a car near the points up the other leg", () => {
  const { yard, state } = setup({ head: ". . L", s2: "A" });
  const a0 = state.at[1].s;
  const r = drive(yard, state, 0, 1, 2);
  near(r.moved, 2, "loco carries on");
  near(state.at[1].s, a0 + FOUL, "A shoved just clear of the points");
  const far = setup({ head: ". . L", s2: ". A" });
  const a1 = far.state.at[1].s;
  drive(far.yard, far.state, 0, 1, 2);
  near(far.state.at[1].s, a1, "a car already clear isn't touched");
});

test("the shove carries on after the nose reaches a track between two switches", () => {
  // the locomotive goes through P1 onto the short lead to P2, with D parked beside P1 on s1
  const { yard, state } = setup({ head: ". . L", s1: "D" }, ladder(3, [4, 3, 3]));
  state.sw[0] = 1; // P1 toward the lead
  const d0 = state.at[1].s;
  drive(yard, state, 0, 1, 1);
  near(state.at[1].s, d0 + FOUL, "D shoved fully clear, not left half in the way");
});

test("the shove stops if the car it shoves can't move", () => {
  const { yard, state } = setup({ head: ". . L", s2: "A B C" });
  const r = drive(yard, state, 0, 1, 2);
  near(r.moved, 0.3, "only as far as the spare room at the buffer lets A move");
  assert.equal(r.stop.why, "foul");
});

test("coming down a leg into the side of a car on the other leg is blocked", () => {
  const { yard, state } = setup({ s1: ". L", s2: "A" });
  const a0 = state.at[1].s;
  const r = drive(yard, state, 0, -1, 2);
  assert.equal(r.stop.why, "foul");
  near(state.at[1].s, a0, "A not moved");
  assert.ok(r.moved < 1, "stopped short of the points");
});

test("against a switch set the other way, the nose stops where the drawn track ends", () => {
  const { yard, state } = setup({ s2: ". L" });
  const r = drive(yard, state, 0, -1, 5);
  assert.equal(r.stop.why, "against");
  near(state.at[0].s - 0.5, BLANK, "nose BLANK short of the points");
});

test("done means every goal car is touching its own marker", () => {
  const lv = loadLevel({ layout: ladder(3, [3, 3]), start: { head: "L", s1: ". A B" }, goals: [{ track: "s1", end: "E1", cars: "A B" }] });
  const state = fromSlots(lv.yard, lv.state);
  assert.ok(goalMet(lv.yard, lv.cars, lv.goals, state), "packed against the buffer: done");
  const B = 2, A = 1;
  state.at[B].s -= 0.5; state.at[A].s -= 0.5; // half a car short of the buffer: still touching
  assert.ok(goalMet(lv.yard, lv.cars, lv.goals, state));
  state.at[B].s -= 0.5; state.at[A].s -= 0.5; // a whole car short: not touching
  assert.ok(!goalMet(lv.yard, lv.cars, lv.goals, state));
});

test("cars a little apart are in reach to couple; farther apart they aren't", () => {
  const { yard, state } = setup({ head: "L" });
  state.at.push({ track: "head", s: state.at[0].s + 1 + REACH * 0.8 });
  assert.equal(joints(yard, state).length, 1, "in reach");
  state.at[1].s += REACH * 0.5;
  assert.equal(joints(yard, state).length, 0, "out of reach");
});

test("every level's start is a legal position and not already solved", () => {
  for (const lv of LEVELS) {
    const { yard, cars, goals, state } = loadLevel(lv);
    assert.ok(!goalMet(yard, cars, goals, fromSlots(yard, state)), lv.name);
  }
});

test("a locomotive couples only on its coupler end, and pushes with both", () => {
  // cars: 0 is the gray car, 1 the locomotive, 2 is A
  const front = setup({ head: "x L> A" }); // coupler toward A
  assert.deepEqual(pairs(front.yard, front.state), ["1-2"], "only the coupler side can couple");
  const back = setup({ head: "x <L A" }); // coupler toward the gray car
  assert.deepEqual(pairs(back.yard, back.state), ["0-1"]);
  // pushing A with the end that has no coupler still works
  const a0 = back.state.at[2].s;
  drive(back.yard, back.state, 1, 1, 0.5);
  near(back.state.at[2].s, a0 + 0.5, "A pushed by the end with no coupler");
});

test("a locomotive keeps its coupler on the same end as it rolls onto a track running the other way", () => {
  // two tracks joined head to head: the second one runs right to left
  const layout = { nodes: { A: [0, 0], J: [3, 0], B: [6, 0] }, tracks: [{ id: "one", from: "A", to: "J" }, { id: "two", from: "B", to: "J" }], switches: {} };
  const { yard, state } = setup({ one: "L> . ." }, layout);
  drive(yard, state, 0, 1, 3);
  assert.equal(state.at[0].track, "two");
  assert.equal(state.face[0], -1, "still facing the way it's going, which is -1 on track two");
});

const tableYard = {
  nodes: { A: [-4.15, 0], B: [4.15, 0], C: [0, -5.15] },
  tracks: [{ id: "west", from: "A", to: "T.0" }, { id: "east", from: "T.1", to: "B" }, { id: "north", from: "T.2", to: "C" }],
  switches: {},
  turntables: { T: { center: [0, 0], length: 2, exits: [180, 0, 270] } },
};

test("a turntable carries a locomotive round, and turns it", () => {
  const { yard, state } = setup({ west: ". . L>" }, tableYard);
  const T = yard.turntables[0];
  state.tt[0] = T.stops.findIndex((s) => s.b === 0); // the deck's b end at the west exit
  near(drive(yard, state, 0, 1, 2).moved, 2, "on to the deck");
  assert.equal(state.at[0].track, "T.deck");
  // turn until the deck lines up with the north exit
  let guard = 0;
  while (T.stops[state.tt[0]].a !== 2 && T.stops[state.tt[0]].b !== 2 && guard++ < 8) assert.ok(turnTurntable(yard, state, 0));
  const d = T.stops[state.tt[0]].a === 2 ? -1 : 1; // toward whichever end of the deck faces north
  const r = drive(yard, state, 0, d, 2);
  near(r.moved, 2, "off the deck onto the north exit");
  assert.equal(state.at[0].track, "north");
});

test("a turntable won't turn with a car hanging off it", () => {
  const { yard, state } = setup({ west: ". . L>" }, tableYard);
  state.tt[0] = yard.turntables[0].stops.findIndex((s) => s.b === 0);
  drive(yard, state, 0, 1, 0.6); // half on the deck
  assert.ok(turntableLocked(yard, state, 0));
  drive(yard, state, 0, 1, 1.4); // all the way on
  assert.ok(!turntableLocked(yard, state, 0));
});

const plateYard = (wires) => {
  const lay = ladder(4, [3, 3]);
  return { ...lay, plates: [{ track: "head", slot: 2, wires }] };
};

test("rolling onto a plate throws the switches wired to it, once per train", () => {
  const { yard, state } = setup({ head: "L> A . ." }, plateYard(["P1"]));
  toggleCoupling(state, 0, 1);
  assert.equal(state.sw[0], 0);
  // the coupled pair rolls over the plate: one train, one throw
  const r = drive(yard, state, 0, 1, 2);
  assert.equal(r.events.length, 1);
  assert.equal(state.sw[0], 1);
  assert.ok(!yard.switches[0].lever, "a switch a plate drives has no lever");
});

test("a plate can't throw a switch with a car on its points; the other one still goes", () => {
  const lay = ladder(4, [3, 3, 3]);
  const { yard, state } = setup({ head: "L> . . .", l1: ". A" }, { ...lay, plates: [{ track: "head", slot: 1, wires: ["P1", "P2"] }] });
  // put A across P2's points (it starts at the far end of the lead)
  state.at[1].s += 0.3;
  assert.ok(switchLocked(yard, state, 1));
  drive(yard, state, 0, 1, 1.2);
  assert.equal(state.sw[0], 1, "P1 thrown");
  assert.equal(state.sw[1], 0, "P2 held by the car on it");
});
