// Layouts and levels. Coordinates are in car lengths, y grows downward.
//
// Track that changes rows does it the way real track does: an S-bend, two
// arcs of radius R turning through TURN with a straight between them, so it
// leaves and arrives level. Tracks between switches must be whole numbers of
// cars long (see yard.mjs), so each bend's straight is solved to make that so.

const R = 0.6, TURN = Math.PI / 4, ARC_STEPS = 12;
const SPARE = 0.3;  // room left over at each buffer stop

// One arc, sampled as a polyline: its length and the points after the first.
const arcChord = 2 * ARC_STEPS * R * Math.sin(TURN / (2 * ARC_STEPS)); // polyline length of one arc

// An S-bend starting at (x, y) heading along xdir (±1), drifting toward ydir
// (±1), `len` long. Returns its points (start included) and where it ends.
function sBend(x, y, xdir, ydir, len) {
  const l = len - 2 * arcChord; // the straight between the arcs
  if (l < 0) throw new Error("bend too short");
  const pts = [];
  for (let k = 0; k <= ARC_STEPS; k++) {
    const f = (TURN * k) / ARC_STEPS;
    pts.push([x + xdir * R * Math.sin(f), y + ydir * R * (1 - Math.cos(f))]);
  }
  const [ax, ay] = pts[pts.length - 1];
  const bx = ax + xdir * l * Math.cos(TURN), by = ay + ydir * l * Math.sin(TURN);
  const ex = bx + xdir * R * Math.sin(TURN), ey = by + ydir * R * (1 - Math.cos(TURN));
  for (let k = ARC_STEPS; k >= 0; k--) {
    const f = (TURN * k) / ARC_STEPS;
    pts.push([ex - xdir * R * Math.sin(f), ey - ydir * R * (1 - Math.cos(f))]);
  }
  return { pts, end: [ex, ey] };
}

const LEAD = 2; // a ladder rung between switches is 2 cars long

// A headshunt of `head` slots on the left, then a ladder of switches fanning
// sidings off to the right. lens[i] = slots in siding i (top to bottom).
export function ladder(head, lens) {
  const nodes = { H: [0, 0] }, tracks = [], switches = {};
  let x = head + SPARE, y = 0, trunk = "head";
  nodes.P1 = [x, y];
  tracks.push({ id: "head", from: "H", to: "P1" });
  for (let i = 0; i < lens.length; i++) {
    const P = `P${i + 1}`, sid = `s${i + 1}`, E = `E${i + 1}`;
    nodes[E] = [x + lens[i] + SPARE, y];
    tracks.push({ id: sid, from: P, to: E });
    if (i + 1 === lens.length) break;
    const bend = sBend(x, y, 1, 1, LEAD);
    if (i + 2 === lens.length) {
      // the last switch's diverging leg bends down a row and becomes the last siding
      const E2 = `E${i + 2}`;
      nodes[E2] = [bend.end[0] + lens[i + 1] + SPARE - LEAD, bend.end[1]];
      tracks.push({ id: `s${i + 2}`, from: P, to: E2, via: bend.pts.slice(1) });
      switches[P] = { trunk, legs: [sid, `s${i + 2}`] };
      break;
    }
    const Q = `P${i + 2}`, lead = `l${i + 1}`;
    nodes[Q] = bend.end;
    tracks.push({ id: lead, from: P, to: Q, via: bend.pts.slice(1, -1) });
    switches[P] = { trunk, legs: [sid, lead] };
    trunk = lead; [x, y] = bend.end;
  }
  return { nodes, tracks, switches };
}

// A run-around loop: headshunt, then two parallel tracks between switches L
// and R (the loop, bending up and back down, is one car longer than the
// main), then a tail past R ending in a buffer.
export function runaround({ head, main, tail }) {
  const xL = head + SPARE, xR = xL + main;
  // each bend is half a car longer than the ground it covers, so the loop is one car longer
  const len = 2 * arcChord + (0.5 - 2 * arcChord + 2 * R * Math.sin(TURN)) / (1 - Math.cos(TURN));
  const up = sBend(xL, 0, 1, -1, len), down = sBend(xR, 0, -1, -1, len);
  const nodes = { H: [0, 0], L: [xL, 0], R: [xR, 0], T: [xR + tail + SPARE, 0] };
  const tracks = [
    { id: "head", from: "H", to: "L" },
    { id: "main", from: "L", to: "R" },
    { id: "loop", from: "L", to: "R", via: [...up.pts.slice(1), ...down.pts.slice(1).reverse()] },
    { id: "tail", from: "R", to: "T" },
  ];
  const switches = { L: { trunk: "head", legs: ["main", "loop"] }, R: { trunk: "tail", legs: ["main", "loop"] } };
  return { nodes, tracks, switches };
}

// Stars for a finish in this many moves or fewer: [three, two, one]. Three is
// the fewest the solver found; one is twice that (at least two more); two,
// which is par, sits halfway between. A level can set its own `stars`.
export function starCuts(lv) {
  if (lv.stars) return lv.stars;
  if (lv.fewest == null) return null;
  const three = lv.fewest, one = Math.max(three + 2, 2 * three);
  return [three, Math.floor((three + one) / 2), one];
}
export const starsFor = (lv, moves) => {
  const cuts = starCuts(lv);
  return cuts ? cuts.filter((c) => moves <= c).length : 0;
};

// Levels. `start` lists each track's contents left to right (tracks run from
// their `from` node to their `to` node, which is left to right on screen):
// L/M = locomotives, A–H = lettered cars, x = an unlettered car, . = empty.
// `goals` list cars left to right too, packed against the `end` node.
// In order of how hard they are to think through (not how big their search is):
// two tutorials, then parking a car aside (Swap two), the loop trick (Run around),
// parking at scale, gathering from several sidings, reversing, two goals at
// once, and finally yards with almost no room to work in.
export const LEVELS = [
  {
    name: "Delivery",
    blurb: "Push A to its marker.",
    layout: ladder(4, [3, 3]),
    start: { head: "L A" },
    goals: [{ track: "s2", end: "E2", cars: "A" }],
    fewest: 1,
  },
  {
    name: "Fetch",
    blurb: "Fetch A and take it to its marker.",
    layout: ladder(4, [3, 3]),
    start: { head: "L", s2: ". . A" },
    goals: [{ track: "s1", end: "E1", cars: "A" }],
    fewest: 3,
  },
  {
    name: "Swap two",
    blurb: "Swap A and B.",
    layout: ladder(4, [3, 3]),
    start: { head: "L", s1: ". A B" },
    goals: [{ track: "s1", end: "E1", cars: "B A" }],
    fewest: 8,
  },
  {
    name: "Run around",
    blurb: "Get the locomotive to the other end of its train.",
    layout: runaround({ head: 5, main: 5, tail: 5 }),
    start: { head: "L A B C" },
    goals: [{ track: "head", end: "H", cars: "A B C" }],
    fewest: 4,
  },
  {
    name: "Pick out",
    blurb: "Get A B C to their markers.",
    layout: ladder(5, [5, 3]),
    start: { head: "L", s1: "x B x A C" },
    goals: [{ track: "s1", end: "E1", cars: "A B C" }],
    fewest: 10,
  },
  {
    name: "Three sidings",
    blurb: "Gather A B C D at their markers.",
    layout: ladder(4, [4, 3, 3]),
    start: { head: "L", s1: ". . D B", s2: ". . C", s3: ". . A" },
    goals: [{ track: "s1", end: "E1", cars: "A B C D" }],
    fewest: 13,
  },
  {
    name: "Four in order",
    blurb: "Line up A B C D at their markers.",
    layout: ladder(5, [5, 3, 3]),
    start: { head: "L", s1: "C . A", s2: "B . D" },
    goals: [{ track: "s1", end: "E1", cars: "A B C D" }],
    fewest: 12,
  },
  {
    name: "Reverse three",
    blurb: "Turn the train around.",
    layout: ladder(5, [4, 3]),
    start: { head: "L", s1: ". A B C" },
    goals: [{ track: "s1", end: "E1", cars: "C B A" }],
    fewest: 13,
  },
  {
    name: "Two trains",
    blurb: "Sort the cars into two trains at their markers.",
    layout: ladder(3, [3, 3, 3]),
    start: { head: "L", s1: "E A", s2: ". B F", s3: ". C D" },
    goals: [{ track: "s1", end: "E1", cars: "A B C" }, { track: "s2", end: "E2", cars: "D E F" }],
    fewest: null, // too big to search; stars set by hand
    stars: [24, 32, 42],
  },
  {
    name: "Swap sidings",
    blurb: "Swap the two trains.",
    layout: ladder(4, [3, 3, 2]),
    start: { head: "L", s1: "A B C", s2: "D E F" },
    goals: [{ track: "s1", end: "E1", cars: "D E F" }, { track: "s2", end: "E2", cars: "A B C" }],
    fewest: null, // too big to search; stars set by hand
    stars: [22, 30, 40],
  },
  {
    name: "Tight squeeze",
    blurb: "Line up A B C D at their markers. There's barely any room.",
    layout: ladder(3, [4, 2, 2]),
    start: { head: "L", s1: "x C x A", s2: "D B" },
    goals: [{ track: "s1", end: "E1", cars: "A B C D" }],
    fewest: 34,
  },
];
