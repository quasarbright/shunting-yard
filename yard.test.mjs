// Track geometry and connections.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEVELS, ladder } from "./levels.mjs";
import { loadLevel } from "./setup.mjs";
import { buildYard, walk, nextTrack } from "./yard.mjs";

test("tracks are cut into whole car lengths", () => {
  const y = buildYard(ladder(3, [5, 3, 3]));
  assert.equal(y.tracks.head.slots.length, 3);
  assert.equal(y.tracks.s1.slots.length, 5);
  assert.equal(y.tracks.s3.slots.length, 3);
});

// every way the switches and turntables can be set in a level
function* settings(yard) {
  const sizes = [...yard.switches.map(() => 2), ...yard.turntables.map((T) => T.stops.length)];
  const total = sizes.reduce((a, b) => a * b, 1);
  for (let m = 0; m < Math.min(total, 256); m++) {
    let r = m;
    const v = sizes.map((n) => { const x = r % n; r = Math.floor(r / n); return x; });
    yield { sw: v.slice(0, yard.switches.length), tt: v.slice(yard.switches.length) };
  }
}

test("neighboring slots are exactly one car length apart, across switches and turntables too", () => {
  for (const lv of LEVELS) {
    const yard = buildYard(lv.layout);
    const at = new Map(yard.slots.map((sl) => [`${sl.track}:${sl.s.toFixed(4)}`, sl]));
    for (const st of settings(yard)) for (const sl of yard.slots) for (const d of [1, -1]) {
      const p = walk(yard, sl.track, sl.s, d, 1, st);
      const moved = p.track !== sl.track || Math.abs(p.s - sl.s) > 1 - 1e-6;
      if (!moved) continue; // ran into the end of the line
      // where it lands is either another slot, or spare room at a buffer
      const q = at.get(`${p.track}:${p.s.toFixed(4)}`);
      const t = yard.tracks[p.track];
      const nearBuffer = [t.from, t.to].some((n) => yard.nodes[n].kind === "buffer");
      assert.ok(q || nearBuffer, `${lv.name}: one car on from slot ${sl.id} isn't a slot`);
    }
  }
});

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

test("no level starts with cars clashing beside a switch", () => {
  for (const lv of LEVELS) {
    const { yard, state } = loadLevel(lv);
    const occ = new Set(state.pos);
    for (const p of state.pos) for (const f of yard.slots[p].fouls) assert.ok(!occ.has(f), `${lv.name}: slots ${p} and ${f}`);
  }
});
