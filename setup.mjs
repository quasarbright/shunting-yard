// Turn a level file (see grid.mjs) into a yard, cars, goals and a starting
// position, and find anything wrong with it: track that can't be built, or
// things off the track or on top of each other.
import { layoutOf, DIRS, DIR_NAMES, vkey } from "./grid.mjs";
import { buildYard, locate, pointOnTrack } from "./yard.mjs";
import { plateCovered, joints, toggleCoupling, BODY, FOUL } from "./motion.mjs";

const LOCO_NAMES = ["L", "M", "N", "O", "P"];

// With `strict` (the default) a problem throws; otherwise it's listed in
// `problems` and as much as could be loaded is returned.
export function loadLevel(level, { strict = true } = {}) {
  const lay = layoutOf(level);
  const problems = [...lay.problems];
  const fail = () => {
    if (strict) throw new Error(`${level.name || "level"}: ${problems.map((p) => `${p.msg} at ${p.at}`).join("; ")}`);
    return { problems, layout: lay };
  };
  if (problems.length) return fail();

  // where something sits: its spot, as a place on a track
  const yard0 = buildYard(lay.def);
  const placeIn = (at, what) => {
    const p = locate(yard0, at[0], at[1]);
    if (!p || p.dist > 0.02) { problems.push({ msg: `${what} isn't on the track`, at }); return null; }
    return p;
  };

  // plates, wired to switches (by their grid point) and turntables (by their center)
  const plates = [];
  for (const pl of level.plates || []) {
    const p = placeIn(pl.at, "a plate");
    if (!p) continue;
    const wires = [];
    for (const w of pl.wires || []) {
      const k = vkey(...w);
      if (lay.switchAt.has(k)) wires.push(k);
      else if (lay.tables.some((T) => vkey(...T.at) === k)) wires.push(`T${k}`);
      else problems.push({ msg: "a plate is wired to nothing", at: w });
    }
    plates.push({ track: p.track, s: p.s, wires });
  }
  const yard = buildYard({ ...lay.def, plates });

  // A car right on a switch's points goes on the trunk, which runs on to
  // both legs, so a train coming from either leg finds it.
  const onTrunk = (p) => {
    const t = yard.tracks[p.track];
    for (const [end, s] of [[t.from, 0], [t.to, t.len]]) {
      const k = yard.switchIndex[end];
      if (k == null || Math.abs(p.s - s) > 1e-6) continue;
      const trunk = yard.tracks[yard.switches[k].trunk];
      return { ...p, track: trunk.id, s: trunk.from === end ? 0 : trunk.len };
    }
    return p;
  };
  const cars = [], at = [], face = {}, byName = {};
  let locos = 0;
  for (const c of level.cars || []) {
    let p = placeIn(c.at, "a car");
    if (!p) continue;
    p = onTrunk(p);
    const i = cars.length;
    if (c.kind === "locomotive") {
      cars.push({ name: LOCO_NAMES[locos++] || "L", loco: true });
      // which way along the track the coupler points: +1 toward the track's `to` end
      const d = DIRS[DIR_NAMES.indexOf(c.coupler || "E")] || DIRS[0];
      const ang = pointOnTrack(yard.tracks[p.track], p.s).ang;
      face[i] = Math.cos(ang) * d[0] + Math.sin(ang) * d[1] >= 0 ? 1 : -1;
    } else if (c.name) {
      if (byName[c.name] != null) problems.push({ msg: `two cars named ${c.name}`, at: c.at });
      cars.push({ name: c.name });
      byName[c.name] = i;
    } else cars.push({ name: "", filler: true });
    at.push({ track: p.track, s: p.s });
  }

  const goals = [];
  for (const g of level.goals || []) {
    const p = placeIn(g.at, "a goal");
    if (!p) continue;
    if (byName[g.name] == null) { problems.push({ msg: `there's no car ${g.name} for this goal`, at: g.at }); continue; }
    if (goals.some((o) => o.car === byName[g.name])) problems.push({ msg: `two goals for ${g.name}`, at: g.at });
    goals.push({ car: byName[g.name], track: p.track, s: p.s, at: g.at });
  }

  // nothing on top of anything else
  const where = at.map((p) => pointOnTrack(yard.tracks[p.track], p.s));
  for (let i = 0; i < at.length; i++) for (let j = i + 1; j < at.length; j++) {
    const sameTrack = at[i].track === at[j].track && Math.abs(at[i].s - at[j].s) < 1 - 1e-6;
    if (sameTrack || carsOverlap(where[i], where[j])) problems.push({ msg: "two cars on top of each other", at: level.cars[i]?.at });
  }
  // or too close together beside a switch, on its two legs
  const toNode = (p, id) => (yard.tracks[p.track].from === id ? p.s : yard.tracks[p.track].len - p.s);
  for (const S of yard.switches) {
    const near = S.legs.map((l) => at.some((p) => p.track === l && toNode(p, S.id) < FOUL + 0.5 - 1e-6));
    if (near[0] && near[1]) problems.push({ msg: "two cars side by side at a switch", at: yard.nodes[S.id] && [yard.nodes[S.id].x, yard.nodes[S.id].y] });
  }

  if (problems.length && strict) return fail();
  const sw = yard.switches.map((S) => {
    const set = (level.switches || []).find((s) => vkey(...s.at) === S.id);
    if (!set) return 0;
    const sa = lay.switchAt.get(S.id), d = DIR_NAMES.indexOf(set.set);
    const leg = sa.legs.indexOf(d);
    return leg < 0 ? 0 : leg;
  });
  const tt = yard.turntables.map((T) => T.start);
  const state = { at, sw, tt, face, coupled: new Set() };
  // pairs of cars that start coupled: each pair has to be close enough to couple
  const reach = joints(yard, state);
  for (const pair of level.couplings || []) {
    const [i, j] = pair.map((p) => (level.cars || []).findIndex((c) => c.at[0] === p[0] && c.at[1] === p[1]));
    if (i < 0 || j < 0 || !reach.some((r) => (r.a === i && r.b === j) || (r.a === j && r.b === i))) {
      problems.push({ msg: "those two can't start coupled", at: pair[0] });
      continue;
    }
    toggleCoupling(state, i, j);
  }
  if (problems.length && strict) return fail();
  state.plateOn = yard.plates.map((pl) => plateCovered(yard, state, pl));
  return { yard, cars, goals, state, problems, layout: lay };
}

// Do two car bodies (center and heading) overlap? Each is BODY long and a
// little under half a car wide.
function carsOverlap(p, q) {
  const box = (c) => {
    const ux = Math.cos(c.ang), uy = Math.sin(c.ang), hl = BODY / 2, hw = 0.24;
    return [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([a, b]) => [c.x + ux * a - uy * b, c.y + uy * a + ux * b]);
  };
  const A = box(p), B = box(q);
  for (const poly of [A, B]) for (let i = 0; i < 4; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % 4], nx = y0 - y1, ny = x1 - x0;
    const proj = (P) => P.map(([x, y]) => x * nx + y * ny);
    const a = proj(A), b = proj(B);
    if (Math.max(...a) < Math.min(...b) + 1e-9 || Math.max(...b) < Math.min(...a) + 1e-9) return false;
  }
  return true;
}
