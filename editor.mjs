// The level editor. The level being edited is a level file (see grid.mjs)
// whose track is kept as a Map of grid steps. Every change is tried on a
// copy and kept only if the level still loads with no problems, so the
// level on screen can always be played.
import { createGame, C, CAR_COLORS, thumbSvg } from "./game.mjs";
import { loadLevel } from "./setup.mjs";
import { layoutOf, edgesOf, pathsOf, ekey, DIRS, DIR_NAMES, vkey, dirOf, turnBetween } from "./grid.mjs";
import { goalMet } from "./motion.mjs";

const $ = (id) => document.getElementById(id);
const LETTERS = "ABCDEFGH".split("");
const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const pkey = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const opp = (d) => (d + 4) % 8;
const unit = (d) => { const [x, y] = DIRS[d], l = Math.hypot(x, y); return [x / l, y / l]; };

// ---------- the level being edited ----------
const blank = (name = "") => ({ name, blurb: "", edges: new Map(), turntables: [], switches: [], plates: [], cars: [], goals: [] });
function toFile(d) {
  const f = { name: d.name, blurb: d.blurb, track: pathsOf(d.edges) };
  for (const k of ["turntables", "switches", "plates", "cars", "goals"]) if (d[k].length) f[k] = d[k];
  return f;
}
function fromFile(f) {
  const c = (x) => JSON.parse(JSON.stringify(x || []));
  return {
    name: f.name ?? "", blurb: f.blurb ?? "", edges: edgesOf(f), turntables: c(f.turntables), switches: c(f.switches),
    plates: c(f.plates).map((p) => ({ ...p, wires: p.wires || [] })), cars: c(f.cars), goals: c(f.goals),
  };
}
const copy = (d) => fromFile(toFile(d));
const snap = (d) => JSON.stringify(toFile(d));

let doc = blank(), docId = null, savedSnap = snap(doc);
let past = [], future = [], lastMerge = null;
let lay = layoutOf(toFile(doc)); // the current layout: spots, switches, turntables
let playing = false;

// where a turntable's deck can point: along any exit
const deckDirs = (T) => [...new Set(T.exits.flatMap((n) => [n, DIR_NAMES[opp(DIR_NAMES.indexOf(n))]]))];

// After a change, drop whatever no longer has a place: things on track that's
// gone, wires to switches that are gone, goals for cars that are gone.
function prune(d) {
  for (const T of d.turntables) if (T.deck && !deckDirs(T).includes(T.deck)) delete T.deck;
  const l = layoutOf(toFile(d));
  if (l.problems.length) return;
  const spots = new Set(l.spots.map(pkey));
  const on = (it) => spots.has(pkey(it.at));
  d.cars = d.cars.filter(on);
  d.plates = d.plates.filter(on);
  const names = new Set(d.cars.map((c) => c.name).filter(Boolean));
  d.goals = d.goals.filter((g) => on(g) && names.has(g.name));
  d.switches = d.switches.filter((s) => { const S = l.switchAt.get(vkey(...s.at)); return S && S.legs.includes(DIR_NAMES.indexOf(s.set)); });
  const targets = new Set([...l.switchAt.keys(), ...d.turntables.map((T) => vkey(...T.at))]);
  for (const p of d.plates) p.wires = p.wires.filter((w) => targets.has(vkey(...w)));
}

// Try a change. It's kept only if the level still loads cleanly; otherwise
// the hint says why. Changes with the same `merge` token (one drag) undo together.
function attempt(change, { merge = null, quiet = false } = {}) {
  const next = copy(doc);
  if (change(next) === false) return false;
  prune(next);
  const lv = loadLevel(toFile(next), { strict: false });
  if (lv.problems.length) { if (!quiet) flash(lv.problems[0].msg, "bad"); return false; }
  if (!(merge != null && merge === lastMerge)) { past.push(snap(doc)); future = []; }
  lastMerge = merge;
  doc = next;
  refresh();
  return true;
}

// Things the level allows but probably doesn't mean: [{ msg, at? }]
let warnings = [];
function warningsOf(file) {
  const out = [];
  if (!file.track.length) return out; // nothing yet
  const cars = file.cars || [], goals = file.goals || [];
  if (!cars.some((c) => c.kind === "locomotive")) out.push({ msg: "There's no locomotive" });
  const goalFor = new Set(goals.map((g) => g.name));
  for (const c of cars) if (c.name && !goalFor.has(c.name)) out.push({ msg: `Car ${c.name} has no goal`, at: c.at });
  if (!goals.length) out.push({ msg: "No goals, so the level can't be finished" });
  else {
    const lv = loadLevel(file, { strict: false });
    if (!lv.problems.length && goalMet(lv.goals, lv.state)) out.push({ msg: "It starts already finished" });
  }
  for (const p of file.plates || []) if (!p.wires.length) out.push({ msg: "A plate isn't wired to anything", at: p.at });
  for (const T of file.turntables || []) if (!T.exits.length) out.push({ msg: "A turntable has no exits", at: T.at });
  if (!file.name.trim()) out.push({ msg: "The level has no name" });
  if (!file.blurb.trim()) out.push({ msg: "There's no line saying what to do" });
  return out;
}

function refresh({ refit = false } = {}) {
  lay = layoutOf(toFile(doc));
  warnings = warningsOf(toFile(doc));
  const box = $("warn");
  box.hidden = !warnings.length || playing;
  box.innerHTML = warnings.map((w) => `<li>${w.msg}</li>`).join("");
  if (refit || outgrown()) fitView();
  if (!playing) game.load(toFile(doc), { play: false });
  $("undo").disabled = !past.length; $("redo").disabled = !future.length;
  const dirty = snap(doc) !== savedSnap;
  $("saved").textContent = !docId ? "not saved yet" : dirty ? "unsaved changes" : "saved";
  $("saved").classList.toggle("is-dirty", dirty || !docId);
  if (document.activeElement !== $("name")) $("name").value = doc.name;
  if (document.activeElement !== $("blurb")) $("blurb").value = doc.blurb;
  showHint();
}

function undo() {
  if (!past.length || playing) return;
  future.push(snap(doc)); doc = fromFile(JSON.parse(past.pop())); lastMerge = null; refresh();
}
function redo() {
  if (!future.length || playing) return;
  past.push(snap(doc)); doc = fromFile(JSON.parse(future.pop())); lastMerge = null; refresh();
}

// ---------- the view ----------
// The view fits the level with room to grow, and only grows while editing
// (it doesn't jump around as track is laid).
let view = { minX: 0, minY: 0, maxX: 14, maxY: 8 };
function contentBounds() {
  let b = null;
  const grow = (x, y) => { if (!b) b = { minX: x, minY: y, maxX: x, maxY: y }; else { b.minX = Math.min(b.minX, x); b.minY = Math.min(b.minY, y); b.maxX = Math.max(b.maxX, x); b.maxY = Math.max(b.maxY, y); } };
  for (const [a, c] of doc.edges.values()) { grow(...a); grow(...c); }
  for (const T of doc.turntables) { const r = T.length / 2 + 1; grow(T.at[0] - r, T.at[1] - r); grow(T.at[0] + r, T.at[1] + r); }
  return b;
}
function fitView() {
  const b = contentBounds();
  if (!b) { view = { minX: 0, minY: 0, maxX: 14, maxY: 8 }; return; }
  const m = 3, w = Math.max(14, b.maxX - b.minX + 2 * m), h = Math.max(8, b.maxY - b.minY + 2 * m);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  view = { minX: Math.floor(cx - w / 2), minY: Math.floor(cy - h / 2), maxX: Math.ceil(cx + w / 2), maxY: Math.ceil(cy + h / 2) };
}
function outgrown() {
  const b = contentBounds();
  return b && (b.minX < view.minX + 1 || b.minY < view.minY + 1 || b.maxX > view.maxX - 1 || b.maxY > view.maxY - 1);
}

// ---------- tools ----------
let tool = "track", letter = { car: "A", goal: "A" };
let hover = null;      // world point under the pointer
let stroke = null;     // a drag in progress
let strokeId = 0;

const HINTS = {
  track: "Drag across the grid to lay track. Click a switch, turntable or locomotive to change which way it starts.",
  erase: "Click or drag over anything to remove it.",
  turntable: "Click to place a turntable, on track or off it. Click its middle to lengthen it; click just outside the rim to add an exit.",
  loco: "Click a spot to put a locomotive there. Click one to turn its coupler round.",
  car: "Click a spot to put this car there, or click it again to take it away.",
  goal: "Click the spot where this car has to end up.",
  plate: "Click a spot for a plate; click a plate to remove it. Drag from a plate to a switch or turntable to wire it.",
};
let flashMsg = null, flashTimer = 0;
function flash(text, kind = "bad", ms = 2600) {
  flashMsg = { text, kind };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashMsg = null; showHint(); }, ms);
  showHint();
}
function showHint() {
  const el = $("hint");
  el.classList.toggle("is-bad", flashMsg?.kind === "bad");
  el.classList.toggle("is-good", flashMsg?.kind === "good");
  if (flashMsg) { el.textContent = flashMsg.text; return; }
  if (playing) { el.textContent = "Playing. Space or Esc goes back to editing."; return; }
  if (!doc.edges.size && tool === "track") { el.textContent = "Start by dragging across the grid to lay some track."; return; }
  el.textContent = HINTS[tool];
}

function setTool(t) {
  tool = t;
  for (const b of document.querySelectorAll("[data-tool]")) b.classList.toggle("is-active", b.dataset.tool === t);
  buildPalette();
  showHint();
}
function buildPalette() {
  const pal = $("palette");
  pal.hidden = tool !== "car" && tool !== "goal";
  if (pal.hidden) return;
  const options = tool === "car" ? ["", ...LETTERS] : LETTERS;
  pal.innerHTML = "";
  options.forEach((l, i) => {
    const b = document.createElement("button");
    b.className = "tool" + (letter[tool] === l ? " is-active" : "");
    b.title = `${l ? `Car ${l}` : "A gray car (any number of them)"} (${i + 1})`;
    b.innerHTML = `<span class="ed-swatch" style="background:${l ? CAR_COLORS[l] : C.filler}">${l}</span>`;
    b.onclick = () => { letter[tool] = l; buildPalette(); };
    pal.appendChild(b);
  });
}

// what's where, in world units
const spotAt = (w, r = 0.45) => {
  let best = null;
  for (const s of lay.spots) { const d = dist(w, s); if (d < r && (!best || d < best.d)) best = { at: [s[0], s[1]], dir: s[2], table: s[3], d }; }
  return best;
};
const indexAt = (list, at) => list.findIndex((it) => same(it.at, at));
const tableAt = (w, extra = 0) => doc.turntables.findIndex((T) => dist(w, T.at) < T.length / 2 + extra);
// A switch near w. Its points are also a spot, so tools that put things on
// spots only count the grid point where it branches.
function switchNear(w, points = true) {
  let best = null;
  for (const [k, S] of lay.switchAt) {
    const d = points ? Math.min(dist(w, S.at), dist(w, S.points)) : dist(w, S.at);
    if (d < (points ? 0.6 : 0.4) && (!best || d < best.d)) best = { k, S, d };
  }
  return best;
}
// the grid step nearest w, if it's close
function edgeNear(w) {
  let best = null;
  for (const [k, [a, b]] of doc.edges) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const f = Math.max(0, Math.min(1, ((w[0] - a[0]) * dx + (w[1] - a[1]) * dy) / l2));
    const d = Math.hypot(a[0] + dx * f - w[0], a[1] + dy * f - w[1]);
    if (d < 0.3 && (!best || d < best.d)) best = { k, d };
  }
  return best;
}
// what Erase would take at w
function eraseTarget(w) {
  for (const kind of ["cars", "plates", "goals"]) {
    const i = doc[kind].findIndex((it) => dist(it.at, w) < 0.4);
    if (i >= 0) return { kind, i };
  }
  const e = edgeNear(w);
  if (e) return { kind: "edge", k: e.k };
  const t = tableAt(w, 0.15);
  if (t >= 0) return { kind: "turntable", i: t };
  return null;
}
function erase(target, merge) {
  if (!target) return;
  attempt((d) => {
    if (target.kind === "edge") d.edges.delete(target.k);
    else if (target.kind === "turntable") d.turntables.splice(target.i, 1);
    else d[target.kind].splice(target.i, 1);
  }, { merge });
}

// the end of a locomotive's coupler that faces mostly right (or down)
function defaultCoupler(dir) {
  const [x, y] = DIRS[dir];
  return DIR_NAMES[x > 0 || (x === 0 && y > 0) ? dir : opp(dir)];
}

// A turntable put down on track takes the track over: the track inside its
// pit goes, and wherever track carries on from just outside the rim, roughly
// straight out, becomes an exit.
function absorb(d, i) {
  const T = d.turntables[i], r = T.length / 2, [cx, cy] = T.at;
  for (const [k, [a, b]] of [...d.edges]) if (dist(a, T.at) < r + 0.3 || dist(b, T.at) < r + 0.3) d.edges.delete(k);
  for (let dir = 0; dir < 8; dir++) {
    const [dx, dy] = DIRS[dir], step = Math.hypot(dx, dy), k = Math.floor(r / step + 1e-9) + 1, v = [cx + k * dx, cy + k * dy];
    if (T.exits.includes(DIR_NAMES[dir])) continue;
    // one track leaving that point, heading straight away from the turntable,
    // or curving off where the stub from the rim is long enough to curve
    const out = [...d.edges.values()].map(([a, b]) => (same(a, v) ? b : same(b, v) ? a : null)).filter(Boolean);
    if (out.length !== 1) continue;
    const turn = turnBetween(dirOf(out[0][0] - v[0], out[0][1] - v[1]), dir);
    if (turn === 0 || (turn === 1 && k * step - r >= 0.5 - 1e-9)) T.exits.push(DIR_NAMES[dir]);
  }
}

function clickTool(w) {
  if (tool === "turntable") {
    const i = tableAt(w, 1.3);
    if (i < 0) {
      const at = [Math.round(w[0]), Math.round(w[1])];
      return attempt((d) => { d.turntables.push({ at, length: 1, exits: [] }); absorb(d, d.turntables.length - 1); });
    }
    const T = doc.turntables[i], r = T.length / 2;
    if (dist(w, T.at) < Math.max(0.35, r - 0.15)) {
      // longer, until 3, then back to 1; a longer one takes over more of the track
      return attempt((d) => { d.turntables[i].length = (T.length % 3) + 1; absorb(d, i); });
    }
    // just outside the rim: the exit that way
    const ang = Math.atan2(w[1] - T.at[1], w[0] - T.at[0]);
    const dir = DIR_NAMES[((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8];
    return attempt((d) => {
      const t = d.turntables[i];
      t.exits = t.exits.includes(dir) ? t.exits.filter((x) => x !== dir) : [...t.exits, dir];
    });
  }
  if (tool === "track") return toggleAt(w);
  const s = spotAt(w);
  if (!s) return toggleAt(w, { points: false });
  if (tool === "loco") {
    const i = indexAt(doc.cars, s.at);
    if (i >= 0 && doc.cars[i].kind === "locomotive") return attempt((d) => { const c = d.cars[i]; c.coupler = DIR_NAMES[opp(DIR_NAMES.indexOf(c.coupler || "E"))]; });
    return attempt((d) => {
      if (i >= 0) d.cars.splice(i, 1);
      d.cars.push({ at: s.at, kind: "locomotive", coupler: defaultCoupler(s.dir) });
    });
  }
  if (tool === "car") {
    const l = letter.car, i = indexAt(doc.cars, s.at);
    if (i >= 0 && !doc.cars[i].kind && (doc.cars[i].name || "") === l) return attempt((d) => { d.cars.splice(i, 1); });
    return attempt((d) => {
      d.cars = d.cars.filter((c) => !same(c.at, s.at) && !(l && c.name === l));
      d.cars.push(l ? { at: s.at, name: l } : { at: s.at });
    });
  }
  if (tool === "goal") {
    const l = letter.goal, i = indexAt(doc.goals, s.at);
    if (i >= 0 && doc.goals[i].name === l) return attempt((d) => { d.goals.splice(i, 1); });
    if (!doc.cars.some((c) => c.name === l)) return flash(`put car ${l} somewhere first`);
    return attempt((d) => {
      d.goals = d.goals.filter((g) => !same(g.at, s.at) && g.name !== l);
      d.goals.push({ at: s.at, name: l });
    });
  }
  if (tool === "plate") {
    const i = indexAt(doc.plates, s.at);
    if (i >= 0) return attempt((d) => { d.plates.splice(i, 1); });
    return attempt((d) => { d.plates.push({ at: s.at, wires: [] }); });
  }
}

// What a click on w would change about how the level starts: a switch's
// leg, a turntable's deck, or a locomotive's coupler. null if nothing's there.
function toggleTarget(w, { points = true } = {}) {
  const sw = switchNear(w, points);
  if (sw) return { kind: "switch", sw };
  const s = spotAt(w), li = s ? doc.cars.findIndex((c) => c.kind === "locomotive" && same(c.at, s.at)) : -1;
  if (li >= 0) return { kind: "loco", i: li };
  const t = tableAt(w, 0.2);
  if (t >= 0) return { kind: "turntable", i: t };
  return null;
}

function toggleAt(w, opts) {
  const tg = toggleTarget(w, opts);
  if (!tg) return;
  if (tg.kind === "loco") return attempt((d) => { const c = d.cars[tg.i]; c.coupler = DIR_NAMES[opp(DIR_NAMES.indexOf(c.coupler || "E"))]; });
  if (tg.kind === "switch") {
    const { k, S } = tg.sw;
    return attempt((d) => {
      const i = d.switches.findIndex((s) => vkey(...s.at) === k);
      const cur = i >= 0 ? DIR_NAMES.indexOf(d.switches[i].set) : S.legs[0];
      const next = S.legs.find((l) => l !== cur);
      if (i >= 0) d.switches.splice(i, 1);
      if (next !== S.legs[0]) d.switches.push({ at: S.at, set: DIR_NAMES[next] });
    });
  }
  // a turntable: the deck starts pointing along the next exit round
  const t = tg.i, T = doc.turntables[t], dirs = deckDirs(T);
  if (dirs.length < 2) return flash("give the turntable an exit first");
  const cur = T.deck ?? T.exits[0], next = dirs[(dirs.indexOf(cur) + 1) % dirs.length];
  // whatever's on the deck turns with it
  const [ux, uy] = unit(DIR_NAMES.indexOf(cur)), [vx, vy] = unit(DIR_NAMES.indexOf(next));
  const turn = (at) => {
    const o = (at[0] - T.at[0]) * ux + (at[1] - T.at[1]) * uy, off = Math.hypot(at[0] - T.at[0] - o * ux, at[1] - T.at[1] - o * uy);
    return off < 1e-6 && Math.abs(o) < T.length / 2 ? [T.at[0] + o * vx, T.at[1] + o * vy] : null;
  };
  return attempt((d) => {
    d.turntables[t].deck = next;
    for (const it of [...d.cars, ...d.goals, ...d.plates]) {
      const to = turn(it.at);
      if (!to) continue;
      it.at = to.map((v) => Math.round(v * 1e9) / 1e9);
      if (it.coupler) { const c = DIR_NAMES.indexOf(it.coupler); it.coupler = c === DIR_NAMES.indexOf(cur) ? next : c === opp(DIR_NAMES.indexOf(cur)) ? DIR_NAMES[opp(DIR_NAMES.indexOf(next))] : it.coupler; }
    }
  });
}

// what a plate's wire is being dragged to
function wireTarget(w) {
  const sw = switchNear(w);
  if (sw) return sw.S.at;
  const t = tableAt(w, 0.3);
  return t >= 0 ? doc.turntables[t].at : null;
}

// ---------- the game, drawing the level ----------
const game = createGame($("yard"), {
  rotate: false,
  maxL: 72,
  nudgeEl: $("nudge"),
  view: () => (playing ? null : view),
  margins: () => (playing ? { top: 90, bottom: 100, side: 30 } : { top: 80, bottom: 90, left: 84, right: 24 }),
  onWin: () => flash("Level complete", "good", 4000),
  underlay: drawGrid,
  overlay: drawOverlay,
});

function drawGrid(ctx, v) {
  if (playing) return;
  const { sx, sy, wx, wy } = v, L = v.L;
  // every grid point on screen: track can go anywhere you can see
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.fillStyle = "#3a454c";
  for (let x = Math.floor(wx(0)); x <= Math.ceil(wx(W)); x++) for (let y = Math.floor(wy(0)); y <= Math.ceil(wy(H)); y++) {
    ctx.beginPath(); ctx.arc(sx(x), sy(y), Math.max(1.5, L * 0.035), 0, Math.PI * 2); ctx.fill();
  }
}

function drawOverlay(ctx, v) {
  if (playing) return;
  const { sx, sy } = v, L = v.L;
  const ring = (p, r, color, width = 2, dash = null) => {
    ctx.beginPath(); ctx.arc(sx(p[0]), sy(p[1]), r, 0, Math.PI * 2);
    ctx.setLineDash(dash || []); ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke(); ctx.setLineDash([]);
  };
  const line = (a, b, color, width) => {
    ctx.beginPath(); ctx.moveTo(sx(a[0]), sy(a[1])); ctx.lineTo(sx(b[0]), sy(b[1]));
    ctx.lineCap = "round"; ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke();
  };
  // spots, for the tools that put things on them
  if (["loco", "car", "goal", "plate"].includes(tool)) {
    for (const s of lay.spots) ring(s, Math.max(3, L * 0.07), "rgba(242,169,59,.35)", 1.5);
  }
  // things that are allowed but probably not meant, where they are
  for (const wn of warnings) if (wn.at) ring(wn.at, L * 0.55, C.danger, 2.5, [6, 4]);
  if (!hover) return;
  // something a click would toggle: a switch, turntable or locomotive
  const toggle = (tg) => {
    if (tg.kind === "switch") ring([(tg.sw.S.at[0] + tg.sw.S.points[0]) / 2, (tg.sw.S.at[1] + tg.sw.S.points[1]) / 2], L * 0.45, C.amberHi, 3);
    else if (tg.kind === "loco") ring(doc.cars[tg.i].at, L * 0.5, C.amberHi, 3);
    else { const T = doc.turntables[tg.i]; ring(T.at, (T.length / 2 + 0.15) * L, C.amberHi, 3); }
  };
  if (tool === "track" && !stroke?.erasing) {
    const tg = !stroke?.laid && toggleTarget(hover);
    if (tg) { toggle(tg); return; }
    const g = [Math.round(hover[0]), Math.round(hover[1])];
    ring(g, Math.max(5, L * 0.14), C.amberHi, 2.5);
    if (stroke?.last && !stroke.dead) line(stroke.last, g, "rgba(255,192,97,.5)", Math.max(3, L * 0.1));
  } else if (tool === "erase" || stroke?.erasing) {
    const t = eraseTarget(hover);
    if (t?.kind === "edge") { const [a, b] = doc.edges.get(t.k); line(a, b, C.danger, Math.max(4, L * 0.16)); }
    else if (t?.kind === "turntable") { const T = doc.turntables[t.i]; ring(T.at, (T.length / 2 + 0.15) * L, C.danger, 4); }
    else if (t) ring(doc[t.kind][t.i].at, L * 0.5, C.danger, 3);
  } else if (tool === "turntable") {
    const i = tableAt(hover, 1.3);
    if (i < 0) ring([Math.round(hover[0]), Math.round(hover[1])], L * 0.62, C.amberHi, 2, [5, 4]);
    else {
      const T = doc.turntables[i], r = T.length / 2;
      if (dist(hover, T.at) < Math.max(0.35, r - 0.15)) ring(T.at, (r + 0.12) * L, C.amberHi, 3);
      else {
        const ang = Math.atan2(hover[1] - T.at[1], hover[0] - T.at[0]), d = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
        const [ux, uy] = unit(d);
        line([T.at[0] + ux * r, T.at[1] + uy * r], [T.at[0] + ux * (r + 0.8), T.at[1] + uy * (r + 0.8)], T.exits.includes(DIR_NAMES[d]) ? C.danger : C.amberHi, Math.max(3, L * 0.1));
      }
    }
  } else {
    const s = spotAt(hover);
    if (s) {
      const col = tool === "loco" ? C.amber : tool === "plate" ? C.wire : CAR_COLORS[letter[tool]] || C.filler;
      ring(s.at, L * 0.42, col, 3);
    } else if (!stroke) {
      const tg = toggleTarget(hover, { points: false });
      if (tg) toggle(tg);
    }
  }
  if (stroke?.wire) {
    const from = doc.plates[stroke.wire.plate].at, to = wireTarget(hover);
    ctx.setLineDash([L * 0.12, L * 0.1]);
    line(from, to || hover, C.wire, Math.max(2, L * 0.05));
    ctx.setLineDash([]);
    if (to) ring(to, L * 0.35, C.wire, 3);
  }
}

// ---------- pointer ----------
const canvas = $("yard");
const world = (e) => { const [px, py] = game.view.pointer(e); return [game.view.wx(px), game.view.wy(py)]; };

canvas.addEventListener("contextmenu", (e) => { if (!playing) e.preventDefault(); });
canvas.addEventListener("pointerdown", (e) => {
  if (playing) return;
  const w = world(e);
  hover = w;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  const id = ++strokeId;
  if (e.button === 2 || tool === "erase") {
    stroke = { id, erasing: true };
    erase(eraseTarget(w), id);
    return;
  }
  if (tool === "track") {
    // a drag lays track; a click (on a switch, turntable or locomotive) toggles it
    stroke = { id, last: [Math.round(w[0]), Math.round(w[1])], dead: false, start: w, laid: false };
    return;
  }
  if (tool === "plate") {
    const s = spotAt(w), i = s ? indexAt(doc.plates, s.at) : -1;
    if (i >= 0) { stroke = { id, wire: { plate: i }, start: w }; return; }
  }
  clickTool(w);
});
canvas.addEventListener("pointermove", (e) => {
  if (playing) return;
  const w = world(e);
  hover = w;
  if (!stroke) return;
  if (stroke.erasing) { erase(eraseTarget(w), stroke.id); return; }
  if (tool === "track" && !stroke.dead) {
    // the nearest grid point, once the pointer's close to it
    const g = [Math.round(w[0]), Math.round(w[1])];
    if (dist(w, g) > 0.4) return;
    while (!same(stroke.last, g)) {
      const a = stroke.last, b = [a[0] + Math.sign(g[0] - a[0]), a[1] + Math.sign(g[1] - a[1])];
      if (!doc.edges.has(ekey(a, b)) && !attempt((d) => { d.edges.set(ekey(a, b), [a, b]); }, { merge: stroke.id })) { stroke.dead = true; break; }
      stroke.last = b;
      stroke.laid = true;
    }
  }
});
const endStroke = (e) => {
  if (!stroke) return;
  if (stroke.start && !stroke.laid && !stroke.dead && e && dist(world(e), stroke.start) < 0.3) clickTool(stroke.start);
  if (stroke.wire && e) {
    const w = world(e), to = wireTarget(w), i = stroke.wire.plate;
    if (to) {
      attempt((d) => {
        const p = d.plates[i], has = p.wires.findIndex((x) => same(x, to));
        if (has >= 0) p.wires.splice(has, 1); else p.wires.push(to);
      });
    } else if (dist(w, stroke.start) < 0.3) attempt((d) => { d.plates.splice(i, 1); }); // a click: remove it
  }
  stroke = null;
};
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", () => { stroke = null; });
canvas.addEventListener("pointerleave", () => { if (!stroke) hover = null; });

// ---------- playing ----------
function setPlaying(on) {
  playing = on;
  $("rail").hidden = on;
  $("warn").hidden = on || !warnings.length;
  $("play").querySelector("span").textContent = on ? "Edit" : "Play";
  $("play").querySelector("svg").innerHTML = on ? '<path d="M4 20h4L19 9l-4-4L4 16z"/>' : '<path d="M7 4.5v15l12-7.5z"/>';
  $("play").title = on ? "back to editing (Space or Esc)" : "play it, then come back to editing (Space)";
  flashMsg = null;
  if (on) game.load(toFile(doc), { play: true }); else { game.hide(); refresh({ refit: true }); }
  showHint();
}

// ---------- files ----------
let catalog = { order: [], levels: [] };
async function loadCatalog() { catalog = await (await fetch("/api/levels")).json(); }
async function fetchLevel(id) { return (await fetch(`levels/${id}.level.json`, { cache: "no-store" })).json(); }

function updateWhere() {
  const i = catalog.order.indexOf(docId);
  $("where").innerHTML = !docId ? "" : i >= 0 ? `level <b>${i + 1}</b> in the game · ${docId}` : `draft, not in the game · ${docId}`;
}

async function openLevel(id) {
  if (!confirmLeave()) return;
  doc = fromFile(await fetchLevel(id));
  docId = id; savedSnap = snap(doc); past = []; future = []; lastMerge = null;
  history.replaceState(null, "", `?level=${encodeURIComponent(id)}`);
  if (playing) setPlaying(false);
  refresh({ refit: true });
  updateWhere();
}
function confirmLeave() {
  return snap(doc) === savedSnap || confirm("This level has unsaved changes. Leave it anyway?");
}

async function save() {
  if (!docId) return;
  const res = await fetch(`/api/levels/${docId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toFile(doc)) });
  if (!res.ok) return flash(`couldn't save: ${(await res.json()).error}`);
  savedSnap = snap(doc);
  await loadCatalog();
  refresh();
  updateWhere();
  flash("Saved", "good", 1200);
}

const slug = (s) => s.toLowerCase().trim().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
async function create() {
  const name = $("newName").value.trim(), id = slug(name);
  if (!id) return;
  if (catalog.levels.some((l) => l.id === id)) return flash(`there's already a level called ${id}`);
  if (!confirmLeave()) return;
  doc = blank(name); docId = id; savedSnap = ""; past = []; future = [];
  await save();
  $("newName").value = "";
  closeLevels();
  history.replaceState(null, "", `?level=${encodeURIComponent(id)}`);
  refresh({ refit: true });
  updateWhere();
}

async function putOrder(order) {
  await fetch("/api/order", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order) });
  await loadCatalog();
  updateWhere();
}

// the level list: thumbnails, in game order, then the drafts; drag rows to reorder
let thumbs = new Map();
async function showLevels() {
  await loadCatalog();
  await Promise.all(catalog.levels.map(async (l) => { if (!thumbs.has(l.id) || l.id === docId) thumbs.set(l.id, thumbSvg(await fetchLevel(l.id), "ed-thumb")); }));
  buildLists();
  $("levels").hidden = false;
  $("levels").querySelector(".ed-sheet").scrollTop = 0;
}
function closeLevels() { $("levels").hidden = true; }
function buildLists() {
  const byId = new Map(catalog.levels.map((l) => [l.id, l]));
  const inGame = catalog.order.filter((id) => byId.has(id));
  const drafts = catalog.levels.map((l) => l.id).filter((id) => !inGame.includes(id)).sort();
  for (const [box, ids, numbered] of [[$("inGame"), inGame, true], [$("drafts"), drafts, false]]) {
    box.innerHTML = ids.length ? "" : `<p>${numbered ? "Nothing in the game." : "No drafts."}</p>`;
    ids.forEach((id, i) => {
      const row = document.createElement("div");
      row.className = "ed-row" + (id === docId ? " is-current" : "");
      row.draggable = true;
      row.dataset.id = id;
      row.innerHTML = `<span class="ed-num">${numbered ? i + 1 : ""}</span>${thumbs.get(id) || ""}` +
        `<div><div class="ed-name">${byId.get(id).name}</div><div class="ed-id">${id}</div></div>`;
      row.onclick = () => { closeLevels(); openLevel(id); };
      row.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", id); row.classList.add("is-dragging"); });
      row.addEventListener("dragend", () => row.classList.remove("is-dragging"));
      box.appendChild(row);
    });
  }
}
// dropping a row: into the game list at that place, or out to the drafts
for (const box of [$("inGame"), $("drafts")]) {
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("is-target"); });
  box.addEventListener("dragleave", () => box.classList.remove("is-target"));
  box.addEventListener("drop", async (e) => {
    e.preventDefault(); box.classList.remove("is-target");
    const id = e.dataTransfer.getData("text/plain");
    let order = catalog.order.filter((x) => x !== id);
    if (box.dataset.list === "game") {
      const rows = [...box.querySelectorAll(".ed-row")].filter((r) => r.dataset.id !== id);
      const before = rows.find((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
      const at = before ? order.indexOf(before.dataset.id) : order.length;
      order.splice(at < 0 ? order.length : at, 0, id);
    }
    await putOrder(order);
    buildLists();
  });
}

// ---------- wiring ----------
for (const b of document.querySelectorAll("[data-tool]")) b.onclick = () => setTool(b.dataset.tool);
$("undo").onclick = undo;
$("redo").onclick = redo;
$("save").onclick = save;
$("play").onclick = () => setPlaying(!playing);
$("open").onclick = showLevels;
$("closeLevels").onclick = closeLevels;
$("levels").addEventListener("pointerdown", (e) => { if (e.target === $("levels")) closeLevels(); });
$("create").onclick = create;
$("newName").addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
for (const f of ["name", "blurb"]) {
  $(f).addEventListener("input", () => {
    if (lastMerge !== `field:${f}`) { past.push(snap(doc)); future = []; lastMerge = `field:${f}`; }
    doc[f] = $(f).value;
    refresh();
  });
  $(f).addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") e.target.blur(); });
}
window.addEventListener("beforeunload", (e) => { if (snap(doc) !== savedSnap) e.preventDefault(); });

const KEYS = { t: "track", e: "erase", u: "turntable", l: "loco", c: "car", g: "goal", p: "plate" };
window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "s") { e.preventDefault(); save(); return; }
  if (e.target.closest("input, textarea")) return;
  if (!$("levels").hidden) { if (e.key === "Escape") closeLevels(); return; }
  if (e.key === " " || (playing && e.key === "Escape")) { e.preventDefault(); setPlaying(!playing); return; }
  if (playing) {
    if (e.key === "z" && !mod) game.undo();
    else if (e.key === "r" && !mod) game.reset();
    return;
  }
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod) return;
  if (e.key === "o") { showLevels(); return; }
  if (KEYS[e.key]) { setTool(KEYS[e.key]); return; }
  const n = Number(e.key);
  if (n >= 1 && (tool === "car" || tool === "goal")) {
    const options = tool === "car" ? ["", ...LETTERS] : LETTERS;
    if (n <= options.length) { letter[tool] = options[n - 1]; buildPalette(); }
  }
});

// ---------- start ----------
await loadCatalog();
const want = new URLSearchParams(location.search).get("level");
const first = want && catalog.levels.some((l) => l.id === want) ? want : catalog.order[0] || catalog.levels[0]?.id;
if (first) await openLevel(first); else refresh({ refit: true });
setTool("track");
window.editor = { get doc() { return doc; }, toFile: () => toFile(doc), attempt, game, setTool, openLevel, save, get lay() { return lay; } };
