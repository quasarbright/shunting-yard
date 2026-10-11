// Shunting yard: track geometry and how the pieces connect. How things move
// is in motion.mjs.
//
// Units are car lengths. A track is a polyline between two nodes. A node is a
// buffer stop (one track), a plain join (two), a switch (three: a trunk and
// two legs, one leg selected at a time), or one end of a turntable: either the
// rim, where an exit track meets the pit, or an end of the turntable's deck.
//
// Levels are laid out on a grid (see grid.mjs), which works out the nodes
// and the shape of each track; this file only needs the result.
//
// A turntable is a deck (a straight track `length` cars long) that turns in a
// round pit, with exit tracks meeting the rim at fixed angles. It stops
// wherever either end of the deck lines up with an exit.
//
// A pressure plate sits on a track; each time something rolls onto it, the
// switches and turntables wired to it change (see motion.mjs).

// def = {
//   nodes: { id: [x, y] },
//   tracks: [{ id, from, to, via?: [[x, y], ...] }],
//   switches: { nodeId: { trunk: trackId, legs: [trackId, trackId] } },
//   turntables?: { id: { center: [x, y], length, exits: [degrees, ...], deck?: degrees } },
//     rim nodes are named `${id}.${exitIndex}` (positions filled in here);
//     the deck is the track `${id}.deck`, from node `${id}.a` to `${id}.b`,
//     and starts with its `a` end pointing at `deck` (the first exit if not given)
//   plates?: [{ track, s, wires: [switchNodeId | turntableId, ...] }],
// }
export function buildYard(def) {
  const nodes = {};
  for (const [id, [x, y]] of Object.entries(def.nodes)) nodes[id] = { id, x, y, tracks: [] };

  // turntables: rim nodes, deck ends, and the deck track
  const turntables = [], turntableIndex = {};
  const tracksDef = def.tracks.slice();
  for (const [id, tt] of Object.entries(def.turntables || {})) {
    const r = tt.length / 2, [cx, cy] = tt.center;
    const exits = tt.exits.map((deg, i) => {
      const a = (deg * Math.PI) / 180, node = `${id}.${i}`;
      nodes[node] = { id: node, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), tracks: [], turntable: id, exit: i };
      return { angle: a, node };
    });
    // a stop: an angle where one end of the deck lines up with an exit
    const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const stops = [];
    for (const [i, e] of exits.entries()) for (const [end, a] of [["a", e.angle], ["b", e.angle + Math.PI]]) {
      const ang = norm(a);
      let s = stops.find((q) => Math.abs(Math.sin((q.angle - ang) / 2)) < 1e-6);
      if (!s) { s = { angle: ang, a: null, b: null }; stops.push(s); }
      s[end] = i;
    }
    stops.sort((p, q) => p.angle - q.angle);
    nodes[`${id}.a`] = { id: `${id}.a`, x: cx + r, y: cy, tracks: [], turntable: id, deckEnd: "a" };
    nodes[`${id}.b`] = { id: `${id}.b`, x: cx - r, y: cy, tracks: [], turntable: id, deckEnd: "b" };
    tracksDef.push({ id: `${id}.deck`, from: `${id}.a`, to: `${id}.b` });
    turntableIndex[id] = turntables.length;
    const want = tt.deck != null ? (tt.deck * Math.PI) / 180 : exits.length ? exits[0].angle : 0;
    let start = stops.findIndex((s) => Math.abs(Math.sin((s.angle - norm(want)) / 2)) < 1e-6);
    if (start < 0) start = 0;
    if (!stops.length) stops.push({ angle: norm(want), a: null, b: null });
    turntables.push({ id, center: [cx, cy], r, length: tt.length, deck: `${id}.deck`, exits, stops, start });
  }

  const tracks = {};
  for (const t of tracksDef) {
    nodes[t.from].tracks.push(t.id);
    nodes[t.to].tracks.push(t.id);
  }
  const kind = (n) => nodes[n].turntable ? (nodes[n].deckEnd ? "deck" : "rim")
    : nodes[n].tracks.length === 1 ? "buffer" : nodes[n].tracks.length === 2 ? "join" : "switch";
  for (const t of tracksDef) {
    const pts = [[nodes[t.from].x, nodes[t.from].y], ...(t.via || []), [nodes[t.to].x, nodes[t.to].y]];
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    tracks[t.id] = { id: t.id, from: t.from, to: t.to, pts, cum, len: cum[cum.length - 1] };
  }
  const switchIds = Object.keys(def.switches || {});
  const switches = switchIds.map((id) => ({ id, ...def.switches[id] }));
  for (const id of Object.keys(nodes)) {
    nodes[id].kind = kind(id);
    if (nodes[id].kind === "switch" && !def.switches[id]) throw new Error(`node ${id} has 3 tracks but no switch`);
  }
  const switchIndex = Object.fromEntries(switchIds.map((id, i) => [id, i]));

  // pressure plates, and which switches and turntables they drive (those get no lever)
  const plates = (def.plates || []).map((p) => {
    const wires = p.wires.map((w) => (switchIndex[w] != null ? { switch: switchIndex[w] } : turntableIndex[w] != null ? { turntable: turntableIndex[w] } : null));
    if (wires.includes(null)) throw new Error(`plate on ${p.track} is wired to something that isn't a switch or turntable`);
    return { track: p.track, s: p.s, wires };
  });
  for (const S of switches) S.lever = !plates.some((p) => p.wires.some((w) => w.switch === switchIndex[S.id]));
  for (const [k, T] of turntables.entries()) T.manual = !plates.some((p) => p.wires.some((w) => w.turntable === k));

  // bounds, for fitting to the screen
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  for (const t of Object.values(tracks)) for (const [x, y] of t.pts) grow(x, y);
  for (const T of turntables) { grow(T.center[0] - T.r, T.center[1] - T.r); grow(T.center[0] + T.r, T.center[1] + T.r); }
  if (minX > maxX) minX = minY = maxX = maxY = 0; // no track yet
  const yard = { nodes, tracks, switches, switchIndex, turntables, turntableIndex, plates, bounds: { minX, minY, maxX, maxY } };
  for (let k = 0; k < turntables.length; k++) setDeckAngle(yard, k, turntables[k].stops[turntables[k].start].angle);
  return yard;
}

// Point the deck's `a` end at `angle` (radians). The deck's geometry is the
// only part of the yard that changes; it's used only for drawing.
export function setDeckAngle(yard, k, angle) {
  const T = yard.turntables[k], [cx, cy] = T.center, t = yard.tracks[T.deck];
  const ax = cx + T.r * Math.cos(angle), ay = cy + T.r * Math.sin(angle);
  t.pts = [[ax, ay], [2 * cx - ax, 2 * cy - ay]];
  for (const [end, x, y] of [["a", ax, ay], ["b", 2 * cx - ax, 2 * cy - ay]]) { yard.nodes[`${T.id}.${end}`].x = x; yard.nodes[`${T.id}.${end}`].y = y; }
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
// and turntables set as in `st` ({ sw, tt }): { track, dir } (dir +1 if you
// enter at its `from` end), or null at a buffer, a switch set against you, or
// the edge of a turntable pit that isn't lined up.
export function nextTrack(yard, trackId, nodeId, st) {
  const node = yard.nodes[nodeId];
  let next;
  if (node.kind === "buffer") return null;
  if (node.kind === "join") next = node.tracks[0] === trackId ? node.tracks[1] : node.tracks[0];
  else if (node.kind === "switch") {
    const k = yard.switchIndex[nodeId], S = yard.switches[k], leg = S.legs[st.sw[k]];
    if (trackId === S.trunk) next = leg;
    else if (trackId === leg) next = S.trunk;
    else return null; // trailing into a switch set against you
  } else {
    const k = yard.turntableIndex[node.turntable], T = yard.turntables[k], stop = T.stops[st.tt[k]];
    if (node.kind === "rim") {
      // from an exit onto the deck, if an end of the deck is here
      if (stop.a === node.exit) next = T.deck, nodeId = `${T.id}.a`;
      else if (stop.b === node.exit) next = T.deck, nodeId = `${T.id}.b`;
      else return null;
    } else {
      // off the end of the deck onto whatever exit it's lined up with
      const exit = stop[node.deckEnd];
      if (exit == null) return null;
      nodeId = T.exits[exit].node;
      next = yard.nodes[nodeId].tracks[0];
    }
  }
  return { track: next, dir: yard.tracks[next].from === nodeId ? 1 : -1 };
}

// Roll `dist` along the track from (track, s) heading dir, following switches
// and turntables. Stops short where the line ends.
export function walk(yard, trackId, s, dir, dist, st) {
  if (dist < 0) { dir = -dir; dist = -dist; }
  for (let guard = 0; guard < 100; guard++) {
    const t = yard.tracks[trackId];
    const room = dir > 0 ? t.len - s : s;
    if (dist <= room) { s += dir * dist; break; }
    const nx = nextTrack(yard, trackId, dir > 0 ? t.to : t.from, st);
    if (!nx) { s = dir > 0 ? t.len : 0; break; }
    dist -= room;
    trackId = nx.track; dir = nx.dir;
    s = dir > 0 ? 0 : yard.tracks[trackId].len;
  }
  return { track: trackId, s, dir, ...pointOnTrack(yard.tracks[trackId], s) };
}

// The point on any track nearest (x, y): { track, s, dist }.
export function locate(yard, x, y) {
  let best = null;
  for (const t of Object.values(yard.tracks)) {
    for (let i = 1; i < t.pts.length; i++) {
      const [x0, y0] = t.pts[i - 1], [x1, y1] = t.pts[i];
      const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
      const f = l2 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
      const dist = Math.hypot(x0 + dx * f - x, y0 + dy * f - y);
      if (!best || dist < best.dist - 1e-9) best = { track: t.id, s: t.cum[i - 1] + f * (t.cum[i] - t.cum[i - 1]), dist };
    }
  }
  return best;
}
