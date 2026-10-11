// Track geometry and connections, and laying levels out on the grid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadLevel } from "./setup.mjs";
import { layoutOf, edgesOf, pathsOf } from "./grid.mjs";
import { buildYard, nextTrack, locate } from "./yard.mjs";

const dir = new URL("./levels/", import.meta.url);
const LEVELS = JSON.parse(readFileSync(new URL("order.json", dir))).map((id) => JSON.parse(readFileSync(new URL(`${id}.level.json`, dir))));
const problems = (level) => loadLevel(level, { strict: false }).problems.map((p) => p.msg);

test("a turntable connects its deck to whichever exits its ends point at", () => {
  const yard = buildYard({
    nodes: { A: [-4, 0], B: [4, 0], C: [0, -4] },
    tracks: [{ id: "west", from: "A", to: "T.0" }, { id: "east", from: "T.1", to: "B" }, { id: "north", from: "T.2", to: "C" }],
    switches: {},
    turntables: { T: { center: [0, 0], length: 2, exits: [180, 0, 270] } },
  });
  const T = yard.turntables[0];
  // stops: one per distinct deck angle; west/east share one (the deck spans both)
  assert.equal(T.stops.length, 4);
  for (let k = 0; k < T.stops.length; k++) {
    const st = { sw: [], tt: [k] }, stop = T.stops[k];
    const out = nextTrack(yard, "west", "T.0", st);
    const lined = stop.a === 0 || stop.b === 0;
    assert.equal(!!out, lined, `stop ${k}: west ${lined ? "should" : "shouldn't"} reach the deck`);
  }
});

test("track curves round a corner instead of kinking", () => {
  const { def } = layoutOf({ track: [[[0, 0], [3, 0], [5, 2], [8, 2]]] });
  const pts = buildYard(def).tracks.t0.pts;
  for (let i = 2; i < pts.length; i++) {
    const a = Math.atan2(pts[i - 1][1] - pts[i - 2][1], pts[i - 1][0] - pts[i - 2][0]);
    const b = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
    assert.ok(Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) < 0.1, `kink at point ${i - 1}`);
  }
});

test("a switch's points sit half a car back along the trunk", () => {
  const { def } = layoutOf({ track: [[[0, 0], [6, 0]], [[3, 0], [4, 1], [6, 1]]] });
  assert.deepEqual(def.nodes["3,0"], [2.5, 0]);
  const yard = buildYard(def), S = yard.switches[0];
  assert.equal(yard.tracks[S.trunk].len, 2.5);
  assert.equal(yard.tracks[S.legs[0]].len, 3.5, "the straight leg goes first");
});

test("every spot in every level is on the track", () => {
  for (const lv of LEVELS) {
    const lay = layoutOf(lv), yard = buildYard(lay.def);
    for (const [x, y] of lay.spots) assert.ok(locate(yard, x, y).dist < 1e-6, `${lv.name}: spot ${x},${y}`);
  }
});

test("saving turns grid steps back into the same track", () => {
  for (const lv of LEVELS) {
    const edges = edgesOf(lv), again = edgesOf({ track: pathsOf(edges) });
    assert.deepEqual([...again.keys()].sort(), [...edges.keys()].sort(), lv.name);
  }
});

test("track that can't be built is a problem, not a crash", () => {
  assert.deepEqual(problems({ track: [[[0, 0], [2, 0], [2, 2]]] }), ["too sharp a turn: 45° at most"]);
  assert.deepEqual(problems({ track: [[[0, 0], [4, 0]], [[2, 0], [2, 2]]] }), ["a branch has to leave at 45°"]);
  assert.deepEqual(problems({ track: [[[0, 0], [2, 2]], [[2, 0], [0, 2]]] }), ["too many tracks meet here"]);
  assert.deepEqual(problems({ track: [[[0, 0], [1, 1]], [[1, 0], [0, 1]]] }), ["tracks can't cross"]);
  assert.ok(problems({ track: [[[0, 0], [3, 0]]], turntables: [{ at: [2, 0], length: 1, exits: ["E"] }] }).includes("track runs into the turntable"));
});

test("cars can start coupled, if they're close enough to couple", () => {
  const track = [[[0, 0], [6, 0]]];
  const cars = [{ at: [0.5, 0], kind: "locomotive", coupler: "E" }, { at: [1.5, 0] }, { at: [3.5, 0] }];
  const lv = loadLevel({ track, cars, couplings: [[[0.5, 0], [1.5, 0]]] });
  assert.deepEqual([...lv.state.coupled], ["0,1"]);
  assert.deepEqual(problems({ track, cars, couplings: [[[1.5, 0], [3.5, 0]]] }), ["those two can't start coupled"]);
  // a locomotive couples only at its coupler end
  const back = [{ at: [0.5, 0], kind: "locomotive", coupler: "W" }, { at: [1.5, 0] }];
  assert.deepEqual(problems({ track, cars: back, couplings: [[[0.5, 0], [1.5, 0]]] }), ["those two can't start coupled"]);
});

test("cars can't start on top of each other, or side by side at a switch", () => {
  const track = [[[0, 0], [6, 0]], [[3, 0], [4, 1], [6, 1]]];
  assert.deepEqual(problems({ track, cars: [{ at: [1.5, 0] }, { at: [1.5, 0] }] }), ["two cars on top of each other"]);
  assert.deepEqual(problems({ track, cars: [{ at: [3.5, 0] }, { at: [3.5, 0.5] }] }), ["two cars on top of each other", "two cars side by side at a switch"]);
  // the next spot down the curving leg is far enough along
  assert.deepEqual(problems({ track, cars: [{ at: [3.5, 0] }, { at: [4.5, 1] }] }), []);
});
