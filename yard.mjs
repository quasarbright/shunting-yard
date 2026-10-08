// Shunting yard: track geometry, the rules of moving cars, and a solver.
//
// Units are car lengths. A track is a polyline between two nodes, cut into
// car-length slots. A node is a buffer stop (one track), a plain join (two),
// or a switch (three: a trunk and two legs, one leg selected at a time).
// Every car sits in exactly one slot.
//
// Slot centers are exactly one car length apart along the track everywhere,
// including across nodes, so a coupled train keeps its spacing as it moves.
// That means every track between two non-buffer nodes must be a whole number
// of car lengths long; a track ending at a buffer leaves any spare length at
// the buffer.

// def = {
//   nodes: { id: [x, y] },
//   tracks: [{ id, from, to, via?: [[x, y], ...] }],
//   switches: { nodeId: { trunk: trackId, legs: [trackId, trackId] } },
// }
export function buildYard(def) {
  const nodes = {};
  for (const [id, [x, y]] of Object.entries(def.nodes)) nodes[id] = { id, x, y, tracks: [] };
  const tracks = {}, slots = [];
  for (const t of def.tracks) {
    nodes[t.from].tracks.push(t.id);
    nodes[t.to].tracks.push(t.id);
  }
  const kind = (n) => nodes[n].tracks.length === 1 ? "buffer" : nodes[n].tracks.length === 2 ? "join" : "switch";
  for (const t of def.tracks) {
    const pts = [[nodes[t.from].x, nodes[t.from].y], ...(t.via || []), [nodes[t.to].x, nodes[t.to].y]];
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const len = cum[cum.length - 1];
    const bufFrom = kind(t.from) === "buffer", bufTo = kind(t.to) === "buffer";
    const n = !bufFrom && !bufTo ? Math.round(len) : Math.floor(len + 1e-3);
    if (n < 1) throw new Error(`track ${t.id} is shorter than a car`);
    if (!bufFrom && !bufTo && Math.abs(len - n) > 1e-3) throw new Error(`track ${t.id} is ${len.toFixed(3)} long; it runs between switches, so it must be a whole number of cars`);
    // where slot 0's center sits: packed against whichever end isn't a buffer
    const first = bufFrom && !bufTo ? len - n + 0.5 : bufFrom && bufTo ? (len - n) / 2 + 0.5 : 0.5;
    const track = { id: t.id, from: t.from, to: t.to, pts, cum, len, slots: [] };
    for (let i = 0; i < n; i++) {
      const s = first + i;
      const p = pointOnTrack(track, s);
      track.slots.push(slots.length);
      slots.push({ id: slots.length, track: t.id, i, s, x: p.x, y: p.y, ang: p.ang });
    }
    tracks[t.id] = track;
  }
  const switchIds = Object.keys(def.switches || {});
  const switches = switchIds.map((id) => ({ id, ...def.switches[id] }));
  for (const id of Object.keys(nodes)) {
    nodes[id].kind = kind(id);
    if (nodes[id].kind === "switch" && !def.switches[id]) throw new Error(`node ${id} has 3 tracks but no switch`);
  }
  // The two legs of a switch start out side by side, so a car parked on the
  // first slot of one leg is in the way of a car on the first slot of the
  // other (railways call this fouling). slot.fouls lists the slots it clashes with.
  for (const sl of slots) sl.fouls = [];
  const endOf = (tid, nid) => { const t = tracks[tid]; return t.from === nid ? t.slots[0] : t.slots[t.slots.length - 1]; };
  for (const S of switches) {
    const [a, b] = S.legs.map((l) => endOf(l, S.id));
    slots[a].fouls.push(b); slots[b].fouls.push(a);
  }
  // bounds, for fitting to the screen
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of Object.values(tracks)) for (const [x, y] of t.pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { nodes, tracks, slots, switches, switchIndex: Object.fromEntries(switchIds.map((id, i) => [id, i])), bounds: { minX, minY, maxX, maxY } };
}

export function pointOnTrack(track, s) {
  const { pts, cum } = track;
  s = Math.max(0, Math.min(track.len, s));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const f = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
  const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
  return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, ang: Math.atan2(y1 - y0, x1 - x0) };
}

// The track you roll onto leaving `trackId` through `nodeId`, with switches
// set as `sw`: { track, dir } (dir +1 if you enter at its `from` end), or null
// at a buffer or a switch set against you.
export function nextTrack(yard, trackId, nodeId, sw) {
  const node = yard.nodes[nodeId];
  let next;
  if (node.kind === "buffer") return null;
  if (node.kind === "join") next = node.tracks[0] === trackId ? node.tracks[1] : node.tracks[0];
  else {
    const k = yard.switchIndex[nodeId], S = yard.switches[k], leg = S.legs[sw[k]];
    if (trackId === S.trunk) next = leg;
    else if (trackId === leg) next = S.trunk;
    else return null; // trailing into a switch set against you
  }
  return { track: next, dir: yard.tracks[next].from === nodeId ? 1 : -1 };
}

// The slot you reach by leaving `slot` in direction dir (+1 toward the track's
// `to` node, -1 toward `from`), with switches set as `sw`. Returns {slot, dir}
// (dir is the direction of travel in the new slot's track) or null.
export function step(yard, slot, dir, sw) {
  const sl = yard.slots[slot], t = yard.tracks[sl.track];
  const j = sl.i + dir;
  if (j >= 0 && j < t.slots.length) return { slot: t.slots[j], dir };
  const nx = nextTrack(yard, t.id, dir > 0 ? t.to : t.from, sw);
  if (!nx) return null;
  const T = yard.tracks[nx.track];
  return { slot: nx.dir > 0 ? T.slots[0] : T.slots[T.slots.length - 1], dir: nx.dir };
}

// slot at a track's end next to a node
export function endSlot(yard, trackId, nodeId) {
  const t = yard.tracks[trackId];
  return t.from === nodeId ? t.slots[0] : t.slots[t.slots.length - 1];
}

// Roll `dist` along the track from (track, s) heading dir, following switches.
// Stops short at a buffer or a switch set against it.
export function walk(yard, trackId, s, dir, dist, sw) {
  if (dist < 0) { dir = -dir; dist = -dist; }
  for (let guard = 0; guard < 100; guard++) {
    const t = yard.tracks[trackId];
    const room = dir > 0 ? t.len - s : s;
    if (dist <= room) { s += dir * dist; break; }
    const nx = nextTrack(yard, trackId, dir > 0 ? t.to : t.from, sw);
    if (!nx) { s = dir > 0 ? t.len : 0; break; }
    dist -= room;
    trackId = nx.track; dir = nx.dir;
    s = dir > 0 ? 0 : yard.tracks[trackId].len;
  }
  return { track: trackId, s, dir, ...pointOnTrack(yard.tracks[trackId], s) };
}

// ---------- slot state (the solver's model) ----------
// Here cars sit only on slot centers; motion.mjs has the continuous version
// the game uses. state = { pos: [slot per car], sw: [leg index per switch], coupled: Set("i,j" with i<j) }
// cars = [{ id, loco?: true }]

export function occupancy(yard, pos) {
  const occ = new Array(yard.slots.length).fill(-1);
  pos.forEach((s, c) => { occ[s] = c; });
  return occ;
}

const pairKey = (i, j) => (i < j ? `${i},${j}` : `${j},${i}`);
export function isCoupled(state, i, j) { return state.coupled.has(pairKey(i, j)); }

// A switch can't be thrown while two cars are coupled across it.
export function switchLocked(yard, state, k, occ = occupancy(yard, state.pos)) {
  const S = yard.switches[k];
  const a = occ[endSlot(yard, S.trunk, S.id)], b = occ[endSlot(yard, S.legs[state.sw[k]], S.id)];
  return a >= 0 && b >= 0 && isCoupled(state, a, b);
}

export function throwSwitch(yard, state, k) {
  if (switchLocked(yard, state, k)) return false;
  state.sw[k] = 1 - state.sw[k];
  return true;
}

export function toggleCoupling(state, a, b) {
  const k = pairKey(a, b);
  if (state.coupled.has(k)) state.coupled.delete(k); else state.coupled.add(k);
}

// What moves if `loco` drives one car length in direction d (relative to its
// slot's track direction): every car touching it ahead gets pushed, and cars
// coupled behind it get pulled. Returns { chain: [car, ...] front to back,
// dest: slot the front car moves into, dirs } or { blocked: true, chain }.
export function driveChain(yard, state, loco, d, occ = occupancy(yard, state.pos), pullAll = false) {
  const ahead = [];
  let cur = { slot: state.pos[loco], dir: d }, next;
  for (;;) {
    next = step(yard, cur.slot, cur.dir, state.sw);
    if (!next || occ[next.slot] < 0) break;
    ahead.push(occ[next.slot]);
    cur = next;
  }
  const behind = [];
  let prev = loco, back = { slot: state.pos[loco], dir: -d };
  for (;;) {
    const nb = step(yard, back.slot, back.dir, state.sw);
    if (!nb) break;
    const c = occ[nb.slot];
    if (c < 0 || !(pullAll || isCoupled(state, prev, c))) break;
    behind.push(c);
    prev = c; back = nb;
  }
  const chain = [...ahead.reverse(), loco, ...behind];
  if (!next) {
    // what stopped it: the node at the far end of the front car's track
    const t = yard.tracks[yard.slots[cur.slot].track];
    return { blocked: true, chain, stopNode: cur.dir > 0 ? t.to : t.from };
  }
  const foul = yard.slots[next.slot].fouls.find((f) => occ[f] >= 0);
  if (foul != null) {
    const into = yard.slots[next.slot].track, t = yard.tracks[into];
    const node = [t.from, t.to].find((n) => yard.switchIndex[n] != null && yard.switches[yard.switchIndex[n]].legs.includes(into));
    const S = yard.switches[yard.switchIndex[node]];
    // coming down a leg toward the points, the nose would hit that car's side
    if (yard.slots[cur.slot].track !== S.trunk) return { blocked: true, chain, stopNode: node, fouled: true };
    // coming through from the trunk, the nose shoves it (and whatever it
    // touches) one car further up its leg
    const ft = yard.tracks[yard.slots[foul].track];
    let at = { slot: foul, dir: ft.from === node ? 1 : -1 };
    const side = [occ[foul]];
    let free;
    for (;;) {
      free = step(yard, at.slot, at.dir, state.sw);
      if (!free || occ[free.slot] < 0) break;
      side.push(occ[free.slot]);
      at = free;
    }
    if (!free) return { blocked: true, chain, stopNode: node, fouled: true };
    return { chain, dest: next.slot, side: { chain: side.reverse(), dest: free.slot } };
  }
  return { chain, dest: next.slot };
}

// Drive one car length. Returns the loco's new travel direction, or null if blocked.
export function drive(yard, state, loco, d) {
  const r = driveChain(yard, state, loco, d);
  if (r.blocked) return null;
  const nd = step(yard, state.pos[loco], d, state.sw).dir;
  applyChain(state, r);
  return nd;
}

function applyChain(state, { chain, dest, side }) {
  if (side) applyChain(state, side);
  const old = chain.map((c) => state.pos[c]);
  state.pos[chain[0]] = dest;
  for (let k = 1; k < chain.length; k++) state.pos[chain[k]] = old[k - 1];
}

// ---------- goals ----------
// goal = { track, end: nodeId, cars: [carIndex, ...] } — cars listed in the
// track's from→to order, packed against the `end` node. Other cars can be anywhere.
export function goalSlots(yard, goal) {
  const t = yard.tracks[goal.track], n = goal.cars.length;
  return t.from === goal.end ? t.slots.slice(0, n) : t.slots.slice(t.slots.length - n);
}

export function goalMet(yard, cars, goals, pos) {
  const occ = occupancy(yard, pos);
  return goals.every((g) => goalSlots(yard, g).every((slot, k) => occ[slot] === g.cars[k]));
}

// ---------- solver ----------
// Fewest moves to reach the goal, where a move is a click: throwing a switch,
// or coupling or uncoupling two cars. Driving is free. So this is a search
// where driving one car length costs nothing and a click costs one (a "0-1
// BFS"): a search node is where every car is, how the switches are set, and
// which touching pairs are coupled. Cars with `filler: true` are
// interchangeable.
export function solve(yard, cars, start, goals, { maxStates = 4e6 } = {}) {
  const fillers = cars.map((c, i) => (c.filler ? i : -1)).filter((i) => i >= 0);
  const locos = cars.map((c, i) => (c.loco ? i : -1)).filter((i) => i >= 0);
  const nSw = yard.switches.length;

  const key = (st) => {
    // relabel the fillers in slot order so swapping two of them is the same node
    const rename = new Map();
    if (fillers.length > 1) {
      const order = fillers.slice().sort((a, b) => st.pos[a] - st.pos[b]);
      order.forEach((f, k) => rename.set(f, fillers[k]));
    }
    const p = st.pos.slice();
    for (const [f, g] of rename) p[g] = st.pos[f];
    const pairs = [...st.coupled].map((k) => {
      const [i, j] = k.split(",").map(Number);
      const a = rename.get(i) ?? i, b = rename.get(j) ?? j;
      return a < b ? `${a},${b}` : `${b},${a}`;
    }).sort();
    return p.join(",") + "|" + st.sw.join("") + "|" + pairs.join(";");
  };
  const copy = (st) => ({ pos: st.pos.slice(), sw: st.sw.slice(), coupled: new Set(st.coupled) });

  const s0 = copy(start);
  if (goalMet(yard, cars, goals, s0.pos)) return { moves: 0, states: 1 };
  const dist = new Map([[key(s0), 0]]);
  // two queues: this cost and the next
  let cur = [s0], next = [], cost = 0;
  while (cur.length || next.length) {
    if (!cur.length) { cur = next; next = []; cost++; }
    const st = cur.pop();
    if (dist.get(key(st)) < cost) continue;
    const visit = (n, c) => {
      const k = key(n);
      const d = dist.get(k);
      if (d != null && d <= c) return false;
      dist.set(k, c);
      (c === cost ? cur : next).push(n);
      return true;
    };
    // free: drive any loco one car length either way
    for (const loco of locos) for (const d of [1, -1]) {
      const n = copy(st);
      if (drive(yard, n, loco, d) === null) continue;
      if (visit(n, cost) && goalMet(yard, cars, goals, n.pos)) return { moves: cost, states: dist.size };
    }
    // one move: throw a switch
    const occ = occupancy(yard, st.pos);
    for (let k = 0; k < nSw; k++) {
      if (switchLocked(yard, st, k, occ)) continue;
      const n = copy(st);
      n.sw[k] = 1 - n.sw[k];
      visit(n, cost + 1);
    }
    // one move: couple or uncouple a touching pair
    for (const [a, b] of touching(yard, st, occ)) {
      const n = copy(st);
      toggleCoupling(n, a, b);
      visit(n, cost + 1);
    }
    if (dist.size > maxStates) return { moves: null, states: dist.size, gaveUp: true };
  }
  return { moves: null, states: dist.size };
}

// pairs of cars in neighboring slots along the set route
function touching(yard, st, occ) {
  const out = [], seen = new Set();
  st.pos.forEach((p, a) => {
    for (const d of [1, -1]) {
      const nx = step(yard, p, d, st.sw);
      if (!nx || occ[nx.slot] < 0) continue;
      const b = occ[nx.slot], k = a < b ? `${a},${b}` : `${b},${a}`;
      if (!seen.has(k)) { seen.add(k); out.push([a, b]); }
    }
  });
  return out;
}
