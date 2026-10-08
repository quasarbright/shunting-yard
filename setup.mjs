// Turn a level description into a yard, cars and a starting state.
import { buildYard } from "./yard.mjs";

export function loadLevel(level) {
  const yard = buildYard(level.layout);
  const cars = [], pos = [], byName = {};
  for (const [tid, spec] of Object.entries(level.start)) {
    const t = yard.tracks[tid];
    if (!t) throw new Error(`no track ${tid}`);
    spec.trim().split(/\s+/).forEach((tok, i) => {
      if (tok === ".") return;
      if (i >= t.slots.length) throw new Error(`track ${tid} has only ${t.slots.length} slots`);
      const car = tok === "x" ? { name: "", filler: true } : { name: tok, loco: tok === "L" || tok === "M" };
      if (car.name) byName[car.name] = cars.length;
      cars.push(car);
      pos.push(t.slots[i]);
    });
  }
  const goals = level.goals.map((g) => ({ ...g, cars: g.cars.trim().split(/\s+/).map((n) => byName[n]) }));
  const sw = yard.switches.map(() => 0);
  return { yard, cars, goals, state: { pos, sw, coupled: new Set() } };
}
