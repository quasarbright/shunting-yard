// The game on a canvas: drawing the yard, and driving, switches, couplings
// and turntables under the pointer. Used by the game page (index.html) and
// by the editor's Play mode.
import { loadLevel } from "./setup.mjs";
import { walk, nextTrack, pointOnTrack, setDeckAngle } from "./yard.mjs";
import {
  clone, drive, coast, scan, switchLocked, throwSwitch, joints, toggleCoupling, isCoupled, goalMet, REACH, POINTS, atSpot,
  turnTurntable, turntableLocked, BODY,
} from "./motion.mjs";

export const C = {
  bg: "#121619", dim: "#323b42", lit: "#e9e4d6", amber: "#f2a93b", amberHi: "#ffc061",
  muted: "#87929a", faint: "#56616a", filler: "#5e6970", danger: "#e0556b",
  wire: "#6fd3ff", // pressure plates and their wiring
  steel: "#a9b4ba", // the section of track at a switch's points
};
export const CAR_COLORS = {
  A: "#c8553d", B: "#4b87c6", C: "#5aa66c", D: "#a070c8",
  E: "#3fb0aa", F: "#d6739e", G: "#8f9c4c", H: "#b07a4a",
};
export const carColor = (car) => car.loco ? C.amber : car.filler ? C.filler : CAR_COLORS[car.name] || C.muted;

// a color with some black mixed in, for the sides of things
export function shade(hex, f = 0.42) {
  const n = parseInt(hex.slice(1, 7), 16);
  const ch = (v) => Math.round(v * (1 - f)).toString(16).padStart(2, "0");
  return "#" + ch(n >> 16) + ch((n >> 8) & 255) + ch(n & 255);
}

// A little map of a level: its track, and its cars where they start.
export function thumbSvg(level, cls = "st-thumb") {
  let lv;
  try { lv = loadLevel(level); } catch { return `<svg class="${cls}" viewBox="0 0 1 1"></svg>`; }
  const { yard: y, cars: cs, state: st } = lv;
  const b = y.bounds, pad = 0.5, w = b.maxX - b.minX + 2 * pad, h = b.maxY - b.minY + 2 * pad;
  const X = (x) => (x - b.minX + pad).toFixed(2), Y = (v) => (v - b.minY + pad).toFixed(2);
  let svg = `<svg class="${cls}" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" preserveAspectRatio="xMidYMid meet">`;
  for (const T of y.turntables) svg += `<circle cx="${X(T.center[0])}" cy="${Y(T.center[1])}" r="${(T.r + 0.12).toFixed(2)}" fill="#0b0e10" stroke="${T.manual ? C.amber : C.dim}" stroke-width="0.08"/>`;
  for (const t of Object.values(y.tracks)) {
    svg += `<polyline points="${t.pts.map(([x, v]) => `${X(x)},${Y(v)}`).join(" ")}" fill="none" stroke="${C.dim}" stroke-width="0.16" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  for (const pl of y.plates) {
    const q = pointOnTrack(y.tracks[pl.track], pl.s);
    svg += `<rect x="-0.25" y="-0.3" width="0.5" height="0.6" rx="0.06" fill="${C.wire}" transform="translate(${X(q.x)} ${Y(q.y)}) rotate(${(q.ang * 180 / Math.PI).toFixed(1)})"/>`;
  }
  st.at.forEach((p, c) => {
    const q = pointOnTrack(y.tracks[p.track], p.s);
    const rect = (dy, fill) => `<rect x="-0.42" y="-0.22" width="0.84" height="0.44" rx="0.08" fill="${fill}" transform="translate(${X(q.x)} ${(+Y(q.y) + dy).toFixed(2)}) rotate(${(q.ang * 180 / Math.PI).toFixed(1)})"/>`;
    svg += rect(0.07, shade(carColor(cs[c]))) + rect(0.035, shade(carColor(cs[c]))) + rect(0, carColor(cs[c]));
  });
  return svg + "</svg>";
}

// opts:
//   margins(W, H): { top, bottom, side } screen room to leave for other things
//   view(): bounds to fit on screen instead of the yard's own, or null
//   rotate: turn the yard a quarter on portrait phones when that's bigger
//   nudgeEl: an element for the first levels' pointers (none if not given)
//   onWin(), onHistory(): the level was finished; undo history changed
//   underlay(ctx, view), overlay(ctx, view): draw more under or over the yard
//                         (the editor), in layout space
export function createGame(canvas, opts = {}) {
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1;
  let L = 40, ox = 0, oy = 0, rot = 0; // car length in px, layout origin, quarter turn on phones

  // ---------- game state ----------
  let level = null, yard = null, cars = [], goals = [], state = null, startAt = [];
  let history = [], solved = false, shown = false, interactive = false;
  let drag = null, hover = null, flashSwitch = null, flashTable = null;
  // plates going off: plate → time, and what they hit: "switch:k" / "turntable:k" → { t, ok }
  const plateFlash = new Map(), wireHit = new Map();
  // free-rolling cars: car → { speed, dir }, carried by the car at the front of the move
  let rolling = new Map();
  // how far each switch has swung toward its leg 1 (eases to state), and how lit each track is
  let swing = [], litAmt = new Map();
  // each turntable's deck angle on screen, easing toward its stop
  let tableAngle = [];

  function freshState() { return loadLevel(level).state; }

  // Show a level (a level file). Interactive: it can be played; otherwise it's just drawn.
  function load(lv, { play = true } = {}) {
    level = lv;
    ({ yard, cars, goals } = loadLevel(level));
    state = freshState();
    startAt = state.at.map((p) => ({ ...p }));
    history = []; solved = false; drag = null; hover = null; rolling = new Map(); pull = null;
    swing = state.sw.slice(); litAmt = new Map();
    tableAngle = state.tt.map((st, k) => yard.turntables[k].stops[st].angle);
    shown = true; interactive = play;
    canvas.style.cursor = "default";
    layout();
    opts.onHistory?.();
  }
  function hide() { shown = false; interactive = false; drag = null; hover = null; opts.nudgeEl?.classList.add("is-gone"); }

  function pushHistory() { history.push(clone(state)); opts.onHistory?.(); }
  function undo() {
    if ((drag && drag.held) || !history.length) return;
    drag = null; rolling = new Map(); pull = null;
    state = history.pop();
    solved = false;
    opts.onHistory?.();
  }
  function reset() {
    if (!history.length || (drag && drag.held)) return;
    drag = null; rolling = new Map(); pull = null;
    pushHistory();
    state = freshState();
    solved = false;
    opts.onHistory?.();
  }

  // ---------- layout ----------
  function layout() {
    W = canvas.parentElement === document.body ? document.documentElement.clientWidth : canvas.parentElement.clientWidth;
    H = canvas.parentElement === document.body ? document.documentElement.clientHeight : canvas.parentElement.clientHeight;
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    if (!yard) return;
    const b = opts.view?.() || yard.bounds, pad = 0.8;
    const bw = b.maxX - b.minX + 2 * pad, bh = b.maxY - b.minY + 2 * pad;
    const m = opts.margins ? opts.margins(W, H) : { top: 16, bottom: 16, side: 16 };
    const { top, bottom, side } = m, left = m.left ?? side, right = m.right ?? side;
    // On a portrait phone the yard runs down the screen instead of across it,
    // when that makes the cars bigger. The drawing happens in an unrotated
    // "layout" space, turned a quarter clockwise onto the screen.
    const flatL = Math.min((W - left - right) / bw, (H - top - bottom) / bh, opts.maxL ?? 96);
    const tallL = Math.min((H - top - bottom) / bw, (W - 2 * side) / bh, opts.maxL ?? 96);
    rot = opts.rotate && H > W && tallL > flatL * 1.15 ? Math.PI / 2 : 0;
    let x0, x1, y0, y1;
    if (rot) { L = tallL; x0 = top; x1 = H - bottom; y0 = side; y1 = W - side; }
    else { L = flatL; x0 = left; x1 = W - right; y0 = top; y1 = H - bottom; }
    ox = x0 + (x1 - x0 - (b.maxX - b.minX) * L) / 2 - b.minX * L;
    oy = y0 + (y1 - y0 - (b.maxY - b.minY) * L) / 2 - b.minY * L;
  }
  const sx = (x) => ox + x * L, sy = (y) => oy + y * L;
  const wx = (px) => (px - ox) / L, wy = (py) => (py - oy) / L;
  // pointer position (relative to the canvas) → layout space
  const toLayout = (px, py) => rot ? [py, W - px] : [px, py];
  const pointer = (e) => { const r = canvas.getBoundingClientRect(); return toLayout(e.clientX - r.left, e.clientY - r.top); };
  // text that stays upright on screen whichever way the yard is turned
  function uprightText(text, x, y, dx = 0, dy = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(-rot); ctx.fillText(text, dx, dy); ctx.restore();
  }

  // ---------- where things are ----------
  const centerOf = (c) => pointOnTrack(yard.tracks[state.at[c].track], state.at[c].s);
  // a car body rides two bogies 0.4 either side of its center; the body is the line between them
  function poseOf(c) {
    const { track, s } = state.at[c];
    const p = walk(yard, track, s, 1, 0.4, state), q = walk(yard, track, s, -1, 0.4, state);
    return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, ang: Math.atan2(p.y - q.y, p.x - q.x) };
  }
  // unit direction the loco would roll in direction d (relative to its track), or null at a dead end
  function heading(c, d) {
    const { track, s } = state.at[c], here = pointOnTrack(yard.tracks[track], s);
    const p = walk(yard, track, s, d, 0.15, state);
    const vx = p.x - here.x, vy = p.y - here.y, len = Math.hypot(vx, vy);
    return len < 1e-4 ? null : { x: vx / len, y: vy / len };
  }
  function canDrive(c, d) { return drive(yard, clone(state), c, d, 0.02).moved > 1e-4; }
  // halfway between the two cars' centers along the track
  const jointPoint = (j) => walk(yard, state.at[j.a].track, state.at[j.a].s, j.dir, j.dist / 2, state);

  // ---------- driving ----------
  // The pointer sets where you want the locomotive; it heads there along the
  // track as fast as it can, up to VMAX. Cars it pushes but isn't coupled to
  // keep its speed when it backs off, and roll on until friction stops them,
  // like a wooden toy train given a shove.
  const VMAX = 10;      // the locomotive's top speed, car lengths per second
  const FRICTION = 18;  // how fast a rolling car slows, car lengths per second²
  const FOLLOW = 0.04;  // the locomotive closes on the pointer over about this many seconds

  const locoIds = () => cars.map((c, i) => (c.loco ? i : -1)).filter((i) => i >= 0);
  // a car and everything coupled to it
  function consistOf(c0) {
    const out = new Set(), stack = [c0];
    while (stack.length) {
      const c = stack.pop();
      if (out.has(c)) continue;
      out.add(c);
      for (let o = 0; o < cars.length; o++) if (!out.has(o) && isCoupled(state, c, o)) stack.push(o);
    }
    return out;
  }

  function stepDrive(dt) {
    const loco = drag.loco, tg = drag.target;
    // Look along the track both ways, as the switches are set, for the point
    // nearest the pointer, and head there: proj is how far along the track it is.
    const here = state.at[loco], p0 = pointOnTrack(yard.tracks[here.track], here.s);
    let best = null, bestD = Math.hypot(tg.x - p0.x, tg.y - p0.y);
    for (const d of [1, -1]) {
      let cur = { track: here.track, s: here.s, dir: d }, t = 0;
      for (let i = 0; i < 1000; i++) { // up to 40 car lengths each way
        const nx = walk(yard, cur.track, cur.s, cur.dir, 0.04, state);
        const stepped = nx.track !== cur.track || Math.abs(nx.s - cur.s) > 1e-6;
        if (!stepped) break; // the end of the line this way
        t += 0.04; cur = nx;
        const dd = Math.hypot(tg.x - nx.x, tg.y - nx.y);
        if (dd < bestD - 1e-6) { bestD = dd; best = { d, proj: t }; }
      }
    }
    drag.still = true;
    // a small dead zone before turning back, so it settles instead of hunting back and forth
    if (best && best.d !== drag.lastD && best.proj < 0.04) best = null;
    if (best && best.proj > 0.003 && dt > 0) {
      const before = clone(state);
      // ease toward the pointer (pointer events come in bursts), never faster than VMAX
      const want = best.proj < 0.02 ? best.proj : best.proj * Math.min(1, dt / FOLLOW);
      // anything in the way gets shoved, another locomotive included
      const r = drive(yard, state, loco, best.d, Math.min(want, VMAX * dt));
      noteEvents(r.events);
      // its speed, averaged over a few frames: what it hands on to cars it shoves
      drag.v = (drag.v ?? 0) + (r.moved / dt - (drag.v ?? 0)) * Math.min(1, dt / 0.08);
      if (r.moved > 1e-6) {
        drag.still = false;
        drag.lastD = r.dir;
        if (!drag.pushed) { history.push(before); drag.pushed = true; opts.onHistory?.(); }
        // whatever it pushed without being coupled to it is now moving at its speed
        const attached = consistOf(loco), pushed = r.members.filter((m) => !attached.has(m.c));
        if (pushed.length) {
          const rear = pushed[pushed.length - 1], speed = Math.min(drag.v, r.moved / dt);
          for (const m of pushed) rolling.delete(m.c);
          rolling.set(rear.c, { speed, dir: rear.dir, mass: pushed.length });
        }
      }
      if (r.stop) blockedBy(r.stop);
    }
    if (!drag.held && drag.still) drag = null; // let go and arrived
  }

  // cars rolling on their own, slowing with friction
  function stepRolling(dt) {
    if (!rolling.size || dt <= 0) return;
    // the locomotive you're driving (and what's coupled to it) goes where you
    // take it; anything else, other locomotives included, rolls like a car
    const held = drag ? consistOf(drag.loco) : new Set();
    for (const [c, v] of [...rolling]) {
      if (!rolling.has(c)) continue;
      if (held.has(c)) { rolling.delete(c); continue; }
      const r = coast(yard, state, c, v.dir, v.speed * dt, drag ? new Set([drag.loco]) : null);
      noteEvents(r.events);
      // anything it runs into shares its momentum
      const mass = r.members.length;
      if (mass > v.mass) { v.speed *= v.mass / mass; v.mass = mass; }
      for (const m of r.members) if (m.c !== c) rolling.delete(m.c);
      v.dir = r.dir;
      v.speed -= FRICTION * dt;
      if (r.stop || v.speed <= 0 || r.moved <= 1e-9) rolling.delete(c);
    }
  }

  // Coupling across a small gap: the couplers draw the two cars together to
  // the usual coupled spacing. The side with a locomotive holds still (its
  // brakes are on); otherwise the lighter side moves. If that side can't
  // move, the other one does.
  const PULL_SPEED = 2; // car lengths per second
  let pull = null; // { a, b, mover, dir, remaining, swapped }

  function dirToward(from, to) {
    const p = state.at[from];
    for (const d of [1, -1]) {
      const r = scan(yard, state, p.track, p.s, d, 1 + REACH + 0.05);
      if (r && r.car === to) return d;
    }
    return 0;
  }

  function startPull(a, b, dist) {
    const gap = dist - 1;
    if (gap <= 1e-3) return;
    const A = consistOf(a), B = consistOf(b);
    const hasLoco = (set) => [...set].some((c) => cars[c].loco);
    const moveA = hasLoco(B) && !hasLoco(A) ? true
      : hasLoco(A) && !hasLoco(B) ? false
      : A.size < B.size;
    const mover = moveA ? a : b, other = moveA ? b : a;
    pull = { a, b, mover, dir: dirToward(mover, other), remaining: gap, swapped: false };
  }

  function stepPull(dt) {
    if (!pull || dt <= 0) return;
    const { a, b } = pull;
    // with this one coupling set aside, roll the mover in toward the other car
    toggleCoupling(state, a, b);
    const locos = new Set(locoIds().filter((l) => !consistOf(pull.mover).has(l)));
    const r = coast(yard, state, pull.mover, pull.dir, Math.min(pull.remaining, PULL_SPEED * dt), locos);
    noteEvents(r.events);
    toggleCoupling(state, a, b);
    pull.remaining -= r.moved;
    if (pull.remaining <= 1e-4) { pull = null; return; }
    if (r.moved <= 1e-6) {
      if (pull.swapped) { pull = null; return; } // neither side can move: leave the slack
      const stuck = pull.mover, next = stuck === a ? b : a;
      pull = { ...pull, mover: next, dir: dirToward(next, stuck), swapped: true };
    }
  }

  // a plate went off: light it and its wires, and show which targets moved
  function noteEvents(events) {
    const now = performance.now();
    for (const ev of events || []) {
      plateFlash.set(ev.plate, now);
      for (const r of ev.results) wireHit.set(r.switch != null ? `switch:${r.switch}` : `turntable:${r.turntable}`, { t: now, ok: r.ok });
    }
  }

  function blockedBy(stop) {
    if (!stop || stop.why !== "foul") return;
    const k = yard.switchIndex[stop.node];
    if (k == null || (flashSwitch && flashSwitch.k === k && performance.now() - flashSwitch.t < 600)) return;
    flashSwitch = { k, t: performance.now() };
  }

  // ---------- hit testing ----------
  // A manual switch is worked by a lever standing beside the points, on the
  // side away from the diverging leg.
  function leverPos(k) {
    const S = yard.switches[k], n = yard.nodes[S.id];
    const dt = legDir(S.trunk, S.id), [d0, d1] = S.legs.map((l) => legDir(l, S.id));
    let px = -dt.y, py = dt.x; // across the track
    const dev = (d) => d.x * dt.x + d.y * dt.y; // the diverging leg is the one bending most
    const div = dev(d0) > dev(d1) ? d0 : d1;
    if (px * div.x + py * div.y > 0) { px = -px; py = -py; }
    return { x: n.x + px * 0.75 + dt.x * 0.3, y: n.y + py * 0.75 + dt.y * 0.3, nx: px, ny: py };
  }
  function leverAt(px, py) {
    for (let k = 0; k < yard.switches.length; k++) {
      if (!yard.switches[k].lever) continue;
      const p = leverPos(k);
      if (Math.hypot(sx(p.x) - px, sy(p.y) - py) < Math.max(18, L * 0.34)) return k;
    }
    return -1;
  }
  // A car blocks a switch when its body is over the points. Cars are drawn
  // BODY long but are a whole car length coupler to coupler, so the stretch of
  // track where a drawn car blocks is JOINT either side of the points.
  const JOINT = 0.5 - BODY / 2;

  // A manual turntable's lever stands outside the pit, in the widest gap between its exits.
  function tableLeverPos(k) {
    const T = yard.turntables[k];
    const angs = T.exits.map((e) => ((e.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).sort((a, b) => a - b);
    let best = 0, gap = -1;
    angs.forEach((a, i) => {
      const b = i + 1 < angs.length ? angs[i + 1] : angs[0] + 2 * Math.PI;
      if (b - a > gap) { gap = b - a; best = a + (b - a) / 2; }
    });
    const R = T.r + 0.95;
    return { x: T.center[0] + R * Math.cos(best), y: T.center[1] + R * Math.sin(best) };
  }
  function turntableAt(px, py) {
    for (let k = 0; k < yard.turntables.length; k++) {
      if (!yard.turntables[k].manual) continue;
      const p = tableLeverPos(k);
      if (Math.hypot(sx(p.x) - px, sy(p.y) - py) < Math.max(18, L * 0.34)) return k;
    }
    return -1;
  }
  // The tap zone for a coupler is an oval: generous across the track, tight
  // along it, so it doesn't eat into where you'd grab the locomotive.
  function jointAt(px, py) {
    const along = Math.max(12, L * 0.2), across = Math.max(26, L * 0.55);
    let best = null, bd = 1;
    for (const j of joints(yard, state)) {
      const m = jointPoint(j);
      const dx = px - sx(m.x), dy = py - sy(m.y), c = Math.cos(m.ang), s = Math.sin(m.ang);
      const d = Math.hypot((dx * c + dy * s) / along, (-dx * s + dy * c) / across);
      if (d < bd) { bd = d; best = j; }
    }
    return best;
  }
  function locoAt(px, py) {
    for (let c = 0; c < cars.length; c++) {
      if (!cars[c].loco) continue;
      const s = poseOf(c);
      const dx = wx(px) - s.x, dy = wy(py) - s.y;
      const u = dx * Math.cos(s.ang) + dy * Math.sin(s.ang), v = -dx * Math.sin(s.ang) + dy * Math.cos(s.ang);
      if (Math.abs(u) < 0.5 && Math.abs(v) < 0.35) return c;
    }
    return -1;
  }
  function hitTest(px, py) {
    // a car sitting on the points covers the switch (which is locked anyway)
    const j = jointAt(px, py);
    if (j) return { kind: "joint", j };
    const c = locoAt(px, py);
    if (c >= 0) return { kind: "loco", c };
    const k = leverAt(px, py);
    if (k >= 0) return { kind: "switch", k };
    const t = turntableAt(px, py);
    if (t >= 0) return { kind: "turntable", k: t };
    return null;
  }

  canvas.addEventListener("pointermove", (e) => {
    if (!interactive) return;
    const [px, py] = pointer(e);
    if (drag && drag.held) { drag.target = { x: wx(px) - drag.off.x, y: wy(py) - drag.off.y }; return; }
    hover = solved ? null : hitTest(px, py);
    canvas.style.cursor = !hover ? "default"
      : hover.kind === "loco" ? "grab"
      : hover.kind === "switch" && switchLocked(yard, state, hover.k) ? "not-allowed"
      : hover.kind === "turntable" && turntableLocked(yard, state, hover.k) ? "not-allowed"
      : "pointer";
  });
  canvas.addEventListener("pointerleave", () => { if (!drag) hover = null; });
  canvas.addEventListener("pointerdown", (e) => {
    if (solved || !interactive) return;
    const [px, py] = pointer(e);
    const h = hitTest(px, py);
    hover = h;
    if (!h) return;
    if (h.kind === "switch") {
      if (switchLocked(yard, state, h.k)) { flashSwitch = { k: h.k, t: performance.now(), why: "car on switch" }; return; }
      pushHistory();
      throwSwitch(yard, state, h.k);
    } else if (h.kind === "turntable") {
      if (turntableLocked(yard, state, h.k)) { flashTable = { k: h.k, t: performance.now() }; return; }
      pushHistory();
      turnTurntable(yard, state, h.k);
    } else if (h.kind === "joint") {
      pushHistory();
      const coupling = !isCoupled(state, h.j.a, h.j.b);
      toggleCoupling(state, h.j.a, h.j.b);
      if (coupling) startPull(h.j.a, h.j.b, h.j.dist);
    } else if (h.kind === "loco") {
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      const c = centerOf(h.c);
      drag = { loco: h.c, off: { x: wx(px) - c.x, y: wy(py) - c.y }, target: { x: c.x, y: c.y }, held: true, pushed: false, still: true };
      canvas.style.cursor = "grabbing";
    }
  });
  const endDrag = () => { if (drag && drag.held) { drag.held = false; canvas.style.cursor = "grab"; } };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  window.addEventListener("resize", layout);

  // ---------- drawing ----------
  // tracks reachable from a loco with the switches as they are
  function litTracks() {
    const lit = new Set(), stack = [];
    cars.forEach((c, i) => { if (c.loco) stack.push(state.at[i].track); });
    while (stack.length) {
      const id = stack.pop();
      if (lit.has(id)) continue;
      lit.add(id);
      const t = yard.tracks[id];
      for (const n of [t.from, t.to]) { const nx = nextTrack(yard, id, n, state); if (nx) stack.push(nx.track); }
    }
    return lit;
  }

  function trackPath(t, s0 = 0, s1 = t.len, fresh = true) {
    if (fresh) ctx.beginPath();
    const p0 = pointOnTrack(t, s0);
    ctx.moveTo(sx(p0.x), sy(p0.y));
    for (let i = 1; i < t.pts.length - 1; i++) if (t.cum[i] > s0 && t.cum[i] < s1) ctx.lineTo(sx(t.pts[i][0]), sy(t.pts[i][1]));
    const p1 = pointOnTrack(t, s1);
    ctx.lineTo(sx(p1.x), sy(p1.y));
  }

  // which way a track heads away from a node, judged a little way along
  // (a curved leg leaves the points nearly straight)
  function legDir(trackId, nodeId) {
    const t = yard.tracks[trackId], n = yard.nodes[nodeId];
    const p = pointOnTrack(t, t.from === nodeId ? Math.min(0.8, t.len) : Math.max(0, t.len - 0.8));
    const len = Math.hypot(p.x - n.x, p.y - n.y) || 1;
    return { x: (p.x - n.x) / len, y: (p.y - n.y) / len };
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // a little fake 3D: everything stands up off the panel, so its side shows
  // below it on screen. Screen-down, in layout pixels (the yard may be turned).
  const depth = () => Math.max(3, L * 0.11);
  const downX = () => Math.sin(rot), downY = () => Math.cos(rot);

  // a box at (x, y) layout units, `along` long in direction d and `across` wide,
  // with its side showing below it on screen
  function block(x, y, d, along, across, col, lift = depth() * 0.8, radius = 0.03) {
    const ang = Math.atan2(d.y, d.x);
    const face = (ox2, oy2) => {
      ctx.save(); ctx.translate(sx(x) + ox2, sy(y) + oy2); ctx.rotate(ang);
      roundRect(-along * L / 2, -across * L / 2, along * L, across * L, radius * L); ctx.fill(); ctx.restore();
    };
    ctx.fillStyle = shade(col);
    for (let k = lift; k > 0; k -= 1) face(downX() * k, downY() * k);
    ctx.fillStyle = col; face(0, 0);
  }
  // A switch lever: a steel base beside the points with a handle that leans
  // one way for each leg (swinging as the switch throws), and an amber knob.
  function drawLever(k, sw, { hot, locked, flash }) {
    const S = yard.switches[k], p = leverPos(k), dt = legDir(S.trunk, S.id);
    block(p.x, p.y, dt, 0.36, 0.2, C.muted, depth() * 0.6, 0.04);
    const a = (sw - 0.5) * 1.6; // radians either side of straight up the track
    const hx = dt.x * Math.cos(a) + p.nx * Math.sin(a), hy = dt.y * Math.cos(a) + p.ny * Math.sin(a);
    const len = 0.38, x0 = sx(p.x), y0 = sy(p.y), x1 = sx(p.x + hx * len), y1 = sy(p.y + hy * len);
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(2.5, L * 0.06); ctx.strokeStyle = shade(C.muted, 0.2);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.beginPath(); ctx.arc(x1, y1, Math.max(4, L * (hot ? 0.1 : 0.085)), 0, Math.PI * 2);
    ctx.fillStyle = flash ? C.danger : locked ? C.faint : hot ? C.amberHi : C.amber; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = C.bg; ctx.stroke();
  }

  // A turntable's lever: a round steel base with a crank that points the way
  // the deck does (so it turns as the table turns), and an amber knob.
  function drawTableLever(k, { hot, locked, flash }) {
    const p = tableLeverPos(k), a = tableAngle[k] ?? 0;
    block(p.x, p.y, { x: 1, y: 0 }, 0.3, 0.3, C.muted, depth() * 0.6, 0.15);
    const x0 = sx(p.x), y0 = sy(p.y), x1 = sx(p.x + Math.cos(a) * 0.3), y1 = sy(p.y + Math.sin(a) * 0.3);
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(2.5, L * 0.06); ctx.strokeStyle = shade(C.muted, 0.2);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.beginPath(); ctx.arc(x1, y1, Math.max(4, L * (hot ? 0.1 : 0.085)), 0, Math.PI * 2);
    ctx.fillStyle = flash ? C.danger : locked ? C.faint : hot ? C.amberHi : C.amber; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = C.bg; ctx.stroke();
  }

  function drawBufferStop(n) {
    const d = legDir(n.tracks[0], n.id), p = { x: -d.y, y: d.x }; // d points into the track
    const at = (back, side) => [n.x - d.x * back + p.x * side, n.y - d.y * back + p.y * side];
    // the frame: the rails carry on behind the beam, propping it up
    for (const side of [-1, 1]) {
      const [fx, fy] = at(0.3, side * 0.17);
      block(fx, fy, d, 0.36, 0.06, shade(C.muted, 0.2), depth() * 0.4, 0.02);
    }
    // the beam, then the two buffers on its track side
    const [bx, by] = at(0.1, 0);
    block(bx, by, d, 0.12, 0.62, C.muted);
    for (const side of [-1, 1]) {
      const [px, py] = at(0.0, side * 0.17);
      block(px, py, d, 0.08, 0.13, "#c9cfd3", depth() * 0.5, 0.04);
    }
  }

  function drawCar(c, pose, o = {}) {
    const car = cars[c];
    const w = L * 0.84, h = L * 0.42, r = L * 0.07, col = carColor(car);
    // the side: the body swept straight down, in a darker shade
    ctx.fillStyle = shade(col);
    for (let k = depth(); k > 0; k -= 1) {
      ctx.save();
      ctx.translate(sx(pose.x) + downX() * k, sy(pose.y) + downY() * k);
      ctx.rotate(pose.ang);
      roundRect(-w / 2, -h / 2, w, h, r);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(sx(pose.x), sy(pose.y));
    ctx.rotate(pose.ang);
    roundRect(-w / 2, -h / 2, w, h, r);
    ctx.fillStyle = col;
    ctx.fill();
    if (o.outline) { ctx.lineWidth = 2; ctx.strokeStyle = C.amberHi; ctx.stroke(); }
    if (car.loco) {
      // a coupler sticks out of one end only; the cab is at the other end
      const side = state.face[c] ?? 1; // +1: the coupler's at the end toward its track's +s
      ctx.fillStyle = "#121619aa";
      const ww = L * 0.16, wh = h * 0.62;
      ctx.fillRect(-side * (w / 2 - L * 0.06) - (side > 0 ? 0 : ww), -wh / 2, ww, wh);
      ctx.fillStyle = "#2b3238";
      const kw = L * 0.09, kh = L * 0.13;
      roundRect(side > 0 ? w / 2 - L * 0.01 : -w / 2 + L * 0.01 - kw, -kh / 2, kw, kh, L * 0.02);
      ctx.fill();
    }
    ctx.restore();
    if (car.name && !(car.loco && cars.filter((k) => k.loco).length === 1)) {
      ctx.fillStyle = "#121619";
      ctx.font = `600 ${Math.round(L * 0.26)}px "IBM Plex Mono", monospace`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      uprightText(car.name, sx(pose.x), sy(pose.y), 0, L * 0.01);
    }
  }

  let lastNow = null;
  function frame(now) {
    const dt = lastNow == null ? 0 : Math.min(0.05, (now - lastNow) / 1000);
    lastNow = now;
    if (shown && interactive && !solved) {
      stepRolling(dt);
      stepPull(dt);
      if (drag) stepDrive(dt);
    }
    // done as soon as the goal is met and everything has stopped, held or not
    if (shown && interactive && !solved && !rolling.size && !pull && (!drag || drag.still) && goalMet(goals, state)) win();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    if (!shown || !yard) { requestAnimationFrame(frame); return; }
    if (rot) { ctx.translate(W, 0); ctx.rotate(rot); }
    opts.underlay?.(ctx, view);
    const tw = Math.max(4, L * 0.13);
    const labels = []; // drawn last
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // switches swing over and the lit route follows, rather than cutting
    const ease = (cur, to, rate) => cur + Math.sign(to - cur) * Math.min(Math.abs(to - cur), rate * dt);
    state.sw.forEach((v, k) => { swing[k] = ease(swing[k] ?? v, v, 1 / 0.18); });
    const lit = litTracks();
    for (const id of Object.keys(yard.tracks)) litAmt.set(id, ease(litAmt.get(id) ?? (lit.has(id) ? 1 : 0), lit.has(id) ? 1 : 0, 1 / 0.25));

    // track: dim everywhere, lamp-lit along the route the locomotives can reach.
    // At a switch, the leg it isn't set to loses its first POINTS, fading as the
    // switch throws. That stretch is the switch's own track (drawn in steel on
    // the leg it is set to), and a car over it blocks the switch, so a car is
    // never left on track that's gone.
    const unset = (t, nodeId) => {
      const k = yard.switchIndex[nodeId];
      if (k == null) return 0;
      const leg = yard.switches[k].legs.indexOf(t.id);
      return leg < 0 ? 0 : leg === 0 ? swing[k] : 1 - swing[k];
    };
    function strokeTrack(t, width, color, alpha, s0 = 0, s1 = t.len) {
      if (alpha <= 0.002) return;
      const cutA = unset(t, t.from), cutB = unset(t, t.to);
      const a0 = Math.max(s0, cutA ? POINTS : 0), a1 = Math.min(s1, cutB ? t.len - POINTS : t.len);
      // square ends, so the short gap at a switched-away leg isn't covered by a rounded cap
      ctx.lineCap = "butt";
      ctx.lineWidth = width; ctx.strokeStyle = color;
      if (a1 > a0) { ctx.globalAlpha = alpha; trackPath(t, a0, a1); ctx.stroke(); }
      // the fading stretch at a switched-away leg's points, within [s0, s1]
      const e0 = Math.min(s1, POINTS), e1 = Math.max(s0, t.len - POINTS);
      if (cutA && s0 < e0) { ctx.globalAlpha = alpha * (1 - cutA); trackPath(t, s0, e0); ctx.stroke(); }
      if (cutB && e1 < s1) { ctx.globalAlpha = alpha * (1 - cutB); trackPath(t, e1, s1); ctx.stroke(); }
      ctx.globalAlpha = 1;
      ctx.lineCap = "round";
    }
    // turntable decks swing round to their stop (always the same way round)
    yard.turntables.forEach((T, k) => {
      const to = T.stops[state.tt[k]].angle, cur = tableAngle[k] ?? to;
      const ahead = ((to - cur) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      tableAngle[k] = ahead < 1e-4 ? to : cur + Math.min(ahead, dt * 4.5);
      setDeckAngle(yard, k, tableAngle[k]);
    });
    // turntable pits, under everything; a manual one is turned by its lever
    yard.turntables.forEach((T, k) => {
      const x = sx(T.center[0]), y = sy(T.center[1]), r = (T.r + 0.12) * L;
      const hot = hover && hover.kind === "turntable" && hover.k === k && !drag;
      const flash = flashTable && flashTable.k === k && now - flashTable.t < 900;
      const hit = wireHit.get(`turntable:${k}`), hitOn = hit && now - hit.t < 700;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = "#0b0e10"; ctx.fill();
      ctx.lineWidth = Math.max(3, L * (hot ? 0.09 : 0.07));
      ctx.strokeStyle = flash || (hitOn && !hit.ok) ? C.danger : hot ? C.amber : C.dim;
      ctx.stroke();
      if (hot && turntableLocked(yard, state, k)) labels.push({ text: "car hanging off", x, y, dy: r + 14 });
    });
    // Wires, under the track: every control is wired to what it works, plates
    // and levers alike. A long wire bows out to one side so it never hides along
    // a track; a short one (a lever beside its points) runs straight.
    function drawWire(p0, q, lit) {
      const mx = (p0.x + q.x) / 2, my = (p0.y + q.y) / 2, dx = q.x - p0.x, dy = q.y - p0.y;
      const len = Math.hypot(dx, dy) || 1, bow = len < 2 ? 0 : Math.max(0.9, len * 0.25);
      const cx2 = mx + (-dy / len) * bow, cy2 = my + (dx / len) * bow;
      ctx.setLineDash([L * 0.12, L * 0.1]);
      ctx.lineWidth = Math.max(1.5, L * (lit ? 0.05 : 0.035)); ctx.strokeStyle = C.wire;
      ctx.globalAlpha = lit ? 0.95 : 0.45;
      ctx.beginPath(); ctx.moveTo(sx(p0.x), sy(p0.y)); ctx.quadraticCurveTo(sx(cx2), sy(cy2), sx(q.x), sy(q.y)); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    const tableCenter = (k) => ({ x: yard.turntables[k].center[0], y: yard.turntables[k].center[1] });
    yard.plates.forEach((pl, i) => {
      const p0 = pointOnTrack(yard.tracks[pl.track], pl.s);
      const lit = now - (plateFlash.get(i) ?? -1e9) < 700;
      for (const w of pl.wires) drawWire(p0, w.switch != null ? yard.nodes[yard.switches[w.switch].id] : tableCenter(w.turntable), lit);
    });
    yard.switches.forEach((S, k) => {
      if (S.lever) drawWire(leverPos(k), yard.nodes[S.id], hover && hover.kind === "switch" && hover.k === k);
    });
    yard.turntables.forEach((T, k) => {
      if (T.manual) drawWire(tableLeverPos(k), tableCenter(k), hover && hover.kind === "turntable" && hover.k === k);
    });
    for (const t of Object.values(yard.tracks)) strokeTrack(t, tw, C.dim, 1);
    for (const t of Object.values(yard.tracks)) strokeTrack(t, tw * 0.55, C.lit, litAmt.get(t.id));
    // Switches. The switch's own track, where a car's body over it blocks the
    // switch, is drawn in steel: on the leg it's set to, that reads as the
    // blade; on the other leg it fades away, leaving the gap.
    yard.switches.forEach((S, k) => {
      const locked = switchLocked(yard, state, k);
      const hot = hover && hover.kind === "switch" && hover.k === k && !drag;
      const flash = flashSwitch && flashSwitch.k === k && now - flashSwitch.t < 900;
      const hit = wireHit.get(`switch:${k}`), hitOn = hit && now - hit.t < 700;
      const col = flash || (hitOn && !hit.ok) ? C.danger : locked ? "#b5838b" : hot ? C.amberHi : C.steel;
      // the switch's own track: the points, and the first POINTS of each leg
      for (const id of [S.trunk, ...S.legs]) {
        const t = yard.tracks[id], len = id === S.trunk ? JOINT : POINTS;
        if (t.from === S.id) strokeTrack(t, tw, col, 1, 0, len); else strokeTrack(t, tw, col, 1, t.len - len, t.len);
      }
      // on hover over its lever, the leg a pull would set, faintly
      if (hot && !locked) {
        const leg = yard.tracks[S.legs[state.sw[k] ? 0 : 1]];
        ctx.lineWidth = tw * 0.55; ctx.strokeStyle = C.amber; ctx.globalAlpha = 0.45;
        if (leg.from === S.id) trackPath(leg, 0, 0.85); else trackPath(leg, leg.len - 0.85, leg.len);
        ctx.stroke(); ctx.globalAlpha = 1;
      }
      if (S.lever) drawLever(k, swing[k], { hot, locked, flash });
      if (hot && locked) { const p = leverPos(k); labels.push({ text: "car on switch", x: sx(p.x), y: sy(p.y), dy: L * 0.5 }); }
    });
    // turntable levers
    yard.turntables.forEach((T, k) => {
      if (!T.manual) return;
      const hot = hover && hover.kind === "turntable" && hover.k === k && !drag;
      const flash = flashTable && flashTable.k === k && now - flashTable.t < 900;
      drawTableLever(k, { hot, locked: turntableLocked(yard, state, k), flash });
    });
    // plates, on the track
    yard.plates.forEach((pl, i) => {
      const p = pointOnTrack(yard.tracks[pl.track], pl.s);
      const on = state.plateOn[i], lit = now - (plateFlash.get(i) ?? -1e9) < 700;
      // a flat pad set into the track: outlined, filled in while something's on it
      ctx.save(); ctx.translate(sx(p.x), sy(p.y)); ctx.rotate(p.ang);
      const w = L * 0.46, h = L * 0.62;
      roundRect(-w / 2, -h / 2, w, h, L * 0.08);
      ctx.fillStyle = C.wire; ctx.globalAlpha = lit ? 0.85 : on ? 0.55 : 0.14; ctx.fill(); ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(2, L * 0.045); ctx.strokeStyle = C.wire; ctx.stroke();
      ctx.restore();
    });
    // buffer stops: a crossbeam where the rails end, two buffers facing the track,
    // and a braced frame behind, standing up off the panel like the cars do
    for (const n of Object.values(yard.nodes)) {
      if (n.kind === "buffer") drawBufferStop(n);
    }

    // goal: a bay painted on the track for each car. It's a little wider than
    // a car, so its edge shows around whatever's parked in it, and it lights
    // up when the right car is there.
    for (const g of goals) {
      const car = cars[g.car], col = carColor(car);
      const sl = pointOnTrack(yard.tracks[g.track], g.s);
      const ok = atSpot(state, g.track, g.car, g.s);
      ctx.save();
      ctx.translate(sx(sl.x), sy(sl.y)); ctx.rotate(sl.ang);
      const w = L * 0.92, h = L * 0.66;
      roundRect(-w / 2, -h / 2, w, h, L * 0.1);
      ctx.globalAlpha = ok ? 0.5 : 0.18; ctx.fillStyle = col; ctx.fill();
      ctx.globalAlpha = ok ? 1 : 0.7; ctx.lineWidth = Math.max(2, L * 0.04); ctx.strokeStyle = col; ctx.stroke();
      ctx.restore();
      // the letter shows in an empty bay (a parked car covers it)
      ctx.globalAlpha = 0.9; ctx.fillStyle = col;
      ctx.font = `600 ${Math.round(L * 0.26)}px "IBM Plex Mono", monospace`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      uprightText(car.name, sx(sl.x), sy(sl.y));
      ctx.globalAlpha = 1;
    }

    // cars
    const poses = cars.map((_, c) => poseOf(c));
    const hoverLoco = drag ? drag.loco : hover && hover.kind === "loco" ? hover.c : -1;
    const consist = hoverLoco >= 0 ? consistOf(hoverLoco) : new Set();
    // nearer the bottom of the screen is nearer the viewer: draw those last
    const screenDown = (p) => sx(p.x) * downX() + sy(p.y) * downY();
    cars.map((_, c) => c).sort((a, b) => screenDown(poses[a]) - screenDown(poses[b]))
      .forEach((c) => drawCar(c, poses[c], { outline: consist.has(c) && consist.size > 1 }));

    // loco chevrons: you can drive this, and which ways
    if (interactive) cars.forEach((car, c) => {
      if (!car.loco || solved) return;
      const pose = poses[c], active = hoverLoco === c;
      for (const d of [1, -1]) {
        if (!canDrive(c, d)) continue;
        // a car right there on this side: its coupler line goes in that gap, not an arrow
        if (scan(yard, state, state.at[c].track, state.at[c].s, d, 1 + REACH + 0.01)) continue;
        const h = heading(c, d);
        const tipX = sx(pose.x + h.x * 0.62), tipY = sy(pose.y + h.y * 0.62);
        const s = L * 0.11;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - h.x * s * 1.3 - h.y * s, tipY - h.y * s * 1.3 + h.x * s);
        ctx.lineTo(tipX - h.x * s * 1.3 + h.y * s, tipY - h.y * s * 1.3 - h.x * s);
        ctx.closePath();
        ctx.fillStyle = C.amber;
        ctx.globalAlpha = active ? 1 : 0.55 + 0.25 * Math.sin(now / 400);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    });

    // Couplers. Every coupler is a circle at its end of the car, always there:
    // both ends of a car, only the coupler end of a locomotive. Two couplers
    // close enough to couple get a line between them, the circles still hollow;
    // once coupled, a solid link is drawn over both.
    {
      // circles sit just inside the car's end, small enough that two touching
      // cars' circles have a visible gap for the line between them
      const R = Math.max(3, L * 0.052);
      const end = (c, side) => walk(yard, state.at[c].track, state.at[c].s, side, BODY / 2 - 0.03, state);
      const links = joints(yard, state).map((j) => ({
        j, p: end(j.a, j.dir), q: end(j.b, dirToward(j.b, j.a)),
        on: isCoupled(state, j.a, j.b),
        hot: hover && hover.kind === "joint" && hover.j.a === j.a && hover.j.b === j.b,
      }));
      const line = (p, q, width, color) => {
        ctx.lineCap = "round"; ctx.lineWidth = width; ctx.strokeStyle = color;
        ctx.beginPath(); ctx.moveTo(sx(p.x), sy(p.y)); ctx.lineTo(sx(q.x), sy(q.y)); ctx.stroke();
      };
      // in reach, not yet coupled: a line between the two
      for (const k of links) if (!k.on) line(k.p, k.q, Math.max(2, L * (k.hot ? 0.06 : 0.04)), k.hot ? C.amberHi : C.amber);
      // every coupler's circle
      cars.forEach((car, c) => {
        for (const side of [1, -1]) {
          if (car.loco && state.face[c] !== side) continue;
          const e = end(c, side);
          ctx.beginPath(); ctx.arc(sx(e.x), sy(e.y), R, 0, Math.PI * 2);
          ctx.fillStyle = C.bg; ctx.fill();
          ctx.lineWidth = Math.max(1.5, L * 0.03); ctx.strokeStyle = C.steel; ctx.stroke();
        }
      });
      // coupled: a solid link over both circles
      for (const k of links) if (k.on) line(k.p, k.q, Math.max(3.5, L * (k.hot ? 0.095 : 0.08)), k.hot ? C.amberHi : C.amber);
      for (const k of links) if (k.hot) {
        const m = jointPoint(k.j);
        labels.push({ text: k.on ? "uncouple" : "couple", x: sx(m.x), y: sy(m.y), dy: -L * 0.42 });
      }
    }

    // hover labels go over everything: white with a soft drop shadow, legible on any car
    ctx.font = `700 ${Math.max(12, Math.round(L * 0.21))}px Barlow, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "rgba(0,0,0,.85)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
    for (const lb of labels) uprightText(lb.text, lb.x, lb.y, 0, lb.dy);
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    opts.overlay?.(ctx, view);
    updateNudge();
    requestAnimationFrame(frame);
  }
  const view = { sx, sy, wx, wy, get L() { return L; }, pointer, roundRect, uprightText };

  // ---------- first-level pointers ----------
  // layout space → screen
  const toScreenPx = (lx, ly) => rot ? [W - ly, lx] : [lx, ly];
  function nudgeFor() {
    if (!interactive || solved || drag) return null;
    const at = (x, y, text) => ({ p: toScreenPx(sx(x), sy(y) - L * 0.3), text });
    const loco = cars.findIndex((c) => c.loco);
    if (loco < 0) return null;
    const lp = poseOf(loco);
    const lever = yard.switches.length && yard.switches[0].lever ? leverPos(0) : null;
    if (level.name === "Delivery" && lever) {
      if (state.sw[0] === 0) return at(lever.x, lever.y, "Pull the lever to send the locomotive down the lower track");
      const home = startAt[loco], here = state.at[loco];
      if (here.track === home.track && Math.abs(here.s - home.s) < 0.05) return at(lp.x, lp.y, "Drag the locomotive to push A onto its marker");
    }
    if (level.name === "Fetch" && lever) {
      const touching = joints(yard, state).find((j) => (j.a === loco || j.b === loco));
      if (touching && !isCoupled(state, touching.a, touching.b)) {
        const m = jointPoint(touching);
        return at(m.x, m.y, "Click between them to couple");
      }
      if (touching) return at(lp.x, lp.y, "Now pull A out and take it to its marker");
      if (state.sw[0] === 0 && !history.length) return at(lever.x, lever.y, "A is down there: pull the lever");
      if (history.length <= 1) return at(lp.x, lp.y, "Drive up to A until they touch");
    }
    if (level.name === "Turn around" && yard.turntables.length) {
      // on the turntable, coupler still facing away from A
      const T = yard.turntables[0];
      if (state.at[loco].track === T.deck && !turntableLocked(yard, state, 0) && !joints(yard, state).length) {
        const p = tableLeverPos(0);
        return at(p.x, p.y, "Pull the lever to turn the turntable round");
      }
    }
    return null;
  }
  let nudgeText = "";
  function updateNudge() {
    const el = opts.nudgeEl;
    if (!el) return;
    const n = nudgeFor();
    if (!n) { el.classList.add("is-gone"); return; }
    if (n.text !== nudgeText) { el.textContent = n.text; nudgeText = n.text; }
    // keep it on screen, with its arrow still pointing at the spot
    const half = el.offsetWidth / 2, x = Math.max(half + 12, Math.min(W - half - 12, n.p[0]));
    el.style.left = x + "px"; el.style.top = n.p[1] + "px";
    el.style.setProperty("--ax", Math.max(-half + 16, Math.min(half - 16, n.p[0] - x)) + "px");
    el.classList.remove("is-gone");
  }

  function win() {
    solved = true; hover = null; drag = null;
    canvas.style.cursor = "default";
    opts.onWin?.();
  }

  layout();
  requestAnimationFrame(frame);
  return {
    load, hide, undo, reset, layout, view,
    get canUndo() { return history.length > 0; },
    get state() { return state; }, get yard() { return yard; }, get cars() { return cars; },
    get solved() { return solved; }, get level() { return level; },
    toScreen: (x, y) => toScreenPx(sx(x), sy(y)), poseOf, jointsNow: () => joints(yard, state),
  };
}
