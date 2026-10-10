// Turn a level description into a yard, cars and a starting state.
//
// `start` lists each track's contents left to right (from its `from` node to
// its `to` node): A–H are lettered cars, x an unlettered one, . an empty spot,
// and L or M a locomotive. A locomotive has a coupler on one end only, shown by
// an arrow: "L>" has it on the right (toward the track's `to` end), "<L" on the
// left. Plain "L" means "L>".
import { buildYard } from "./yard.mjs";

export function loadLevel(level) {
  const yard = buildYard(level.layout);
  const cars = [], pos = [], face = {}, byName = {};
  for (const [tid, spec] of Object.entries(level.start)) {
    const t = yard.tracks[tid];
    if (!t) throw new Error(`no track ${tid}`);
    spec.trim().split(/\s+/).forEach((tok, i) => {
      if (tok === ".") return;
      if (i >= t.slots.length) throw new Error(`track ${tid} has only ${t.slots.length} slots`);
      const name = tok.replace(/[<>]/g, "");
      const loco = name === "L" || name === "M";
      const car = name === "x" ? { name: "", filler: true } : { name, loco };
      if (loco) face[cars.length] = tok.startsWith("<") ? -1 : 1;
      if (car.name) byName[car.name] = cars.length;
      cars.push(car);
      pos.push(t.slots[i]);
    });
  }
  const goals = level.goals.map((g) => ({ ...g, cars: g.cars.trim().split(/\s+/).map((n) => byName[n]) }));
  const sw = yard.switches.map((S) => (level.switches && level.switches[S.id]) || 0);
  const tt = yard.turntables.map((T) => T.start);
  return { yard, cars, goals, state: { pos, sw, tt, face, coupled: new Set() } };
}
