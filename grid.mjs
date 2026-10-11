// Levels as they're stored and edited: track laid on a grid.
//
// Track runs between neighboring grid points, across, down or diagonally,
// one car length per square. Where it changes direction (45° at most at a
// point) it curves round the corner instead of kinking, so a path's drawn
// shape cuts the corner by half a car length either side. Three tracks
// meeting at a point make a switch: one of them, the trunk, has to carry on
// roughly straight into each of the other two, the legs. The switch's points
// sit half a car length back along the trunk, where a leg that turns starts
// curving away.
//
// A level file:
// {
//   name,
//   track: [[[x, y], [x, y], ...], ...]  paths of grid points; each step runs
//                                        straight across, down or diagonally
//   turntables: [{ at: [x, y], length, exits: ["E", "SW", ...], deck?: "E" }]
//                                        deck: which way the deck's first end points at the start
//   switches: [{ at: [x, y], set: "SE" }]  a switch that starts set to the leg leaving
//                                        that way (otherwise the straight leg)
//   plates: [{ at: [x, y], wires: [[x, y], ...] }]  wired to the switches and
//                                        turntables at those grid points
//   cars: [{ at: [x, y], kind?: "locomotive", coupler?: "E", name?: "A" }]
//                                        no kind and no name: an unlettered car
//   goals: [{ at: [x, y], name: "A" }]
//   couplings: [[[x, y], [x, y]], ...]   pairs of cars (by where they are) that start coupled
// }
// Things on the track sit at "spots": the middle of each grid step, and one
// car length apart along a turntable's deck. `at` is the spot's position.

export const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
export const DIR_NAMES = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"]; // y grows downward
export const vkey = (x, y) => `${x},${y}`;
export const dirOf = (dx, dy) => DIRS.findIndex(([a, b]) => a === Math.sign(dx) && b === Math.sign(dy));
const opp = (d) => (d + 4) % 8;
// how far apart two directions are, in 45° steps (0 to 4)
export const turnBetween = (a, b) => { const m = (((a - b) % 8) + 8) % 8; return Math.min(m, 8 - m); };
const unit = (d) => { const [dx, dy] = DIRS[d], l = Math.hypot(dx, dy); return [dx / l, dy / l]; };
const TRIM = 0.5; // how far a curve starts from the grid point it rounds
const ARC_STEPS = 12;

// One grid step of track: "x,y|x,y", the lesser point first.
export const ekey = (a, b) => { const p = vkey(...a), q = vkey(...b); return p < q ? `${p}|${q}` : `${q}|${p}`; };
export const edgeEnds = (k) => k.split("|").map((v) => v.split(",").map(Number));

// The grid steps a level's paths are made of: Map(ekey → [a, b]).
export function edgesOf(level, bad = () => {}) {
  const edges = new Map();
  for (const path of level.track || []) for (let i = 1; i < path.length; i++) {
    let [x, y] = path[i - 1];
    const [x1, y1] = path[i];
    if (x !== x1 && y !== y1 && Math.abs(x1 - x) !== Math.abs(y1 - y)) { bad("track has to run straight or at 45°", [x, y]); continue; }
    const dx = Math.sign(x1 - x), dy = Math.sign(y1 - y);
    while (x !== x1 || y !== y1) {
      const a = [x, y], b = [x + dx, y + dy];
      edges.set(ekey(a, b), [a, b]);
      x += dx; y += dy;
    }
  }
  return edges;
}

// Grid steps back into paths for saving: runs through points where the
// track just carries on, cut at ends and switches, corners as single points.
export function pathsOf(edges) {
  const adj = new Map();
  const add = (p, q) => { const k = vkey(...p); if (!adj.has(k)) adj.set(k, []); adj.get(k).push(q); };
  for (const [a, b] of edges.values()) { add(a, b); add(b, a); }
  const used = new Set(), paths = [];
  const walkFrom = (start, next) => {
    const path = [start];
    let prev = start, cur = next;
    used.add(ekey(prev, cur));
    for (;;) {
      path.push(cur);
      const out = adj.get(vkey(...cur));
      if (out.length !== 2) break;
      const nx = out.find((q) => !used.has(ekey(cur, q)));
      if (!nx) break;
      used.add(ekey(cur, nx));
      prev = cur; cur = nx;
    }
    // keep only the points where the direction changes
    return path.filter((p, i) => i === 0 || i === path.length - 1
      || dirOf(p[0] - path[i - 1][0], p[1] - path[i - 1][1]) !== dirOf(path[i + 1][0] - p[0], path[i + 1][1] - p[1]));
  };
  const points = [...adj.keys()].map((k) => k.split(",").map(Number)).sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  // start at ends and switches, then whatever's left (loops)
  for (const pass of [(n) => n !== 2, () => true]) for (const p of points) {
    const out = adj.get(vkey(...p));
    if (!pass(out.length)) continue;
    for (const q of out) if (!used.has(ekey(p, q))) paths.push(walkFrom(p, q));
  }
  return paths;
}

// Work out a level's track: the yard description buildYard takes (see
// yard.mjs), plus where things can go. Returns { def, problems, spots,
// switchAt (grid key → switch info), tables }. With problems, def is null.
export function layoutOf(level) {
  const problems = [];
  const bad = (msg, at) => problems.push({ msg, at });
  const edges = edgesOf(level, bad);

  const verts = new Map();
  const vert = (x, y) => {
    const k = vkey(x, y);
    let v = verts.get(k);
    if (!v) verts.set(k, (v = { x, y, key: k, dirs: [], stub: null }));
    return v;
  };
  for (const [a, b] of edges.values()) {
    const d = dirOf(b[0] - a[0], b[1] - a[1]);
    vert(...a).dirs.push(d);
    vert(...b).dirs.push(opp(d));
  }

  // Turntables. Each exit's track starts at the first grid point beyond the
  // pit's rim that way: a short stub runs from the rim to it.
  const tables = (level.turntables || []).map((T) => {
    const [cx, cy] = T.at, r = T.length / 2, id = `T${vkey(cx, cy)}`;
    const exits = (T.exits || []).map((name, e) => {
      const d = DIR_NAMES.indexOf(name);
      const [dx, dy] = DIRS[d], step = Math.hypot(dx, dy);
      const k = Math.floor(r / step + 1e-9) + 1;
      const v = vert(cx + k * dx, cy + k * dy);
      if (v.stub) bad("two turntables share an exit", [v.x, v.y]);
      v.stub = { table: id, exit: e, dir: opp(d), len: k * step - r, rim: [cx + (r * dx) / step, cy + (r * dy) / step] };
      return d;
    });
    const deck = DIR_NAMES.indexOf(T.deck ?? "");
    return { id, at: [cx, cy], r, length: T.length, exits, deck: deck >= 0 ? deck : exits.length ? exits[0] : 0 };
  });
  for (const [i, T] of tables.entries()) {
    for (const v of verts.values()) {
      if (v.stub && v.stub.table === T.id) continue;
      if (Math.hypot(v.x - T.at[0], v.y - T.at[1]) < T.r + 0.3) bad("track runs into the turntable", [v.x, v.y]);
    }
    for (const U of tables.slice(i + 1)) if (Math.hypot(U.at[0] - T.at[0], U.at[1] - T.at[1]) < T.r + U.r + 0.5) bad("turntables too close together", U.at);
  }
  // diagonals can't cross each other
  for (const [a, b] of edges.values()) {
    if (b[0] - a[0] === 1 && b[1] - a[1] === 1 && edges.has(ekey([a[0] + 1, a[1]], [a[0], a[1] + 1]))) bad("tracks can't cross", [a[0] + 0.5, a[1] + 0.5]);
  }

  // what each grid point is
  for (const v of verts.values()) {
    const all = v.stub ? [...v.dirs, v.stub.dir] : v.dirs.slice();
    v.all = all;
    const at = [v.x, v.y];
    if (new Set(all).size !== all.length) { bad("track runs into the turntable", at); continue; }
    if (all.length === 1) v.kind = "buffer";
    else if (all.length === 2) {
      const t = turnBetween(all[0], all[1]);
      if (t === 4) v.kind = "through";
      else if (t === 3) v.kind = "corner";
      else bad("too sharp a turn: 45° at most", at);
    } else if (all.length === 3) {
      const trunk = all.find((t) => all.every((o) => o === t || turnBetween(t, o) >= 3));
      if (trunk == null) bad("a branch has to leave at 45°", at);
      else if (v.stub) bad("no switch right beside a turntable", at);
      else {
        v.kind = "switch"; v.trunk = trunk;
        // the leg that carries straight on first
        v.legs = all.filter((d) => d !== trunk).sort((a, b) => turnBetween(trunk, b) - turnBetween(trunk, a) || a - b);
      }
    } else bad("too many tracks meet here", at);
  }

  // where each track leaves a grid point, after rounding the corner there
  const trim = (v, d) => (v.kind === "corner" || (v.kind === "switch" && (d === v.trunk || turnBetween(v.trunk, d) === 3)) ? TRIM : 0);
  const port = (v, d) => { const t = trim(v, d), [ux, uy] = unit(d); return [v.x + t * ux, v.y + t * uy]; };
  for (const v of verts.values()) if (v.stub && v.kind && trim(v, v.stub.dir) > v.stub.len + 1e-9) bad("too tight a curve beside the turntable", [v.x, v.y]);

  // spots: [x, y, which way the track runs there]
  const spots = [];
  for (const [a, b] of edges.values()) spots.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, dirOf(b[0] - a[0], b[1] - a[1])]);
  for (const v of verts.values()) if (v.stub && v.stub.len > 1 - 1e-9) spots.push([(v.x + v.stub.rim[0]) / 2, (v.y + v.stub.rim[1]) / 2, v.stub.dir]);
  for (const T of tables) {
    const [ux, uy] = unit(T.deck);
    for (let i = 0; i < T.length; i++) { const o = i + 0.5 - T.length / 2; spots.push([T.at[0] + o * ux, T.at[1] + o * uy, T.deck, T.id]); }
  }

  const switchAt = new Map();
  for (const v of verts.values()) if (v.kind === "switch") switchAt.set(v.key, { at: [v.x, v.y], trunk: v.trunk, legs: v.legs, points: port(v, v.trunk) });
  if (problems.length) return { def: null, problems, spots, switchAt, tables };

  // A curve round grid point v from where track d1 leaves it to where d2 does:
  // the points after the first.
  function arc(v, d1, d2) {
    const [ax, ay] = unit(d1), [bx, by] = unit(d2);
    let mx = ax + bx, my = ay + by;
    const ml = Math.hypot(mx, my); mx /= ml; my /= ml;
    const half = Math.acos(ax * bx + ay * by) / 2;
    const cx = v.x + (mx * TRIM) / Math.cos(half), cy = v.y + (my * TRIM) / Math.cos(half), R = TRIM * Math.tan(half);
    const p = port(v, d1), q = port(v, d2);
    const a0 = Math.atan2(p[1] - cy, p[0] - cx);
    let da = Math.atan2(q[1] - cy, q[0] - cx) - a0;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    const out = [];
    for (let k = 1; k < ARC_STEPS; k++) { const a = a0 + (da * k) / ARC_STEPS; out.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]); }
    out.push(q);
    return out;
  }

  // Trace each track from one node to the next. Tags name a node and which
  // way the track leaves it, so a track found from both ends is kept once.
  const tracks = [], byTag = new Map(), seen = new Set(), visited = new Set();
  const nodes = {};
  function trace(startTag, pts, v, d) {
    const push = (p) => { const q = pts[pts.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) pts.push(p); };
    visited.add(v.key);
    let endTag;
    for (let guard = 0; guard < 100000; guard++) {
      // leave v along d
      push(port(v, d));
      if (v.stub && d === v.stub.dir) { push(v.stub.rim); endTag = `rim:${v.stub.table}.${v.stub.exit}`; break; }
      const w = verts.get(vkey(v.x + DIRS[d][0], v.y + DIRS[d][1])), e = opp(d);
      visited.add(w.key);
      push(port(w, e));
      if (w.kind === "buffer") { endTag = `b${w.key}`; break; }
      if (w.kind === "switch") {
        if (e !== w.trunk) { if (turnBetween(w.trunk, e) === 3) pts.push(...arc(w, e, w.trunk)); else push(port(w, w.trunk)); }
        endTag = `${w.key}:${e}`;
        break;
      }
      const next = w.all.find((x) => x !== e);
      if (w.kind === "corner") pts.push(...arc(w, e, next));
      v = w; d = next;
    }
    const key = [startTag, endTag].sort().join("~");
    if (seen.has(key)) return;
    seen.add(key);
    const id = `t${tracks.length}`;
    const nodeOf = (tag) => (tag.startsWith("rim:") ? tag.slice(4) : tag.startsWith("b") ? tag : tag.split(":")[0]);
    tracks.push({ id, from: nodeOf(startTag), to: nodeOf(endTag), via: pts.slice(1, -1) });
    byTag.set(startTag, id); byTag.set(endTag, id);
  }
  const sorted = [...verts.values()].sort((p, q) => p.y - q.y || p.x - q.x);
  for (const v of sorted) {
    if (v.kind === "buffer") {
      nodes[`b${v.key}`] = [v.x, v.y];
      if (v.stub) { // just a stub: a bare exit with a buffer stop at the grid point
        trace(`b${v.key}`, [[v.x, v.y]], v, v.stub.dir);
      } else trace(`b${v.key}`, [[v.x, v.y]], v, v.all[0]);
    } else if (v.kind === "switch") {
      const N = port(v, v.trunk);
      nodes[v.key] = N;
      trace(`${v.key}:${v.trunk}`, [N], v, v.trunk);
      for (const l of v.legs) {
        const pts = [N];
        if (turnBetween(v.trunk, l) === 3) pts.push(...arc(v, v.trunk, l)); else pts.push([v.x, v.y]);
        trace(`${v.key}:${l}`, pts, v, l);
      }
    }
  }
  // exits whose track carries on to something already found from the far end
  for (const v of sorted) if (v.stub && v.kind !== "buffer" && !byTag.has(`rim:${v.stub.table}.${v.stub.exit}`)) {
    const pts = [v.stub.rim];
    pts.push(port(v, v.stub.dir));
    // arriving at v from the rim: carry on the other way
    const e = v.stub.dir;
    const next = v.all.find((x) => x !== e);
    if (v.kind === "corner") pts.push(...arc(v, e, next));
    trace(`rim:${v.stub.table}.${v.stub.exit}`, pts, v, next);
  }
  for (const v of verts.values()) if (!visited.has(v.key) && v.dirs.length) { bad("a loop of track needs a switch on it", [v.x, v.y]); break; }
  for (const v of verts.values()) if (v.kind === "switch" && byTag.get(`${v.key}:${v.legs[0]}`) === byTag.get(`${v.key}:${v.legs[1]}`)) bad("a switch's legs can't loop back into it", [v.x, v.y]);
  if (problems.length) return { def: null, problems, spots, switchAt, tables };

  const switches = {};
  for (const [k, S] of switchAt) {
    switches[k] = { trunk: byTag.get(`${k}:${S.trunk}`), legs: S.legs.map((l) => byTag.get(`${k}:${l}`)) };
  }
  const turntables = Object.fromEntries(tables.map((T) => [T.id, {
    center: T.at, length: T.length,
    exits: T.exits.map((d) => (Math.atan2(DIRS[d][1], DIRS[d][0]) * 180) / Math.PI),
    deck: (Math.atan2(DIRS[T.deck][1], DIRS[T.deck][0]) * 180) / Math.PI,
  }]));
  return { def: { nodes, tracks, switches, turntables }, problems, spots, switchAt, tables };
}
