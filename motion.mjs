// How things move: the rules of the game.
//
// Every car has a position along a track (the arclength `s` of its center)
// and is one car length long, so two cars touch when their centers are one
// car length apart along the route. Nothing moves unless a locomotive drives
// it: the locomotive carries the cars coupled to it, pushes whatever it runs
// into, and everything else stays where it is (or rolls on a little, see
// index.html). A locomotive has a coupler on one end only: it pushes with
// either end but can only couple (and so pull) with that one.
//
// state = {
//   at: [{ track, s }] per car,
//   sw: [leg per switch], tt: [stop per turntable],
//   face: { locoIndex: +1 | -1 }, the end its coupler is on (+1: toward its track's `to` end),
//   coupled: Set("i,j"),
//   plateOn: [bool per plate], whether something was on it last we looked,
// }

import { nextTrack, walk } from "./yard.mjs";

export const FOUL = 1; // how far from the points the two legs are too close for two cars
export const BLANK = 0.42; // the stretch of a leg at the points that's cut off when the switch is set against it
// how big a gap you can couple across: the cars then pull together to the
// usual coupled spacing (see index.html)
export const REACH = 0.12;
const EPS = 1e-6, TOUCH = 1e-4;

const pairKey = (i, j) => (i < j ? `${i},${j}` : `${j},${i}`);
export const isCoupled = (state, i, j) => state.coupled.has(pairKey(i, j));
export function toggleCoupling(state, i, j) {
  const k = pairKey(i, j);
  if (state.coupled.has(k)) state.coupled.delete(k); else state.coupled.add(k);
}

export function fromSlots(yard, { pos, sw, tt, face, coupled }) {
  const state = {
    at: pos.map((p) => ({ track: yard.slots[p].track, s: yard.slots[p].s })),
    sw: sw.slice(), tt: (tt || []).slice(), face: { ...(face || {}) }, coupled: new Set(coupled),
  };
  state.plateOn = yard.plates.map((pl) => plateCovered(yard, state, pl));
  return state;
}
export function clone(state) {
  return {
    at: state.at.map((p) => ({ ...p })), sw: state.sw.slice(), tt: state.tt.slice(), face: { ...state.face },
    coupled: new Set(state.coupled), plateOn: state.plateOn.slice(),
  };
}

// Nearest car center along the route from (track, s) heading dir, within maxDist.
// Returns { car, dist, dir } (dir = travel direction on that car's track) or null.
export function scan(yard, state, track, s, dir, maxDist, skip = null) {
  let dist = 0;
  for (let guard = 0; guard < 100; guard++) {
    let best = null;
    state.at.forEach((p, c) => {
      if (p.track !== track || (skip && skip.has(c))) return;
      const ds = (p.s - s) * dir;
      if (ds > EPS && dist + ds <= maxDist + EPS && (!best || ds < best.ds)) best = { c, ds };
    });
    if (best) return { car: best.c, dist: dist + best.ds, dir };
    const t = yard.tracks[track];
    dist += dir > 0 ? t.len - s : s;
    if (dist > maxDist) return null;
    const nx = nextTrack(yard, track, dir > 0 ? t.to : t.from, state);
    if (!nx) return null;
    track = nx.track; dir = nx.dir; s = dir > 0 ? 0 : yard.tracks[track].len;
  }
  return null;
}

// The cars that move when `loco` drives in direction d (relative to its own
// track), front first, each with the direction it travels on its own track:
// everything touching ahead of it (pushed) and, if `pull`, everything coupled
// behind it.
export function group(yard, state, loco, d, pull = true, fixed = null) {
  const at = state.at;
  const members = [{ c: loco, dir: d }];
  let cur = { track: at[loco].track, s: at[loco].s, dir: d };
  let last = loco;
  for (;;) {
    // ahead: whatever it's touching gets pushed, and whatever's coupled to that
    const r = scan(yard, state, cur.track, cur.s, cur.dir, 1 + REACH + TOUCH);
    if (!r || members.some((m) => m.c === r.car) || (fixed && fixed.has(r.car))) break;
    if (r.dist > 1 + TOUCH && !isCoupled(state, last, r.car)) break;
    members.unshift({ c: r.car, dir: r.dir });
    last = r.car;
    cur = { track: at[r.car].track, s: at[r.car].s, dir: r.dir };
  }
  let prev = loco;
  cur = { track: at[loco].track, s: at[loco].s, dir: -d };
  while (pull) {
    const r = scan(yard, state, cur.track, cur.s, cur.dir, 1 + REACH + TOUCH);
    if (!r || !isCoupled(state, prev, r.car) || members.some((m) => m.c === r.car)) break;
    members.push({ c: r.car, dir: -r.dir });
    prev = r.car;
    cur = { track: at[r.car].track, s: at[r.car].s, dir: r.dir };
  }
  return members;
}

// distance from a car's center to node `nodeId` at one end of its track
const toNode = (yard, p, nodeId) => (yard.tracks[p.track].from === nodeId ? p.s : yard.tracks[p.track].len - p.s);

// Is a car (not in skip) within FOUL of the points on this leg?
function legFouled(yard, state, legId, nodeId, skip) {
  return state.at.some((p, c) => !skip.has(c) && p.track === legId && toNode(yard, p, nodeId) < FOUL + 0.5 - TOUCH);
}

// How far the front car can roll before it hits a buffer, a switch set
// against it, or the side of a car on the other leg of a switch it's
// converging on. { dist, node, why }
function barrier(yard, state, front, skip) {
  let { track, s } = state.at[front.c], dir = front.dir, dist = 0;
  for (let guard = 0; guard < 100; guard++) {
    const t = yard.tracks[track];
    const room = dir > 0 ? t.len - s : s;
    const nodeId = dir > 0 ? t.to : t.from;
    const k = yard.switchIndex[nodeId];
    const S = k != null ? yard.switches[k] : null;
    // heading along a leg toward its points: stop at the fouling mark
    if (S && S.legs.includes(track) && room - 0.5 >= FOUL - TOUCH) {
      const other = S.legs.find((l) => l !== track);
      if (legFouled(yard, state, other, nodeId, skip)) return { dist: dist + room - 0.5 - FOUL, node: nodeId, why: "foul" };
    }
    const nx = nextTrack(yard, track, nodeId, state);
    // a buffer, a switch set against it, or the edge of a turntable pit: the
    // nose stops where the drawn track ends
    if (!nx) {
      const why = S ? "against" : yard.nodes[nodeId].turntable ? "pit" : "buffer";
      return { dist: Math.max(0, dist + room - 0.5 - (S ? BLANK : 0)), node: nodeId, why };
    }
    dist += room;
    if (dist > 1e3) break;
    track = nx.track; dir = nx.dir; s = dir > 0 ? 0 : yard.tracks[track].len;
  }
  return { dist: Infinity };
}

// The switches the front car is going through from the trunk side, each with
// how far its nose is past the points (negative while still approaching). A
// short track between two switches can have one just behind and one ahead.
function throughPoints(yard, state, front) {
  const p = state.at[front.c], t = yard.tracks[p.track], out = [];
  const ahead = front.dir > 0 ? t.to : t.from, behind = front.dir > 0 ? t.from : t.to;
  let k = yard.switchIndex[ahead];
  if (k != null && yard.switches[k].trunk === p.track) out.push({ k, a: 0.5 - (front.dir > 0 ? t.len - p.s : p.s) });
  k = yard.switchIndex[behind];
  if (k != null && yard.switches[k].legs[state.sw[k]] === p.track) out.push({ k, a: (front.dir > 0 ? p.s : t.len - p.s) + 0.5 });
  return out;
}

// Drive `loco` up to `amount` car lengths in direction d. Moves the cars in
// place. Returns { moved, dir (the loco's travel direction now), stop,
// members (the cars that moved, front first, with their travel directions),
// events (plates that went off, see updatePlates) }. Cars in `fixed` (other
// locomotives, which have their brakes on) can't be pushed.
export function drive(yard, state, loco, d, amount, fixed = null) {
  return inSteps(yard, state, (amt, dir) => moveChain(yard, state, loco, dir, amt, true, fixed), d, amount);
}

// A free-rolling car (and whatever's coupled to it) carrying on by itself.
export function coast(yard, state, car, d, amount, fixed = null) {
  return inSteps(yard, state, (amt, dir) => moveChain(yard, state, car, dir, amt, true, fixed), d, amount);
}

// Plates are checked every PLATE_STEP of movement, so a switch a plate throws
// partway through a drive takes effect for the rest of it.
const PLATE_STEP = 0.1;
function inSteps(yard, state, mover, d, amount) {
  if (!yard.plates.length) return { ...mover(amount, d), events: [] };
  let moved = 0, dir = d, stop = null, members = [];
  const events = [];
  while (moved < amount - EPS) {
    const r = mover(Math.min(PLATE_STEP, amount - moved), dir);
    moved += r.moved; dir = r.dir; members = r.members;
    events.push(...updatePlates(yard, state));
    if (r.stop) { stop = r.stop; break; }
    if (r.moved <= EPS) break;
  }
  return { moved, dir, stop, members, events };
}

function moveChain(yard, state, lead, d, amount, pull, fixed = null) {
  let moved = 0, dir = d, stop = null, members = [];
  for (let guard = 0; guard < 500 && moved < amount - EPS; guard++) {
    members = group(yard, state, lead, dir, pull, fixed);
    const skip = new Set(members.map((m) => m.c));
    const front = members[0];
    const bar = barrier(yard, state, front, skip);
    const fp = state.at[front.c];
    const ahead = scan(yard, state, fp.track, fp.s, front.dir, amount - moved + 1 + TOUCH, skip);
    let gap = ahead ? Math.max(0, ahead.dist - 1) : Infinity;
    let bar2 = bar;
    if (ahead && fixed && fixed.has(ahead.car)) { bar2 = { dist: Math.min(bar.dist, gap), why: "car" }; gap = Infinity; }
    const remaining = amount - moved;
    let len = Math.max(0, Math.min(remaining, bar2.dist, gap));

    // Going through the points from the trunk, the nose meets the end of any
    // car parked close to the points on the other leg, and shoves it up that
    // leg until the two are clear of each other (FOUL past the points).
    let side = null;
    for (const tp of throughPoints(yard, state, front)) {
      if (!(tp.a < FOUL && tp.a + len > 0)) continue;
      const S = yard.switches[tp.k], other = S.legs[1 - state.sw[tp.k]], ot = yard.tracks[other];
      const into = ot.from === S.id ? 1 : -1;
      const r = scan(yard, state, other, into > 0 ? 0 : ot.len, into, FOUL + 0.5, skip);
      if (r) {
        len = Math.min(len, 0.05); // small steps while shouldering a car aside
        const need = Math.min(tp.a + len, FOUL) - (r.dist - 0.5);
        if (need > EPS) {
          const pushed = fixed && fixed.has(r.car) ? 0 : moveChain(yard, state, r.car, r.dir, need, false, fixed).moved;
          if (pushed < need - EPS) { len = Math.max(0, len - (need - pushed)); side = { node: S.id, why: "foul" }; }
        }
      }
    }

    if (len > 0) for (const m of members) {
      const p = walk(yard, state.at[m.c].track, state.at[m.c].s, m.dir, len, state);
      state.at[m.c] = { track: p.track, s: p.s };
      // a locomotive that rolls onto a track running the other way still has
      // its coupler on the same end; relative to the new track, that's the other side
      if (state.face[m.c] != null && Math.sign(p.dir) !== Math.sign(m.dir)) state.face[m.c] = -state.face[m.c];
      m.dir = p.dir;
      if (m.c === lead) dir = p.dir;
    }
    moved += len;
    if (side) { stop = side; break; }
    if (bar2.dist <= len + EPS && bar2.dist < remaining - EPS) { stop = bar2; break; } // up against something
    if (gap <= len + EPS && gap < remaining - EPS) continue; // reached a car: it gets pushed from here on
    if (len <= EPS) break;
  }
  return { moved, dir, stop, members };
}

// A switch can't be thrown while a car sits across the points, or while two
// cars are coupled across them.
export function switchLocked(yard, state, k) {
  const S = yard.switches[k];
  const tracksHere = [S.trunk, ...S.legs];
  const on = state.at.some((p) => tracksHere.includes(p.track) && toNode(yard, p, S.id) < 0.5 - TOUCH);
  if (on) return true;
  return joints(yard, state).some((j) => isCoupled(state, j.a, j.b) && j.across === S.id);
}

export function throwSwitch(yard, state, k) {
  if (switchLocked(yard, state, k)) return false;
  state.sw[k] = 1 - state.sw[k];
  return true;
}

// Every pair of cars close enough to couple (touching, or within REACH of it),
// not counting a locomotive's end without a coupler: [{ a, b, dir, dist, across }]
// where dir is the direction from a to b along a's track, dist the distance
// between their centers, and `across` names a switch or turntable node between them.
export function joints(yard, state) {
  const out = [], seen = new Set();
  state.at.forEach((p, a) => {
    for (const d of [1, -1]) {
      const r = scan(yard, state, p.track, p.s, d, 1 + REACH + TOUCH);
      if (!r || r.dist < 1 - 1e-3) continue;
      const k = pairKey(a, r.car);
      if (seen.has(k)) continue;
      seen.add(k);
      // a locomotive couples only on its coupler end
      if (state.face[a] != null && state.face[a] !== d) continue;
      if (state.face[r.car] != null && state.face[r.car] !== -r.dir) continue;
      const q = state.at[r.car];
      let across = null;
      if (q.track !== p.track) {
        const t = yard.tracks[p.track];
        const n = d > 0 ? t.to : t.from;
        if (yard.switchIndex[n] != null || yard.nodes[n].turntable) across = n;
      }
      out.push({ a, b: r.car, dir: d, dist: r.dist, across });
    }
  });
  return out;
}

// ---------- turntables ----------
// A turntable turns whenever nothing hangs off the deck or over the edge of
// the pit, and no coupling crosses the edge. A car a hair over the edge
// (up to SLACK) doesn't count: nobody should have to park to the pixel.
const SLACK = 0.15;
export function turntableLocked(yard, state, k) {
  const T = yard.turntables[k], deck = yard.tracks[T.deck];
  const rims = new Set(T.exits.map((e) => e.node));
  const hanging = state.at.some((p) => {
    if (p.track === T.deck) return p.s < 0.5 - SLACK || p.s > deck.len - 0.5 + SLACK;
    const t = yard.tracks[p.track];
    return (rims.has(t.from) && p.s < 0.5 - SLACK) || (rims.has(t.to) && t.len - p.s < 0.5 - SLACK);
  });
  if (hanging) return true;
  return joints(yard, state).some((j) => isCoupled(state, j.a, j.b) && j.across && yard.nodes[j.across].turntable === T.id);
}

// Turn to the next stop, going round by increasing angle. Returns false if it can't turn.
export function turnTurntable(yard, state, k) {
  if (turntableLocked(yard, state, k)) return false;
  const T = yard.turntables[k], len = yard.tracks[T.deck].len;
  state.tt[k] = (state.tt[k] + 1) % T.stops.length;
  // anything a hair over the edge is settled onto the deck as it turns, so it
  // doesn't swing round into a car waiting at the next exit
  const on = state.at.filter((p) => p.track === T.deck);
  if (on.length) {
    const lo = Math.min(...on.map((p) => p.s)), hi = Math.max(...on.map((p) => p.s));
    const shift = lo < 0.5 ? 0.5 - lo : hi > len - 0.5 ? len - 0.5 - hi : 0;
    for (const p of on) p.s += shift;
  }
  return true;
}

// ---------- pressure plates ----------
// A plate counts as covered while any car is over it. A car is one car length
// end to end, couplers included, so a train of touching cars covers it the
// whole way across: it goes off once per train, not once per car.
const PLATE_HALF = 0.25;
export function plateCovered(yard, state, plate) {
  return state.at.some((p) => p.track === plate.track && Math.abs(p.s - plate.s) < 0.5 + PLATE_HALF);
}

// Check every plate; each one something has just rolled onto goes off: every
// switch and turntable wired to it changes, unless a car on it holds it where
// it is. Returns [{ plate, results: [{ switch | turntable, ok }] }].
export function updatePlates(yard, state) {
  const events = [];
  yard.plates.forEach((pl, i) => {
    const on = plateCovered(yard, state, pl);
    if (on && !state.plateOn[i]) {
      const results = pl.wires.map((w) => (w.switch != null
        ? { switch: w.switch, ok: throwSwitch(yard, state, w.switch) }
        : { turntable: w.turntable, ok: turnTurntable(yard, state, w.turntable) }));
      events.push({ plate: i, results });
    }
    state.plateOn[i] = on;
  });
  return events;
}

// Where each goal car belongs: packed against the goal's end of its track,
// one car length apart, in the order listed (left to right along the track).
export function goalSpots(yard, g) {
  const t = yard.tracks[g.track], n = g.cars.length;
  return g.cars.map((car, k) => {
    const idx = t.from === g.end ? k : n - 1 - k; // how many cars in from the end
    return { car, s: t.from === g.end ? 0.5 + idx : t.len - 0.5 - idx };
  });
}

// How long a car (and a goal marker) is drawn, in car lengths.
export const BODY = 0.84;

// Is the car touching its spot: on the goal track, with its body overlapping
// the marker? (Loose on purpose; nobody should have to line cars up to the pixel.)
export function atSpot(state, track, car, s) {
  const p = state.at[car];
  return p.track === track && Math.abs(p.s - s) < BODY;
}

// The goal: every goal car touching its spot. Where the other cars are
// doesn't matter.
export function goalMet(yard, cars, goals, state) {
  return goals.every((g) => goalSpots(yard, g).every(({ car, s }) => atSpot(state, g.track, car, s)));
}
