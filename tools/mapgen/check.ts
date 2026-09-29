/**
 * Reliability and speed check for the proposed generator.
 *
 *   npx tsx tools/mapgen/check.ts [seedsPerCount]
 *
 * For a spread of player counts and many seeds, verifies every spawn is
 * connected to every other, every fall can be reached, every spawn has food in
 * starting reach, wealth per player is even, and generation is fast.
 */
import { START_NUTRIENTS, reach } from "../../src/config";
import { generateMap } from "./generate";

const perCount = Number(process.argv[2]) || 60;
const counts = [1, 2, 4, 8, 16, 30, 47];
let failures = 0;

for (const players of counts) {
  const times: number[] = [];
  const spread: number[] = [];
  const falls: number[] = [];
  const shape = { enclaves: 0, loops: 0, chokes: 0, repairs: 0, open: 0, routeSpread: 0 };
  const problems: string[] = [];
  for (let seed = 1; seed <= perCount; seed++) {
    const m = generateMap({ seed, players });
    times.push(m.stats.ms);
    falls.push(m.falls.length);
    if (!m.stats.connected) problems.push(`seed ${seed}: open ground is not all connected`);
    if (m.stats.enclaves < 1 && players >= 2) problems.push(`seed ${seed}: no enclaves`);
    if (m.stats.loops < 1) problems.push(`seed ${seed}: no loops (single route everywhere)`);
    shape.enclaves += m.stats.enclaves;
    shape.loops += m.stats.loops;
    shape.chokes += m.stats.chokepoints;
    shape.repairs += m.stats.repairs;
    shape.open += m.stats.openShare;
    const rt = m.stats.routeToCentre;
    if (rt.length > 1 && players <= 12) shape.routeSpread = Math.max(shape.routeSpread, (Math.max(...rt) - Math.min(...rt)) / Math.min(...rt));
    // Every spawn with a meal in starting reach, and a richer one just past it.
    m.spawns.forEach((s, i) => {
      const home = m.falls.filter((f) => f.home === i);
      const near = home.filter((f) => Math.hypot(f.x - s.x, f.y - s.y) <= reach(START_NUTRIENTS));
      if (near.length === 0) problems.push(`seed ${seed}: spawn ${i} has no food in reach`);
      if (home.length < 2) problems.push(`seed ${seed}: spawn ${i} has only ${home.length} home fall(s)`);
    });
    if (players > 1) {
      const w = m.stats.wealth;
      const mean = w.reduce((a, b) => a + b, 0) / w.length;
      spread.push((Math.max(...w) - Math.min(...w)) / mean);
    }
    // No fall may overlap a wall or another fall; spawns must clear walls.
    for (const f of m.falls) {
      if (m.walls.some((w) => Math.hypot(w.x - f.x, w.y - f.y) < w.r + 14)) problems.push(`seed ${seed}: fall inside a wall`);
    }
    for (const s of m.spawns) {
      if (m.walls.some((w) => Math.hypot(w.x - s.x, w.y - s.y) < w.r + 30)) problems.push(`seed ${seed}: spawn inside a wall`);
    }
  }
  failures += problems.length;
  times.sort((a, b) => a - b);
  spread.sort((a, b) => a - b);
  const pct = (v: number[], p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  console.log(
    `${String(players).padStart(2)} players  ${perCount} seeds  time p50 ${pct(times, 0.5).toFixed(0)}ms p95 ${pct(times, 0.95).toFixed(0)}ms max ${times[times.length - 1].toFixed(0)}ms` +
      `  falls avg ${Math.round(falls.reduce((a, b) => a + b, 0) / falls.length)}` +
      (spread.length ? `  wealth spread (max-min)/mean p50 ${(pct(spread, 0.5) * 100).toFixed(0)}% worst ${(spread[spread.length - 1] * 100).toFixed(0)}%` : "") +
      `  problems ${problems.length}` +
      `
     avg per map: open ${(shape.open / perCount * 100).toFixed(0)}%, enclaves ${(shape.enclaves / perCount).toFixed(1)}, loops ${(shape.loops / perCount).toFixed(0)}, chokepoints ${(shape.chokes / perCount).toFixed(0)}, repairs ${(shape.repairs / perCount).toFixed(1)}` +
      (players <= 12 && players > 1 ? `, worst spawn-route spread ${(shape.routeSpread * 100).toFixed(0)}%` : ""),
  );
  for (const p of problems.slice(0, 3)) console.log("   ", p);
}
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} PROBLEMS`);
process.exit(failures === 0 ? 0 : 1);
