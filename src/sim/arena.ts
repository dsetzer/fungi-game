import {
  ARENA_RADIUS,
  NODE_SPACING,
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
  /** False for solid rock and for any open ground still cut off from the main cave. */
  isReachable(p: Vec): boolean;
}

/** A pocket smaller than this is filled in rather than connected. */
const MIN_POCKET_CELLS = 4;
/** Carved connections are this many cells either side of the path (3 cells wide). */
const CARVE_RADIUS = 1;

/**
 * Terrain (§4) as a cellular-automata cave system: open rooms joined by narrow
 * chokepoints, with pockets that take probing to find. Wall cells become jittered
 * circles so the silhouette keeps the soft cloud look.
 *
 * Passability is judged against the actual wall circles, not the raw grid: a
 * one-cell gap is sealed by the circles either side of it, so treating it as open
 * would leave pockets nothing can reach. Anything still cut off afterwards is
 * either connected by a carved crack or filled in.
 */
export function generateArena(seed: number, playerCount: number, radiusOverride?: number): Arena {
  const rng = makeRng(seed);
  const radius = radiusOverride ?? ARENA_RADIUS;
  const cs = TERRAIN_CELL;
  const n = Math.ceil((radius * 2) / cs) + 2;
  const origin = -radius - cs;
  const toCell = (v: number) => Math.floor((v - origin) / cs);
  const toWorld = (i: number) => origin + (i + 0.5) * cs;
  const at = (x: number, y: number) => y * n + x;
  const inGrid = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n;
  const isRock = (x: number, y: number) => Math.hypot(toWorld(x), toWorld(y)) > radius - cs;

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
      if (isRock(x, y)) {
        solid[at(x, y)] = 1; // outer boundary
        continue;
      }
      const wx = toWorld(x);
      const wy = toWorld(y);
      if (spawns.some((s) => Math.hypot(s.x - wx, s.y - wy) < SPAWN_CLEAR_RADIUS)) {
        protectedCell[at(x, y)] = 1; // clear bubble around each spawn
        continue;
      }
      solid[at(x, y)] = rng() < TERRAIN_FILL ? 1 : 0;
    }
  }

  // A wandering artery from each spawn to the middle, so the map has through-routes.
  for (const s of spawns) {
    const steps = 60;
    let drift = 0;
    const nx = s.y;
    const ny = -s.x;
    const len = Math.hypot(nx, ny) || 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      drift += (rng() - 0.5) * cs * 2.2;
      const px = s.x * (1 - t) + (nx / len) * drift * Math.sin(t * Math.PI);
      const py = s.y * (1 - t) + (ny / len) * drift * Math.sin(t * Math.PI);
      carve(toCell(px), toCell(py));
    }
  }

  function carve(cx: number, cy: number): void {
    for (let dy = -CARVE_RADIUS; dy <= CARVE_RADIUS; dy++) {
      for (let dx = -CARVE_RADIUS; dx <= CARVE_RADIUS; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!inGrid(x, y) || isRock(x, y)) continue;
        solid[at(x, y)] = 0;
        protectedCell[at(x, y)] = 1;
      }
    }
  }

  for (let pass = 0; pass < TERRAIN_SMOOTHING; pass++) {
    const next = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (isRock(x, y)) {
          next[at(x, y)] = 1;
          continue;
        }
        if (protectedCell[at(x, y)]) continue;
        let walls = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            // Out of bounds counts as wall, so the map closes in on itself.
            walls += inGrid(x + dx, y + dy) ? solid[at(x + dx, y + dy)] : 1;
          }
        }
        next[at(x, y)] = walls > 4 ? 1 : walls < 4 ? 0 : solid[at(x, y)];
      }
    }
    solid = next;
  }

  const buildWalls = (): Wall[] => {
    const out: Wall[] = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!solid[at(x, y)]) continue;
        out.push({
          x: toWorld(x) + (hash01(x, y, seed ^ 1) - 0.5) * cs * 0.3,
          y: toWorld(y) + (hash01(x, y, seed ^ 2) - 0.5) * cs * 0.3,
          r: cs * (0.62 + hash01(x, y, seed ^ 3) * 0.22),
        });
      }
    }
    return out;
  };

  /** Open cells a node could actually occupy, given the wall circles around them. */
  const buildPassable = (index: WallIndex): Uint8Array => {
    const pass = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (solid[at(x, y)] || isRock(x, y)) continue;
        const p = { x: toWorld(x), y: toWorld(y) };
        pass[at(x, y)] = index.discBlocks(p, NODE_SPACING) ? 0 : 1;
      }
    }
    return pass;
  };

  let walls = buildWalls();
  let index = new WallIndex(walls, radius);
  let passable = buildPassable(index);
  let reachable = floodFrom(spawns[0], passable, n, at, toCell);

  // Connect (or delete) whatever the main cave still can't get to.
  for (let attempt = 0; attempt < 4; attempt++) {
    const pockets = findPockets(passable, reachable, n, at);
    if (pockets.length === 0) break;
    const routes = routesToMain(reachable, passable, n, inGrid);
    let changed = false;
    for (const pocket of pockets) {
      if (pocket.length < MIN_POCKET_CELLS) {
        for (const i of pocket) solid[i] = 1; // too small to be worth a crack
        changed = true;
        continue;
      }
      // Carve back along the shortest route from the pocket to the main cave.
      let best = -1;
      for (const i of pocket) if (best < 0 || routes.dist[i] < routes.dist[best]) best = i;
      if (best < 0 || routes.dist[best] === Infinity) continue;
      for (let i = best; i !== -1 && routes.dist[i] > 0; i = routes.parent[i]) {
        carve(i % n, (i - (i % n)) / n);
      }
      changed = true;
    }
    if (!changed) break;
    walls = buildWalls();
    index = new WallIndex(walls, radius);
    passable = buildPassable(index);
    reachable = floodFrom(spawns[0], passable, n, at, toCell);
  }

  return {
    radius,
    walls,
    spawns,
    index,
    isReachable: (p) => {
      const x = toCell(p.x);
      const y = toCell(p.y);
      return inGrid(x, y) && reachable[at(x, y)] === 1;
    },
  };
}

/** Groups of passable cells the main cave can't reach. */
function findPockets(
  passable: Uint8Array,
  reachable: Uint8Array,
  n: number,
  at: (x: number, y: number) => number,
): number[][] {
  const seen = new Uint8Array(n * n);
  const pockets: number[][] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const start = at(x, y);
      if (!passable[start] || reachable[start] || seen[start]) continue;
      const group: number[] = [];
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        group.push(i);
        for (const j of neighbours(i, n)) {
          if (passable[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      pockets.push(group);
    }
  }
  return pockets;
}

/**
 * Breadth-first search outward from the main cave across every cell, wall or not,
 * so each pocket can be walked back to the main cave along the shortest route.
 */
function routesToMain(
  reachable: Uint8Array,
  passable: Uint8Array,
  n: number,
  inGrid: (x: number, y: number) => boolean,
): { dist: Float64Array; parent: Int32Array } {
  const dist = new Float64Array(n * n).fill(Infinity);
  const parent = new Int32Array(n * n).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < reachable.length; i++) {
    if (reachable[i] && passable[i]) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    for (const j of neighbours(i, n)) {
      const x = j % n;
      const y = (j - x) / n;
      // Keep one cell clear of the grid edge so carving can't breach the boundary.
      if (!inGrid(x, y) || x < 2 || y < 2 || x >= n - 2 || y >= n - 2) continue;
      if (dist[j] !== Infinity) continue;
      dist[j] = dist[i] + 1;
      parent[j] = i;
      queue.push(j);
    }
  }
  return { dist, parent };
}

function* neighbours(i: number, n: number): Generator<number> {
  const x = i % n;
  const y = (i - x) / n;
  if (x > 0) yield i - 1;
  if (x < n - 1) yield i + 1;
  if (y > 0) yield i - n;
  if (y < n - 1) yield i + n;
}

/** Marks passable cells connected to `start`. */
function floodFrom(
  start: Vec,
  passable: Uint8Array,
  n: number,
  at: (x: number, y: number) => number,
  toCell: (v: number) => number,
): Uint8Array {
  const seen = new Uint8Array(n * n);
  let sx = toCell(start.x);
  let sy = toCell(start.y);
  if (sx < 0 || sy < 0 || sx >= n || sy >= n) return seen;
  if (!passable[at(sx, sy)]) {
    // Spawn cell itself is tight: start from the nearest passable cell instead.
    let best = -1;
    let bestD = Infinity;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!passable[at(x, y)]) continue;
        const d = (x - sx) ** 2 + (y - sy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = at(x, y);
        }
      }
    }
    if (best < 0) return seen;
    sx = best % n;
    sy = (best - sx) / n;
  }
  const stack = [at(sx, sy)];
  seen[at(sx, sy)] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    for (const j of neighbours(i, n)) {
      if (seen[j] || !passable[j]) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  return seen;
}

/** Stable per-cell pseudo-random value, so wall circles survive a rebuild unchanged. */
function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (b + 0x165667b1), 0xc2b2ae35);
  h = Math.imul(h ^ (c + 0x27d4eb2f), 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
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
