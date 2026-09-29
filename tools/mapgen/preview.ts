/**
 * Map-generation previews. Nothing here touches the game: it draws the CURRENT
 * generator next to the proposed one (generate.ts) so they can be compared.
 *
 *   npx tsx tools/mapgen/preview.ts            default showcase
 *   npx tsx tools/mapgen/preview.ts 5 9 12     seeds, 4 players each
 *
 * Writes tools/mapgen/out/index.html (self-contained; open it in a browser).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_SPACING, START_NUTRIENTS, fallAura, radiusForPlayers, reach } from "../../src/config";
import { World } from "../../src/sim/world";
import { generateMap, type Disc, type Fall, type MapResult } from "./generate";

interface Shown {
  title: string;
  note: string;
  map: Pick<MapResult, "radius" | "walls" | "spawns" | "falls">;
  stats: string[];
}

const COLORS = ["#3d9a4a", "#d9420b", "#3a6fd8", "#b03ad8", "#c9a300", "#0b9aa8", "#8a5a2b", "#d63a86"];

function current(seed: number): Shown {
  const world = World.createMatch(seed, 4, true);
  const falls: Fall[] = [...world.nodes.values()]
    .filter((n) => n.kind === "fall")
    .map((n) => ({ x: n.x, y: n.y, pool: n.nutrients, home: null }));
  const map = { radius: world.arena.radius, walls: world.arena.walls, spawns: world.arena.spawns, falls };
  return {
    title: `Current generator — seed ${seed}, 4 players`,
    note: "Grid of small circles from cellular automata; falls in clusters of 4–8.",
    map,
    stats: [`${map.walls.length} wall circles`, `${falls.length} falls`, poolStats(falls)],
  };
}

function proposed(seed: number, players: number): Shown {
  const map = generateMap({ seed, players });
  return {
    title: `New generator — seed ${seed}, ${players} players`,
    note: "Rooms of varied size joined by passages: chokepoints, loops, dead-end enclaves; rock filled with discs.",
    map,
    stats: [
      `${map.stats.rooms} rooms, ${map.stats.passages} passages (${map.stats.chokepoints} chokepoints, ${map.stats.loops} loops), ${map.stats.enclaves} enclaves`,
      `${map.walls.length} rock discs (radius ${Math.round(Math.min(...map.walls.map((w) => w.r)))}–${Math.round(Math.max(...map.walls.map((w) => w.r)))}), ${Math.round(map.stats.openShare * 100)}% open ground`,
      `${map.falls.length} falls, ${poolStats(map.falls)}`,
      `wealth per player: ${map.stats.wealth.map((w) => Math.round(w)).join(" / ")}`,
      `generated in ${map.stats.ms.toFixed(0)} ms, connected: ${map.stats.connected}`,
    ],
  };
}

function poolStats(falls: Fall[]): string {
  const p = falls.map((f) => f.pool).sort((a, b) => a - b);
  return `pools ${p[0]} / median ${p[Math.floor(p.length / 2)]} / ${p[p.length - 1]} (min/med/max)`;
}

/** Ground a spawn can't reach, for showing pockets on the current map. */
function stranded(map: Shown["map"]): Disc[] {
  const R = map.radius;
  const cell = R > 8000 ? 100 : 80;
  const n = Math.ceil((R * 2) / cell);
  const c = (i: number) => -R + (i + 0.5) * cell;
  const open = new Uint8Array(n * n);
  const buckets = new Map<number, Disc[]>();
  const B = 400;
  for (const w of map.walls) {
    for (let ix = Math.floor((w.x - w.r) / B); ix <= Math.floor((w.x + w.r) / B); ix++) {
      for (let iy = Math.floor((w.y - w.r) / B); iy <= Math.floor((w.y + w.r) / B); iy++) {
        const k = (ix + 500) * 2048 + iy + 500;
        (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(w);
      }
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = c(x);
      const py = c(y);
      if (Math.hypot(px, py) > R - NODE_SPACING) continue;
      const b = buckets.get((Math.floor(px / B) + 500) * 2048 + Math.floor(py / B) + 500) ?? [];
      open[y * n + x] = b.some((w) => Math.hypot(w.x - px, w.y - py) < w.r + NODE_SPACING) ? 0 : 1;
    }
  }
  const seen = new Uint8Array(n * n);
  const stack: number[] = [];
  const s0 = map.spawns[0];
  const start = Math.floor((s0.y + R) / cell) * n + Math.floor((s0.x + R) / cell);
  if (open[start]) {
    seen[start] = 1;
    stack.push(start);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % n;
    for (const j of [x > 0 ? i - 1 : -1, x < n - 1 ? i + 1 : -1, i - n, i + n]) {
      if (j >= 0 && j < n * n && open[j] && !seen[j]) {
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  const out: Disc[] = [];
  for (let i = 0; i < n * n; i++) if (open[i] && !seen[i]) out.push({ x: c(i % n), y: c(Math.floor(i / n)), r: cell / 2 });
  return out;
}

function svg(map: Shown["map"], pockets: Disc[]): string {
  const R = map.radius;
  const pad = R * 0.04;
  const size = (R + pad) * 2;
  const o: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-R - pad} ${-R - pad} ${size} ${size}">`,
    `<rect x="${-R - pad}" y="${-R - pad}" width="${size}" height="${size}" fill="#fff"/>`,
    `<path fill="#e2e4ec" fill-rule="evenodd" d="M${-R - pad},${-R - pad}h${size}v${size}h${-size}z M${-R},0a${R},${R} 0 1,0 ${R * 2},0a${R},${R} 0 1,0 ${-R * 2},0z"/>`,
  ];
  for (const p of pockets) o.push(`<rect x="${p.x - p.r}" y="${p.y - p.r}" width="${p.r * 2}" height="${p.r * 2}" fill="#f5b5b0"/>`);
  o.push(`<g fill="#e2e4ec" stroke="#cfd2dd" stroke-width="${R / 900}">`);
  for (const w of map.walls) o.push(`<circle cx="${w.x.toFixed(0)}" cy="${w.y.toFixed(0)}" r="${w.r.toFixed(0)}"/>`);
  o.push(`</g>`);
  for (const f of map.falls) {
    const r = Math.max(14, fallAura(f.pool));
    o.push(`<circle cx="${f.x.toFixed(0)}" cy="${f.y.toFixed(0)}" r="${r.toFixed(0)}" fill="#b8b8c2" stroke="#8d8d99" stroke-width="${R / 1100}"/>`);
    o.push(`<circle cx="${f.x.toFixed(0)}" cy="${f.y.toFixed(0)}" r="${R / 600}" fill="#6f6f7c"/>`);
  }
  map.spawns.forEach((s, i) => {
    o.push(`<circle cx="${s.x}" cy="${s.y}" r="${reach(START_NUTRIENTS)}" fill="none" stroke="${COLORS[i % COLORS.length]}" stroke-width="${R / 800}" stroke-dasharray="${R / 180} ${R / 220}"/>`);
    o.push(`<circle cx="${s.x}" cy="${s.y}" r="${R / 170}" fill="${COLORS[i % COLORS.length]}"/>`);
  });
  o.push(`</svg>`);
  return o.join("");
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "out");
mkdirSync(outDir, { recursive: true });

const seeds = process.argv.slice(2).map(Number).filter(Number.isFinite);
const shown: Shown[] =
  seeds.length > 0
    ? seeds.map((s) => proposed(s, 4))
    : [current(1), proposed(1, 4), proposed(2, 4), proposed(3, 4), proposed(4, 8), proposed(5, 2)];

const figs = shown.map((s) => {
  const pockets = s.title.startsWith("Current") ? stranded(s.map) : [];
  const extra = pockets.length > 0 ? `<li>pale red = ground no spawn can reach (${pockets.length} cells)</li>` : "";
  return `<figure>${svg(s.map, pockets)}<figcaption><b>${s.title}</b><br>${s.note}<ul>${s.stats.map((t) => `<li>${t}</li>`).join("")}${extra}</ul></figcaption></figure>`;
});
writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Map generation previews</title>
<style>body{font:14px system-ui;margin:20px;background:#fafafa;color:#222}.row{display:flex;gap:20px;flex-wrap:wrap}
figure{margin:0;width:min(46vw,760px)}svg{width:100%;height:auto;border:1px solid #ccc;display:block}li{margin:2px 0}
p{max-width:900px}</style>
<h1>Map generation previews</h1>
<p>Dashed ring = a player's starting reach (${reach(START_NUTRIENTS)}). Grey discs = nutrient falls, sized by pool. Light shapes = terrain. The arena is a circle whose radius scales with player count (${radiusForPlayers(4)} for 4).</p>
<div class="row">${figs.join("")}</div>`,
);
console.log(`wrote ${join(outDir, "index.html")}`);
