import {
  ARENA_RADIUS,
  SPAWN_CLEAR_RADIUS,
  TERRAIN_CELL,
  TERRAIN_FILL,
  TERRAIN_SMOOTHING,
} from "../config";
import { makeRng, segmentHitsCircle, type Vec } from "./geometry";
import type { Wall } from "./types";

export interface Arena {
  radius: number;
  walls: Wall[];
  spawns: Vec[];
  /** Spatial index over `walls` — line-of-sight and placement queries go through it. */
  index: WallIndex;
  /** False for open ground cut off from the main cave system (and for solid rock). */
  isReachable(p: Vec): boolean;
}

/**
 * Terrain (§4) as a cellular-automata cave system: open rooms joined by narrow
 * chokepoints, with pockets that take probing to find. Wall cells become jittered
 * circles so the silhouette keeps the soft cloud look.
 */
export function generateArena(seed: number, playerCount: number): Arena {
  const rng = makeRng(seed);
  const radius = ARENA_RADIUS;
  const cs = TERRAIN_CELL;
  const n = Math.ceil((radius * 2) / cs) + 2;
  const origin = -radius - cs; // world position of cell (0,0)
  const toCell = (v: number) => Math.floor((v - origin) / cs);
  const toWorld = (i: number) => origin + (i + 0.5) * cs;
  const at = (x: number, y: number) => y * n + x;

  // Spawns sit on a ring, with terrain carved open around them so nobody starts boxed in.
  const spawns: Vec[] = [];
  const spawnDist = radius * 0.66;
  const spawnOffset = rng() * Math.PI * 2;
  for (let i = 0; i < playerCount; i++) {
    const a = spawnOffset + (i / playerCount) * Math.PI * 2;
    spawns.push({ x: Math.cos(a) * spawnDist, y: Math.sin(a) * spawnDist });
  }

  let solid = new Uint8Array(n * n);
  const protectedCell = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const wx = toWorld(x);
      const wy = toWorld(y);
      const d = Math.hypot(wx, wy);
      if (d > radius - cs) {
        solid[at(x, y)] = 1; // outer boundary
        continue;
      }
      // Keep a clear bubble around each spawn.
      if (spawns.some((s) => Math.hypot(s.x - wx, s.y - wy) < SPAWN_CLEAR_RADIUS)) {
        protectedCell[at(x, y)] = 1;
        continue;
      }
      solid[at(x, y)] = rng() < TERRAIN_FILL ? 1 : 0;
    }
  }

  // A wandering artery from each spawn to the middle. Guarantees every player can
  // reach the rest of the map, and gives the cave system its through-routes.
  for (const s of spawns) {
    const steps = 60;
    let drift = 0;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      drift += (rng() - 0.5) * cs * 2.2;
      const nx = -(0 - s.y);
      const ny = 0 - s.x;
      const len = Math.hypot(nx, ny) || 1;
      const px = s.x + (0 - s.x) * t + (nx / len) * drift * Math.sin(t * Math.PI);
      const py = s.y + (0 - s.y) * t + (ny / len) * drift * Math.sin(t * Math.PI);
      const cx = toCell(px);
      const cy = toCell(py);
      const rad = 1; // cells either side → a corridor ~3 cells wide
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const gx = cx + dx;
          const gy = cy + dy;
          if (gx < 1 || gy < 1 || gx >= n - 1 || gy >= n - 1) continue;
          if (Math.hypot(toWorld(gx), toWorld(gy)) > radius - cs * 2) continue;
          protectedCell[at(gx, gy)] = 1;
          solid[at(gx, gy)] = 0;
        }
      }
    }
  }

  for (let pass = 0; pass < TERRAIN_SMOOTHING; pass++) {
    const next = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const wx = toWorld(x);
        const wy = toWorld(y);
        if (Math.hypot(wx, wy) > radius - cs) {
          next[at(x, y)] = 1;
          continue;
        }
        if (protectedCell[at(x, y)]) continue;
        let walls = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            // Out of bounds counts as wall, so the map closes in on itself.
            walls += nx < 0 || ny < 0 || nx >= n || ny >= n ? 1 : solid[at(nx, ny)];
          }
        }
        next[at(x, y)] = walls > 4 ? 1 : walls < 4 ? 0 : solid[at(x, y)];
      }
    }
    solid = next;
  }

  const reachable = floodFrom(spawns[0], solid, n, at, toCell);

  const walls: Wall[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!solid[at(x, y)]) continue;
      walls.push({
        x: toWorld(x) + (rng() - 0.5) * cs * 0.3,
        y: toWorld(y) + (rng() - 0.5) * cs * 0.3,
        r: cs * (0.62 + rng() * 0.22),
      });
    }
  }

  return {
    radius,
    walls,
    spawns,
    index: new WallIndex(walls, radius),
    isReachable: (p) => {
      const x = toCell(p.x);
      const y = toCell(p.y);
      if (x < 0 || y < 0 || x >= n || y >= n) return false;
      return reachable[at(x, y)] === 1;
    },
  };
}

/** Marks open cells connected to `start` — everything else is rock or a sealed pocket. */
function floodFrom(
  start: Vec,
  solid: Uint8Array,
  n: number,
  at: (x: number, y: number) => number,
  toCell: (v: number) => number,
): Uint8Array {
  const seen = new Uint8Array(n * n);
  const sx = toCell(start.x);
  const sy = toCell(start.y);
  if (sx < 0 || sy < 0 || sx >= n || sy >= n || solid[at(sx, sy)]) return seen;
  const stack = [at(sx, sy)];
  seen[at(sx, sy)] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % n;
    const y = (i - x) / n;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = at(nx, ny);
      if (seen[j] || solid[j]) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  return seen;
}

/**
 * Uniform grid over the wall circles. Terrain is thousands of circles, so
 * line-of-sight and placement checks look at only the cells they touch.
 */
export class WallIndex {
  private cell: number;
  private n: number;
  private origin: number;
  private buckets: number[][];

  constructor(private walls: Wall[], radius: number) {
    this.cell = Math.max(TERRAIN_CELL * 2, 1);
    this.origin = -radius - this.cell * 2;
    this.n = Math.max(1, Math.ceil((radius * 2 + this.cell * 4) / this.cell));
    this.buckets = Array.from({ length: this.n * this.n }, () => []);
    walls.forEach((w, i) => {
      for (const c of this.cellsFor(w.x - w.r, w.y - w.r, w.x + w.r, w.y + w.r)) {
        this.buckets[c].push(i);
      }
    });
  }

  private idx(v: number): number {
    return Math.min(this.n - 1, Math.max(0, Math.floor((v - this.origin) / this.cell)));
  }

  private *cellsFor(x0: number, y0: number, x1: number, y1: number): Generator<number> {
    const ix0 = this.idx(x0);
    const ix1 = this.idx(x1);
    const iy0 = this.idx(y0);
    const iy1 = this.idx(y1);
    for (let y = iy0; y <= iy1; y++) for (let x = ix0; x <= ix1; x++) yield y * this.n + x;
  }

  /** Walls overlapping a rectangle (used for view culling when drawing). */
  inRect(x0: number, y0: number, x1: number, y1: number): Wall[] {
    const seen = new Set<number>();
    const out: Wall[] = [];
    for (const c of this.cellsFor(x0, y0, x1, y1)) {
      for (const i of this.buckets[c]) {
        if (seen.has(i)) continue;
        seen.add(i);
        const w = this.walls[i];
        if (w.x + w.r < x0 || w.x - w.r > x1 || w.y + w.r < y0 || w.y - w.r > y1) continue;
        out.push(w);
      }
    }
    return out;
  }

  /** True if any wall circle blocks the segment a→b. */
  segmentBlocks(a: Vec, b: Vec): boolean {
    const seen = new Set<number>();
    for (const c of this.cellsFor(
      Math.min(a.x, b.x), Math.min(a.y, b.y),
      Math.max(a.x, b.x), Math.max(a.y, b.y),
    )) {
      for (const i of this.buckets[c]) {
        if (seen.has(i)) continue;
        seen.add(i);
        if (segmentHitsCircle(a, b, this.walls[i])) return true;
      }
    }
    return false;
  }

  /** True if a disc of `r` at `p` overlaps any wall. */
  discBlocks(p: Vec, r: number): boolean {
    for (const c of this.cellsFor(p.x - r, p.y - r, p.x + r, p.y + r)) {
      for (const i of this.buckets[c]) {
        const w = this.walls[i];
        if (Math.hypot(w.x - p.x, w.y - p.y) < w.r + r) return true;
      }
    }
    return false;
  }
}

/** Wall-free arena, for tests and headless experiments. */
export function emptyArena(radius = 2000, walls: Wall[] = []): Arena {
  return {
    radius,
    walls,
    spawns: [],
    index: new WallIndex(walls, radius),
    isReachable: () => true,
  };
}
